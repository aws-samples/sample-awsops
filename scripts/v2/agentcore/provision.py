#!/usr/bin/env python3
"""AWSops v2 P1f — idempotent AgentCore provisioner.

Reads `terraform -chdir=terraform/foundation output -json` -> ensures Runtime,
9 Gateways, the slice Targets, Memory, Code Interpreter exist (list->create/update),
writes ARNs to SSM, prints a diff/no-op report.

  python3 scripts/v2/agentcore/provision.py          # provision (idempotent)
  python3 scripts/v2/agentcore/provision.py --smoke   # provision + invoke runtime via 1 gateway

Run from the repo root (so `terraform -chdir=...` resolves) AFTER `terraform apply`.
"""
import argparse
import copy
import ipaddress
import json
import os
import subprocess
import sys
import time
from urllib.parse import urlparse

import boto3
from botocore.exceptions import ClientError

import catalog  # same directory

TFDIR = "terraform/foundation"
RUNTIME_NAME = "awsops_v2_agent"                 # underscores only
MEMORY_NAME = "awsops_v2_memory"                 # underscores only
INTERPRETER_NAME = "awsops_v2_code_interpreter"  # underscores only
IMAGE_TAG = os.environ.get("AGENT_IMAGE_TAG", "agent-latest")  # keep in sync with agentcore.mjs push tag

report = []  # (resource, status, detail)


def log(resource, status, detail=""):
    report.append((resource, status, detail))
    print(f"  [{status:8}] {resource}  {detail}")


def tf_outputs():
    raw = subprocess.check_output(["terraform", f"-chdir={TFDIR}", "output", "-json"], text=True)
    data = json.loads(raw)
    if "agentcore" not in data or data["agentcore"]["value"] is None:
        sys.exit("agentcore output is null — set agentcore_enabled=true and `terraform apply` first.")
    return data["agentcore"]["value"]


def _items(resp):
    """AgentCore list APIs are inconsistent on the wrapper key."""
    for k in ("items", "memories", "gateways", "agentRuntimes", "codeInterpreters", "codeInterpreterSummaries"):
        if k in resp:
            return resp[k]
    return []


def _list_all(list_fn, **kwargs):
    """Paginate an AgentCore list_* call (nextToken) and return ALL items."""
    out, token = [], None
    while True:
        resp = list_fn(**{**kwargs, "nextToken": token}) if token else list_fn(**kwargs)
        out.extend(_items(resp))
        token = resp.get("nextToken")
        if not token:
            return out


def gateway_url(gw_id, region):
    return f"https://{gw_id}.gateway.bedrock-agentcore.{region}.amazonaws.com/mcp"


def ensure_gateways(ctrl, ac):
    """9 gateways, idempotent by exact name. Returns {short_key: gateway_id}.

    Description drift converges too (PR #246 review): a catalog description edit used to apply
    only at create_gateway — an already-live gateway kept the stale text forever (observed: the
    ops gateway still advertised "Steampipe SQL ..." long after ADR-001/010 removed live
    Steampipe). list_gateways already returns each gateway's description, so drift detection is
    free; on mismatch, update_gateway is called with exactly the same required fields
    create_gateway sends (name/roleArn/protocolType/authorizerType) — same converge-on-catalog
    posture ensure_targets already has for tool schemas.
    """
    existing = {g.get("name"): g for g in _list_all(ctrl.list_gateways)}
    ids = {}
    for key in catalog.GATEWAYS:
        name = f"awsops-v2-{key}-gateway"  # v2-namespaced: isolate from v1 awsops-* in shared accounts
        if name in existing:
            gw = existing[name]
            ids[key] = gw.get("gatewayId")
            want = catalog.GATEWAY_DESCRIPTIONS.get(key, key)
            if gw.get("description") != want:
                try:
                    ctrl.update_gateway(
                        gatewayIdentifier=gw.get("gatewayId"),
                        name=name,
                        roleArn=ac["role_arn"],
                        protocolType="MCP",
                        authorizerType="NONE",
                        description=want,
                    )
                    log(f"gateway:{key}", "UPDATED", "description drift")
                except ClientError as e:
                    # Description convergence is cosmetic — never fail the provisioning run on it.
                    # WARN, not ERR: main() exits 1 on any ERR in the report (provision.py tail),
                    # which would fail `make agentcore` over a label.
                    log(f"gateway:{key}", "WARN", f"description update failed: {str(e)[:120]}")
            else:
                log(f"gateway:{key}", "EXISTS", name)
            continue
        try:
            resp = ctrl.create_gateway(
                name=name,
                roleArn=ac["role_arn"],
                protocolType="MCP",
                authorizerType="NONE",
                description=catalog.GATEWAY_DESCRIPTIONS.get(key, key),
            )
            ids[key] = resp["gatewayId"]
            log(f"gateway:{key}", "CREATED", name)
        except ClientError as e:
            log(f"gateway:{key}", "ERR", str(e)[:140])
    return ids


def _inject_account(tools):
    """Deep-copy so we never mutate the shared catalog.TARGETS dicts, then add the
    cross-account target_account_id property to each tool's inputSchema."""
    out = []
    for t in tools:
        t = copy.deepcopy(t)
        t.setdefault("inputSchema", {}).setdefault("properties", {}).setdefault("target_account_id", {
            "type": "string",
            "description": "Target AWS account ID for cross-account access (12 digits). Only provide when instructed.",
        })
        out.append(t)
    return out


def tool_fingerprint(tools):
    """Stable serialization of the tool fields THIS code manages (name + description +
    inputSchema), for drift detection.

    PR-review round 9 MAJOR: drift used to be the tool-NAME set only, so an in-place edit that
    kept the name (round 8 removed `secret_arn` from execute_sql's inputSchema) was never
    detected and the deployed gateway kept advertising the old contract.

    Stability matters more than completeness here: the tools are sorted by name and every dict is
    dumped with sort_keys, so an unchanged catalog produces a byte-identical string run after run
    (no spurious drift, no gateway thrash). Only the three fields this provisioner actually sends
    are projected out, so any field the GetGatewayTarget response echoes back that we never set
    (defaults, nulls) is ignored.
    # ponytail: exact compare INSIDE inputSchema. If AgentCore ever starts injecting extra keys
    # into inputSchema itself, this would report drift on every run — idempotent and harmless
    # (update_gateway_target rewrites the same config) but noisy; narrow the projection then.
    """
    return json.dumps(
        sorted(({"name": t.get("name"),
                 "description": t.get("description"),
                 "inputSchema": t.get("inputSchema")} for t in tools),
               key=lambda t: t["name"] or ""),
        sort_keys=True, separators=(",", ":"))


def ensure_targets(ctrl, ac, gw_ids, skip_names=frozenset()):
    """Slice targets, idempotent by name. update_gateway_target on tool-schema drift.

    skip_names: legacy TARGETS names that ensure_mcp_server_targets owns THIS run (the preset is
    active or actively cutting over). Without this, ensure_targets (which only looks at whether
    the lambda_arn is still in the tf output — true for the whole ADR-017 deprecation window) would
    recreate a legacy target that a PRIOR run's ensure_mcp_server_targets retired, and THIS run's
    ensure_mcp_server_targets would retire it again seconds later — flapping the target into
    existence and back out every single provisioner run (kiro review MAJOR finding, 2026-07-31),
    which is exactly the duplicate-tool-name window the retire ordering is meant to prevent."""
    for tname, spec in catalog.TARGETS.items():
        if tname in skip_names:
            log(f"target:{tname}", "SKIP", "superseded by an active ADR-017 mcp-server preset — owned by ensure_mcp_server_targets this run")
            continue
        gw_id = gw_ids.get(spec["gateway"])
        if not gw_id:
            log(f"target:{tname}", "ERR", f"gateway {spec['gateway']} missing")
            continue
        lambda_arn = ac["lambda_arns"].get(spec["lambda_key"])
        if not lambda_arn:
            # Flag-gated targets (e.g. notion-mcp when integrations_enabled=false) have no Lambda
            # in the tf output. That is expected, not an error — SKIP so `make agentcore` exits 0.
            log(f"target:{tname}", "SKIP", f"lambda {spec['lambda_key']} not in tf output (flag off?)")
            continue
        tools = _inject_account(spec["tools"])
        cfg = {"mcp": {"lambda": {"lambdaArn": lambda_arn, "toolSchema": {"inlinePayload": tools}}}}
        creds = [{"credentialProviderType": "GATEWAY_IAM_ROLE"}]
        existing = {t.get("name"): t for t in _list_all(ctrl.list_gateway_targets, gatewayIdentifier=gw_id)}
        try:
            if tname in existing:
                tid = existing[tname]["targetId"]
                cur = ctrl.get_gateway_target(gatewayIdentifier=gw_id, targetId=tid)
                cur_tools = cur.get("targetConfiguration", {}).get("mcp", {}).get("lambda", {}).get("toolSchema", {}).get("inlinePayload", [])
                # Drift = the full managed tool definition (name + description + inputSchema), not
                # just the name set — an in-place schema edit keeping the same name re-syncs too.
                if tool_fingerprint(cur_tools) == tool_fingerprint(tools):
                    log(f"target:{tname}", "EXISTS", f"{len(tools)} tools")
                else:
                    ctrl.update_gateway_target(gatewayIdentifier=gw_id, targetId=tid, name=tname,
                                                description=spec["description"], targetConfiguration=cfg,
                                                credentialProviderConfigurations=creds)
                    log(f"target:{tname}", "UPDATED", f"{len(tools)} tools (schema drift)")
            else:
                ctrl.create_gateway_target(gatewayIdentifier=gw_id, name=tname, description=spec["description"],
                                            targetConfiguration=cfg, credentialProviderConfigurations=creds)
                log(f"target:{tname}", "CREATED", f"{len(tools)} tools")
        except ClientError as e:
            log(f"target:{tname}", "ERR", str(e)[:140])


