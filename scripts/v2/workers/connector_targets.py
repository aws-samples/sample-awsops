"""Connector target sync: make a just-registered datasource kind callable from chat.

Registering a ClickHouse/Prometheus/Tempo/... datasource stores the endpoint in Aurora, but the
chat agent reaches connectors only through AgentCore gateways, whose per-kind
targets were created by `make agentcore` (scripts/v2/agentcore/provision.py). A connector Lambda
created by a later Terraform apply therefore had no target until the next provision run.

The job first confirms via GetGateway that the catalog gateway runs as this stack's AgentCore role
(CONNECTOR_TARGET_GATEWAY_ROLE_ARN) with AWS_IAM inbound auth, and skips without writing otherwise.
It then creates or updates exactly one awsops-owned target (`<kind>-mcp-target`) on the catalog
gateway for that kind (external-obs for ClickHouse/Prometheus; monitoring for Loki/Tempo/Mimir),
pointing at this stack's own connector Lambda. Vendor MCP presets (Datadog/Dynatrace) stay owned by
provision.ensure_mcp_server_targets, and Jaeger has no chat target, so they are out of scope. Scope (ADR-005
owner-override exception 2026-11-04, the second after ADR-015): create/update of awsops's own resources only. It never deletes,
only writes those two awsops gateways, and only accepts Lambda ARNs supplied by Terraform through
CONNECTOR_TARGET_LAMBDAS. The tool schema comes from the packaged provision catalog, so the target
is byte-identical to what provision.py would write. It runs as the dedicated
`<project>-connector-target-sync` function, whose role alone holds the gateway-target grant; the
worker job only invokes it.
"""
import copy
import json
import os
import re

GATEWAY_KEYS = ("external-obs", "monitoring")
# Write ceiling pinned in code (not only via the CONNECTOR_TARGET_LAMBDAS env map).
CONNECTOR_KINDS = ("clickhouse", "prometheus", "loki", "tempo", "mimir")


def gateway_name(key):
    return f"awsops-v2-{key}-gateway"  # provision.ensure_gateways naming
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


def _log(result):
    """One CloudWatch line per outcome; status/reason/target/gateway/kind only (no ARNs)."""
    fields = {k: result[k] for k in ("status", "reason", "target", "gateway", "kind") if k in result}
    print(json.dumps({"connector_target_sync": fields}, sort_keys=True))


def _expected_gateway_role():
    value = os.environ.get("CONNECTOR_TARGET_GATEWAY_ROLE_ARN")
    return value if isinstance(value, str) and value.startswith("arn:aws:iam::") else None


def run(payload, ctrl=None, targets=None):
    """payload: {kind}. Returns {status, target?}; status in created/updated/exists/skipped.

    Raises RuntimeError when the catalog gateway is missing or ambiguous so the job is marked failed.
    """
    kind = (payload or {}).get("kind")
    kind = kind if isinstance(kind, str) and _KIND.fullmatch(kind) else None  # log only well-formed kinds
    try:
        result = _run(payload, ctrl, targets)
    except Exception as error:
        fields = getattr(error, "log_fields", None)
        if not isinstance(fields, dict):
            reason = str(error).split(":")[0] if isinstance(error, RuntimeError) else type(error).__name__
            fields = {"status": "failed", "reason": reason or type(error).__name__}
        if kind is not None and "kind" not in fields:
            fields = {**fields, "kind": kind}
        _log(fields)
        raise
    logged = result if kind is None or "kind" in result else {**result, "kind": kind}
    _log(logged)
    return result


def _failure(reason, detail, **fields):
    """RuntimeError carrying the failed-outcome log fields; run() logs them once and re-raises."""
    error = RuntimeError(f"{reason}: {detail}")
    error.log_fields = {"status": "failed", "reason": reason, **fields}
    return error


