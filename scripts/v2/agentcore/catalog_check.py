#!/usr/bin/env python3
"""AWSops v2 AF1 — catalog consistency check.

Asserts the invariants for scripts/v2/agentcore/catalog.py:
  - every TARGETS `gateway` is a known GATEWAYS short-key;
  - every tool has a non-empty `name` and `description`;
  - every tool `inputSchema` is a dict with type == 'object';
  - NO tool carries `target_account_id` (provision.py injects it);
  - (ADR-017) every MCP_SERVER_TARGETS `gateway` is a known GATEWAYS short-key, `preset_key` is
    unique, and `auth.mode` is one of "api_key"/"none" with the fields that mode requires;
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

# ADR-017 — MCP_SERVER_TARGETS invariants.
MCP_SERVER_TARGETS = catalog.MCP_SERVER_TARGETS
seen_preset_keys = set()
for target_name, entry in MCP_SERVER_TARGETS.items():
    # review MAJOR L3-2: agent.py's fail-closed allowlist gate (_MCP_SERVER_TARGET_MARKER =
    # "-mcp-server-target___") is a substring match on the target NAME, not on catalog membership —
    # it's the ONLY thing that stops a vendor's raw gateway tools from reaching the model unfiltered.
    # A future preset added under a differently-suffixed key would still get a tool_allowlist entry
    # written to OFFICIAL_MCP_TOOL_ALLOWLIST_JSON, but agent.py's runtime filter would never even
    # look at its tools — reopening exactly the CRITICAL this PR closed, via a naming typo instead of
    # a missing allowlist. Enforce the convention the runtime gate depends on.
    if not target_name.endswith("-mcp-server-target"):
        errors.append(f"{target_name}: MCP_SERVER_TARGETS key must end with '-mcp-server-target' — "
                       "agent.py's runtime allowlist gate matches gateway tool names on that exact "
                       "suffix (+ '___<tool>'); any other naming silently escapes the filter")

    gw = entry.get("gateway")
    if gw not in GATEWAYS:
        errors.append(f"{target_name}: gateway '{gw}' not in GATEWAYS {sorted(GATEWAYS)}")

    preset_key = entry.get("preset_key")
    if not preset_key:
        errors.append(f"{target_name}: missing/empty preset_key")
    elif preset_key in seen_preset_keys:
        errors.append(f"duplicate preset_key '{preset_key}' across MCP_SERVER_TARGETS")
    else:
        seen_preset_keys.add(preset_key)

    if not entry.get("description"):
        errors.append(f"{target_name}: missing/empty description")

    auth = entry.get("auth")
    if not isinstance(auth, dict) or auth.get("mode") not in ("api_key", "none"):
        errors.append(f"{target_name}: auth.mode must be 'api_key' or 'none'")
    elif auth["mode"] == "api_key":
        for field in ("credential_location", "credential_parameter_name"):
            if not auth.get(field):
                errors.append(f"{target_name}: auth.mode=api_key requires '{field}'")

    # ADR-017 amendment 2026-08-05: every preset MUST declare tool_allowlist (tuple/list of str;
    # empty = provision the target but expose zero tools). Absence would silently fail-closed at
    # the runtime anyway, but here it's a catalog bug — the field is the documented contract.
    ta = entry.get("tool_allowlist")
    if not isinstance(ta, (tuple, list)) or any(not isinstance(x, str) or not x for x in ta):
        errors.append(f"{target_name}: tool_allowlist must be a tuple/list of non-empty strings (empty tuple allowed)")

if errors:
    print("FAIL")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)

print("OK")
print("lambda_keys:", sorted(set(lambda_keys)))