def _endpoint_blocked(endpoint, spec=None):
    """ADR-017 defense-in-depth (kiro review MAJOR finding, 2026-07-31): official_mcp_endpoints is
    an https-only tfvars map (enforced by ai.tf's variable validation block at plan time), but a
    tfvars edit can be applied without ever re-running that validation against code that already
    changed — this is the second, runtime check. Mirrors the ALWAYS-BLOCKED subset of
    web/lib/ssrf-guard.ts isAlwaysBlockedHost (metadata/loopback/link-local/multicast/unspecified) —
    RFC1918 private is deliberately ALLOWED (the operator-asserted/self-hosted preset class is
    in-VPC by design — zero such presets exist after the 2026-08-05 amendment, but the rule is
    kept for any future one). Returns a reason string
    if blocked, else None. A non-literal hostname (the common case) is not resolved here — same
    deferral to connect time as the TS guard.

    When `spec` (the catalog MCP_SERVER_TARGETS entry) is passed, this ALSO enforces the per-preset
    host pin, which is what actually keeps this feature inside ADR-007's "curated official-vendor
    only" boundary. Without it, `official_mcp_endpoints` only had to be `https://` and the ack was a
    self-echo of the operator's own string, so a preset key could be bound to any host and
    _ensure_api_key_provider would hand that host the preset's real vendor credential — effectively
    the BYO-MCP connection BASELINE §2 pins as do-not-revive. Two states, deliberately distinct:
    `allowed_host_suffixes` = vendor-hosted, pinned here; `host_is_operator_asserted` = genuinely
    self-hosted, where no vendor domain exists to pin (zero such presets in the catalog since the
    2026-08-05 amendment — the enforcement path stays, test-pinned, for any future one).
    A spec with NEITHER is a catalog bug and fails closed rather than defaulting to permissive."""
    try:
        parsed = urlparse(endpoint)
    except ValueError:
        return "unparsable URL"
    if parsed.scheme != "https":
        return f"scheme {parsed.scheme!r} is not https"
    host = (parsed.hostname or "").lower()
    if not host:
        return "no host in URL"
    if host == "localhost" or host.endswith(".localhost"):
        return "loopback hostname"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return None  # non-literal hostname
    if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or str(ip) == "255.255.255.255":
        return f"IP {ip} is loopback/link-local/multicast/unspecified (always blocked)"
    return None


#: The only address ranges a self-hosted preset may point at. This is an ALLOWLIST, not
#: `ipaddress.is_private`, because `is_private` is a broader predicate than "cannot leave the VPC" and
#: admits publicly-routed IPv6 transition forms: it derives its answer from the IPv4 address EMBEDDED in
#: a 6to4/Teredo address, so `2002:5db8:d822::1` (6to4 wrapping the public 93.184.216.34) and
#: `2001:0:5db8:d822::1` (Teredo) both report is_private=True while routing straight to the public
#: internet — i.e. exactly the exfiltration this gate exists to stop, waved through. Allowlisting the
#: two real in-VPC families instead rejects every transition form by construction (they all sit outside
#: these ranges), so there is no per-form blocklist to keep in sync with future ones.
_IN_VPC_NETS = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("fc00::/7"),  # IPv6 ULA. AWS VPC IPv6 CIDRs are globally-routable GUAs and
                                       # so are deliberately NOT here — a GUA is indistinguishable
                                       # from an exfil target by address alone.
)


def _is_in_vpc_literal(ip):
    return any(ip in net for net in _IN_VPC_NETS)


def _host_under_suffix(host, suffixes):
    """True if `host` sits under one of `suffixes`. Suffixes carry a leading dot so matching can only
    happen on a DNS label boundary: this is what rejects `evil-datadoghq.com` (no boundary) and
    `datadoghq.com.attacker.example` (suffix in the middle), both of which a raw-URL endswith allows."""
    for suf in suffixes:
        bare = suf.lstrip(".")
        if host == bare or host.endswith(suf if suf.startswith(".") else "." + suf):
            return True
    return False


def _host_pin_violation(endpoint, spec):
    """Per-preset host pin — the control that actually keeps this inside ADR-007's curated boundary.

    Vendor-hosted presets pin to `allowed_host_suffixes` from the catalog — a name is fine there,
    because the pin is the vendor's own domain. Operator-asserted (self-hosted) ones — none in the
    catalog since the 2026-08-05 amendment; rule preserved for any future preset — have no vendor
    domain to pin, and letting them take any host left the BYO-MCP path open:
    the preset's real credential would be handed to whatever URL was configured, which is exactly what
    BASELINE §2 pins as do-not-revive. They must therefore give the PRIVATE IP LITERAL of their
    in-VPC endpoint. The literal is the point — a NAME resolves privately at provision time and can
    be repointed at a public address afterwards, and the connection is made later by the
    AgentCore-managed network where we get no second look, so verifying a name proves nothing about
    what gets connected to. A literal has no DNS behind it."""
    try:
        host = (urlparse(endpoint).hostname or "").lower().rstrip(".")
    except ValueError:
        return "unparsable URL"
    if not host:
        return "no host in URL"
    suffixes = spec.get("allowed_host_suffixes")
    if not suffixes:
        if not spec.get("host_is_operator_asserted"):
            return "catalog entry declares neither allowed_host_suffixes nor host_is_operator_asserted"
        # A self-hosted preset must give a PRIVATE IP LITERAL. Not a name — a name is what makes this
        # exfiltratable at all: it resolves privately at provision time, then can be repointed at a
        # public address afterwards, and the connection is made later by the AgentCore-managed network
        # where we have no re-check. A literal has no DNS behind it, so there is nothing to repoint and
        # the value we verify is the value that gets connected to. That closes the class rather than
        # narrowing it, which is why this is enforced instead of merely recommended (earlier revisions
        # documented the rebinding window as residual — it did not have to be).
        try:
            host_ip = ipaddress.ip_address(host)
        except ValueError:
            return (f"self-hosted preset host {host!r} is a NAME — use the private IP literal of the "
                    f"in-VPC endpoint. A name resolves privately now but can be repointed at a public "
                    f"address later, and the connection is made by AgentCore where we cannot re-check")
        if not _is_in_vpc_literal(host_ip):
            return (f"self-hosted preset points at {host_ip}, which is not in an in-VPC range "
                    f"{tuple(str(n) for n in _IN_VPC_NETS)!r} — a self-hosted preset must be in-VPC")
        return None

    if _host_under_suffix(host, suffixes):
        return None
    return f"host {host!r} is not under any allowed suffix {tuple(suffixes)!r}"


