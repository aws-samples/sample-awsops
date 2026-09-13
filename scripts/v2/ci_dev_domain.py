"""Offline dev input validation and allowlisted public-zone plan inspection."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import sys


OVERRIDE = Path("ci-domain.auto.tfvars.json")
LABEL = re.compile(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?")


def hostname(value, *, dns_response=False):
    if not isinstance(value, str):
        raise ValueError("invalid DNS hostname")
    # Provider DNS responses are absolute; operator inputs must be plain FQDNs.
    name = value[:-1] if dns_response and value.endswith(".") else value
    labels = name.split(".")
    if (len(name) > 253 or len(labels) < 2 or not all(LABEL.fullmatch(x) for x in labels)
            or not re.search(r"[a-zA-Z]", labels[-1])):
        raise ValueError("invalid DNS hostname")
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return name.lower()
    raise ValueError("DNS hostname must not be an IP address")


def domain_scope(domain, zone, aliases=()):
    domain, zone = hostname(domain), hostname(zone)
    if not isinstance(aliases, (list, tuple)):
        raise ValueError("configured aliases must be a list")
    hosts = {domain, *(hostname(alias) for alias in aliases)}
    if not all(host == zone or host.endswith("." + zone) for host in hosts):
        raise ValueError("domain and aliases must be inside the configured hosted zone")
    return hosts, zone


def dev_overrides(target, domain, zone, mode):
    if target != "dev":
        return {}, "preserve"
    mode = mode or "preserve"
    if mode not in {"preserve", "managed"}:
        raise ValueError("CERTIFICATE_MODE_DEV must be preserve or managed")
    if bool(domain) != bool(zone):
        raise ValueError("DOMAIN_NAME_DEV and HOSTED_ZONE_NAME_DEV must be set together")
    if not domain:
        return {}, mode
    domain_scope(domain, zone)
    return {"domain_name": hostname(domain), "hosted_zone_name": hostname(zone)}, mode


def plan_scope(plan):
    try:
        variables = plan["variables"]
        return domain_scope(variables["domain_name"]["value"],
                            variables["hosted_zone_name"]["value"],
                            variables["extra_domain_aliases"]["value"])
    except (KeyError, TypeError):
        raise ValueError("missing domain/zone/aliases in saved plan") from None


def plan_rollout(plan, target, scope):
    """Only the immutable saved plan decides whether domain scoping is active."""
    try:
        rollout = plan["variables"]["ci_domain_rollout"]["value"]
    except (KeyError, TypeError):
        raise ValueError("missing ci_domain_rollout in saved plan") from None
    if not isinstance(rollout, bool):
        raise ValueError("invalid ci_domain_rollout in saved plan")
    if rollout and (target != "dev" or scope != "full"):
        raise ValueError("ci_domain_rollout requires dev and full scope")
    return rollout


def zone_summary(plan):
    """Project only public delegation metadata, never state/configuration/outputs."""
    _, zone = plan_scope(plan)
    try:
        resources = plan["planned_values"]["root_module"].get("resources", [])
        if not isinstance(resources, list):
            raise ValueError("invalid planned resource collection")
        matches = [r for r in resources if r.get("address") == "data.aws_route53_zone.main"]
        if not matches:
            # Data already read during planning lives in the saved plan's
            # refreshed prior_state. Never substitute it for a deferred read.
            if any(r.get("address") == "data.aws_route53_zone.main"
                   for r in plan.get("resource_changes", [])):
                raise ValueError("selected public hosted zone read is not resolved")
            resources = plan.get("prior_state", {}).get("values", {}).get("root_module", {}).get("resources", [])
            if not isinstance(resources, list):
                raise ValueError("invalid prior resource collection")
            matches = [r for r in resources if r.get("address") == "data.aws_route53_zone.main"]
        if len(matches) != 1:
            raise ValueError("missing or ambiguous selected public hosted zone")
        resource = matches[0]
        values = resource["values"]
        if (resource.get("mode") != "data" or resource.get("type") != "aws_route53_zone"
                or values.get("private_zone") is not False
                or hostname(values.get("name"), dns_response=True) != zone):
            raise ValueError("selected public hosted zone does not match configured zone")
        zone_id = values.get("zone_id")
        if (not isinstance(zone_id, str) or not re.fullmatch(r"Z[A-Z0-9]+", zone_id)
                or values.get("id", zone_id) != zone_id):
            raise ValueError("missing or invalid selected hosted zone ID")
        servers = values.get("name_servers")
        if not isinstance(servers, list) or len(servers) != 4:
            raise ValueError("missing or ambiguous public hosted zone name_servers")
        servers = sorted({hostname(server, dns_response=True) for server in servers})
        if len(servers) != 4:
            raise ValueError("duplicate public hosted zone name_servers")
        return {"name": zone, "zone_id": zone_id, "name_servers": servers}
    except (KeyError, TypeError, AttributeError):
        raise ValueError("missing or invalid selected public hosted zone data") from None


def check_scoped_dns(plan, changes):
    """Dev DNS permission covers only this zone's service A / ACM CNAME owners."""
    hosts, _ = plan_scope(plan)
    zone = zone_summary(plan)
    for resource in changes:
        match = re.fullmatch(r'aws_route53_record\.(alias|cf_validation)\["([^"]+)"\]',
                             resource["address"])
        if resource["type"] != "aws_route53_record" or not match:
            raise ValueError("DNS change outside configured dev service/validation scope")
        host = hostname(match[2])
        if host not in hosts:
            raise ValueError("DNS change outside configured dev service/validation scope")
        change = resource["change"]
        for side in ("before", "after"):
            values = change.get(side)
            absent = side == "before" and change["actions"] == ["create"] or (
                side == "after" and change["actions"] == ["delete"])
            if values is None and absent:
                continue
            if not isinstance(values, dict) or values.get("zone_id") != zone["zone_id"]:
                raise ValueError("DNS change has missing/foreign hosted zone ID")
            kind = match[1]
            unknown = change.get("after_unknown", {}) if side == "after" else {}
            # ACM chooses a token only at creation. The reviewed cf_validation
            # resource's for_each domain key and zone must already be known.
            creation = side == "after" and change["actions"] == ["create"] and kind == "cf_validation"
            for field in ("name", "type", "records") if kind == "cf_validation" else ("name", "type"):
                value = values.get(field)
                if value is None and creation and isinstance(unknown, dict) and unknown.get(field) is True:
                    continue
                if (field == "records" and creation and value == [None]
                        and isinstance(unknown, dict) and unknown.get(field) == [True]):
                    continue
                if field == "name":
                    valid = (isinstance(value, str) and (
                        hostname(value, dns_response=True) == host if kind == "alias" else
                        re.fullmatch(r"_[A-Za-z0-9_-]{1,62}\." + re.escape(host) + r"\.?", value, re.I)
                    ))
                elif field == "type":
                    valid = value == ("A" if kind == "alias" else "CNAME")
                else:
                    valid = (isinstance(value, list) and len(value) == 1
                             and isinstance(value[0], str)
                             and len(value[0]) <= 254
                             and re.fullmatch(r"_[A-Za-z0-9_-]{1,62}\.(?:[A-Za-z0-9-]{1,63}\.)*"
                                              r"acm-validations\.aws\.?", value[0]))
                if not valid:
                    raise ValueError("DNS record does not match configured dev service/ACM validation")
    return zone


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("overrides", "zone-summary"))
    args = parser.parse_args()
    try:
        if args.command == "zone-summary":
            print(json.dumps(zone_summary(json.load(sys.stdin))))
        else:
            # Persistent runners must not let a previous run influence console.
            OVERRIDE.unlink(missing_ok=True)
            overrides, mode = dev_overrides(
                os.environ.get("TARGET", ""), os.environ.get("DOMAIN_NAME_DEV", ""),
                os.environ.get("HOSTED_ZONE_NAME_DEV", ""), os.environ.get("CERTIFICATE_MODE_DEV", ""),
            )
            rollout = os.environ.get("DOMAIN_ROLLOUT", "false")
            if rollout not in {"true", "false"}:
                raise ValueError("DOMAIN_ROLLOUT must be true or false")
            if rollout == "true" and (os.environ.get("TARGET") != "dev"
                                      or os.environ.get("PLAN_SCOPE", "full") != "full"):
                raise ValueError("ci_domain_rollout requires dev and full scope")
            overrides["ci_domain_rollout"] = rollout == "true"
            OVERRIDE.write_text(json.dumps(overrides) + "\n")
            if os.environ.get("GITHUB_OUTPUT"):
                with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                    output.write(f"certificate_mode={mode}\n")
    except (ValueError, OSError) as error:
        print(f"Dev domain preflight refused: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
