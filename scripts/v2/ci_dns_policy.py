"""Read-only certificate discovery and a DNS mutation gate for deployment plans."""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


# CloudFront supports RSA through 4096 and ECDSA P-256/P-384; retain an RSA 2048 floor.
# https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html
# ACM KeyAlgorithm uses underscores (not the display form "RSA-2048"):
# https://docs.aws.amazon.com/acm/latest/APIReference/API_CertificateDetail.html
KEY_TYPES = ("RSA_2048", "RSA_3072", "RSA_4096", "EC_prime256v1", "EC_secp384r1")
MIN_REMAINING = timedelta(hours=24)


def domain_matches(pattern, hostname):
    pattern, hostname = pattern.lower().rstrip("."), hostname.lower().rstrip(".")
    if pattern.startswith("*."):
        return hostname.count(".") == pattern.count(".") and hostname.endswith(pattern[1:])
    return pattern == hostname


def timestamp(value):
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        return datetime.fromtimestamp(value, timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("certificate validity must include a timezone")
    return parsed


def eligible_certificate(cert, domains, region, account, now):
    expected = rf"arn:aws:acm:{re.escape(region)}:{re.escape(account)}:certificate/[0-9a-f-]{{36}}"
    if not re.fullmatch(expected, cert.get("CertificateArn", "")):
        return False
    if cert.get("Status") != "ISSUED" or cert.get("KeyAlgorithm") not in KEY_TYPES:
        return False
    if cert.get("Type") not in {"AMAZON_ISSUED", "IMPORTED"} or cert.get("CertificateAuthorityArn"):
        return False
    try:
        if not (timestamp(cert.get("NotBefore")) <= now
                and now + MIN_REMAINING < timestamp(cert.get("NotAfter"))):
            return False
    except (ValueError, TypeError, AttributeError, OverflowError):
        return False
    names = cert.get("SubjectAlternativeNames", [])
    return isinstance(names, list) and all(
        any(isinstance(name, str) and domain_matches(name, host) for name in names)
        for host in domains
    )


def aws(*arguments):
    result = subprocess.run(
        ["aws", *arguments, "--output", "json", "--no-cli-pager",
         "--cli-connect-timeout", "10", "--cli-read-timeout", "30"],
        check=True, capture_output=True, text=True, timeout=120,
    )
    return json.loads(result.stdout)


def verify_chain(pem, chain, domains):
    """Use the runner's public CA trust store; never accept a self-signed origin."""
    with tempfile.TemporaryDirectory(prefix="awsops-cert-check-") as directory:
        leaf = Path(directory) / "certificate.pem"
        intermediates = Path(directory) / "chain.pem"
        leaf.write_text(pem)
        intermediates.write_text(chain)
        for domain in domains:
            command = ["openssl", "verify", "-purpose", "sslserver", "-verify_hostname", domain]
            if chain:
                command += ["-untrusted", str(intermediates)]
            result = subprocess.run(
                [*command, str(leaf)], capture_output=True, text=True, timeout=15,
            )
            if result.returncode:
                return False
    return True


def find_certificate(domains, region, account, explicit_arn="", *, excluded=(), preferred_arn=""):
    if explicit_arn in excluded:
        raise ValueError("Certificate is Terraform-managed; leave its external ARN input unset (JSON null).")
    # An attached external certificate has priority over account-wide discovery.
    # Validate it just like an explicit ARN; do not rotate merely for a later expiry.
    if not explicit_arn and preferred_arn and preferred_arn not in excluded:
        try:
            return find_certificate(domains, region, account, preferred_arn, excluded=excluded)
        except ValueError:
            pass
    if explicit_arn:
        arns = [explicit_arn]
    else:
        response = aws(
            "acm", "list-certificates", "--region", region,
            "--certificate-statuses", "ISSUED",
            "--includes", json.dumps({"keyTypes": list(KEY_TYPES)}),
        )
        arns = [item["CertificateArn"] for item in response["CertificateSummaryList"]]
    candidates = []
    now = datetime.now(timezone.utc)
    for arn in arns:
        if arn in excluded:
            continue
        cert = aws("acm", "describe-certificate", "--region", region, "--certificate-arn", arn)["Certificate"]
        if eligible_certificate(cert, domains, region, account, now):
            candidates.append(cert)
    candidates.sort(key=lambda item: timestamp(item["NotAfter"]), reverse=True)
    for cert in candidates:
        response = aws(
            "acm", "get-certificate", "--region", region,
            "--certificate-arn", cert["CertificateArn"],
        )
        if verify_chain(response["Certificate"], response.get("CertificateChain", ""), domains):
            print(f"Verified certificate {cert['CertificateArn']} ({cert['KeyAlgorithm']}); "
                  f"expires {cert['NotAfter']}", file=sys.stderr)
            return cert["CertificateArn"]
    raise ValueError(
        f"No existing public, issued, matching certificate in {region} for {', '.join(domains)}; "
        "at least 24 hours of validity and a trusted chain are required. "
        "Supply an existing trusted certificate or defer HTTPS deployment; do not change validation DNS."
    )


def state_resources(state):
    """Read `terraform show -json` output, including the valid empty-state form."""
    if not isinstance(state, dict) or state.get("format_version") != "1.0":
        raise ValueError("invalid Terraform state JSON")
    if "values" not in state:
        if set(state) - {"format_version", "terraform_version"}:
            raise ValueError("invalid empty Terraform state JSON")
        return [], []
    values = state["values"]
    if not isinstance(values, dict) or not isinstance(values.get("root_module"), dict):
        raise ValueError("invalid Terraform state values")

    def walk(module):
        resources, children = module.get("resources", []), module.get("child_modules", [])
        if not isinstance(resources, list) or not isinstance(children, list):
            raise ValueError("invalid Terraform state module")
        result = []
        for resource in resources:
            if (not isinstance(resource, dict) or resource.get("mode") not in {"managed", "data"}
                    or not all(isinstance(resource.get(k), str) for k in ("address", "type", "name"))
                    or not isinstance(resource.get("values"), dict)):
                raise ValueError("invalid Terraform state resource")
            if resource["mode"] == "managed":
                result.append(resource)
        for child in children:
            if not isinstance(child, dict):
                raise ValueError("invalid Terraform state child module")
            result.extend(walk(child))
        return result

    root = values["root_module"]
    all_resources = walk(root)
    return [r for r in root.get("resources", []) if r["mode"] == "managed"], all_resources


def certificate_overrides(configuration, state, account, allow_dns, *, publish=True, scope="full"):
    """Preserve existing ownership/publication and return typed Terraform inputs."""
    domain, region = configuration["domain"], configuration["region"]
    aliases = configuration.get("aliases", [])
    if not isinstance(aliases, list):
        raise ValueError("configured aliases must be a list (not null)")
    domains = [domain, *aliases]
    if not all(
        isinstance(host, str) and len(host) <= 253
        and re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?", host)
        for host in domains
    ):
        raise ValueError("invalid configured DNS hostname")
    root, resources = state_resources(state)
    managed = {r["values"]["arn"] for r in resources if r["type"] == "aws_acm_certificate"}

    def own(kind, name):
        matches = [r["values"] for r in root if r["type"] == kind and r["name"] == name]
        if len(matches) > 1:
            raise ValueError(f"ambiguous Terraform state for {kind}.{name}")
        return matches[0] if matches else {}

    cf = own("aws_cloudfront_distribution", "main").get("viewer_certificate", [])
    cf_attached = cf[0].get("acm_certificate_arn", "") if cf else ""
    alb_attached = own("aws_lb_listener", "https").get("certificate_arn", "")
    result = {"publish_service_dns": publish if allow_dns else any(
        r["type"] == "aws_route53_record" and r["name"] == "alias" for r in root
    )}
    for key, hosts, certificate_region, attached in (
        ("cf", domains, "us-east-1", cf_attached),
        ("alb", [domain], region, alb_attached),
    ):
        configured = configuration.get(f"{key}_arn")
        current = own("aws_acm_certificate", key).get("arn")
        if configured in managed:
            raise ValueError(
                f"{key} certificate is Terraform-managed; remove the external ARN override "
                "and keep existing_*_certificate_arn as JSON null."
            )
        if not allow_dns and current and configured:
            raise ValueError(f"Cannot replace the managed {key} certificate while DNS changes are prohibited.")
        if configured:
            selected = find_certificate(hosts, certificate_region, account, configured, excluded=managed)
        elif not allow_dns and scope == "full":
            if current:
                # Verify availability without transferring ownership out of Terraform.
                find_certificate(hosts, certificate_region, account, current)
                selected = None
            else:
                selected = find_certificate(
                    hosts, certificate_region, account, excluded=managed, preferred_arn=attached,
                )
        else:
            selected = None  # Keep the original managed-certificate defaults.
        result[f"existing_{key}_certificate_arn"] = selected
    return result


def ecs_service_may_change_dns(change):
    """ECS task changes can write Cloud Map DNS without changing its resources."""
    for side in ("before", "after"):
        values = change.get(side)
        if values is None:  # Creation/deletion has no before/after value.
            continue
        if not isinstance(values, dict):
            return True
        registries = values.get("service_registries")
        if registries is not None and not (isinstance(registries, list) and not registries):
            return True
    unknown = change.get("after_unknown", {})
    if not isinstance(unknown, dict):
        return True
    registries_unknown = unknown.get("service_registries", False)
    # Only an absent/false marker or an empty mask proves there is no unknown
    # registry. Whole-object, nested and malformed unknown values fail closed.
    return not (registries_unknown is False
                or isinstance(registries_unknown, (list, dict)) and not registries_unknown)


def check_plan(plan, allow_dns, scope="full"):
    if not isinstance(plan, dict) or not isinstance(plan.get("planned_values"), dict) or not plan.get("format_version"):
        raise ValueError("invalid Terraform plan JSON")
    changes = plan.get("resource_changes", [])
    if not isinstance(changes, list):
        raise ValueError("invalid Terraform plan resource changes")
    dns_changes, mutations = [], 0
    for resource in changes:
        actions = resource["change"]["actions"]
        if not isinstance(actions, list) or not actions:
            raise ValueError("invalid Terraform plan actions")
        if actions in (["no-op"], ["read"]):
            continue
        mutations += 1
        if scope == "ecr-bootstrap" and resource["address"] != "aws_ecr_repository.web":
            raise ValueError("ECR bootstrap contains an unrelated mutation: " + resource["address"])
        if (resource["type"].startswith(("aws_route53", "aws_service_discovery"))
                or resource["type"] == "aws_ecs_service" and ecs_service_may_change_dns(resource["change"])):
            dns_changes.append(resource["address"])
    if dns_changes and not allow_dns:
        raise ValueError("DNS change prohibited: " + ", ".join(dns_changes))
    return {"changed_resources": mutations, "dns_changes": dns_changes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check-plan")
    check.add_argument("--allow-dns", choices=("true", "false"), required=True)
    check.add_argument("--scope", choices=("full", "ecr-bootstrap"), default="full")
    certificates = commands.add_parser("certificates")
    certificates.add_argument("--cf-arn", default="")
    certificates.add_argument("--alb-arn", default="")
    certificates.add_argument("--state", type=Path, required=True)
    certificates.add_argument("--allow-dns", choices=("true", "false"), required=True)
    certificates.add_argument("--publish", choices=("true", "false"), required=True)
    certificates.add_argument("--scope", choices=("full", "ecr-bootstrap"), required=True)
    args = parser.parse_args()
    try:
        value = json.load(sys.stdin)
        if args.command == "check-plan":
            print(json.dumps(check_plan(value, args.allow_dns == "true", args.scope)))
        else:
            # `terraform console` prints jsonencode's result as a quoted JSON string.
            configuration = json.loads(value) if isinstance(value, str) else value
            if args.cf_arn:
                configuration["cf_arn"] = args.cf_arn
            if args.alb_arn:
                configuration["alb_arn"] = args.alb_arn
            account = aws("sts", "get-caller-identity")["Account"]
            print(json.dumps(certificate_overrides(
                configuration, json.loads(args.state.read_text()), account,
                args.allow_dns == "true", publish=args.publish == "true", scope=args.scope,
            )))
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        print(f"Deployment preflight refused: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