def _load_official_mcp_secret(ac):
    """ADR-017: preset credentials live in the SAME shared secret the web BFF writes connector
    credentials into (web/lib/integration-credentials.ts), under the NAMESPACED key
    "mcp:<preset_key>" — e.g. {"mcp:datadog": {"token": "..."}}. The plain (non-namespaced)
    preset_key is a SEPARATE map entry owned by the datasource-connector kind-mirror
    (mirrorDefaultCredential) for the 5 presets that are ALSO a DATASOURCE_KINDS member
    (clickhouse/tempo/jaeger/dynatrace/datadog) — reusing that key for the MCP credential clobbers
    the connector's {endpoint, authType, ...} shape and vice versa (kiro review MAJOR finding,
    2026-07-31). setMcpPresetCredential (web/lib/integration-credentials.ts) writes the same
    "mcp:<preset_key>" key.

    Returns (secret_map, read_ok). read_ok=False means the READ OR PARSE ITSELF failed (a
    transient Secrets Manager error, e.g. throttling, or malformed JSON) — the caller must NOT
    treat that the same as "the credential is genuinely absent" (which retires any live target),
    or a transient API blip on a routine `make agentcore` re-run would mass-deprovision every
    configured preset (kiro review finding, 2026-07-31). read_ok=True with an empty/missing key
    means integrations_enabled=false or the credential genuinely isn't stored — both real SKIP
    states, not errors."""
    secret_name = ac.get("integrations_secret_name")
    if not secret_name:
        return {}, True  # integrations_enabled=false is a real "nothing configured" state
    # PR #194 review MAJOR (L2): read NOTHING when no preset endpoint is configured. The shared
    # store has no version until the BFF writes a value for the first time, so the read raises
    # ResourceNotFoundException -- which logged ERR and made `sys.exit(1 if errs else 0)` fail a
    # provisioner run that was otherwise fine and had no reason to touch this store at all. That is
    # a regression introduced purely by ADR-017 on deployments that do not use ADR-017.
    if not (ac.get("official_mcp_endpoints") or {}):
        return {}, True
    sm = boto3.client("secretsmanager", region_name=ac["region"])
    try:
        resp = sm.get_secret_value(SecretId=secret_name)
    except ClientError as e:
        log("mcp-server:secret", "ERR", str(e)[:140])
        return {}, False
    try:
        m = json.loads(resp.get("SecretString") or "{}")
    except json.JSONDecodeError as e:
        log("mcp-server:secret", "ERR", f"malformed JSON: {e}"[:140])
        return {}, False
    if not isinstance(m, dict):
        # Valid JSON but not an object (an array/string/number secret — hand-edited or written by
        # something other than web/lib/integration-credentials.ts). Round-4 review MINOR L2-5: this
        # used to return ({}, True) = "read fine, credential absent", which RETIRES a live target.
        # A shape we can't read is a read failure, not evidence the credential was removed.
        log("mcp-server:secret", "ERR", f"secret JSON is a {type(m).__name__}, expected an object — treating as unreadable")
        return {}, False
    return m, True


def _preset_token(secrets, preset_key):
    """The stored API token for an ADR-017 preset, or None if absent/unusable.

    Single choke point for reading `mcp:<preset_key>` — both ensure_mcp_server_targets and
    _cutover_preset_keys go through it so they can never disagree about whether a preset has a
    credential. Type-checked (round-4 review MINOR L2-6): a non-str token (dict/number/null from a
    hand-edited secret) handed to boto3 raises ParamValidationError — NOT a ClientError, so it
    escapes _ensure_api_key_provider's handler and aborts the whole provisioner run. An unusable
    value is treated as absent (SKIP this one preset)."""
    raw = secrets.get(f"mcp:{preset_key}")
    token = raw.get("token") if isinstance(raw, dict) else None
    return token if isinstance(token, str) and token else None


def _ensure_api_key_provider(ctrl, provider_name, token):
    """Idempotent AgentCore Identity API-key credential provider: create if missing, update if the
    token changed. get_api_key_credential_provider does NOT return the key value back (write-only
    vault semantics) so drift can't be detected here — update_api_key_credential_provider is called
    every run when a token is present; AgentCore Identity itself is expected to no-op on an
    unchanged value. Returns the providerArn, or "" on failure."""
    if not isinstance(token, str) or not token:
        # Defense in depth — callers get their token from _preset_token, which already enforces
        # this; a non-str here would be a ParamValidationError (uncatchable by our ClientError
        # handlers below) and would kill the whole run instead of skipping one preset.
        log(f"mcp-server-provider:{provider_name}", "ERR", "refusing to send a non-string/empty apiKey to AgentCore Identity")
        return ""
    try:
        existing = ctrl.get_api_key_credential_provider(name=provider_name)
        arn = existing["credentialProviderArn"]
        ctrl.update_api_key_credential_provider(name=provider_name, apiKey=token)
        return arn
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") not in ("ResourceNotFoundException",):
            log(f"mcp-server-provider:{provider_name}", "ERR", str(e)[:140])
            return ""
    try:
        resp = ctrl.create_api_key_credential_provider(name=provider_name, apiKey=token)
        return resp["credentialProviderArn"]
    except ClientError as e:
        log(f"mcp-server-provider:{provider_name}", "ERR", str(e)[:140])
        return ""


def _api_key_provider_fields(credential_provider_configurations):
    """Extract (providerArn, location, param_name, prefix) an API_KEY credentialProviderConfigurations
    entry uses, or None for any other/absent config. providerArn is included (not just the header
    wiring) so a provider that got deleted-and-recreated (new ARN, same location/param/prefix) is
    still detected as drift — otherwise the target keeps pointing at a now-nonexistent provider."""
    cfgs = credential_provider_configurations or []
    if not cfgs or cfgs[0].get("credentialProviderType") != "API_KEY":
        return None
    apk = (cfgs[0].get("credentialProvider") or {}).get("apiKeyCredentialProvider") or {}
    return (apk.get("providerArn"), apk.get("credentialLocation"), apk.get("credentialParameterName"), apk.get("credentialPrefix", ""))


def _delete_api_key_provider(ctrl, provider_name):
    """Best-effort delete — a missing provider is not an error (nothing to retire)."""
    try:
        ctrl.delete_api_key_credential_provider(name=provider_name)
        log(f"mcp-server-provider:{provider_name}", "DELETED", "retired")
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ResourceNotFoundException":
            log(f"mcp-server-provider:{provider_name}", "ERR", str(e)[:140])


# Gateway target lifecycle states (GetGatewayTarget `status`), confirmed against the botocore
# model: CREATING/UPDATING/SYNCHRONIZING are in-flight; READY is the only "safe to cut over to"
# state; the rest are terminal failures.
_TARGET_TERMINAL_FAILURE_STATUSES = {"FAILED", "UPDATE_UNSUCCESSFUL", "SYNCHRONIZE_UNSUCCESSFUL"}


_RUNTIME_TERMINAL_FAILURE_STATUSES = ("CREATE_FAILED", "UPDATE_FAILED")


def _wait_runtime_ready(ctrl, runtime_id, timeout_s=300, interval_s=5):
    """Poll GetAgentRuntime until status=READY (True), a terminal failure status (False, logged),
    or timeout_s elapses (False, logged).

    review MAJOR (follow-up): create_agent_runtime/update_agent_runtime return as soon as the
    request is ACCEPTED (status CREATING/UPDATING), not once the new revision is actually serving
    — the base smoke path's own `time.sleep(10)` comment already says as much. Without this wait,
    ensure_runtime returning a non-empty ARN told main() "safe to proceed" while the OLD runtime
    image (potentially predating OFFICIAL_MCP_TOOL_ALLOWLIST_JSON entirely) was still what actually
    answered gateway calls — reordering ensure_runtime before ensure_mcp_server_targets closes the
    ordering half of this gap, but not the propagation-delay half. Mirrors _wait_target_ready's
    shape. timeout_s=300 (review MINOR): a container-runtime rollout includes an image pull — 60s
    was routinely exceedable, and every timeout defers provisioning for the WHOLE run, so a
    chronically-short timeout meant hosted presets could never activate. Override via the
    AGENTCORE_RUNTIME_READY_TIMEOUT env if a deployment needs more."""
    try:
        timeout_s = int(os.environ.get("AGENTCORE_RUNTIME_READY_TIMEOUT", timeout_s))
    except (TypeError, ValueError):
        log("runtime:ready", "ERR", "AGENTCORE_RUNTIME_READY_TIMEOUT is not an integer — using the default")
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            resp = ctrl.get_agent_runtime(agentRuntimeId=runtime_id)
        except ClientError as e:
            log("runtime:ready", "ERR", str(e)[:140])
            return False
        status = resp.get("status")
        if status == "READY":
            return True
        if status in _RUNTIME_TERMINAL_FAILURE_STATUSES:
            log("runtime:ready", "ERR", f"reached terminal status {status}: {(resp.get('failureReason') or '')[:120]}")  # `or ''`: an explicit null must not TypeError outside the try
            return False
        if time.monotonic() >= deadline:
            log("runtime:ready", "ERR", f"timed out after {timeout_s}s waiting for READY (last status: {status})")
            return False
        time.sleep(interval_s)


