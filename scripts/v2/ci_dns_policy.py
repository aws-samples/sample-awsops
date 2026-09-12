"""Read-only certificate discovery and a DNS mutation gate for deployment plans."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


KEY_TYPES = ("RSA_2048", "RSA_3072", "RSA_4096", "EC_prime256v1")


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
        if not timestamp(cert.get("NotBefore")) <= now < timestamp(cert.get("NotAfter")):
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


def find_certificate(domains, region, account, explicit_arn=""):
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
            return cert["CertificateArn"]
    raise ValueError(
        f"No existing public, issued, matching certificate in {region} for {', '.join(domains)}; "
        "DNS changes remain prohibited. Supply an existing trusted certificate or defer HTTPS deployment."
    )


def check_plan(plan, allow_dns):
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
        if resource["type"].startswith("aws_route53") or resource["type"] in {
            "aws_service_discovery_private_dns_namespace", "aws_service_discovery_public_dns_namespace",
        }:
            dns_changes.append(resource["address"])
    if dns_changes and not allow_dns:
        raise ValueError("DNS change prohibited: " + ", ".join(dns_changes))
    return {"changed_resources": mutations, "dns_changes": dns_changes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check-plan")
    check.add_argument("--allow-dns", choices=("true", "false"), required=True)
    certificates = commands.add_parser("certificates")
    certificates.add_argument("--cf-arn", default="")
    certificates.add_argument("--alb-arn", default="")
    args = parser.parse_args()
    try:
        value = json.load(sys.stdin)
        if args.command == "check-plan":
            print(json.dumps(check_plan(value, args.allow_dns == "true")))
        else:
            # `terraform console` prints jsonencode's result as a quoted JSON string.
            configuration = json.loads(value) if isinstance(value, str) else value
            domain, region = configuration["domain"], configuration["region"]
            domains = [domain, *configuration.get("aliases", [])]
            if not all(
                isinstance(host, str) and len(host) <= 253
                and re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?", host)
                for host in domains
            ):
                raise ValueError("invalid configured DNS hostname")
            account = aws("sts", "get-caller-identity")["Account"]
            cf = find_certificate(
                domains, "us-east-1", account, args.cf_arn or configuration.get("cf_arn") or "",
            )
            alb = find_certificate(
                [domain], region, account, args.alb_arn or configuration.get("alb_arn") or "",
            )
            print(f"cf_certificate_arn={cf}\nalb_certificate_arn={alb}")
    except (ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"Deployment preflight refused: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
