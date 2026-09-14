"""Read-only verification of selected certificates and deployment DNS/ownership gates."""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from ci_dev_domain import check_scoped_dns, domain_scope, hostname, plan_rollout, plan_scope, zone_summary


# CloudFront supports RSA through 4096 and ECDSA P-256/P-384; retain an RSA 2048 floor.
# https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html
# ACM's API model lists underscore enums, while describe-certificate CLI output
# also uses hyphens (e.g. RSA-2048). Accept both spellings of the same RSA sizes.
# https://docs.aws.amazon.com/acm/latest/APIReference/API_CertificateDetail.html
# https://docs.aws.amazon.com/cli/latest/reference/acm/describe-certificate.html
KEY_TYPES = ("RSA_2048", "RSA_3072", "RSA_4096", "RSA-2048", "RSA-3072", "RSA-4096",
             "EC_prime256v1", "EC_secp384r1")
MIN_REMAINING = timedelta(hours=24)
CERTIFICATE_ARN = re.compile(
    r"arn:aws:acm:([a-z]{2}(?:-[a-z]+)+-[0-9]):([0-9]{12}):certificate/"
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)
PUBLISHED_DOMAIN_CHANGE = (
    "Published old-domain rollout is unsupported; use a separate expressly "
    "authorized retirement plan under the old configuration."
)


def validate_arn(arn, region=None, account=None):
    match = CERTIFICATE_ARN.fullmatch(arn) if isinstance(arn, str) else None
    if (not match or region is not None and match[1] != region
            or account is not None and match[2] != account):
        raise ValueError("Invalid certificate ARN shape, deployment account or Region.")


def certificate_label(arn):
    if arn is None:
        return "managed"
    validate_arn(arn)
    return "external:" + arn[-8:]


def deployment_summary(inputs):
    """Never copy account-bearing inputs into a public Actions summary."""
    return {
        "publish_service_dns": inputs["publish_service_dns"],
        **{key: certificate_label(inputs[f"existing_{key}_certificate_arn"]) for key in ("cf", "alb")},
    }


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


def certificate_problem(cert, domains, region, account, now):
    """Return only fixed diagnostic text; never echo unrelated ACM metadata."""
    try:
        validate_arn(cert.get("CertificateArn"), region, account)
    except ValueError:
        return "certificate ARN does not match the deployment account or Region"
    if cert.get("Status") != "ISSUED":
        return "certificate status is not ISSUED"
    if cert.get("KeyAlgorithm") not in KEY_TYPES:
        return "unsupported key algorithm"
    if cert.get("Type") not in {"AMAZON_ISSUED", "IMPORTED"} or cert.get("CertificateAuthorityArn"):
        return "not a public certificate"
    try:
        if timestamp(cert.get("NotBefore")) > now:
            return "certificate is not yet valid"
        if now + MIN_REMAINING >= timestamp(cert.get("NotAfter")):
            return "remaining validity is 24 hours or less"
    except (ValueError, TypeError, AttributeError, OverflowError):
        return "missing or invalid validity timestamps"
    names = cert.get("SubjectAlternativeNames", [])
    if not (isinstance(names, list) and all(
        any(isinstance(name, str) and domain_matches(name, host) for name in names)
        for host in domains
    )):
        return "SAN coverage does not include all configured hostnames"
    return None