def _wait_target_ready(ctrl, gw_id, target_id, tname, timeout_s=30, interval_s=2):
    """Poll GetGatewayTarget until status=READY (True), a terminal failure status (False, logged),
    or timeout_s elapses (False, logged). create/update_gateway_target return as soon as the
    request is ACCEPTED, not once the target is actually usable — retiring the legacy target right
    after that 200, without confirming READY, can cut over to a target that isn't live yet (kiro
    review finding, 2026-07-31)."""
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            status = ctrl.get_gateway_target(gatewayIdentifier=gw_id, targetId=target_id).get("status")
        except ClientError as e:
            log(f"target:{tname}:ready", "ERR", str(e)[:140])
            return False
        if status == "READY":
            return True
        if status in _TARGET_TERMINAL_FAILURE_STATUSES:
            log(f"target:{tname}:ready", "ERR", f"reached terminal status {status}, never became READY")
            return False
        if time.monotonic() >= deadline:
            log(f"target:{tname}:ready", "ERR", f"timed out after {timeout_s}s waiting for READY (last status: {status})")
            return False
        time.sleep(interval_s)


def _retire_gateway_target(ctrl, gw_id, existing, tname, reason):
    """Delete a live gateway target by name, if it exists. Used both to retire a disabled/removed
    ADR-017 preset's target and to clear a legacy lambda target out of the way before cutover."""
    t = existing.get(tname)
    if not t:
        return
    try:
        ctrl.delete_gateway_target(gatewayIdentifier=gw_id, targetId=t["targetId"])
        log(f"target:{tname}", "RETIRED", reason)
        existing.pop(tname, None)  # keep the cache correct for the rest of this run
    except ClientError as e:
        log(f"target:{tname}", "ERR", str(e)[:140])