def _run(payload, ctrl, targets):
    if os.environ.get("CONNECTOR_TARGET_SYNC_ENABLED") != "true":
        return {"status": "skipped", "reason": "disabled"}
    kind = (payload or {}).get("kind")
    if not isinstance(kind, str) or not _KIND.fullmatch(kind):
        return {"status": "skipped", "reason": "invalid_kind"}
    if kind not in CONNECTOR_KINDS:
        return {"status": "skipped", "reason": "not_a_connector_kind", "kind": kind}
    if targets is None:
        import catalog  # packaged copy of scripts/v2/agentcore/catalog.py
        targets = catalog.TARGETS
    name = f"{kind}-mcp-target"
    spec = targets.get(name)
    if not spec or spec.get("gateway") not in GATEWAY_KEYS:
        return {"status": "skipped", "reason": "not_a_connector_kind"}
    lambda_arn = _connector_lambdas().get(spec["lambda_key"])
    if not lambda_arn:
        return {"status": "skipped", "reason": "connector_lambda_not_deployed"}
    if ctrl is None:
        import boto3
        ctrl = boto3.client("bedrock-agentcore-control", region_name=os.environ.get("AWS_REGION"))

    gw_name = gateway_name(spec["gateway"])
    gateways = [g for g in _list_all(ctrl.list_gateways) if g.get("name") == gw_name]
    if len(gateways) != 1 or not isinstance(gateways[0].get("gatewayId"), str):
        raise _failure("gateway_unavailable", gw_name, gateway=gw_name, kind=kind)
    gw_id = gateways[0]["gatewayId"]
    # The gateway name is account-wide: write only to a gateway that runs as THIS stack's AgentCore
    # role with AWS_IAM inbound auth (never auto-replace a NONE-auth gateway; see provision.ensure_gateways).
    expected_role = _expected_gateway_role()
    if not expected_role:
        return {"status": "skipped", "reason": "gateway_role_unknown", "gateway": gw_name}
    gw = ctrl.get_gateway(gatewayIdentifier=gw_id)
    if gw.get("roleArn") != expected_role:
        return {"status": "skipped", "reason": "gateway_owned_by_another_stack", "gateway": gw_name}
    if gw.get("authorizerType") != "AWS_IAM":
        return {"status": "skipped", "reason": "gateway_auth_not_iam", "gateway": gw_name}
    tools = inject_account(spec["tools"])
    cfg = {"mcp": {"lambda": {"lambdaArn": lambda_arn, "toolSchema": {"inlinePayload": tools}}}}
    existing = {t.get("name"): t for t in _list_all(ctrl.list_gateway_targets, gatewayIdentifier=gw_id)}
    if name not in existing:
        try:
            ctrl.create_gateway_target(gatewayIdentifier=gw_id, name=name, description=spec["description"],
                                       targetConfiguration=cfg, credentialProviderConfigurations=_CREDS)
        except Exception as error:
            code = (getattr(error, "response", None) or {}).get("Error", {}).get("Code")
            if code == "ConflictException":
                # Confirm the concurrent create actually produced this target before reporting it.
                relisted = _list_all(ctrl.list_gateway_targets, gatewayIdentifier=gw_id)
                if any(t.get("name") == name for t in relisted):
                    return {"status": "exists", "reason": "concurrent_create", "target": name}
            raise
        return {"status": "created", "target": name}
    target_id = existing[name].get("targetId")
    if not isinstance(target_id, str):
        raise _failure("target_id_missing", name, target=name, gateway=gw_name, kind=kind)
    current = ctrl.get_gateway_target(gatewayIdentifier=gw_id, targetId=target_id)
    current_lambda = current.get("targetConfiguration", {}).get("mcp", {}).get("lambda", {})
    credential_types = [c.get("credentialProviderType")
                        for c in (current.get("credentialProviderConfigurations") or [])]
    if (current_lambda.get("lambdaArn") == lambda_arn and credential_types == ["GATEWAY_IAM_ROLE"]
            and tool_fingerprint(current_lambda.get("toolSchema", {}).get("inlinePayload", []))
            == tool_fingerprint(tools)):
        return {"status": "exists", "target": name}
    # The gateway name is account-wide, so another awsops stack in the same account may own this
    # target. Update only a target that already invokes THIS kind's own connector Lambda; a target
    # pointing at another of this stack's connector Lambdas is left alone too (never cross-re-pointed).
    own = set(_connector_lambdas().values())
    if current_lambda.get("lambdaArn") not in own:
        return {"status": "skipped", "reason": "target_owned_by_another_stack", "target": name}
    if current_lambda.get("lambdaArn") != lambda_arn:
        return {"status": "skipped", "reason": "target_points_at_another_connector", "target": name}
    preserve = {field: copy.deepcopy(current[field]) for field in ("metadataConfiguration", "privateEndpoint")
                 if current.get(field) is not None}
    ctrl.update_gateway_target(gatewayIdentifier=gw_id, targetId=target_id, name=name,
                               description=spec["description"], targetConfiguration=cfg,
                               credentialProviderConfigurations=_CREDS, **preserve)
    return {"status": "updated", "target": name}


def lambda_handler(event, _context):
    """Dedicated connector-target-sync function entry point (its own IAM role holds the gateway grant)."""
    return run(event if isinstance(event, dict) else {})
