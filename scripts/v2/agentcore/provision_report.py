"""Bounded public diagnostics; only catalog keys, fixed codes and counts escape."""
import json
from collections import Counter

import catalog

STATUSES = {"CREATED", "EXISTS", "UPDATED", "ERR", "WARN", "SKIP", "WROTE",
            "DELETED", "RETIRED", "KEEP", "OK"}
STAGES = {"configuration", "identity", "gateways", "credentials", "lambda_targets",
          "runtime", "mcp_targets", "prune", "memory", "interpreter", "ssm", "smoke", "complete"}
CODES = {
    "operation_recorded", "operation_failed", "operation_skipped", "operation_warning",
    "runtime_allowlist_unconfirmed", "read_only_ack_required", "preset_disabled",
    "credentials_unavailable", "credential_missing", "credential_invalid", "superseded_by_preset",
    "legacy_lambda_retained", "endpoint_rejected", "readiness_timeout", "readiness_terminal",
    "invalid_wait_timeout", "invalid_dev_deployment", "actual_dev_caller_mismatch",
    "invalid_agent_image_digest", "agentcore_output_unavailable", "runtime_identity_unconfirmed",
    "aws_access_denied", "aws_credentials_expired", "aws_throttled", "aws_request_failed",
    "read_timeout", "invalid_json", "unexpected_error", "runtime_unavailable",
    "readiness_confirmed", "readiness_protocol_unavailable", "readiness_configuration_unavailable",
    "inventory_disabled", "inventory_configuration_unavailable", "legacy_invocation_only",
    "invoke_access_denied", "invoke_throttled", "invoke_credentials_expired", "invoke_timeout", "invoke_failed",
    "not_event_stream", "protocol_invalid", "response_identity_mismatch", "checks_failed",
    "disabled", "inventory_incomplete", "inventory_stale", "inventory_empty", "identity_failed", "account_mismatch",
    "gateway_unavailable", "tools_unavailable", "inventory_unavailable", "known_resource_missing", "known_resource_unverified",
    "model_failed", "timeout", "invalid_request", "response_close_failed",
}
_stage = "configuration"
_counts = Counter()
_emitted = 0
_dropped = 0
LIMIT = 240


def reset():
    global _stage, _counts, _emitted, _dropped
    _stage, _counts, _emitted, _dropped = "configuration", Counter(), 0, 0


def stage(name):
    global _stage
    _stage = name if name in STAGES else "unknown"
    print(json.dumps({"event": "agentcore_provision_stage", "stage": _stage}, sort_keys=True), flush=True)


def error_code(error):
    value = str(error)
    if value in CODES:
        return value
    response = getattr(error, "response", None)
    detail = response.get("Error") if isinstance(response, dict) else None
    code = detail.get("Code", "") if isinstance(detail, dict) else ""
    if code in ("AccessDenied", "AccessDeniedException", "UnauthorizedException"):
        return "aws_access_denied"
    if code in ("ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId"):
        return "aws_credentials_expired"
    if code in ("Throttling", "ThrottlingException", "TooManyRequestsException"):
        return "aws_throttled"
    if type(error).__name__ in ("ReadTimeoutError", "ConnectTimeoutError", "TimeoutExpired"):
        return "read_timeout"
    if type(error).__name__ == "JSONDecodeError":
        return "invalid_json"
    return "aws_request_failed" if code else "unexpected_error"


def _reason(status, detail):
    text = detail if isinstance(detail, str) else ""
    if text in CODES:
        return text
    for prefix, code in (
        ("runtime allowlist", "runtime_allowlist_unconfirmed"),
        ("official_mcp_read_only_ack", "read_only_ack_required"),
        ("read-only ack", "read_only_ack_required"),
        ("no endpoint configured", "preset_disabled"),
        ("could not read credentials secret", "credentials_unavailable"),
        ("no stored credential", "credential_missing"),
        ("superseded by", "superseded_by_preset"),
        ("lambda '", "legacy_lambda_retained"),
        ("timed out after", "readiness_timeout"),
        ("reached terminal status", "readiness_terminal"),
        ("AGENTCORE_RUNTIME_READY_TIMEOUT", "invalid_wait_timeout"),
        ("malformed JSON", "credential_invalid"),
        ("secret JSON is", "credential_invalid"),
    ):
        if text.startswith(prefix):
            return code
    if text.startswith("official_mcp_endpoints["):
        return "endpoint_rejected"
    for token, code in (("(AccessDenied", "aws_access_denied"), ("(ExpiredToken", "aws_credentials_expired"),
                        ("(Throttling", "aws_throttled"), ("(TooManyRequests", "aws_throttled")):
        if token in text:
            return code
    return {"ERR": "operation_failed", "WARN": "operation_warning", "SKIP": "operation_skipped"}.get(
        status, "operation_recorded")


def _resource(value):
    parts = value.split(":") if isinstance(value, str) else []
    if not parts:
        return "unknown", None
    kind, key = parts[0], parts[1] if len(parts) > 1 else None
    targets = set(catalog.TARGETS) | set(catalog.MCP_SERVER_TARGETS)
    if kind == "gateway" and key in catalog.GATEWAYS:
        return kind, key
    if kind in ("target", "prune") and key in targets:
        return "target", key
    if kind == "mcp-server-provider":
        providers = {f"awsops-v2-{spec['preset_key']}-mcp": spec["preset_key"]
                     for spec in catalog.MCP_SERVER_TARGETS.values()
                     if isinstance(spec, dict) and isinstance(spec.get("preset_key"), str)}
        return ("provider", providers[key]) if key in providers else ("provider", None)
    if kind == "ssm":
        name = value.rsplit("/", 1)[-1]
        return "ssm", name if name in ("runtime_arn", "interpreter_id", "memory_id") else None
    if kind == "mcp-server":
        return "credentials", None
    if kind == "smoke":
        return "operation", "smoke"
    if kind in ("runtime", "memory", "interpreter", "operation"):
        return kind, None
    return "unknown", None


def result(resource, status, detail):
    global _emitted, _dropped
    status = status if status in STATUSES else "ERR"
    _counts[status] = min(_counts[status] + 1, 1_000_000)
    if _emitted >= LIMIT:
        _dropped = min(_dropped + 1, 1_000_000)
        return
    kind, key = _resource(resource)
    print(json.dumps({"event": "agentcore_provision_result", "stage": _stage, "kind": kind,
                      "key": key, "status": status, "code": _reason(status, detail)}, sort_keys=True), flush=True)
    _emitted += 1


def summary():
    print(json.dumps({"event": "agentcore_provision_summary", "stage": _stage,
                      "counts": dict(_counts), "dropped": _dropped}, sort_keys=True), flush=True)