def ensure_mcp_server_targets(ctrl, ac, gw_ids, secrets=None, secrets_read_ok=None, allow_provision=True):
    """ADR-017: register curated official-vendor MCP servers as remote `mcpServer` gateway targets.

    allow_provision=False (review MAJOR, follow-up): the caller confirmed the runtime revision
    carrying OFFICIAL_MCP_TOOL_ALLOWLIST_JSON is NOT live this run (ensure_runtime failed or never
    reached READY). Every TEARDOWN path below (blocked endpoint, no endpoint, stale/missing ack,
    missing credential, the RETIRED_MCP_SERVER_TARGETS tombstone pass) still runs unconditionally —
    those only ever REDUCE exposure and don't depend on the runtime allowlist existing. The
    CREATE/UPDATE/SYNC path for an otherwise-eligible preset is skipped, and — same principle,
    other direction (review MAJOR on this round's first cut) — an otherwise-eligible preset's
    ALREADY-LIVE target is RETIRED, because a target serving through a runtime that may predate
    the allowlist is the exact unfiltered-vendor-write-tool exposure this gate exists to close.
    An earlier revision of this function had the caller skip the WHOLE call on
    runtime failure, which also blocked teardown — an operator revoking an ack or removing an
    endpoint specifically to shut a live vendor target off would have been unable to, for as long
    as the runtime stayed unready (review MAJOR, this round).

    Ordering is deliberate and safety-critical (2026-07-31 kiro review, findings #1/#2 on the first
    cut of this function, plus round-4 L2-2):
      1. TEARDOWN FIRST — blocked endpoint, no endpoint (flag off / removed), ack missing-or-stale:
         retire only THIS preset's own mcp-server target + credential provider if a prior run left
         them live. These run ABOVE the secrets-read gate (round-4 L2-2) because a retirement needs
         no credential, and a Secrets Manager blip must not disable the kill-switch.
         The legacy lambda target is NEVER touched here — an incomplete/reverted cutover must leave
         the old tool working, not take it down too.
      1b. Credential gate: secret unreadable -> SKIP touching anything (fail-safe); credential
         genuinely absent while the endpoint+ack stand -> retire (finding #2 — a missing credential
         must also tear down a now-uncredentialed target, not just no-op).
      2. ACTIVE -> validate the credential provider FIRST, then create/update the new target, and
         ONLY on confirmed success (CREATED/UPDATED/EXISTS) retire the legacy lambda target. Doing
         the legacy delete BEFORE the new target was confirmed live was the outage bug (finding #1):
         a missing credential or a create/update failure would delete the working old tool with
         nothing to replace it.

    secrets/secrets_read_ok: pass the values from a caller-side _load_official_mcp_secret(ac) call
    to avoid a second Secrets Manager read when main() already needed one (to compute the
    ensure_targets legacy-skip set); when omitted (e.g. every existing test), loads them itself.
    """
    # HOST BINDING IS CODE-PINNED — see _host_pin_violation(), called on every endpoint below.
    #
    # This used to read "ACCEPTED RESIDUAL RISK … the binding is OPERATOR-ASSERTED" and then propose,
    # as a hypothetical, adding a per-preset allowed-host-suffix tuple. That fix landed in this same
    # PR, so the comment described the opposite of the code and would have led the next reviewer to
    # believe no pin exists on a credential-exfiltration boundary (PR #194 review MAJOR, L3).
    #
    # What is actually enforced:
    #   - vendor-hosted presets pin to catalog `allowed_host_suffixes`, matched on the PARSED
    #     hostname at a DNS label boundary — `evil-datadoghq.com` and `datadoghq.com.attacker.example`
    #     both fail (a raw-URL endswith would pass both);
    #   - self-hosted presets must give a PRIVATE IP LITERAL inside an in-VPC range, so there is no
    #     DNS indirection to repoint after the check;
    #   - a catalog entry declaring neither key fails closed.
    # The ack (ack[preset_key] == endpoints[preset_key]) is still a self-echo and is NOT the host
    # control — it records that an operator reviewed a specific URL. The host control is the pin.
    #
    # What the pin does NOT prove: that the software answering at a permitted address is the genuine
    # vendor/product. Inside a private range that is a trust-boundary question, not a config one —
    # recorded as an activation precondition in ADR-017 §Status.
    endpoints = ac.get("official_mcp_endpoints") or {}
    lambda_arns = ac.get("lambda_arns") or {}
    read_only_acks = ac.get("official_mcp_read_only_ack") or {}
    if secrets is None:
        secrets, secrets_read_ok = _load_official_mcp_secret(ac)
    existing_by_gw = {}  # gateway short-key -> {target_name: target}, fetched once per gateway

    def gw_existing(gw_key):
        gw_id = gw_ids.get(gw_key)
        if not gw_id:
            return None, {}
        if gw_key not in existing_by_gw:
            existing_by_gw[gw_key] = {t.get("name"): t for t in _list_all(ctrl.list_gateway_targets, gatewayIdentifier=gw_id)}
        return gw_id, existing_by_gw[gw_key]

    # Converge on the DECLARED catalog: retire targets (and their vendor-token credential providers)
    # that this catalog no longer declares. The per-preset loop below only reaches names that are
    # still IN the catalog, and prune_moved_targets() KEEPs unknown names on purpose — so without
    # this pass a removed preset's remote target lives on forever (review MAJOR, PR #207).
    # BOTH deletes run UNCONDITIONALLY — same idiom as the inactive-preset SKIP path below, and for
    # the same reason. The two objects fail independently, so any attempt to use one as the other's
    # retry trigger strands the survivor: provision creates the provider BEFORE the target, so a
    # failed target create (or a half-done retirement) leaves provider-only state that a
    # target-present gate would skip forever, orphaning the vendor token. Both calls tolerate
    # "already gone", so re-attempting every run is cheap, idempotent, and self-healing.
    for tname, preset_key in getattr(catalog, "RETIRED_MCP_SERVER_TARGETS", ()):
        gw_id, existing = gw_existing("external-obs")
        if not gw_id:
            continue
        _retire_gateway_target(ctrl, gw_id, existing, tname, "removed from the catalog — retiring (ADR-017 amended)")
        _delete_api_key_provider(ctrl, f"awsops-v2-{preset_key}-mcp")

    for tname, spec in catalog.MCP_SERVER_TARGETS.items():
        preset_key = spec["preset_key"]
        endpoint = endpoints.get(preset_key)
        gw_id, existing = gw_existing(spec["gateway"])
        if not gw_id:
            log(f"target:{tname}", "ERR", f"gateway {spec['gateway']} missing")
            continue

        auth = spec["auth"]
        provider_name = f"awsops-v2-{preset_key}-mcp"

        # ── Teardown decisions first (round-4 review MAJOR L2-2, 2026-07-31) ─────────────────
        # Every branch below is an EXPLICIT operator-requested retirement (blocked endpoint / flag
        # off / endpoint removed / ack revoked or stale) and needs NO credential to carry out —
        # retiring a target never reads the secret. They therefore run ABOVE the secrets-read gate.
        # Round-3 had the secrets-read SKIP first, which meant a Secrets Manager blip left a live
        # target AND its API-key provider running after the flag was turned off or the ack revoked
        # — the kill-switch silently stopped working, and (flag off) ensure_targets would then also
        # recreate the legacy lambda target, giving the gateway duplicate tool names.
        if endpoint:
            blocked_reason = _endpoint_blocked(endpoint) or _host_pin_violation(endpoint, spec)
            if blocked_reason:
                log(f"target:{tname}", "ERR", f"official_mcp_endpoints['{preset_key}'] rejected: {blocked_reason}")
                _retire_gateway_target(ctrl, gw_id, existing, tname, "endpoint failed the SSRF/scheme guard — retiring")
                _delete_api_key_provider(ctrl, provider_name)
                continue

        if not endpoint:
            log(f"target:{tname}", "SKIP", f"no endpoint configured for preset '{preset_key}' (official_mcp_enabled/official_mcp_endpoints)")
            _retire_gateway_target(ctrl, gw_id, existing, tname, "no endpoint configured — retiring")
            # Best-effort: AWS may reject deleting a provider while a target still references it
            # if the just-issued target deletion is still async. A failure here is logged (ERR) and
            # self-heals on the NEXT provisioner run — this SKIP path re-attempts the delete every
            # time the preset stays inactive, and delete_api_key_credential_provider is idempotent.
            _delete_api_key_provider(ctrl, provider_name)
            continue

        if read_only_acks.get(preset_key) != endpoint:
            # CRITICAL (kiro review, 2026-07-31): unlike the Lambda TARGETS (toolSchema.inlinePayload
            # hard-limits the exposed tool set), an mcpServer target has NO server-side tool
            # allowlist — it exposes 100% of whatever the vendor's remote MCP server advertises,
            # write tools included. ADR-017's read_only_note (spec["read_only_note"]) is currently
            # "trust the vendor's own config" (RBAC scope / --disable-write / etc); provision.py has
            # no control-plane API to introspect the vendor's live tool list (tools/list only exists
            # on the data-plane MCP endpoint, not bedrock-agentcore-control) so it cannot verify that
            # claim itself. Fail CLOSED: require an explicit per-preset operator acknowledgment
            # (terraform var.official_mcp_read_only_ack[preset_key] = the exact endpoint reviewed)
            # that the read_only_note control was actually verified on the vendor side, before
            # provisioning at all — default {} means nothing provisions until acked.
            #
            # ack is bound to the ENDPOINT VALUE, not just the preset_key (round-3 review MAJOR,
            # 2026-07-31 fix): comparing != endpoint (not just falsy) means changing
            # official_mcp_endpoints[preset_key] to a different URL without a matching re-ack is
            # treated exactly like never having acked at all — fail-closed, retire, no silent
            # credential handoff to an unreviewed endpoint.
            log(f"target:{tname}", "SKIP",
                f"official_mcp_read_only_ack['{preset_key}'] missing or doesn't match the current "
                f"endpoint — refusing to provision an unenforced write surface "
                f"({spec.get('read_only_note', 'no read-only note')}); ack in terraform.tfvars "
                "(value = the exact endpoint URL) only after verifying the vendor-side read-only "
                "control, and re-ack whenever the endpoint changes")
            _retire_gateway_target(ctrl, gw_id, existing, tname, "read-only ack missing or stale (endpoint changed since ack) — retiring")
            _delete_api_key_provider(ctrl, provider_name)
            continue

        # ── Runtime-allowlist gate (provisioning only — every teardown branch above already ran
        # regardless) ────────────────────────────────────────────────────────────────────────────
        if not allow_provision:
            # An ELIGIBLE preset with a LIVE target is retired here, not skipped (PR #207 review
            # MAJOR, 3 cells independent): "left untouched" meant a target created by a PRE-allowlist
            # revision kept serving 100% of the vendor's tools — write tools included — through
            # whatever runtime IS live, which is exactly the exposure this PR closes. The PR's own
            # principle ("a target must not be exposed to a runtime that predates the allowlist")
            # applies to retaining one as much as to creating one. Retirement is teardown, so it
            # doesn't conflict with this gate's teardown-always contract; the next successful run
            # recreates the target idempotently (flapping only across failed rollouts — acceptable:
            # fail-closed beats serving unfiltered vendor write tools).
            if existing.get(tname):
                log(f"target:{tname}", "ERR", "runtime allowlist not confirmed live this run — "
                    "retiring the live target rather than letting it serve through a possibly "
                    "pre-allowlist runtime (recreated on the next successful run)")
                _retire_gateway_target(ctrl, gw_id, existing, tname, "runtime allowlist unconfirmed — retiring live target")
            else:
                log(f"target:{tname}", "SKIP", "runtime allowlist not confirmed live this run — "
                    "deferring create/update/sync")
            # Provider deletion runs in BOTH branches (codex stop-gate P2 on 569105be): AWS can
            # reject deleting a provider while the just-issued target deletion is still async, and
            # the NEXT run sees no target → the quiet branch → the provider was never retried.
            # Same self-healing convention as the no-endpoint SKIP branch; the delete is idempotent
            # and a successful next run recreates the provider alongside the target anyway.
            _delete_api_key_provider(ctrl, provider_name)
            continue

        # ── Credential gate (provisioning only — everything that tears down already ran) ──────
        token = _preset_token(secrets, preset_key) if auth["mode"] == "api_key" else None

        if auth["mode"] == "api_key" and not token and not secrets_read_ok:
            # Could not READ the credentials secret this run (transient Secrets Manager error /
            # malformed JSON / non-object secret) — NOT the same as "the credential was
            # intentionally removed", and must never retire a live target on that basis (kiro
            # review finding, 2026-07-31: a transient API blip would otherwise mass-deprovision
            # every configured preset). Fail safe: skip this preset, touch nothing.
            log(f"target:{tname}", "SKIP", f"could not read credentials secret this run for preset '{preset_key}' — leaving any existing target/provider untouched")
            continue

        if auth["mode"] == "api_key" and not token:
            log(f"target:{tname}", "SKIP", f"no stored credential for preset '{preset_key}' (Connectors tab)")
            _retire_gateway_target(ctrl, gw_id, existing, tname, "no stored credential — retiring")
            _delete_api_key_provider(ctrl, provider_name)  # see the no-endpoint branch's note
            continue

        # INFORMATIONAL only (dead-code reminder) — does NOT gate target creation. The legacy
        # target itself (below, AFTER a confirmed-successful create/update) is what closes the
        # actual duplicate-tool-name risk; a tf-config-only check can't see a leftover target
        # object from a prior run, and gating on it would just reproduce that gap.
        conflict = catalog.conflicting_lambda_key(preset_key, lambda_arns)
        if conflict:
            # NOT necessarily dead code: web/lib/mcp-lambda-invoke.ts (KNOWN_MCP_LAMBDA_KINDS covers
            # clickhouse/tempo/jaeger/dynatrace/datadog), web/lib/trace-source.ts and
            # scripts/v2/workers/diagnosis/sources.py invoke these Lambdas DIRECTLY, not through a
            # gateway target. The earlier wording said "dead code once this preset is live", and
            # following it would have broken Explore, trace lookup and async diagnosis (PR #194
            # review MAJOR, L4). Only the gateway TARGET is superseded here.
            log(f"target:{tname}", "WARN",
                f"lambda '{conflict}' still deployed — its gateway target is superseded by this preset, "
                f"but do NOT remove it from ai.tf without checking the direct-invoke callers "
                f"(web/lib/mcp-lambda-invoke.ts, web/lib/trace-source.ts, "
                f"scripts/v2/workers/diagnosis/sources.py)")

        creds = [{"credentialProviderType": "GATEWAY_IAM_ROLE"}]
        if auth["mode"] == "api_key":
            provider_arn = _ensure_api_key_provider(ctrl, provider_name, token)
            if not provider_arn:
                continue  # error already logged by _ensure_api_key_provider — legacy target untouched
            api_key_provider = {
                "providerArn": provider_arn,
                "credentialLocation": auth["credential_location"],
                "credentialParameterName": auth["credential_parameter_name"],
            }
            # ponytail: defensive only — omit credentialPrefix entirely when the preset has none
            # (e.g. New Relic's "Api-Key" header takes no prefix) rather than passing "", in case
            # botocore/the API enforces a min-length on this field (unverified as of 2026-07-31
            # review; AWS testing would confirm either way — this fix is safe regardless).
            if auth.get("credential_prefix"):
                api_key_provider["credentialPrefix"] = auth["credential_prefix"]
            creds = [{
                "credentialProviderType": "API_KEY",
                "credentialProvider": {"apiKeyCredentialProvider": api_key_provider},
            }]

        # listingMode DEFAULT = the control plane caches the tool list it discovered, i.e. THE VENDOR
        # DECIDES WHICH TOOLS THIS GATEWAY EXPOSES.
        #
        # RESOLVED (2026-08-05, ADR-017 re-amendment) — this used to be an ACTIVATION BLOCKER, not
        # an accepted risk: bedrock-agentcore-control has no tool-listing operation at all (target
        # ops are only Create/Get/List/Update/DeleteGatewayTarget + SynchronizeGatewayTargets, no
        # response carries tool names — verified against the botocore 2023-06-05 model), so
        # provision.py cannot read, let alone diff, the vendor's advertised tools; and the one field
        # that WOULD cap them, McpServerTargetConfiguration.mcpToolSchema, requires an
        # authorization-code-grant credential unavailable to these API_KEY presets. A vendor adding
        # a WRITE tool to an already-acked preset used to be absorbed into the agent's tool surface
        # on the next `make agentcore` with no re-ack, no PR, no review.
        # That gap is now closed a layer up, at the RUNTIME, not the control plane: each catalog
        # entry below declares `tool_allowlist` (read-only tool names TRANSCRIBED from vendor docs —
        # see catalog.py's per-entry provenance comments), written here to
        # OFFICIAL_MCP_TOOL_ALLOWLIST_JSON (below) and intersected in agent.py against every
        # `<target>___<tool>` name coming back from the gateway — empty/untranscribed allowlist or a
        # missing env var both mean zero tools for that preset (fail-closed), and this same gate is
        # shared (not duplicated) between the Strands handler and the anthropic_loop dark-path
        # handler (PR #207 CRITICAL fix — a prior revision only gated the Strands path). A vendor
        # adding a write tool no longer reaches the model: it's simply not in the allowlist.
        # `listingMode=DEFAULT` above still means the control plane itself imposes no cap — the
        # allowlist is enforced entirely in agent.py, not here — so this file still cannot verify
        # what the vendor's server advertises; it only bounds what's let through downstream.
        # Compensating controls, unchanged: `official_mcp_enabled` + `integrations_enabled`
        # default-off; the curated catalog (only vendors WE list get a preset_key — see
        # MCP_SERVER_TARGETS, now vendor-hosted-only per ADR-017); the fail-closed per-preset
        # `official_mcp_read_only_ack` bound to the exact endpoint; `integrations_write_enabled`
        # staying off. Recorded in ADR-017 §Decision/§Trade-offs and the ADR-004/ADR-007 amendments
        # (both carry a 2026-08-05 follow-up noting this resolution).
        cfg = {"mcp": {"mcpServer": {"endpoint": endpoint, "listingMode": "DEFAULT"}}}
        tid_final = None
        tid_to_sync = None
        try:
            if tname in existing:
                tid_final = existing[tname]["targetId"]
                cur = ctrl.get_gateway_target(gatewayIdentifier=gw_id, targetId=tid_final)
                cur_endpoint = cur.get("targetConfiguration", {}).get("mcp", {}).get("mcpServer", {}).get("endpoint")
                cur_provider = _api_key_provider_fields(cur.get("credentialProviderConfigurations"))
                new_provider = _api_key_provider_fields(creds)
                drifted = (cur_endpoint != endpoint or cur_provider != new_provider or cur.get("description") != spec["description"])
                if not drifted:
                    log(f"target:{tname}", "EXISTS", endpoint)
                    # Round-3 review MAJOR (2026-07-31): ADR-017's whole stated benefit is "the
                    # vendor maintains the tool list, we don't" — but a sync request only fired on
                    # CREATE/UPDATE, never on an unchanged EXISTS target, so a vendor adding/renaming
                    # tools on their end never reached this Gateway after the first provision. Sync
                    # every run regardless of drift; synchronize_gateway_targets is a cheap best-effort
                    # refresh request, not a mutation of our config.
                    tid_to_sync = tid_final
                else:
                    ctrl.update_gateway_target(gatewayIdentifier=gw_id, targetId=tid_final, name=tname,
                                                description=spec["description"], targetConfiguration=cfg,
                                                credentialProviderConfigurations=creds)
                    log(f"target:{tname}", "UPDATED", f"drift: endpoint/description/credential-provider config changed -> {endpoint}")
                    tid_to_sync = tid_final
            else:
                resp = ctrl.create_gateway_target(gatewayIdentifier=gw_id, name=tname, description=spec["description"],
                                                   targetConfiguration=cfg, credentialProviderConfigurations=creds)
                log(f"target:{tname}", "CREATED", endpoint)
                tid_final = resp["targetId"]
                tid_to_sync = tid_final
        except ClientError as e:
            log(f"target:{tname}", "ERR", str(e)[:140])
            continue  # new target failed — leave the legacy lambda target alone (no outage)

        if tid_to_sync:
            # Best-effort refresh request — its success/failure is INDEPENDENT of whether the
            # target actually reaches READY (checked below), so a sync failure alone must not
            # short-circuit the ready-wait or silently permit an unconfirmed cutover either way.
            try:
                ctrl.synchronize_gateway_targets(gatewayIdentifier=gw_id, targetIdList=[tid_to_sync])
                log(f"target:{tname}:sync", "OK", "tools/list refresh requested")
            except ClientError as e:
                log(f"target:{tname}:sync", "ERR", str(e)[:140])

        # create/update_gateway_target return as soon as the request is ACCEPTED, not once the
        # target is actually usable — confirm READY before treating the new target as the live
        # replacement (kiro review finding, 2026-07-31). Not ready -> leave the legacy lambda
        # target alone; retry on the next provisioner run (this whole block is idempotent).
        if not _wait_target_ready(ctrl, gw_id, tid_final, tname):
            continue

        legacy_name = catalog.legacy_target_name(preset_key)
        if legacy_name:
            # The legacy lambda target may live on a DIFFERENT gateway than this preset's new
            # mcpServer target (e.g. tempo-mcp-target is on 'monitoring' while
            # tempo-mcp-server-target is on 'external-obs') — searching only `existing` (this
            # preset's own gateway) can never find it there, so it would live forever (kiro review
            # MAJOR finding, 2026-07-31). Look up the legacy target's OWN gateway from the catalog.
            legacy_gw_key = (catalog.TARGETS.get(legacy_name) or {}).get("gateway", spec["gateway"])
            legacy_gw_id, legacy_existing = gw_existing(legacy_gw_key)
            if legacy_gw_id and legacy_name in legacy_existing:
                _retire_gateway_target(ctrl, legacy_gw_id, legacy_existing, legacy_name,
                                        f"superseded by {tname} (ADR-017 cutover, confirmed READY)")


