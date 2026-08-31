"""Network Path Check — `network_path` job (Fargate runtime; see handlers.py's REGISTRY comment on
why: Kubernetes policy evaluation + multi-account route analysis can exceed a short invocation
budget). Implements the design spec's 4 phases: resolve -> discover -> verify -> conclude
(docs/superpowers/specs/2026-08-13-network-path-check-design.md, "Worker" section).

Gating, honestly stated (L5 docs-consistency fix — the previous version of this paragraph claimed a
safety property `handlers.py` does not implement): `handlers.py`'s REGISTRY entry for
`network_path` is NOT conditional on `NETWORK_PATH_CHECK_ENABLED` — it is an unconditional
dict row, and `_network_path()` used to call straight into this module regardless of the flag.
The REAL fail-closed gates today are (a) Terraform: `network-path.tf`'s `local.npc` count is 0
unless both `workers_enabled` and `network_path_check_enabled` are true, so the worker task only
gets the `NETWORK_PATH_CHECK_ENABLED=true` env var when the feature is actually on, and (b) the web
BFF: every Network Path route calls `web/lib/network-path-gate.ts`'s fail-closed gate before a run
can even be created/enqueued. `handlers.py`'s `_network_path()` now ALSO checks the
`NETWORK_PATH_CHECK_ENABLED` env var itself before calling into this module (a second, structurally
independent gate at the dispatch site, closing the gap this docstring used to falsely claim was
already closed) — see handlers.py for that check.

`fetch_live_topology()` below now has a REAL, best-effort body — see its own docstring for exactly
what it can and cannot discover from CACHED Aurora topology alone (`topology_nodes`/`topology_edges`,
`class='infra'` — web/lib/infra-topology.ts's ontology). It deliberately does NOT make any live AWS
or Kubernetes API call (staying inside this session's "no live AWS calls" scope) — the design spec's
"re-read SG/NACL/routes/etc. live at run time" promise remains unimplemented; only the cached-
topology-accelerator half of `discover` is real now. Because of that gap, `run()` still treats ANY
exception during discovery (not just `NetworkPathError`) as a terminal `failed` run, so a caller
whose Aurora connection fails, or any other unexpected fetcher error, ends in a visible `failed` row
instead of crashing uncaught and leaving `network_path_runs` stuck at `running`/`discover`.
`web/lib/network-path-gate.ts`'s `LIVE_TOPOLOGY_IMPLEMENTED` flag is deliberately left `false` — this
pass ships a real, but still openly degraded (cache-only, no live re-read), fetcher, not the full
live-topology guarantee that flag is meant to gate; flipping it is a separate, deliberate product
decision this pass does not make.

`network_path_check_enabled` has no governing ADR (docs-consistency fix, corrected after an earlier
round left this ambiguous): code across this feature (this module, handlers.py, reaper.py, the
network_path_check migration, variables.tf) previously cited "ADR-019 §2 register row" or "governed
under ADR-019's Decision" for this flag. Both phrasings are wrong. `docs/decisions/
019-athena-flow-log-query-classification.md` §Decision is explicit that it does not cover
`network_path_check_enabled` at all — that spec was approved on its own remaining conditions (a
BASELINE.md §2 row + one adapter-safety review pass), independent of ADR-019, and BASELINE.md's own
§2 row for this flag records its 근거 ADR as "—" (none). The only correct citation for this flag's
gating is `docs/decisions/BASELINE.md`'s §2 gate/freeze register row itself — not ADR-019, and not
any other ADR. Every citation of this shape in the network-path code now reads "BASELINE.md §2
register row" without attributing it to ADR-019.

AI boundary (spec): this module never calls a model. It only computes the deterministic checklist.

This module deliberately never imports or calls `agent/lambda/datasource_diag_mcp.py`'s
`_test_http_connectivity` (grep-verified by test_network_path.py) — see network_path_adapters.py's
module docstring for why.

Known structural gap, documented rather than silently implied (L4 finding #13): every layer this
module evaluates is still primarily a SOURCE-side check — `sg`/`nacl`/`route` read the source ENI's
own SG union/NACL/route table. A full bidirectional rewrite (independently evaluating the
destination's own ingress SG/NACL, and return routing for an `aws_resource` destination, as a
first-class part of every candidate) is a larger effort out of scope this round. The cheap
mitigation shipped instead: when the topology fetcher can resolve the destination's OWN describable
ENI (`dest_eni_known` on a candidate's topology hint — see `_layer_plan_for`), a SECOND pass reusing
the exact same `sg`/`nacl` adapters (`eval_security_group`/`eval_nacl`, just given the destination
ENI's own rules/peer identity) runs under the `sg-dst`/`nacl-dst` layer names. This covers the most
common case (a describable destination ENI) but NOT: peering/TGW/VPN/DX-fronted destinations whose
own ENI isn't resolved, ALB/NLB-fronted targets (the target's OWN SG is not independently checked
past `target-group`), or return-path routing on the destination side. A path can still report
`allowed` based on less than the full bidirectional policy surface in those cases.
"""
import base64
import json
import os
import re
import ssl
import time
import uuid
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

import network_path_adapters as ad
import network_path_reduce as reduce

# Host account / readonly-role constants for the live-identity resolve phase below (Gap 4) — a
# local copy of the same names sg_rule_scan.py/schedule_dispatcher.py already each keep independently
# (this repo's established pattern: every worker module owns its own tiny copy rather than importing
# a sibling job's module, since sibling job modules are edited independently and aren't meant to be
# treated as shared libraries).
HOST_ACCOUNT_ID = os.environ.get("AWS_ACCOUNT_ID", "")
READONLY_ROLE_NAME = "AWSopsReadOnlyRole"
_K8S_REQUEST_TIMEOUT_S = 4  # matches web/lib/eks-incluster.ts's K8S_REQUEST_TIMEOUT_MS bound
_PROVIDER_ID_RE = re.compile(r'^aws:///[^/]+/(i-[0-9a-f]+)$')

# CI-review MAJOR fix (round 17): a Kubernetes resource name (namespace/pod/node/cluster) must
# match this safe charset before it's ever interpolated into a K8s API path or the signed
# `x-k8s-aws-id` header — see `_validate_k8s_name` below. Deliberately permissive enough to accept
# every legitimate name shape actually seen here (namespace/pod names are DNS-1123 labels; EC2-
# style Node names are DNS-1123 SUBDOMAINS with dots, e.g. `ip-10-0-1-5.ec2.internal`; EKS cluster
# names allow letters/digits/hyphens/underscores) while still rejecting the one thing that
# matters for path safety: no `/` (or other URL-meaningful characters) can ever appear, so a
# `../`-style segment can never form.
_K8S_NAME_RE = re.compile(r'^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$')

# CI-review MAJOR fix (round 24): `region` is a definition-authored identity field (like
# `cluster`/`namespace`/`pod_name`/`node_name` above) that reaches `boto3.client("sts",
# region_name=region)`, the assumed session's `eks` client, and a hand-built
# `f"https://sts.{region}.amazonaws.com/..."` presigned URL in `_default_k8s_get` — but unlike
# those K8s-name fields, it was never validated at this trust boundary at all (only checked for
# non-emptiness in `resolve_identities()`). Mirrors the sibling `sg_rule_matching._REGION_VALUE_RE`
# (kept as a local copy per this module's own `_assumed_session` convention, not an import).
_REGION_VALUE_RE = re.compile(r'^[a-z]{2,4}(-[a-z]+)+-\d$')

# CI-review MAJOR fix (round 19, item 6, defense-in-depth): `_default_k8s_get` must never issue a
# request to any K8s API path other than the two shapes `resolve_live_identity()` actually needs —
# a Pod GET or a Node GET. `_validate_k8s_name` already constrains the interpolated
# namespace/pod/node segments themselves (no `/`, no path-traversal characters), but this is an
# INDEPENDENT belt-and-suspenders check on the assembled path as a whole: even if some future
# caller/bug builds a differently-shaped path, or the assumed principal's actual cluster RBAC turns
# out to be broader than intended (see the accompanying least-privilege Access Entry fix), this
# code itself can never be made to GET anything else. Checked BEFORE any HTTP request is attempted.
_ALLOWED_K8S_GET_PATH_RE = re.compile(
    r'^/api/v1/namespaces/[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?/pods/'
    r'[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$'
    r'|^/api/v1/nodes/[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$'
)


