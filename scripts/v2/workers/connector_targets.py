"""Connector target sync: make a just-registered datasource kind callable from chat.

Registering a ClickHouse/Prometheus/Tempo/... datasource stores the endpoint in Aurora, but the
chat agent reaches connectors only through the external-obs AgentCore gateway, whose per-kind
targets were created by `make agentcore` (scripts/v2/agentcore/provision.py). A connector Lambda
created by a later Terraform apply therefore had no target until the next provision run.

This job creates or updates exactly one awsops-owned target (`<kind>-mcp-target`) on the
awsops-owned external-obs gateway, pointing at this stack's own connector Lambda. Scope (ADR-005
owner clarification 2026-11-04): create/update of awsops's own resources only. It never deletes,
never touches another gateway, and only accepts Lambda ARNs supplied by Terraform through
CONNECTOR_TARGET_LAMBDAS. The tool schema comes from the packaged provision catalog, so the target
is byte-identical to what provision.py would write.
"""
import copy
import json
import os
import re

GATEWAY_KEY = "external-obs"
GATEWAY_NAME = f"awsops-v2-{GATEWAY_KEY}-gateway"  # provision.ensure_gateways naming
_KIND = re.compile(r"[a-z][a-z0-9-]{1,30}")
_CREDS = [{"credentialProviderType": "GATEWAY_IAM_ROLE"}]


def _items(resp):
    for key in ("items", "gateways"):
        if key in resp:
            return resp[key]
    return []


def _list_all(list_fn, **kwargs):
    out, token = [], None
    while True:
        resp = list_fn(**{**kwargs, "nextToken": token}) if token else list_fn(**kwargs)
        out.extend(_items(resp))
        token = resp.get("nextToken")
        if not token:
            return out


def inject_account(tools):
    """Same transform as provision._inject_account (parity is unit-tested)."""
    out = []
    for tool in tools:
        tool = copy.deepcopy(tool)
        tool.setdefault("inputSchema", {}).setdefault("properties", {}).setdefault("target_account_id", {
            "type": "string",
            "description": "Target AWS account ID for cross-account access (12 digits). Only provide when instructed.",
        })
        out.append(tool)
    return out


def tool_fingerprint(tools):
    """Same projection as provision.tool_fingerprint (parity is unit-tested)."""
    return json.dumps(
        sorted(({"name": t.get("name"), "description": t.get("description"),
                 "inputSchema": t.get("inputSchema")} for t in tools),
               key=lambda t: t["name"] or ""),
        sort_keys=True, separators=(",", ":"))


def _connector_lambdas():
    try:
        value = json.loads(os.environ.get("CONNECTOR_TARGET_LAMBDAS", "{}"))
    except ValueError:
        return {}
    if not isinstance(value, dict):
        return {}
    return {k: v for k, v in value.items() if isinstance(k, str) and isinstance(v, str) and v.startswith("arn:aws:lambda:")}


def run(payload, ctrl=None, targets=None):
    """payload: {kind}. Returns {status, target?}; status in created/updated/exists/skipped/error."""
    if os.environ.get("CONNECTOR_TARGET_SYNC_ENABLED") != "true":
        return {"status": "skipped", "reason": "disabled"}
    kind = (payload or {}).get("kind")
    if not isinstance(kind, str) or not _KIND.fullmatch(kind):
        return {"status": "skipped", "reason": "invalid_kind"}
    if targets is None:
        import catalog  # packaged copy of scripts/v2/agentcore/catalog.py
        targets = catalog.TARGETS
    name = f"{kind}-mcp-target"
    spec = targets.get(name)
    if not spec or spec.get("gateway") != GATEWAY_KEY:
        return {"status": "skipped", "reason": "not_a_connector_kind"}
    lambda_arn = _connector_lambdas().get(spec["lambda_key"])
    if not lambda_arn:
        return {"status": "skipped", "reason": "connector_lambda_not_deployed"}
    if ctrl is None:
        import boto3
        ctrl = boto3.client("bedrock-agentcore-control")

    gateways = [g for g in _list_all(ctrl.list_gateways) if g.get("name") == GATEWAY_NAME]
    if len(gateways) != 1 or not isinstance(gateways[0].get("gatewayId"), str):
        return {"status": "error", "reason": "gateway_unavailable"}
    gw_id = gateways[0]["gatewayId"]
    tools = inject_account(spec["tools"])
    cfg = {"mcp": {"lambda": {"lambdaArn": lambda_arn, "toolSchema": {"inlinePayload": tools}}}}
    existing = {t.get("name"): t for t in _list_all(ctrl.list_gateway_targets, gatewayIdentifier=gw_id)}
    if name not in existing:
        ctrl.create_gateway_target(gatewayIdentifier=gw_id, name=name, description=spec["description"],
                                   targetConfiguration=cfg, credentialProviderConfigurations=_CREDS)
        return {"status": "created", "target": name}
    target_id = existing[name]["targetId"]
    current = ctrl.get_gateway_target(gatewayIdentifier=gw_id, targetId=target_id)
    current_lambda = current.get("targetConfiguration", {}).get("mcp", {}).get("lambda", {})
    credential_types = [c.get("credentialProviderType")
                        for c in (current.get("credentialProviderConfigurations") or [])]
    if (current_lambda.get("lambdaArn") == lambda_arn and credential_types == ["GATEWAY_IAM_ROLE"]
            and tool_fingerprint(current_lambda.get("toolSchema", {}).get("inlinePayload", []))
            == tool_fingerprint(tools)):
        return {"status": "exists", "target": name}
    # The gateway name is account-wide, so another awsops stack in the same account may own this
    # target. Re-point only a target that already invokes one of THIS stack's connector Lambdas.
    own = set(_connector_lambdas().values())
    if current_lambda.get("lambdaArn") not in own:
        return {"status": "skipped", "reason": "target_owned_by_another_stack", "target": name}
    preserve ={field: copy.deepcopy(current[field]) for field in ("metadataConfiguration", "privateEndpoint")
                if current.get(field) is not None}
    ctrl.update_gateway_target(gatewayIdentifier=gw_id, targetId=target_id, name=name,
                               description=spec["description"], targetConfiguration=cfg,
                               credentialProviderConfigurations=_CREDS, **preserve)
    return {"status": "updated", "target": name}