def _cutover_preset_keys(ac, secrets, secrets_read_ok):
    """Preset keys ensure_mcp_server_targets will treat as ACTIVE this run — same conditions as its
    own SKIP/retire branches (endpoint configured, endpoint not blocked, ack matching the current
    endpoint, and — for api_key auth — a credential present OR the secret read itself failed,
    mirroring that function's own fail-safe so this helper and ensure_mcp_server_targets never
    disagree). Used by main() to tell ensure_targets which legacy lambda targets are owned by
    ensure_mcp_server_targets this run (see ensure_targets' skip_names docstring for why that
    matters — otherwise the legacy target flaps).

    The _endpoint_blocked / _preset_token calls here are the SAME helpers ensure_mcp_server_targets
    uses, deliberately not re-implemented (round-4 review MAJOR L2-1, 2026-07-31): this helper used
    to check only "endpoint present + ack matches", so a blocked endpoint (e.g. https://127.0.0.1/mcp
    — https, so terraform's ^https:// validation passes it) counted as a cutover here (legacy target
    landed in skip_names => never created) while ensure_mcp_server_targets rejected it (remote target
    retired/never created) => EVERY tool for that kind silently vanished. Sharing one decision means
    a blocked endpoint is simply "not cut over", which keeps the legacy target alive."""
    endpoints = ac.get("official_mcp_endpoints") or {}
    read_only_acks = ac.get("official_mcp_read_only_ack") or {}
    active = set()
    for spec in catalog.MCP_SERVER_TARGETS.values():
        preset_key = spec["preset_key"]
        endpoint = endpoints.get(preset_key)
        if not endpoint or read_only_acks.get(preset_key) != endpoint:
            continue
        if _endpoint_blocked(endpoint) or _host_pin_violation(endpoint, spec):
            continue
        if spec["auth"]["mode"] == "api_key":
            if not _preset_token(secrets, preset_key) and secrets_read_ok:
                continue
        active.add(preset_key)
    return active


