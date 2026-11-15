"""Merge bounded, new dev datasource endpoints without rewriting protected tfvars."""
import json
import os
from pathlib import Path
import re
import sys

OUTPUT = Path("ci-privatelink.auto.tfvars.json")
MAX_BYTES = 32768
KINDS = {"clickhouse", "prometheus", "loki", "tempo", "mimir"}
FIELDS = {"kind", "service_name", "ports", "publish_dns"}
KEY = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?")
REGION = re.compile(r"[a-z]{2}(?:-[a-z]+)+-[1-9]")


def require(value):
    if not value:
        raise ValueError("invalid PrivateLink additions")


def unique(items):
    result = {}
    for key, value in items:
        require(key not in result)
        result[key] = value
    return result


def parse(value):
    require(len(value.encode("utf-8")) <= MAX_BYTES)
    return json.loads(value, object_pairs_hook=unique,
                      parse_constant=lambda _: require(False))


def validate(entries, region, *, additions):
    require(isinstance(entries, dict) and len(entries) <= (8 if additions else 32))
    for key, entry in entries.items():
        require(isinstance(key, str) and KEY.fullmatch(key))
        require(isinstance(entry, dict) and set(entry) <= FIELDS)
        require((FIELDS if additions else FIELDS - {"publish_dns"}) <= set(entry))
        require(isinstance(entry.get("kind"), str) and entry["kind"] in KINDS)
        name = entry.get("service_name")
        require(isinstance(name, str) and re.fullmatch(
            r"com\.amazonaws\.vpce\." + re.escape(region) + r"\.vpce-svc-[0-9a-f]{17}", name))
        ports = entry.get("ports")
        require(isinstance(ports, list) and 1 <= len(ports) <= 4)
        require(all(type(port) is int and 1 <= port <= 65535 for port in ports))
        require(len(set(ports)) == len(ports))
        require("publish_dns" not in entry or type(entry["publish_dns"]) is bool)


def merge_additions(existing, additions, region):
    require(isinstance(region, str) and REGION.fullmatch(region))
    validate(existing, region, additions=False)
    validate(additions, region, additions=True)
    require(not set(existing).intersection(additions))
    require(len(existing) + len(additions) <= 32)
    return {**existing, **additions}


def main():
    try:
        # Workflow also removes this before Terraform evaluates the base map.
        OUTPUT.unlink(missing_ok=True)
        value = os.environ.get("CI_PRIVATELINK_ADDITIONS_DEV", "")
        if not value.strip():
            print('{"configured": false}')
            return 0
        require(os.environ.get("TARGET") == "dev" and os.environ.get("PLAN_SCOPE") == "full")
        additions = parse(value)
        text = sys.stdin.buffer.read(MAX_BYTES + 1)
        require(len(text) <= MAX_BYTES)
        existing = parse(text.decode("utf-8"))
        if isinstance(existing, str):  # terraform console's quoted jsonencode result
            existing = parse(existing)
        merged = merge_additions(existing, additions, os.environ.get("AWS_REGION", ""))
        if additions:
            fd = os.open(OUTPUT, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as stream:
                json.dump({"privatelink_endpoints": merged}, stream, sort_keys=True)
                stream.write("\n")
        print(json.dumps({"configured": bool(additions), "added_count": len(additions)}))
        return 0
    except (ValueError, TypeError, OSError, UnicodeError, RecursionError):
        try:
            OUTPUT.unlink(missing_ok=True)
        except OSError:
            pass
        print("PrivateLink additions rejected; check dev/full scope and endpoint configuration.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
