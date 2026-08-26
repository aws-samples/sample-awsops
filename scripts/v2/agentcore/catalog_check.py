#!/usr/bin/env python3
"""AWSops v2 AF1 — catalog consistency check.

Asserts the invariants for scripts/v2/agentcore/catalog.py:
  - every TARGETS `gateway` is a known GATEWAYS short-key;
  - every tool has a non-empty `name` and `description`;
  - every tool `inputSchema` is a dict with type == 'object';
  - NO tool carries `target_account_id` (provision.py injects it);
  - prints `OK` + the sorted set of lambda_keys (for cross-checking ai.tf agent_lambdas).

Exit non-zero on any failure.
"""
import sys

import catalog

GATEWAYS = set(catalog.GATEWAYS)
TARGETS = catalog.TARGETS

errors = []
lambda_keys = []

for target_name, entry in TARGETS.items():
    gw = entry.get("gateway")
    if gw not in GATEWAYS:
        errors.append(f"{target_name}: gateway '{gw}' not in GATEWAYS {sorted(GATEWAYS)}")

    lk = entry.get("lambda_key")
    if not lk:
        errors.append(f"{target_name}: missing/empty lambda_key")
    else:
        lambda_keys.append(lk)

    tools = entry.get("tools")
    if not isinstance(tools, list) or not tools:
        errors.append(f"{target_name}: tools must be a non-empty list")
        continue

    for tool in tools:
        name = tool.get("name")
        desc = tool.get("description")
        if not name:
            errors.append(f"{target_name}: a tool has empty 'name'")
        if not desc:
            errors.append(f"{target_name}/{name}: empty 'description'")

        schema = tool.get("inputSchema")
        if not isinstance(schema, dict):
            errors.append(f"{target_name}/{name}: inputSchema must be a dict")
            continue
        if schema.get("type") != "object":
            errors.append(f"{target_name}/{name}: inputSchema.type must be 'object'")

        props = schema.get("properties", {})
        if not isinstance(props, dict):
            errors.append(f"{target_name}/{name}: inputSchema.properties must be a dict")
            continue
        if "target_account_id" in props:
            errors.append(f"{target_name}/{name}: must NOT carry target_account_id (provision.py injects it)")

# lambda_keys must be unique across targets
seen = set()
for lk in lambda_keys:
    if lk in seen:
        errors.append(f"duplicate lambda_key '{lk}' across TARGETS")
    seen.add(lk)

if errors:
    print("FAIL")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)

print("OK")
print("lambda_keys:", sorted(set(lambda_keys)))