def prune_moved_targets(ctrl, gw_ids):
    """Idempotent reconcile: delete a target that the catalog has MOVED to a different gateway —
    a KNOWN target name still living on a gateway it is no longer assigned to. Prevents the
    split-brain after a catalog gateway reassignment (e.g. prometheus/clickhouse → external-obs),
    where ensure_targets creates the target on its new home but the stale copy lingers on the old
    gateway (exposing a tool the old gateway's prompt no longer documents). Runs AFTER ensure_targets
    so the new target exists before the old one is removed. Targets whose name is NOT in the catalog
    are manual/experimental — never auto-deleted, only logged."""
    desired = {tname: spec["gateway"] for tname, spec in catalog.TARGETS.items()}
    desired.update({tname: spec["gateway"] for tname, spec in catalog.MCP_SERVER_TARGETS.items()})
    # Snapshot every provisioned gateway's targets once.
    by_gw = {gw_key: _list_all(ctrl.list_gateway_targets, gatewayIdentifier=gw_id)
             for gw_key, gw_id in gw_ids.items()}
    # SAFETY (review #86 M1): a name is safe to prune off an OLD gateway ONLY if it is confirmed
    # live on its DESIRED home gateway. If the new home target wasn't created — flag-OFF (lambda
    # SKIPped) or a create that ERRed (e.g. GW-not-READY ValidationException) — we must NOT delete
    # the last copy, or the tool vanishes from every gateway. Preserve the old copy until the move
    # actually lands (next idempotent run completes it).
    safe = {name for name, home in desired.items()
            if any(t.get("name") == name for t in by_gw.get(home, []))}
    for gw_key, gw_id in gw_ids.items():
        for t in by_gw[gw_key]:
            name = t.get("name")
            home = desired.get(name)
            if home is None:
                log(f"prune:{name}", "KEEP", f"not in catalog (manual?) on {gw_key}")
            elif home != gw_key:
                if name not in safe:
                    log(f"prune:{name}", "KEEP", f"home {home} has no live target yet — keeping {gw_key} copy")
                    continue
                try:
                    ctrl.delete_gateway_target(gatewayIdentifier=gw_id, targetId=t["targetId"])
                    log(f"prune:{name}", "DELETED", f"orphan on {gw_key} (moved → {home})")
                except ClientError as e:
                    log(f"prune:{name}", "ERR", str(e)[:140])


def ensure_memory(ctrl):
    # ListMemories items carry id/arn/status but NOT name; resolve name via get_memory.
    for m in _list_all(ctrl.list_memories):
        mid = m.get("id") or m.get("memoryId")
        if not mid:
            continue
        try:
            detail = ctrl.get_memory(memoryId=mid).get("memory", {})
        except ClientError:
            detail = {}
        if detail.get("name") == MEMORY_NAME:
            log("memory", "EXISTS", mid)
            return mid
    try:
        resp = ctrl.create_memory(name=MEMORY_NAME, description="AWSops v2 conversation history",
                                  eventExpiryDuration=365)
        # CreateMemory returns {"memory": {"id": ...}}.
        mem = resp.get("memory", resp)
        mid = mem.get("id") or mem.get("memoryId")
        log("memory", "CREATED", mid)
        return mid
    except ClientError as e:
        log("memory", "ERR", str(e)[:140])
        return ""


def ensure_interpreter(ctrl):
    for c in _list_all(ctrl.list_code_interpreters):
        if c.get("name") == INTERPRETER_NAME:
            cid = c.get("codeInterpreterId") or c.get("id")
            log("interpreter", "EXISTS", cid)
            return cid
    try:
        resp = ctrl.create_code_interpreter(name=INTERPRETER_NAME,
                                            networkConfiguration={"networkMode": "PUBLIC"})
        cid = resp.get("codeInterpreterId") or resp.get("id")
        log("interpreter", "CREATED", cid)
        return cid
    except ClientError as e:
        log("interpreter", "ERR", str(e)[:140])
        return ""