def _validate_k8s_get_path(path):
    if not _ALLOWED_K8S_GET_PATH_RE.match(path or ""):
        raise NetworkPathError(
            f"refusing to GET disallowed K8s API path {path!r} — only "
            "/api/v1/namespaces/{ns}/pods/{name} and /api/v1/nodes/{name} are permitted")
    return path


class _NoRedirectHandler(HTTPRedirectHandler):
    """MINOR fix: `urlopen`'s default opener silently follows a redirect response, which would
    resend the SAME `Authorization: Bearer <k8s-aws-v1. token>` header to whatever host the
    redirect names — a genuinely different host would then receive this cluster's presigned STS
    token. `redirect_request` returning `None` tells urllib to hand back the redirect response
    itself rather than follow it (see `urllib.request.HTTPRedirectHandler`'s own contract)."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N803 — stdlib signature
        return None


def _NO_REDIRECT_OPENER(ssl_context):  # noqa: N802 — reads as a constructor-like helper at call sites
    return build_opener(_NoRedirectHandler(), HTTPSHandler(context=ssl_context))


# MINOR fix: a raw AWS exception message persisted verbatim into the operator-readable
# `network_path_runs.error` column can embed an ARN/account id/Athena-style UUID identifier — strip
# those patterns (never a full redaction framework, just the common leaky shapes) before persisting.
_ARN_RE = re.compile(r'arn:aws[a-zA-Z0-9-]*:[a-zA-Z0-9-]+:[a-zA-Z0-9-]*:\d{12}:[^\s\'"]+')
_UUID_RE = re.compile(r'\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b')
_ACCOUNT_ID_RE = re.compile(r'(?<!\d)\d{12}(?!\d)')


def _redact_sensitive(text):
    if not text:
        return text
    text = _ARN_RE.sub("<arn-redacted>", text)
    text = _UUID_RE.sub("<id-redacted>", text)
    text = _ACCOUNT_ID_RE.sub("<account-redacted>", text)
    return text

# Global deadline for one run's verify phase. Kept well under typical Fargate task/SFN timeouts.
GLOBAL_DEADLINE_S = 90

# Evidence caps (spec: "Evidence is bounded and redacted before persistence").
_MAX_EVIDENCE_ITEMS = 10
_MAX_EVIDENCE_BYTES = 4_000
_REDACT_KEYS = {
    "secret", "secrets", "password", "token", "credentials", "authkey", "auth_key",
    "customerrouterconfig", "annotations",
}


class NetworkPathError(Exception):
    """Execution-level failure (spec: "Identity cannot be resolved -> run completes `failed`").
    Raised by resolve(); the caller marks the run failed WITHOUT creating any candidate rows."""


def _validate_k8s_name(value, field):
    """CI-review MAJOR fix (round 17): a K8s API path-injection hole — `namespace`/`pod_name`/
    `node_name`/`cluster` used to be interpolated straight from the (user-authored) check
    definition into the K8s API GET path, and `cluster` additionally into the signed
    `x-k8s-aws-id` header, with no validation or escaping. A `../`-style segment let a check
    author steer the read to an arbitrary path under the assumed principal's Access Entry —
    read-only, but an authorization-scope escape. Every one of these fields is checked against
    `_K8S_NAME_RE` before it's used in a URL or header.

    Docs fix: this validator is shared with `cluster`, which is an EKS cluster name, not a
    Kubernetes object name — EKS cluster naming permits uppercase letters and underscores (unlike
    strict K8s DNS-1123 label/subdomain rules, which are lowercase-alphanumerics-and-hyphens
    only). `_K8S_NAME_RE` (`^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$`) is deliberately the
    broader superset so ONE validator covers both cases — it still rejects everything relevant to
    path injection (`/`, whitespace, a leading/trailing separator) while accepting every legitimate
    namespace/pod/node AND cluster name."""
    if not isinstance(value, str) or not _K8S_NAME_RE.match(value):
        raise NetworkPathError(f"{field} is not a valid Kubernetes resource name: {value!r}")
    return value


def _account_external_id(conn, account_id):
    """CI-review MAJOR fix (round 17): confused-deputy regression — `resolve_live_identity()`
    used to pass `src["account_id"]`/`src.get("external_id")` (both straight from the
    user-authored check definition) into `_assumed_session()` with no registry check at all,
    against a wildcard `sts:AssumeRole` grant on `arn:aws:iam::*:role/AWSopsReadOnlyRole`
    (network-path.tf). The sibling worker fixed exactly this class of hole already —
    `sg_rule_scan.py`'s `account_external_id()` requires an ENABLED `accounts` row and raises
    otherwise; this is the same lookup, kept as a local copy per this module's own convention
    (see the constants above)."""
    rows = conn.run("SELECT external_id FROM accounts WHERE account_id=:a AND enabled", a=account_id)
    if not rows:
        raise NetworkPathError(
            f"account_id {account_id!r} is not a registered, enabled account in the accounts "
            "table — refusing to assume a role for an unregistered account")
    return rows[0][0]


# ── Evidence redaction/bounding ──────────────────────────────────────────────────────────────────

def _redact(value):
    if isinstance(value, dict):
        return {k: ("[redacted]" if k.lower() in _REDACT_KEYS else _redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    return value


def bound_evidence(evidence):
    """Cap item count and total serialized size; redact known-sensitive keys. Never raises — a
    caller passing malformed evidence gets an empty, safe list rather than a crash mid-verify."""
    try:
        items = [_redact(e) for e in (evidence or [])][:_MAX_EVIDENCE_ITEMS]
        out = []
        total = 0
        for item in items:
            blob = json.dumps(item, default=str)
            total += len(blob)
            if total > _MAX_EVIDENCE_BYTES:
                break
            out.append(item)
        return out
    except (TypeError, ValueError):
        return []


# ── Phase 1: resolve ──────────────────────────────────────────────────────────────────────────────

def resolve_identities(definition):
    """Resolve/validate the source (Pod/Node) and destination identities declared on the check
    definition. This release resolves identity from the SAVED definition's own declared
    account/region/ENI/subnet fields (populated when the check was created against a specific
    Pod/Node/resource) rather than performing a live Kubernetes API call to re-discover a Pod's
    current IP/ENI at run time — see the report for why this is the honestly-scoped boundary for
    this pass. Raises NetworkPathError (-> run fails directly, no candidates) on anything missing.
    """
    src = definition.get("source") or {}
    dst = definition.get("destination") or {}
    req = definition.get("request") or {}

    if src.get("kind") not in ("pod", "node"):
        raise NetworkPathError(f"unsupported source kind: {src.get('kind')!r}")
    if not src.get("account_id") or not src.get("region"):
        raise NetworkPathError("source account_id/region missing")
    if not src.get("eni_id") and not src.get("subnet_id"):
        raise NetworkPathError("source could not be resolved to an ENI or subnet")

    if dst.get("kind") not in ("aws_resource", "internet", "onprem"):
        raise NetworkPathError(f"unsupported destination kind: {dst.get('kind')!r}")
    if dst["kind"] == "aws_resource" and not (dst.get("eni_id") or dst.get("cidr") or dst.get("ip")):
        raise NetworkPathError("aws_resource destination has no eni_id/cidr/ip")
    if dst["kind"] in ("internet", "onprem") and not (dst.get("ip") or dst.get("host") or dst.get("cidr")):
        raise NetworkPathError(f"{dst['kind']} destination has no ip/host/cidr")

    protocol = req.get("protocol", "tcp")
    if protocol not in ("tcp", "udp", "icmp"):
        raise NetworkPathError(f"unsupported protocol: {protocol!r}")

    return {"source": src, "destination": dst, "request": {**req, "protocol": protocol}}


# ── Phase 1b: live identity confirmation (Gap 4 / PR #231 follow-up) ────────────────────────────
#
# `resolve_identities()` above is deliberately left untouched — it stays pure schema
# validation over the definition's OWN declared fields, exactly as every existing test exercises
# it. This section adds a SEPARATE, additive confirmation step: when a saved check's source
# declares a `cluster` (i.e. it was created against a live Kubernetes Pod/Node rather than a
# directly-known ENI/subnet), `resolve_live_identity()` below re-derives the Pod's real IP/Node and
# the Node's real ENI/subnet/VPC from a LIVE, read-only Kubernetes API GET + a live EC2 Describe —
# instead of trusting the definition's own possibly-stale eni_id/subnet_id fields as already
# verified (design spec's "Source identity" section: Pod IP, Node, ENI, subnet, VPC, VPC CNI/
# SG-for-Pods). A source with no `cluster` declared is left exactly as `resolve_identities()`
# already resolved it -- untouched, no live call attempted.
#
# Per spec's error-handling rule ("Identity cannot be resolved -> run completes `failed` with a
# bounded, non-sensitive error"), every exception from the live K8s/EC2 calls below is caught and
# re-raised as `NetworkPathError` with a `_redact_sensitive`-passed message -- this function NEVER
# falls back to trusting the definition's stale fields as if they were verified live data.


def _assumed_session(account_id, region, external_id=None):
    """Role A (read-only cross-account) — the SAME AWSopsReadOnlyRole trust boundary
    network-path.tf's own IAM grant documents (mirrors sg_rule_scan.py's `_assumed_session`, kept
    as a local copy per this module's own convention — see the constants above)."""
    import boto3
    if account_id == HOST_ACCOUNT_ID:
        return boto3.Session(region_name=region)
    sts = boto3.client("sts", region_name=region)
    kwargs = {
        "RoleArn": f"arn:aws:iam::{account_id}:role/{READONLY_ROLE_NAME}",
        "RoleSessionName": "awsops-network-path", "DurationSeconds": 3600,
    }
    if external_id:
        kwargs["ExternalId"] = external_id
    creds = sts.assume_role(**kwargs)["Credentials"]
    return boto3.Session(
        aws_access_key_id=creds["AccessKeyId"], aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"], region_name=region,
    )