def eligible_certificate(cert, domains, region, account, now):
    return certificate_problem(cert, domains, region, account, now) is None


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
    # Selection is an operator decision. An already attached external certificate
    # is the only implicit choice; never scan or fall back to another certificate.
    arn = explicit_arn or preferred_arn
    if not arn:
        raise ValueError(
            f"An explicit existing certificate ARN is required for {region}; "
            "no external certificate is attached. Supply the operator-selected ARN "
            "or defer HTTPS deployment; do not change validation DNS."
        )
    validate_arn(arn, region, account)
    if arn in excluded:
        raise ValueError("Certificate is Terraform-managed; leave its external ARN input unset (JSON null).")
    cert = aws("acm", "describe-certificate", "--region", region, "--certificate-arn", arn)["Certificate"]
    problem = ("ACM returned a different certificate" if cert.get("CertificateArn") != arn else
               certificate_problem(cert, domains, region, account, datetime.now(timezone.utc)))
    if problem is None:
        response = aws(
            "acm", "get-certificate", "--region", region, "--certificate-arn", arn,
        )
        if verify_chain(response["Certificate"], response.get("CertificateChain") or "", domains):
            print(f"Verified certificate suffix {arn[-8:]} ({cert['KeyAlgorithm']}); "
                  f"expires {cert['NotAfter']}", file=sys.stderr)
            return arn
        problem = "public trust or TLS hostname verification failed"
    raise ValueError(
        f"Selected certificate rejected in {region} for {', '.join(domains)}: {problem}. "
        "Resolve the selected certificate's availability or defer HTTPS deployment; "
        "do not change validation DNS."
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


def certificate_overrides(configuration, state, account, allow_dns, *, publish=True, scope="full",
                          certificate_mode="preserve", advisory=False, target=""):
    """Preserve existing ownership/publication and return typed Terraform inputs."""
    domain, region = configuration["domain"], configuration["region"]
    aliases = configuration.get("aliases", [])
    if not isinstance(aliases, list):
        raise ValueError("configured aliases must be a list (not null)")
    domains = [domain, *aliases]
    for host in domains:
        hostname(host)
    if certificate_mode not in {"preserve", "managed"}:
        raise ValueError("invalid certificate mode")
    if certificate_mode == "managed" and any(configuration.get(f"{key}_arn") is not None for key in ("cf", "alb")):
        raise ValueError("managed mode conflicts with supplied existing certificate ARN inputs")
    root, resources = state_resources(state)
    managed = {r["values"]["arn"] for r in resources if r["type"] == "aws_acm_certificate"}
    if not advisory and scope == "full" and (target == "dev" or configuration.get("domain_rollout")):
        published = [r for r in root if r["type"] == "aws_route53_record" and r["name"] == "alias"]
        if published:
            hosts, zone = domain_scope(domain, configuration["zone"], aliases)
            # Console already includes dev overrides, even without rollout.
            # A same-name zone move also retires the published old record.
            zones = [r["values"] for r in state["values"]["root_module"].get("resources", [])
                     if r["address"] == "data.aws_route53_zone.main"]
            if (any(hostname(r["values"].get("name"), dns_response=True) not in hosts for r in published)
                    or any(hostname(z.get("name"), dns_response=True) != zone for z in zones)):
                raise ValueError(PUBLISHED_DOMAIN_CHANGE)

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
    # An ECR-only saved plan cannot mutate certificates; check_plan enforces
    # its sole-resource allowlist again before apply.
    if not advisory and certificate_mode == "managed" and scope not in {"ecr-bootstrap", "runtime-ecr-bootstrap"} and any(
        not own("aws_acm_certificate", key).get("arn") for key in ("cf", "alb")
    ):
        if scope != "full" or not allow_dns:
            raise ValueError("First managed certificate creation/conversion requires a full plan with DNS permission")
    # Validate both ownership choices before looking up either certificate.
    for key in ("cf", "alb"):
        configured = configuration.get(f"{key}_arn")
        if configured in managed:
            raise ValueError(
                f"{key} certificate is Terraform-managed; remove the external ARN override "
                "and keep existing_*_certificate_arn as JSON null."
            )
        if own("aws_acm_certificate", key).get("arn") and configured:
            raise ValueError(
                f"Cannot externalize the managed {key} certificate in routine CI; "
                "a separately reviewed ownership migration is required, even when DNS is allowed."
            )
    for key, hosts, certificate_region, attached in (
        ("cf", domains, "us-east-1", cf_attached),
        ("alb", [domain], region, alb_attached),
    ):
        configured = configuration.get(f"{key}_arn")
        current = own("aws_acm_certificate", key).get("arn")
        if advisory:
            # Advisory plans retain ownership without an ACM/SAN/trust gate.
            # They are never apply-eligible; dispatch preflight verifies live TLS.
            selected = configured or (None if current or certificate_mode == "managed" else attached or None)
        elif configured:
            selected = find_certificate(hosts, certificate_region, account, configured, excluded=managed)
        elif current:
            if not allow_dns and scope == "full":
                # Verify availability without transferring ownership out of Terraform.
                try:
                    find_certificate(hosts, certificate_region, account, current)
                except ValueError as error:
                    raise ValueError(
                        f"Managed {key} certificate unavailable: {error} "
                        "Keep its external ARN input null; ownership migration is a separate operation."
                    ) from error
            selected = None
        elif certificate_mode == "managed":
            selected = None  # External attachments remain externally owned; never delete/revoke them.
        elif attached or not allow_dns and scope == "full":
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


def check_plan(plan, allow_dns, scope="full", *, target="", advisory=False):
    if scope == "runtime-ecr-bootstrap" and target != "dev":
        raise ValueError("Runtime ECR bootstrap is dev-only")
    if not isinstance(plan, dict) or not isinstance(plan.get("planned_values"), dict) or not plan.get("format_version"):
        raise ValueError("invalid Terraform plan JSON")
    rollout = plan_rollout(plan, target, scope)
    changes = plan.get("resource_changes", [])
    if not isinstance(changes, list):
        raise ValueError("invalid Terraform plan resource changes")
    dns_changes, scoped_changes, mutations = [], [], 0
    for resource in changes:
        if (not isinstance(resource, dict)
                or not all(isinstance(resource.get(k), str) and resource[k] for k in ("address", "type"))
                or not isinstance(resource.get("change"), dict)):
            raise ValueError("invalid Terraform plan resource")
        actions = resource["change"].get("actions")
        if (not isinstance(actions, list) or not actions
                or not all(isinstance(action, str) and action in
                           {"no-op", "read", "create", "update", "delete", "forget"} for action in actions)):
            raise ValueError("invalid Terraform plan actions")
        if actions in (["no-op"], ["read"]):
            continue
        if (target == "dev" and resource["type"] == "aws_acm_certificate"
                and actions == ["create"] and resource["change"].get("before") is None
                and (not allow_dns or scope != "full")):
            raise ValueError("First managed certificate creation/conversion requires a full plan with DNS permission")
        # ACM renewal can depend on account-shared validation tokens long after a
        # cutover. DNS permission does not authorize retirement of owned CNAMEs.
        if (resource["type"] == "aws_route53_record"
                and re.search(r"(?:^|\.)aws_route53_record\.cf_validation(?:\[|$)", resource["address"])
                and ("delete" in actions or "forget" in actions)):
            raise ValueError(
                "Validation CNAME retirement/replacement requires a separately reviewed retirement: "
                + resource["address"]
            )
        if (resource["type"] == "aws_acm_certificate"
                and re.fullmatch(r"aws_acm_certificate\.(cf|alb)(?:\[0\])?", resource["address"])
                and ("forget" in actions or "delete" in actions and "create" not in actions)):
            raise ValueError(
                "Managed certificate retirement requires a separately reviewed ownership migration: "
                + resource["address"]
            )
        mutations += 1
        if scope == "ecr-bootstrap" and resource["address"] != "aws_ecr_repository.web":
            raise ValueError("ECR bootstrap contains an unrelated mutation: " + resource["address"])
        if scope == "runtime-ecr-bootstrap" and resource["address"] not in {
            "aws_ecr_repository.steampipe[0]", "aws_ecr_repository.agentcore[0]", "aws_ecr_repository.worker[0]",
        }:
            raise ValueError("Runtime ECR bootstrap contains an unrelated mutation: " + resource["address"])
        if (resource["type"].startswith(("aws_route53", "aws_service_discovery"))
                or resource["type"] == "aws_ecs_service" and ecs_service_may_change_dns(resource["change"])):
            dns_changes.append(resource["address"])
            scoped_changes.append(resource)
    if dns_changes and not allow_dns:
        raise ValueError("DNS change prohibited: " + ", ".join(dns_changes))
    if target == "dev" and not advisory:
        # Derive protection from actual alias mutations and immutable plan
        # names/zone, never a rollout opt-in or current repository variables.
        for resource in scoped_changes:
            if (resource["type"] == "aws_route53_record"
                    and re.fullmatch(r'aws_route53_record\.alias\["[^"]+"\]', resource["address"])
                    and resource["change"]["actions"] != ["create"]):
                hosts, _ = plan_scope(plan)
                before = resource["change"].get("before")
                if (not isinstance(before, dict)
                        or hostname(before.get("name"), dns_response=True) not in hosts
                        or before.get("zone_id") != zone_summary(plan)["zone_id"]):
                    raise ValueError(PUBLISHED_DOMAIN_CHANGE)
    result = {"changed_resources": mutations, "dns_changes": dns_changes}
    if rollout:
        result["public_zone"] = check_scoped_dns(plan, scoped_changes)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("summary")
    check = commands.add_parser("check-plan")
    check.add_argument("--allow-dns", choices=("true", "false"), required=True)
    check.add_argument("--scope", choices=("full", "ecr-bootstrap", "runtime-ecr-bootstrap"), default="full")
    check.add_argument("--target", default="")
    check.add_argument("--advisory", choices=("true", "false"), default="false")
    certificates = commands.add_parser("certificates")
    certificates.add_argument("--cf-arn", default="")
    certificates.add_argument("--alb-arn", default="")
    certificates.add_argument("--state", type=Path, required=True)
    certificates.add_argument("--allow-dns", choices=("true", "false"), required=True)
    certificates.add_argument("--publish", choices=("true", "false"), required=True)
    certificates.add_argument("--scope", choices=("full", "ecr-bootstrap", "runtime-ecr-bootstrap"), required=True)
    certificates.add_argument("--certificate-mode", choices=("preserve", "managed"), default="preserve")
    certificates.add_argument("--target", default="")
    certificates.add_argument("--advisory", choices=("true", "false"), default="false")
    args = parser.parse_args()
    try:
        value = json.load(sys.stdin)
        if args.command == "summary":
            print(json.dumps(deployment_summary(value)))
        elif args.command == "check-plan":
            print(json.dumps(check_plan(value, args.allow_dns == "true", args.scope,
                                        target=args.target, advisory=args.advisory == "true")))
        else:
            # `terraform console` prints jsonencode's result as a quoted JSON string.
            configuration = json.loads(value) if isinstance(value, str) else value
            if args.cf_arn:
                configuration["cf_arn"] = args.cf_arn
            if args.alb_arn:
                configuration["alb_arn"] = args.alb_arn
            mode = args.certificate_mode if args.target == "dev" else "preserve"
            if configuration.get("domain_rollout"):
                domain_scope(configuration["domain"], configuration["zone"], configuration.get("aliases", []))
            if mode == "managed" and any(configuration.get(f"{key}_arn") is not None for key in ("cf", "alb")):
                raise ValueError("managed mode conflicts with supplied existing certificate ARN inputs")
            # Reject malformed inputs before even calling STS, including tfvars inputs.
            for key, region in (("cf", "us-east-1"), ("alb", configuration["region"])):
                if configuration.get(f"{key}_arn"):
                    validate_arn(configuration[f"{key}_arn"], region)
            advisory = args.advisory == "true"
            account = "" if advisory else aws("sts", "get-caller-identity")["Account"]
            print(json.dumps(certificate_overrides(
                configuration, json.loads(args.state.read_text()), account,
                args.allow_dns == "true", publish=args.publish == "true", scope=args.scope,
                certificate_mode=mode, advisory=advisory, target=args.target,
            )))
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        print(f"Deployment preflight refused: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