def ensure_runtime(ctrl, ac, gw_ids):
    region = ac["region"]
    gateways_json = json.dumps({k: gateway_url(v, region) for k, v in gw_ids.items()})
    artifact = {"containerConfiguration": {"containerUri": f"{ac['ecr_uri']}:{IMAGE_TAG}"}}
    # VPC mode when the TF output supplies subnets+SGs (Pattern 2: ENIs in our VPC so agents reach
    # private Aurora/EKS; egress to Bedrock/AgentCore still works via the subnets' NAT). Falls back
    # to PUBLIC otherwise. networkMode/networkModeConfig flip in-place (no interruption).
    subnets = ac.get("subnets") or []
    sgs = ac.get("security_groups") or []
    if subnets and sgs:
        netcfg = {"networkMode": "VPC",
                  "networkModeConfig": {"subnets": subnets, "securityGroups": sgs}}
    else:
        netcfg = {"networkMode": "PUBLIC"}
    # AWSOPS_HOST_ACCOUNT_ID lets agent.account_utils skip the per-cold-start STS
    # GetCallerIdentity lookup (same value cross_account.py uses on the tool
    # Lambdas). Account parsed from the role ARN (arn:aws:iam::<account>:role/...).
    env = {"AWS_REGION": region, "GATEWAYS_JSON": gateways_json,
           "AWSOPS_HOST_ACCOUNT_ID": ac["role_arn"].split(":")[4],
           # Dark-path chat loop (ADR-008 amended / BASELINE §2) — default OFF. Set explicitly on the
           # runtime so it survives re-provisioning and is toggleable via the normal deploy path:
           # `ANTHROPIC_AGENT_LOOP_ENABLED=true make agentcore`.
           "ANTHROPIC_AGENT_LOOP_ENABLED": os.environ.get("ANTHROPIC_AGENT_LOOP_ENABLED", "false"),
           # ADR-017 (amended 2026-08-05) — runtime fail-closed tool allowlist for the vendor-hosted
           # official-MCP presets. Written on EVERY run (not just when official_mcp_enabled) so a
           # stale/absent map can never fail-open: agent.py drops all `*-mcp-server-target___*`
           # tools that aren't in this map.
           "OFFICIAL_MCP_TOOL_ALLOWLIST_JSON": json.dumps(
               {tname: sorted(spec.get("tool_allowlist") or ())
                for tname, spec in catalog.MCP_SERVER_TARGETS.items()}),
           # ADR-017 (amended) — official mcp-clickhouse stdio embedding, default OFF. Toggle via
           # `CLICKHOUSE_OFFICIAL_MCP=true make agentcore` (same pattern as the loop flag above).
           "CLICKHOUSE_OFFICIAL_MCP": os.environ.get("CLICKHOUSE_OFFICIAL_MCP", "false"),
           # Where agent.py reads the datasource kind-mirror credentials for the stdio path (same
           # single integrations secret the connector lambdas use).
           "INTEGRATIONS_SECRET_NAME": f"ops/{ac.get('project', 'awsops-v2')}/integrations/credentials"}
    # Same fail-closed contract as the readiness poll below (review MINOR, codex/L3): this listing
    # used to sit outside the try (which only catches ClientError), so any exception here crashed
    # main() BEFORE ensure_mcp_server_targets ran — blocking the teardown pass for the run.
    # ensure_runtime must never raise; "" (unconfirmed) always lets teardown proceed.
    try:
        existing = {r.get("agentRuntimeName"): r for r in _list_all(ctrl.list_agent_runtimes)}
    except Exception as e:  # noqa: BLE001 — anything here means runtime state is unknowable
        log("runtime", "ERR", f"list_agent_runtimes failed ({type(e).__name__}: {str(e)[:120]}) — treating runtime as unconfirmed")
        return ""
    try:
        if RUNTIME_NAME in existing:
            rid = existing[RUNTIME_NAME].get("agentRuntimeId")
            # v1 quirk: update MUST re-pass roleArn + networkConfiguration.
            resp = ctrl.update_agent_runtime(agentRuntimeId=rid, roleArn=ac["role_arn"],
                                             agentRuntimeArtifact=artifact, networkConfiguration=netcfg,
                                             environmentVariables=env)
            arn = resp.get("agentRuntimeArn") or existing[RUNTIME_NAME].get("agentRuntimeArn")
            log("runtime", "UPDATED", arn)
        else:
            resp = ctrl.create_agent_runtime(agentRuntimeName=RUNTIME_NAME, roleArn=ac["role_arn"],
                                             agentRuntimeArtifact=artifact, networkConfiguration=netcfg,
                                             environmentVariables=env)
            rid = resp.get("agentRuntimeId")
            arn = resp.get("agentRuntimeArn")
            log("runtime", "CREATED", arn)
    except Exception as e:  # noqa: BLE001 — never-raise contract (see the listing/poll blocks)
        # ClientError-only here left BotoCoreError (EndpointConnectionError/ReadTimeout/
        # ParamValidation) escaping to crash main() BEFORE ensure_mcp_server_targets — blocking the
        # teardown pass, e.g. an ack revocation, until a re-run (review MAJOR: this function states
        # its never-raise contract twice and hardened BOTH adjacent blocks with catch-alls for
        # exactly this reason; this middle block was the remaining gap).
        log("runtime", "ERR", f"{type(e).__name__}: {str(e)[:150]}")
        return ""
    # review MAJOR (follow-up): the request above is only ACCEPTED, not live — a caller treating a
    # non-empty ARN as "safe to expose new gateway targets" (main() does, via the ensure_runtime ->
    # ensure_mcp_server_targets ordering) would otherwise race the new revision's actual rollout.
    # FAIL-CLOSED on ANY wait failure, not just a clean False (codex stop-gate on 569105be): an
    # exception escaping here — e.g. a malformed AGENTCORE_RUNTIME_READY_TIMEOUT env — used to
    # propagate out of ensure_runtime and crash main() BEFORE ensure_mcp_server_targets ran, so
    # the very retirement branch this gate feeds was never reached and a stale live target kept
    # serving. Readiness-unconfirmed must always mean "return '' and let the teardown pass run".
    try:
        ready = _wait_runtime_ready(ctrl, rid)
    except Exception as e:  # noqa: BLE001 — anything here means readiness is unconfirmed
        log("runtime:ready", "ERR", f"readiness poll crashed ({type(e).__name__}: {str(e)[:120]}) — treating as not ready")
        ready = False
    if not ready:
        return ""
    return arn


def write_ssm(ac, runtime_arn, interpreter_id, memory_id):
    ssm = boto3.client("ssm", region_name=ac["region"])
    for pname, val in [(ac["ssm_runtime_arn"], runtime_arn),
                       (ac["ssm_interpreter_id"], interpreter_id),
                       (ac["ssm_memory_id"], memory_id)]:
        if not val:
            log(f"ssm:{pname}", "SKIP", "empty value")
            continue
        ssm.put_parameter(Name=pname, Value=val, Type="String", Overwrite=True)
        log(f"ssm:{pname}", "WROTE", val[:60])


def smoke(ac, runtime_arn):
    if not runtime_arn:
        log("smoke", "ERR", "no runtime arn")
        return
    data = boto3.client("bedrock-agentcore", region_name=ac["region"])
    payload = json.dumps({"gateway": "security", "prompt": "List the IAM roles in this account. Use the list_roles tool."}).encode()
    try:
        resp = data.invoke_agent_runtime(agentRuntimeArn=runtime_arn, qualifier="DEFAULT",
                                         runtimeSessionId="p1f-smoke-session-000000000000000000000000000000000",
                                         payload=payload)
        body = resp["response"].read().decode() if hasattr(resp.get("response"), "read") else str(resp.get("response"))
        ok = "role" in body.lower()
        log("smoke", "OK" if ok else "WARN", body[:160])
    except ClientError as e:
        log("smoke", "ERR", str(e)[:160])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="invoke the runtime through one gateway after provisioning")
    args = ap.parse_args()

    ac = tf_outputs()
    region = ac["region"]
    ctrl = boto3.client("bedrock-agentcore-control", region_name=region)

    print(f"\n=== AWSops v2 AgentCore provisioner (region={region}) ===")
    gw_ids = ensure_gateways(ctrl, ac)
    # Load the ADR-017 credentials secret ONCE and share it with both calls below — also lets
    # ensure_targets know which legacy lambda targets ensure_mcp_server_targets owns this run (see
    # ensure_targets' skip_names docstring: without this a legacy target flaps every run).
    secrets, secrets_read_ok = _load_official_mcp_secret(ac)
    legacy_skip = {catalog.legacy_target_name(pk) for pk in _cutover_preset_keys(ac, secrets, secrets_read_ok)}
    legacy_skip.discard(None)
    ensure_targets(ctrl, ac, gw_ids, skip_names=legacy_skip)
    # ensure_runtime BEFORE ensure_mcp_server_targets (review MAJOR L3-1): a gateway mcpServer target
    # is exposed to whatever runtime revision is currently serving the instant it's created. Creating
    # the target first meant the FIRST activation of a preset could hit an old runtime image that
    # predates OFFICIAL_MCP_TOOL_ALLOWLIST_JSON entirely — every vendor tool (including write tools)
    # reaching the model unfiltered for as long as that window lasted, and permanently if ensure_runtime
    # then failed. ensure_runtime only needs ctrl/ac/gw_ids (its allowlist env comes from
    # catalog.MCP_SERVER_TARGETS directly, not from anything ensure_mcp_server_targets produces), so
    # reordering is a pure reorder — the new runtime revision (allowlist included) is live before any
    # mcpServer target that depends on it can exist.
    runtime_arn = ensure_runtime(ctrl, ac, gw_ids)
    # review MAJOR (follow-up): the reorder above closes the WINDOW between target-creation and
    # allowlist-deployment, but ensure_runtime can still fail outright, or accept the request
    # without the new revision actually reaching READY (both now covered — ensure_runtime itself
    # polls for READY and returns "" on failure/timeout). A caller-side skip of the WHOLE
    # ensure_mcp_server_targets call on runtime_arn being falsy would ALSO block its teardown paths
    # (an operator revoking an ack specifically to shut a live target off) — so the call always
    # runs; only its internal create/update/sync path is gated on allow_provision.
    ensure_mcp_server_targets(ctrl, ac, gw_ids, secrets=secrets, secrets_read_ok=secrets_read_ok,
                               allow_provision=bool(runtime_arn))  # ADR-017 curated official-vendor MCP presets
    prune_moved_targets(ctrl, gw_ids)  # remove split-brain orphans after a catalog gateway move
    memory_id = ensure_memory(ctrl)
    interpreter_id = ensure_interpreter(ctrl)
    write_ssm(ac, runtime_arn, interpreter_id, memory_id)

    if args.smoke:
        print("\n=== smoke (runtime -> gateway -> tool) ===")
        # the runtime may need a few seconds after create/update to become invokable
        time.sleep(10)
        smoke(ac, runtime_arn)

    errs = [r for r in report if r[1] == "ERR"]
    print(f"\n=== report: {len(report)} actions, {len(errs)} errors ===")
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