def _instance_id_from_provider_id(provider_id):
    """A K8s Node's `spec.providerID` on EKS is `aws:///<az>/<instance-id>` -- extract the
    instance id, or None if the field is absent/not in that shape (e.g. Fargate profile pods, whose
    virtual Node has no describable EC2 instance at all)."""
    m = _PROVIDER_ID_RE.match(provider_id or "")
    return m.group(1) if m else None


def _default_k8s_get(account_id, region, cluster, path, external_id=None):
    """Read-only GET against the cluster's K8s API, authenticated via the SAME presigned-STS
    `k8s-aws-v1.` bearer token pattern already established in this repo (identical mechanism to
    web/lib/eks-incluster.ts's `eksToken`/`presignEksToken` and
    scripts/v2/workers/insight/k8s_events.py's `_default_getter` — this is that same, precedented
    approach, ported here for Pod/Node reads instead of Events). Requires the assumed session's
    principal (AWSopsReadOnlyRole in a target account, or this worker's own task role in the host
    account) to hold an EKS Access Entry on `cluster` — see the report for why that registration is
    NOT created by this pass's terraform change (mirrors the istio-read MCP precedent: granting a
    principal k8s access is the cluster owner's call, done out-of-band).
    """
    _validate_k8s_get_path(path)
    import boto3
    from botocore.signers import RequestSigner
    session = _assumed_session(account_id, region, external_id)
    eks = session.client("eks")
    c = eks.describe_cluster(name=cluster)["cluster"]
    endpoint, ca = c["endpoint"], c["certificateAuthority"]["data"]
    sts = session.client("sts")
    signer = RequestSigner(sts.meta.service_model.service_id, region, "sts", "v4",
                            sts._request_signer._credentials, sts._request_signer._event_emitter)
    signed = signer.generate_presigned_url(
        {"method": "GET",
         "url": f"https://sts.{region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15",
         "body": {}, "headers": {"x-k8s-aws-id": cluster}, "context": {}},
        region_name=region, expires_in=60, operation_name="")
    token = "k8s-aws-v1." + base64.urlsafe_b64encode(signed.encode()).rstrip(b"=").decode()
    ctx = ssl.create_default_context(cadata=base64.b64decode(ca).decode())
    req = Request(endpoint + path, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    # MINOR fix: `urlopen`'s default opener follows redirects, and a redirect response could carry
    # the same `Authorization` bearer token to a DIFFERENT host than the pinned EKS `endpoint` —
    # `_NoRedirectOpener` refuses to follow any redirect at all rather than trying to verify the
    # target host (the simplest correct fix: this request's only legitimate destination is the
    # cluster's own describe-cluster endpoint, so any redirect response is itself unexpected).
    with _NO_REDIRECT_OPENER(ctx).open(req, timeout=_K8S_REQUEST_TIMEOUT_S) as r:  # noqa: S310 — fixed EKS https endpoint, GET only
        return json.loads(r.read().decode())


def _default_ec2_lookup(account_id, region, instance_id, pod_ip=None, external_id=None):
    """Read-only `DescribeInstances` for the Node's resolved EC2 instance, returning that
    instance's describable ENI/subnet/VPC. When `pod_ip` is given and matches one of the instance's
    attached ENIs' private IPs (VPC CNI secondary-IP / SG-for-Pods branch-ENI placement), THAT ENI
    is returned. When `pod_ip` is NOT given (a bare node source), the instance's primary
    (device-index-0) ENI is used. Raises NetworkPathError (never returns a guess) when the
    instance or a describable ENI isn't found.

    MINOR fix: a pod source whose `pod_ip` matches NO attached ENI (e.g. a SG-for-Pods branch ENI,
    which isn't enumerated under the instance's top-level `NetworkInterfaces` at all) used to
    silently fall back to the instance's primary ENI -- the WRONG ENI for that pod, not a
    describable-but-unrelated one. A pod source must fail closed here rather than resolve to an
    ENI known not to be the pod's; only a bare node source (no `pod_ip` at all) uses the primary-
    ENI fallback, since a Node genuinely IS its primary ENI.

    MINOR fix (CI review): a pod's IP only ever matched against an ENI's own `PrivateIpAddresses`
    -- this misses VPC-CNI *prefix delegation*, where a pod's IP is carved out of an ENI's
    assigned `Ipv4Prefixes` CIDR block(s) rather than appearing as its own discrete secondary IP.
    Every pod on a prefix-delegation-enabled cluster (the CNI's default mode on newer EKS add-on
    versions) used to fail closed here with the SAME "unenumerated SG-for-Pods branch ENI"
    message even though the real cause is unrelated (prefix delegation, not a branch ENI) -- the
    CIDR check below fixes the false negative for the common case, and the error message below no
    longer singles out branch ENIs specifically for whatever (now rarer) case still fails.

    CI-review MAJOR fix (round 22): every check above was IPv4-only (`PrivateIpAddresses`/
    `Ipv4Prefixes`) -- a pod/node on an IPv6 (or dual-stack) EKS cluster failed closed here on
    EVERY live identity resolution, with the same misleading "unenumerated SG-for-Pods branch ENI"
    message this docstring's own prefix-delegation fix already corrected for the IPv4 case. This
    is fail-closed (never a false verdict), so it was a functionality gap rather than an exposure
    -- but it made this feature unusable for an entire cluster family. The equivalent IPv6 fields
    (`Ipv6Addresses`/`Ipv6Prefixes`) are now checked the same way."""
    session = _assumed_session(account_id, region, external_id)
    ec2 = session.client("ec2")
    resp = ec2.describe_instances(InstanceIds=[instance_id])
    instances = [i for r in (resp.get("Reservations") or []) for i in r.get("Instances", [])]
    if not instances:
        raise NetworkPathError(f"EC2 instance {instance_id} not found (DescribeInstances returned none)")
    inst = instances[0]
    enis = inst.get("NetworkInterfaces") or []
    eni = None
    if pod_ip:
        def _eni_owns_pod_ip(ni):
            if any(pa.get("PrivateIpAddress") == pod_ip for pa in ni.get("PrivateIpAddresses", [])):
                return True
            if any(pa.get("Ipv6Address") == pod_ip for pa in ni.get("Ipv6Addresses", [])):
                return True
            # VPC-CNI prefix delegation: the pod's IP is carved out of an assigned prefix on the
            # ENI (IPv4 /28-or-other, or IPv6), not listed as a discrete address of its own.
            prefixes = (ni.get("Ipv4Prefixes") or []) + (ni.get("Ipv6Prefixes") or [])
            return any(
                ad._is_valid_ip(pod_ip) and ad._cidr_contains(p.get("Ipv4Prefix") or p.get("Ipv6Prefix"), pod_ip)
                for p in prefixes if p.get("Ipv4Prefix") or p.get("Ipv6Prefix"))

        eni = next((ni for ni in enis if _eni_owns_pod_ip(ni)), None)
        if eni is None:
            raise NetworkPathError(
                f"pod IP {pod_ip} does not match any network interface attached to EC2 instance "
                f"{instance_id} (checked discrete secondary IPv4/IPv6 addresses and any VPC-CNI "
                "prefix-delegation Ipv4Prefixes/Ipv6Prefixes CIDRs; could also be an unenumerated "
                "SG-for-Pods branch ENI) -- refusing to guess by falling back to the instance's "
                "primary ENI")
    else:
        eni = next((ni for ni in enis if (ni.get("Attachment") or {}).get("DeviceIndex") == 0), None)
    if eni is None:
        raise NetworkPathError(f"EC2 instance {instance_id} has no describable network interface")
    return {
        "instance_id": instance_id,
        "eni_id": eni.get("NetworkInterfaceId"),
        "subnet_id": eni.get("SubnetId") or inst.get("SubnetId"),
        "vpc_id": eni.get("VpcId") or inst.get("VpcId"),
    }


def resolve_live_identity(resolved, conn, k8s_get=None, ec2_lookup=None):
    """Confirm a `pod`/`node` source's identity against the LIVE K8s/EC2 state (Gap 4) rather than
    trusting the saved definition's own eni_id/subnet_id fields as already verified. No-op (returns
    `resolved` unchanged) when the source declares no `cluster` -- that's the "directly-known
    ENI/subnet" path `resolve_identities()` already fully resolves, untouched by this function.

    On success, returns a new `resolved` dict whose `source` has been updated with the REAL
    `pod_ip` (pod source only)/`node_name`/`instance_id`/`eni_id`/`subnet_id`/`vpc_id` -- these
    values now come from a live GET/Describe, not from whatever the definition happened to declare.

    Raises NetworkPathError on: pod/node not found, the pod having no assigned IP/node yet, the
    K8s API/cluster being unreachable, the node having no resolvable EC2 providerID (e.g. a
    Fargate-profile virtual node), or the resolved EC2 instance/ENI not being describable. Per
    spec's "Identity cannot be resolved -> run completes `failed`" rule, this function never
    degrades to trusting the definition's stale fields on any of these failures.

    CI-review MAJOR fix (round 17): `conn` is now REQUIRED (not optional) — `external_id` is no
    longer trusted from the definition's own `src.get("external_id")` (a confused-deputy hole: the
    IAM grant is a wildcard `sts:AssumeRole` on `arn:aws:iam::*:role/AWSopsReadOnlyRole`, so a
    user-authored `account_id`/`external_id` pair could target ANY account with that role). It is
    now resolved server-side from the same enabled `accounts` registry `sg_rule_scan.py`'s
    `account_external_id()` already enforces for the sibling worker — see `_account_external_id`.
    """
    src = resolved["source"]
    cluster = src.get("cluster")
    if not cluster:
        return resolved
    cluster = _validate_k8s_name(cluster, "cluster")

    account_id, region = src["account_id"], src["region"]
    if not isinstance(region, str) or not _REGION_VALUE_RE.match(region):
        raise NetworkPathError(f"source.region {region!r} is not a valid AWS region name")
    external_id = None if account_id == HOST_ACCOUNT_ID else _account_external_id(conn, account_id)
    k8s_get = k8s_get or _default_k8s_get
    ec2_lookup = ec2_lookup or _default_ec2_lookup

    pod_ip = None
    if src["kind"] == "pod":
        namespace, pod_name = src.get("namespace"), src.get("pod_name")
        if not namespace or not pod_name:
            raise NetworkPathError("pod source declares a cluster but is missing namespace/pod_name")
        namespace = _validate_k8s_name(namespace, "namespace")
        pod_name = _validate_k8s_name(pod_name, "pod_name")
        try:
            pod = k8s_get(account_id, region, cluster, f"/api/v1/namespaces/{namespace}/pods/{pod_name}",
                          external_id)
        except Exception as e:  # noqa: BLE001 — any transport/auth/404 failure -> bounded failed run
            raise NetworkPathError(_redact_sensitive(
                f"could not resolve pod {namespace}/{pod_name} on cluster {cluster}: "
                f"{type(e).__name__}: {e}")) from e
        status = pod.get("status") or {}
        pod_ip = status.get("podIP")
        node_name = (pod.get("spec") or {}).get("nodeName")
        if not pod_ip or not node_name:
            raise NetworkPathError(
                f"pod {namespace}/{pod_name} on cluster {cluster} has no assigned IP/node "
                f"(phase={status.get('phase') or 'unknown'})")
    elif src["kind"] == "node":
        node_name = src.get("node_name")
        if not node_name:
            raise NetworkPathError("node source declares a cluster but is missing node_name")
    else:
        return resolved  # a cluster with neither pod nor node kind has nothing to confirm here

    node_name = _validate_k8s_name(node_name, "node_name")
    try:
        node = k8s_get(account_id, region, cluster, f"/api/v1/nodes/{node_name}", external_id)
    except Exception as e:  # noqa: BLE001
        raise NetworkPathError(_redact_sensitive(
            f"could not resolve node {node_name} on cluster {cluster}: {type(e).__name__}: {e}")) from e
    instance_id = _instance_id_from_provider_id((node.get("spec") or {}).get("providerID"))
    if not instance_id:
        raise NetworkPathError(f"node {node_name} on cluster {cluster} has no resolvable EC2 providerID")

    try:
        placement = ec2_lookup(account_id, region, instance_id, pod_ip, external_id)
    except NetworkPathError:
        raise
    except Exception as e:  # noqa: BLE001
        raise NetworkPathError(_redact_sensitive(
            f"could not resolve EC2 instance {instance_id} for node {node_name}: "
            f"{type(e).__name__}: {e}")) from e

    confirmed = dict(src)
    confirmed.update({
        "node_name": node_name,
        "instance_id": placement["instance_id"],
        "eni_id": placement["eni_id"],
        "subnet_id": placement["subnet_id"],
        "vpc_id": placement.get("vpc_id"),
    })
    if pod_ip:
        confirmed["pod_ip"] = pod_ip
    return {**resolved, "source": confirmed}


# ── Phase 2: discover ────────────────────────────────────────────────────────────────────────────

# Mesh-policy layers (single source of truth for both `_layer_plan_for`'s L4 finding #12 wiring
# below AND `_ADAPTER_BY_LAYER`'s registration below). "calico" gets a REAL evaluator
# (`ad.eval_calico_policy`, wired explicitly further down) — it stays listed here because it's still
# one of the layers `_layer_plan_for` inserts alongside the others whenever a candidate's
# destination is a Kubernetes Pod/Service. "cilium"/"istio-*" stay bounded stubs (detection-only —
# see `ad.eval_mesh_policy_stub`'s docstring for what "detection" already means today).
_MESH_KINDS = ("calico", "cilium", "istio-virtualservice", "istio-destinationrule", "istio-gateway",
               "istio-authorizationpolicy", "istio-peerauthentication")
_STUB_MESH_KINDS = tuple(k for k in _MESH_KINDS if k != "calico")
_MESH_LAYERS = [f"k8s-{_kind}" for _kind in _MESH_KINDS]


def _layer_plan_for(destination_kind, topology_hint):
    """Which layers apply to a candidate, in evaluation order — a layer irrelevant to this
    candidate's destination kind is simply never in this list (never persisted as `unknown`, per
    spec: "a layer that doesn't apply to a given candidate is omitted from that candidate's step
    list rather than marked unknown")."""
    plan = ["sg", "nacl", "route"]
    if destination_kind == "aws_resource":
        if topology_hint.get("via") == "peering":
            plan.append("peering")
        elif topology_hint.get("via") == "tgw":
            plan.append("tgw")
        if topology_hint.get("via") == "alb":
            plan += ["alb-listener", "target-group"]
        if topology_hint.get("via") == "k8s-service":
            # Gap 3: Ingress -> Service -> EndpointSlice resolution (ad.eval_k8s_service_resolution
            # is a real evaluator — see its docstring for why it's still unreachable in practice
            # today: this worker has no live K8s client to populate `via`/the layer's own data at
            # all; wiring is a data-plumbing change only once one exists).
            plan.append("k8s-service-resolution")
        # L4 finding #13 (cheap mitigation): every layer above evaluates the SOURCE ENI's own
        # SG/NACL/route only — the destination side's ingress SG/NACL (and return routing for an
        # aws_resource destination) is a real, documented structural gap (a full bidirectional
        # rewrite is out of scope this round — see the report). When the topology fetcher DOES know
        # the destination's own describable ENI (`dest_eni_known`), add a second pass reusing the
        # SAME sg/nacl adapters, just evaluated against the destination ENI's own data (peer/local
        # roles swapped) — cheap because it's the same functions, not a new evaluation engine.
        if topology_hint.get("dest_eni_known"):
            plan += ["sg-dst", "nacl-dst"]
    elif destination_kind == "internet":
        if topology_hint.get("network_firewall"):
            plan.append("network-firewall")
        plan.append("dns")
    elif destination_kind == "onprem":
        plan.append(topology_hint.get("boundary", "vpn"))  # 'vpn' or 'dx'
        plan.append("onprem-segment")  # always `unknown` past the AWS boundary
    if topology_hint.get("k8s_network_policy"):
        plan.insert(0, "k8s-networkpolicy")
        # L4 finding #12: the mesh-policy layers (Calico/Cilium/Istio) were registered in
        # `_ADAPTER_BY_LAYER` but never inserted into any candidate's plan — a real mesh policy
        # that would block the path was never even checked (not even to record `unknown`), so a
        # candidate could reach `allowed` with an empty `unknown_layers` list, silently omitting a
        # policy surface that might actually be the one blocking it. No mesh-CRD-presence signal
        # exists in the topology hint yet, so the conservative, honest fix (per the report) is:
        # whenever the destination is a Kubernetes Pod/Service at all (the same `k8s_network_policy`
        # hint that gates k8s-networkpolicy itself), unconditionally include every mesh layer too —
        # each one is still a bounded stub (`eval_mesh_policy_stub`) that only ever returns
        # `unknown`, so this never fabricates a confident allowed/blocked, it just makes the
        # unevaluated surface VISIBLE instead of silently absent.
        plan += _MESH_LAYERS
    return plan


def discover_candidates(resolved, topology):
    """`topology`: caller-supplied (production: fetched live from cached topology tables + a live
    AWS re-read of the specific candidate path, per spec's "Candidate cache and live evidence";
    tests: a fixture). Shape:

        {"candidates": [{"kind": "resolved"|"hypothesis", "via": str, "data": {...}}, ...]}

    Both ECMP and NAT Gateway candidates MUST be tagged `hypothesis` by the caller building
    `topology["candidates"]` — this function trusts the caller's `kind` rather than re-deriving it,
    because the ECMP-vs-NAT-vs-genuine-LB-redundancy distinction depends on live AWS state
    (multi-target-group health, route-table NAT Gateway target, ECMP hash) that only the topology
    fetcher has. Discovery ALWAYS produces at least one candidate; a topology fetcher that found
    nothing must supply a single degraded candidate rather than an empty list, so a genuine "no path"
    still reduces through the normal candidate machinery instead of silently returning zero evidence.
    """
    raw = topology.get("candidates") or []
    if not raw:
        raise NetworkPathError("discovery produced zero candidates")
    out = []
    for i, cand in enumerate(raw):
        kind = cand.get("kind")
        if kind not in ("resolved", "hypothesis"):
            raise NetworkPathError(f"candidate {i} has invalid kind {kind!r}")
        layer_plan = _layer_plan_for(resolved["destination"]["kind"], cand)
        out.append({
            "candidate_id": f"c{i}",
            "kind": kind,
            "layer_plan": layer_plan,
            "data": cand.get("data", {}),
            "account_id": cand.get("account_id") or resolved["source"]["account_id"],
            "region": cand.get("region") or resolved["source"]["region"],
        })
    return out


# ── Phase 3: verify ──────────────────────────────────────────────────────────────────────────────

def _nacl_or_unknown(data, req, layer="nacl"):
    """Gap 1 safety fix: a real NACL always carries entries (including the implicit deny-all rule
    32767) — an EMPTY `nacl_forward` list from a topology fetcher means "we have no cached/live NACL
    data for this candidate", not "this NACL genuinely has zero entries" (that state can't occur on
    a real AWS NACL). `ad.eval_nacl` has no way to distinguish those two from an empty list alone
    (its first-match loop finds nothing -> a confident deny), so this wrapper makes the distinction
    explicit BEFORE calling into the adapter — the same "never invent a false verdict from missing
    data" rule every other adapter in this module already implements for its own missing-input case.

    CI-review MAJOR fix (round 18): this guard used to check `nacl_forward` only — the SAME "a
    real NACL always carries at least the implicit rule 32767, in BOTH directions" premise applies
    equally to `nacl_return`, but an empty return list fell straight through to `ad.eval_nacl`,
    which reads `ret is None`-shaped emptiness as a confident deny on the return path. Missing
    return data is exactly as "we have no data for this candidate" as missing forward data — guard
    both.
    """
    if not data.get("nacl_forward") or not data.get("nacl_return"):
        return {"layer": layer, "status": "unknown", "resource": None,
                "summary": "no cached/live NACL entries available for this candidate", "evidence": []}
    return ad.eval_nacl(data.get("nacl_forward", []), data.get("nacl_return", []),
                         req["protocol"], req.get("port"), peer_ip=data.get("peer_ip"), layer=layer)


_ADAPTER_BY_LAYER = {
    "sg": lambda data, req: ad.eval_security_group(
        data.get("sg_rules", []), req["protocol"], req.get("port"),
        peer_ip=data.get("peer_ip"), peer_sg_ids=data.get("peer_sg_ids")),
    "nacl": lambda data, req: _nacl_or_unknown(data, req, "nacl"),
    "route": lambda data, req: ad.eval_route(data.get("route_table", []), data.get("dest_cidr")),
    # L4 finding #13: destination-side SG/NACL pass for an aws_resource destination whose own ENI
    # is describable (`dest_eni_known` hint) — the SAME adapters as "sg"/"nacl" above, just given
    # the destination ENI's own attached rules/peer identity (source and destination roles
    # swapped), under a distinct layer name so both passes' steps are independently visible.
    "sg-dst": lambda data, req: ad.eval_security_group(
        data.get("sg_rules", []), req["protocol"], req.get("port"),
        peer_ip=data.get("peer_ip"), peer_sg_ids=data.get("peer_sg_ids"), layer="sg-dst"),
    "nacl-dst": lambda data, req: _nacl_or_unknown(data, req, "nacl-dst"),
    "tgw": lambda data, req: ad.eval_tgw(
        data.get("attachment_state"), data.get("associated", False),
        data.get("propagation_enabled", False), data.get("route_entry")),
    "peering": lambda data, req: ad.eval_peering(data.get("state")),
    # CI-review MAJOR fix (round 25): `route_present` used to default to `False` on absence —
    # indistinguishable from a CONFIRMED-absent route, so `eval_vpn_or_dx`'s own `None`-vs-`False`
    # guard (added to fix exactly this class of bug for `aws_side_state`) never actually fired for
    # `route_present`, since this wiring collapsed the absence to `False` before the adapter ever
    # saw it. No default now, so an unfetched marker reaches the adapter as `None`.
    "vpn": lambda data, req: ad.eval_vpn_or_dx("vpn", data.get("aws_side_state"), data.get("route_present")),
    "dx": lambda data, req: ad.eval_vpn_or_dx("dx", data.get("aws_side_state"), data.get("route_present")),
    "network-firewall": lambda data, req: ad.eval_network_firewall(
        data.get("rule_action"), uninspectable=data.get("uninspectable", False)),
    "alb-listener": lambda data, req: ad.eval_alb_listener(data.get("rules", []), data.get("request", {})),
    "target-group": lambda data, req: ad.eval_target_group_health(
        data.get("healthy_target_count", 0), data.get("total_target_count", 0)),
    "k8s-networkpolicy": lambda data, req: ad.eval_k8s_network_policy(
        data.get("policies", []), data.get("pod_labels", {}), data.get("direction", "egress"),
        peer_labels=data.get("peer_labels"), peer_ip=data.get("peer_ip"),
        protocol=req.get("protocol"), port=req.get("port"),
        # L4 finding #10c: the topology fetcher (once implemented) must set `policies_fetched:
        # False` explicitly when it could not actually retrieve NetworkPolicy data for this pod/
        # namespace — an empty `policies` list defaults to "fetched, genuinely none" (`True`) since
        # that's the correct interpretation for every fixture-driven test today.
        data_available=data.get("policies_fetched", True),
        peer_namespace_labels=data.get("peer_namespace_labels"),
        # item 2c follow-up fix: threaded through once the topology fetcher can supply them — a
        # bare podSelector peer is only a confident match when both are known and equal (see
        # eval_k8s_network_policy's own docstring); neither is set by any fixture today, so this is
        # a no-op until the fetcher is implemented, deliberately not changing current behavior.
        policy_namespace=data.get("policy_namespace"), peer_namespace=data.get("peer_namespace")),
    # Gap 3: real Route 53 evaluation (ad.eval_route53_resolution) — degrades to `unknown` on its
    # own when the caller has no zone-record data (`records_fetched: False`), same pattern as
    # k8s-networkpolicy's `data_available`. Nothing in this pass's `fetch_live_topology` (cached
    # Aurora topology only, no live Route53 read) ever populates real records, so today this still
    # reports `unknown` in practice — but the evaluator itself is now real, ready for that data the
    # moment a caller supplies it (see the report).
    "dns": lambda data, req: ad.eval_route53_resolution(
        data.get("records", []), data.get("query_host"),
        data_available=data.get("records_fetched", False)),
    "onprem-segment": lambda data, req: {
        "layer": "onprem-segment", "status": "unknown", "resource": None,
        "summary": "on-premises segment past the AWS boundary is always unknown (spec Explicit exclusions)",
        "evidence": [],
    },
    # Gap 3: real Ingress -> Service -> EndpointSlice evaluation (ad.eval_k8s_service_resolution) —
    # see network_path_adapters.py's docstring for why this worker can't populate real data for it
    # yet (no live K8s client anywhere in this worker); `data_available` defaults False here for the
    # same "no data plumbed in yet" reason as "dns" above.
    "k8s-service-resolution": lambda data, req: ad.eval_k8s_service_resolution(
        data.get("ingress_rules", []), data.get("services", {}), data.get("endpoint_slices", {}),
        {"host": data.get("host"), "path": data.get("path"), "port": req.get("port")},
        data_available=data.get("resolved_fetched", False)),
    # Gap 2: Calico gets a REAL evaluator now (ad.eval_calico_policy) — wired explicitly rather than
    # through the generic stub loop below, which stays for Cilium/Istio only.
    #
    # CI-review MAJOR fix (round 23): `data_available` used to default `policies_fetched` to
    # `True` — inconsistent with the sibling "dns"/"k8s-service-resolution" wiring above, which
    # both default their own fetched-markers to `False` (no data plumbed in yet), and a
    # regression versus the OLD stub this adapter replaced (`eval_mesh_policy_stub`, which only
    # ever consumed detection-only data and always returned `unknown`). Partially-populated data
    # with the marker simply absent (a real risk once a caller starts supplying SOME Calico
    # fields but not yet this one) used to reach a confident `allowed`/`blocked` from data this
    # worker never actually fetched — the exact contract violation this series exists to close.
    # `crd_present` still defaults `False` so a fully-empty data dict degrades honestly either
    # way, but the fail-open specifically needed partially-populated data to trigger.
    # CI-review MAJOR fix (round 24): `pod_labels` used to default to `{}` on absence — silently
    # indistinguishable from a real, confirmed-empty label set, letting every policy selector term
    # confidently non-match and reach a confident `allowed`. `eval_calico_policy` (via
    # `_calico_selector_matches`) now itself guards `pod_labels is None` -> `unknown`; the default
    # here is removed so that guard actually fires on absent data instead of being pre-empted.
    "k8s-calico": lambda data, req: ad.eval_calico_policy(
        data.get("policies", []), data.get("pod_labels"), data.get("direction", "egress"),
        crd_present=data.get("crd_present", False), observed_api_version=data.get("api_version"),
        peer_labels=data.get("peer_labels"), peer_ip=data.get("peer_ip"),
        peer_namespace_labels=data.get("peer_namespace_labels"),
        protocol=req.get("protocol"), port=req.get("port"),
        data_available=data.get("policies_fetched", False)),
}

# Cilium/Istio stay true bounded stubs (K8s mesh policy) routed through the shared stub evaluator —
# Calico is excluded (see the explicit "k8s-calico" entry above).
for _kind in _STUB_MESH_KINDS:
    _ADAPTER_BY_LAYER[f"k8s-{_kind}"] = (
        lambda data, req, _k=_kind: ad.eval_mesh_policy_stub(
            _k, data.get("api_version"), data.get("crd_present", False)))


def verify_candidate(candidate, request, deadline_at, now=time.monotonic):
    """Run every layer in `candidate['layer_plan']` in order, stopping (marking the rest `not_run`)
    once the global deadline is reached. One adapter's exception makes ONLY that layer `unknown` —
    per spec Error handling: "One adapter failure -> that layer is `?`; unrelated layers continue."
    Returns the list of step dicts (ordinal assigned in plan order, starting at 0).
    """
    steps = []
    deadline_hit = False
    for ordinal, layer in enumerate(candidate["layer_plan"]):
        if deadline_hit or now() >= deadline_at:
            deadline_hit = True
            steps.append({"ordinal": ordinal, "layer": layer, "status": "not_run",
                          "resource": None, "summary": "global deadline reached before this layer ran",
                          "evidence": []})
            continue
        fn = _ADAPTER_BY_LAYER.get(layer)
        if fn is None:
            steps.append({"ordinal": ordinal, "layer": layer, "status": "unknown", "resource": None,
                          "summary": f"no adapter registered for layer {layer!r}", "evidence": []})
            continue
        try:
            result = fn(candidate["data"].get(layer, {}), request)
        except Exception as e:  # noqa: BLE001 — isolate adapter failure to this one layer
            result = {"layer": layer, "status": "unknown", "resource": None,
                      "summary": f"adapter error: {e}", "evidence": []}
        result = dict(result)
        result["evidence"] = bound_evidence(result.get("evidence"))
        result["ordinal"] = ordinal
        steps.append(result)
    return steps


# ── Phase 4: conclude ────────────────────────────────────────────────────────────────────────────

def conclude(candidates_with_steps):
    """`candidates_with_steps`: [{"candidate_id","kind","steps":[{...status...}]}].
    Returns (per_candidate: [{"candidate_id","kind","status","first_blocker"}], overall_status).
    """
    per_candidate = []
    for c in candidates_with_steps:
        statuses = [s["status"] for s in c["steps"]]
        status = reduce.reduce_candidate_status(statuses)
        first_blocker = next(
            (f"{s['layer']}: {s['summary']}" for s in c["steps"] if s["status"] == "blocked"), None)
        per_candidate.append({
            "candidate_id": c["candidate_id"], "kind": c["kind"],
            "status": status, "first_blocker": first_blocker,
        })
    overall = reduce.reduce_overall_status(
        [{"kind": c["kind"], "status": c["status"]} for c in per_candidate])
    return per_candidate, overall


def build_validation_bundle(candidates_with_steps, overall_status):
    """Spec: appears iff no `X` anywhere and every AWSops-inspectable layer is `O`; any `?` layer is
    explicitly listed. AWSops never executes this bundle (Explicit exclusions) — it is operator-run
    text/commands only, and this function only ever returns descriptive strings, never runs anything.
    """
    all_steps = [s for c in candidates_with_steps for s in c["steps"]]
    if overall_status != "allowed":
        return None
    if any(s["status"] == "blocked" for s in all_steps):
        return None
    if any(s["status"] in ("conditional", "not_run") for s in all_steps):
        return None
    unknown_layers = sorted({s["layer"] for s in all_steps if s["status"] == "unknown"})
    return {
        "note": "Operator-run validation only — AWSops does not execute these commands.",
        "unknown_layers": unknown_layers,
        "suggested_checks": (
            ["Confirm the customer-managed on-premises segment separately (out of AWSops's visibility)."]
            if unknown_layers else []
        ),
    }


# ── Aurora I/O ───────────────────────────────────────────────────────────────────────────────────

def _update_phase(conn, run_id, phase):
    conn.run("UPDATE network_path_runs SET phase=:p WHERE id=:id", p=phase, id=run_id)


def _insert_candidate(conn, run_id, candidate_id, kind):
    conn.run(
        "INSERT INTO network_path_run_candidates (run_id, candidate_id, candidate_kind) "
        "VALUES (:r, :c, :k)", r=run_id, c=candidate_id, k=kind)


def _insert_steps(conn, run_id, candidate_id, account_id, region, steps):
    for s in steps:
        conn.run(
            "INSERT INTO network_path_run_steps "
            "(run_id, candidate_id, account_id, region, ordinal, layer, status, resource, summary, "
            "evidence, observed_at) "
            "VALUES (:r, :c, :a, :rg, :o, :l, :st, :res, :sum, :ev::jsonb, now())",
            r=run_id, c=candidate_id, a=account_id, rg=region, o=s["ordinal"], l=s["layer"],
            st=s["status"], res=s.get("resource"), sum=s["summary"], ev=json.dumps(s["evidence"]))


def _update_candidate_result(conn, run_id, candidate_id, status, first_blocker):
    conn.run(
        "UPDATE network_path_run_candidates SET status=:s, first_blocker=:fb "
        "WHERE run_id=:r AND candidate_id=:c",
        s=status, fb=first_blocker, r=run_id, c=candidate_id)


def _finish_run(conn, run_id, status, overall_status=None, validation_bundle=None, error=None):
    """MINOR fix (round-2 report): `error` is now persisted (network_path_runs.error, added by
    migration 01M0CZS7GZJJJ7S050Y9Z04964) — a failed run previously left no trace of WHY it failed
    anywhere the API/UI could read, even though `run()`'s own in-memory return value always had
    the string."""
    conn.run(
        "UPDATE network_path_runs SET status=:s, overall_status=:os, validation_bundle=:vb::jsonb, "
        "error=:err, finished_at=now() WHERE id=:id",
        s=status, os=overall_status,
        vb=(json.dumps(validation_bundle) if validation_bundle is not None else None),
        err=error, id=run_id)


def _find_infra_node(conn, account_id, ref):
    """Best-effort lookup of ONE cached-topology resource node whose id ends with `ref` (infra-class
    node ids are `${resource_type}:${resource_id}` — web/lib/infra-topology.ts's `buildInfraGraph`;
    there is no ENI-specific node kind in this graph today, so this only matches when `ref` (an ENI
    id, IP, or subnet id) happens to literally be some inventoried resource's own id — reliable for
    an `aws_resource` destination given directly by instance/RDS/ALB id, unreliable for a Pod's own
    ENI id, which is rarely also a top-level inventoried resource id). Returns `None` on no match or
    on an AMBIGUOUS match (more than one row) — an ambiguous match is exactly the "can't confidently
    resolve a unique path" case the caller must degrade on, never guess by picking one arbitrarily.
    """
    if not ref:
        return None
    # CI-review MAJOR fix (round 17): `(account_id=:a OR account_id='self')` unconditionally
    # admitted host-account ('self') rows even for a MEMBER-account check — `'self'` is the host
    # sentinel used throughout inventory/topology tables (web/lib/inventory.ts,
    # web/lib/sg-analysis.ts), so a member-account check could have its placement/candidate
    # topology silently computed from the HOST account's own graph. The 'self' alternative must
    # only ever apply when `account_id` genuinely IS the host account.
    account_filter = "(account_id=:a OR account_id='self')" if account_id == HOST_ACCOUNT_ID else "account_id=:a"
    # MINOR fix: `ref` is a definition-authored value (an ENI id, IP, or subnet id straight off the
    # check's own JSON) interpolated into a LIKE pattern -- an unescaped `%`/`_` in it are SQL LIKE
    # wildcard metacharacters (not injection, the query is otherwise parameterized, but they widen
    # the match to unrelated node ids), which could misattribute a different same-account
    # resource's placement data to this candidate. Escape them (and any literal backslash, the
    # escape character itself) before building the pattern.
    escaped_ref = str(ref).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    rows = conn.run(
        f"SELECT id, kind FROM topology_nodes WHERE class='infra' "
        f"AND {account_filter} AND id LIKE :pat ESCAPE '\\' LIMIT 2",
        a=account_id, pat=f"%:{escaped_ref}")
    if len(rows) != 1:
        return None
    node_id, kind = rows[0]
    return {"id": node_id, "kind": kind}


def _infra_placement(conn, account_id, node_id):
    """This candidate's cached `infra:in_vpc`/`infra:in_subnet`/`infra:uses_sg` edges (see
    web/lib/infra-topology.ts) — resource<->vpc/subnet/sg MEMBERSHIP only, never rule/ACL/route
    CONTENT (that's not in this table at all, see `fetch_live_topology`'s own docstring)."""
    # CI-review MAJOR fix (round 17): same cross-account leak as `_find_infra_node` above — the
    # 'self' host sentinel must not be admitted for a member-account check.
    account_filter = "(account_id=:a OR account_id='self')" if account_id == HOST_ACCOUNT_ID else "account_id=:a"
    rows = conn.run(
        f"SELECT rel, target FROM topology_edges WHERE class='infra' "
        f"AND {account_filter} AND source=:s",
        a=account_id, s=node_id)
    vpc = subnet = None
    sg_ids = []
    for rel, target in rows:
        if rel == "infra:in_vpc":
            vpc = target
        elif rel == "infra:in_subnet":
            subnet = target
        elif rel == "infra:uses_sg":
            sg_ids.append(target)
    return {"vpc": vpc, "subnet": subnet, "sg_ids": sg_ids}


def fetch_live_topology(resolved, conn):
    """Best-effort candidate-path discovery from CACHED Aurora topology alone
    (`topology_nodes`/`topology_edges`, `class='infra'` — web/lib/infra-topology.ts's ontology,
    materialized by `graph-store.rebuildInfraGraph` from synced inventory). Deliberately makes NO
    live AWS or Kubernetes API call — see this module's own top docstring for why that's the scope
    of this pass, and the design spec's own "Follow-up correction" note that a full live re-read was
    never actually shipped.

    What this CAN honestly discover from the cached infra graph:
      - whether the source and (for an `aws_resource` destination) destination each resolve to a
        SINGLE, unambiguous inventoried resource node (`_find_infra_node`);
      - that resource's VPC/subnet placement and attached Security Group ids
        (`_infra_placement` — MEMBERSHIP only);
      - whether source and destination share the same VPC (`same_vpc`).

    What this CANNOT discover from the cached infra graph, and never fabricates:
      - the actual CONTENT of any Security Group's rules, any NACL's entries, or any route table's
        entries — `topology_edges` records only *that* a resource uses a given SG/subnet, never
        *what* that SG/NACL/route table actually allows. Feeding the SG ids we DO know (as
        `peer_sg_ids`) into `eval_security_group` alongside an EMPTY rule list would make that
        adapter return a confident, FABRICATED `blocked` (no rule in an empty list ever matches) —
        exactly the false verdict this feature's own "never invent O or X from missing data" rule
        forbids. So this fetcher deliberately leaves the `sg`/`nacl`/`route` (and `sg-dst`/
        `nacl-dst`) layers' `data` empty; every one of those adapters (or, for `nacl`/`nacl-dst`,
        network_path.py's own `_nacl_or_unknown` wrapper) already degrades an empty/missing input to
        `unknown` on its own — no adapter changes were needed to make that honest.
      - TGW attachments, VPN/DX AWS-side state, Network Firewall policy, ELBv2 listener/target-group
        config, or any Kubernetes policy/CRD content — none of these have a cached-topology
        representation at all today. For `tgw`/`network-firewall`/`alb-listener`/`k8s-service-
        resolution`, `_layer_plan_for` only adds the layer when the topology hint says so, and this
        fetcher never sets those hints, so those layers are correctly never added at all.

        CI-review MAJOR fix (round 19): the `onprem` case is DIFFERENT and this docstring's blanket
        "simply never added" claim was false for it — `_layer_plan_for` appends the `vpn`/`dx` layer
        UNCONDITIONALLY for an `onprem` destination (`plan.append(topology_hint.get("boundary",
        "vpn"))`), regardless of what this fetcher's hints contain. Before this fix, the layer WAS
        added with no `aws_side_state`/`route_present` data, and `eval_vpn_or_dx` treated a missing
        `aws_side_state` the same as a confirmed-down one — a confident `blocked` fabricated from
        missing data, the exact failure mode this fetcher otherwise takes care to avoid for
        `sg`/`nacl`/`route` above. `eval_vpn_or_dx` now degrades a `None` `aws_side_state` to
        `unknown` (round 19), and a `None` `route_present` the same way (round 25 — this wiring's
        own `route_present` default was removed so the adapter's guard actually sees the absence
        instead of a masking `False`), so this fetcher's on-prem candidates correctly report
        unknown for either missing marker.

    Candidate `kind`: `resolved` only when discovery found the source (and, for an `aws_resource`
    destination, the destination) as a SINGLE unambiguous node — i.e. path-finding itself hit no
    ambiguity, even though the DEPTH of what it found is shallow. `hypothesis` whenever a required
    node could not be resolved uniquely (not found, or more than one candidate row) — per the design
    spec, `hypothesis` is exactly for "ambiguous source ENI/subnet resolution... discovery could not
    narrow to the single path this flow actually takes", which is precisely this case. Discovery
    ALWAYS returns exactly one candidate (never zero) — a topology-fetcher contract discover_
    candidates() itself enforces (see its own docstring): a genuine "found nothing" degrades to a
    single `hypothesis` candidate with empty placement data, not an empty list.
    """
    src, dst = resolved["source"], resolved["destination"]
    account_id = src.get("account_id")

    # MINOR fix: when `resolve_live_identity()` (Gap 4) has already confirmed this run's source
    # against a LIVE EC2 read, `src["instance_id"]` is the freshest, most-likely-to-hit ref this
    # fetcher can use — the exact bare form (`i-...`) that appears after the `:` in the `ec2:<id>`
    # node ids `web/lib/infra-topology.ts`'s `buildInfraGraph` builds for an EC2 instance. A pod's
    # own ENI id is rarely also a top-level inventoried resource id (this function's own docstring
    # above), so preferring `instance_id` first closes the "cached-topology lookup rarely resolves
    # real identities" gap for exactly the case (a live-resolved pod/node source) where a confident
    # ref is actually available. Falls back to the pre-fix eni_id/subnet_id refs when no live
    # identity was resolved (e.g. a directly-known ENI/subnet source, or `resolve_live_identity()`
    # never ran because the source declares no `cluster`).
    src_node = _find_infra_node(
        conn, account_id, src.get("instance_id") or src.get("eni_id") or src.get("subnet_id"))
    src_place = _infra_placement(conn, account_id, src_node["id"]) if src_node else {}

    dst_node = None
    if dst.get("kind") == "aws_resource":
        dst_ref = dst.get("eni_id") or dst.get("ip") or dst.get("cidr")
        dst_node = _find_infra_node(conn, account_id, dst_ref)
    dst_place = _infra_placement(conn, account_id, dst_node["id"]) if dst_node else {}

    same_vpc = bool(src_place.get("vpc")) and src_place.get("vpc") == dst_place.get("vpc")
    dest_unresolved = dst.get("kind") == "aws_resource" and dst_node is None
    kind = "hypothesis" if (src_node is None or dest_unresolved) else "resolved"

    candidate = {
        "kind": kind,
        "via": "direct" if same_vpc else None,
        "dest_eni_known": dst_node is not None,
        "account_id": account_id,
        "region": src.get("region"),
        "data": {
            # sg/nacl/route/sg-dst/nacl-dst: intentionally NO rule/entry/table content and NO
            # peer_ip/peer_sg_ids — see the docstring above for why supplying the SG ids we DO know
            # without matching rule content would fabricate a false `blocked`. Left empty so every
            # adapter's own "missing data -> unknown" branch fires honestly.
            # "placement" is informational only — never read by any adapter — exposing exactly what
            # this fetcher actually determined, for callers/tests to inspect.
            "placement": {"source": src_place, "destination": dst_place, "same_vpc": same_vpc},
        },
    }
    return {"candidates": [candidate]}


def run(payload, conn, topology_fetcher=None, deadline_s=GLOBAL_DEADLINE_S, now=time.monotonic,
        k8s_get=None, ec2_lookup=None):
    """Entry point registered in handlers.py's REGISTRY. `payload`: {"run_id", "definition"}
    (definition = the run's `definition_snapshot`, already immutable per spec).

    `topology_fetcher`, when supplied, is called as `topology_fetcher(resolved)` — a single-arg
    callable, exactly as before this pass (existing tests inject a fixture this way). The REAL
    default (`fetch_live_topology`) now takes `(resolved, conn)` since it needs the same Aurora
    connection `run()` already holds — `conn` can't be captured in a plain default-argument value at
    function-definition time, so the 1-arg-vs-2-arg fetchers are unified here via a small closure
    instead of changing every existing caller's fixture signature.

    `k8s_get`/`ec2_lookup`, when supplied, are threaded straight into `resolve_live_identity()`
    (Gap 4) — production leaves both `None` (the real presigned-STS K8s GET / boto3 EC2 Describe);
    tests inject fakes exactly the same way existing tests inject `topology_fetcher`.
    """
    run_id = payload["run_id"]
    definition = payload["definition"]
    fetcher = topology_fetcher or (lambda r: fetch_live_topology(r, conn))

    try:
        resolved = resolve_identities(definition)
        # CI-review MAJOR fix (round 17, item 5, second half): `definition.source.account_id` is
        # user-authored (part of the check's own JSON definition) and must be bound to the check's
        # OWN validated `source_account_id` column -- web/lib/network-path.ts's createRun() now
        # threads that column into this payload precisely so this comparison can happen BEFORE any
        # AssumeRole is even attempted (resolve_live_identity, below). A missing
        # `source_account_id` on the payload is treated the same as a mismatch (fail closed) --
        # every payload created by createRun() always carries it, so its absence means this run
        # didn't go through the trusted enqueue path this check expects.
        expected_account_id = payload.get("source_account_id")
        actual_account_id = resolved["source"].get("account_id")
        if expected_account_id != actual_account_id:
            raise NetworkPathError(
                f"definition.source.account_id {actual_account_id!r} does not match this check's "
                f"own source_account_id {expected_account_id!r} -- refusing to resolve identity")
        resolved = resolve_live_identity(resolved, conn, k8s_get=k8s_get, ec2_lookup=ec2_lookup)
    except NetworkPathError as e:
        # CI-review MINOR fix (round 23): this branch persisted `str(e)` verbatim while the
        # broad-Exception branch just below redacts — but `NetworkPathError` messages in THIS
        # phase can themselves embed raw 12-digit account ids (the account-binding-mismatch
        # refusal above, and `_account_external_id`'s own refusal message), which `_ACCOUNT_ID_RE`
        # exists to redact from persisted columns. Redacted the same way now.
        error_text = _redact_sensitive(str(e))
        _finish_run(conn, run_id, "failed", overall_status="failed", error=error_text)
        return {"run_id": run_id, "status": "failed", "error": error_text}
    except Exception as e:  # noqa: BLE001 — CI-review MAJOR fix (round 18): this phase now
        # performs DB I/O (`_account_external_id()`'s `conn.run`), unlike when it only validated
        # the definition's own fields — a `conn.run` failure used to escape this narrow
        # `NetworkPathError`-only catch and crash uncaught, leaving `network_path_runs` stuck at
        # `running`/`resolve` until the reaper eventually flips it minutes later. Mirrors the
        # discover phase's own broad-`Exception` catch below, which exists for exactly this reason.
        error_text = _redact_sensitive(f"{type(e).__name__}: {e}")
        _finish_run(conn, run_id, "failed", overall_status="failed", error=error_text)
        return {"run_id": run_id, "status": "failed", "error": error_text}

    _update_phase(conn, run_id, "discover")
    try:
        topology = fetcher(resolved)
        candidates = discover_candidates(resolved, topology)
    except NetworkPathError as e:
        # CI-review MINOR fix (round 23): this branch persisted `str(e)` verbatim while the
        # broad-Exception branch just below redacts — for consistency with the resolve phase's
        # own NetworkPathError branch above (which CAN embed raw account ids), and since a future
        # `discover_candidates`/`fetcher` error could too. Redacted the same way now.
        error_text = _redact_sensitive(str(e))
        _finish_run(conn, run_id, "failed", overall_status="failed", error=error_text)
        return {"run_id": run_id, "status": "failed", "error": error_text}
    except Exception as e:  # noqa: BLE001 — an unexpected fetcher failure (e.g. the Aurora
        # connection itself failing) must still terminate the run visibly rather than crash uncaught
        # and leave network_path_runs stuck at running/discover until the reaper eventually flips it
        # minutes later.
        error_text = _redact_sensitive(f"{type(e).__name__}: {e}")
        _finish_run(conn, run_id, "failed", overall_status="failed", error=error_text)
        return {"run_id": run_id, "status": "failed", "error": error_text}

    for c in candidates:
        _insert_candidate(conn, run_id, c["candidate_id"], c["kind"])

    _update_phase(conn, run_id, "verify")
    deadline_at = now() + deadline_s
    candidates_with_steps = []
    for c in candidates:
        steps = verify_candidate(c, resolved["request"], deadline_at, now=now)
        _insert_steps(conn, run_id, c["candidate_id"], c["account_id"], c["region"], steps)
        candidates_with_steps.append({"candidate_id": c["candidate_id"], "kind": c["kind"], "steps": steps})

    _update_phase(conn, run_id, "conclude")
    per_candidate, overall_status = conclude(candidates_with_steps)
    for pc in per_candidate:
        _update_candidate_result(conn, run_id, pc["candidate_id"], pc["status"], pc["first_blocker"])
    bundle = build_validation_bundle(candidates_with_steps, overall_status)
    _finish_run(conn, run_id, "succeeded", overall_status=overall_status, validation_bundle=bundle)

    return {"run_id": run_id, "status": "succeeded", "overall_status": overall_status,
            "candidates": len(candidates)}
