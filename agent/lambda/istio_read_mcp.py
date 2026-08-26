"""
Istio-read MCP Lambda — READ-ONLY Istio service-mesh inspection via the EKS Kubernetes API.

Read-only v2 variant of aws_istio_mcp.py. The v1 tool queried Istio CRDs through Steampipe's k8s
tables (pg8000 → steampipe:9193) — that contradicts ADR-037 ("No live Steampipe in v2"). This variant
reads the SAME CRDs directly from the cluster's Kubernetes API using a bearer token built from a
presigned STS GetCallerIdentity (the `k8s-aws-v1.` pattern, reused from datasource_diag_mcp), over the
Python stdlib (urllib + ssl) — no pg8000, no Steampipe, no third-party k8s client.

GET/LIST only. The cluster endpoint + CA are resolved at runtime via eks.describe_cluster(cluster_name)
(the role already has eks:DescribeCluster + an EKS Access Entry); the request host is therefore pinned
to the AWS-returned endpoint (no SSRF surface from caller input). The operator registers the access
entry with AmazonEKSViewPolicy (View, NOT AdminView — least privilege: no cluster-wide Secret/node
read; istio-read only LISTs namespaced Istio CRDs + namespaces) — see register-istio-access.sh.

Istio-read MCP — Steampipe 대신 EKS k8s API로 Istio CRD를 읽기 전용 조회(ADR-037 준수).
"""
import base64
import json
import os
import re
import ssl
import tempfile
from urllib.request import Request, urlopen

from cross_account import get_client, get_role_arn, resolve_tool_name

# DNS-1123 label (k8s namespace name): lowercase alphanumerics + hyphens, <=63 chars.
_NS_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")

# tool_name -> (apiGroup/version, plural CRD name)
_CRDS = {
    "list_virtual_services": ("networking.istio.io/v1beta1", "virtualservices"),
    "list_destination_rules": ("networking.istio.io/v1beta1", "destinationrules"),
    "list_istio_gateways": ("networking.istio.io/v1beta1", "gateways"),
    "list_service_entries": ("networking.istio.io/v1beta1", "serviceentries"),
    "list_authorization_policies": ("security.istio.io/v1", "authorizationpolicies"),
    "list_peer_authentications": ("security.istio.io/v1", "peerauthentications"),
}


def _eks_session(region, role_arn, cluster_name):
    """Resolve (endpoint, bearer_token, ssl_ctx) for the cluster's k8s API. Reuses the EKS
    presigned-STS `k8s-aws-v1.` token pattern from datasource_diag_mcp._check_k8s_service_endpoints."""
    from botocore.signers import RequestSigner

    eks = get_client("eks", region, role_arn)
    cluster = eks.describe_cluster(name=cluster_name)["cluster"]
    endpoint = cluster.get("endpoint", "")
    ca_data = cluster.get("certificateAuthority", {}).get("data", "")
    if not endpoint:
        raise RuntimeError("cluster endpoint not available")

    sts = get_client("sts", region, role_arn)
    signer = RequestSigner(
        sts.meta.service_model.service_id, region, "sts", "v4",
        sts._request_signer._credentials, sts._request_signer._event_emitter,
    )
    signed_url = signer.generate_presigned_url(
        {
            "method": "GET",
            "url": f"https://sts.{region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15",
            "body": {},
            "headers": {"x-k8s-aws-id": cluster_name},
            "context": {},
        },
        region_name=region, expires_in=60, operation_name="",
    )
    token = "k8s-aws-v1." + base64.urlsafe_b64encode(signed_url.encode("utf-8")).rstrip(b"=").decode("utf-8")

    ca_file = tempfile.NamedTemporaryFile(delete=False, suffix=".crt")
    ca_file.write(base64.b64decode(ca_data))
    ca_file.close()
    try:
        ctx = ssl.create_default_context(cafile=ca_file.name)  # reads the PEM immediately
    finally:
        os.unlink(ca_file.name)  # no /tmp leak across warm Lambda invocations
    return endpoint, token, ctx


def _k8s_get(endpoint, path, token, ctx):
    """HTTPS GET against the cluster API server. Read-only. 6s per call so mesh_overview's ~8 sequential
    GETs stay well under the 60s Lambda timeout even if some hang."""
    req = Request(endpoint + path, headers={"Authorization": f"Bearer {token}"})
    resp = urlopen(req, timeout=6, context=ctx)  # noqa: S310 — host pinned to AWS-returned endpoint
    return json.loads(resp.read())


def _items(data):
    out = []
    for i in data.get("items", []):
        meta = i.get("metadata", {})
        out.append({"name": meta.get("name"), "namespace": meta.get("namespace")})
    return out


def _list_crd(session, group_version, plural, namespace=None):
    endpoint, token, ctx = session
    if namespace:
        if not _NS_RE.match(namespace):
            raise ValueError(f"invalid namespace (must be a DNS-1123 label): {namespace!r}")
        path = f"/apis/{group_version}/namespaces/{namespace}/{plural}"
    else:
        path = f"/apis/{group_version}/{plural}"
    return _items(_k8s_get(endpoint, path, token, ctx))


def _mesh_overview(session):
    endpoint, token, ctx = session
    counts = {}
    for gv, plural in {(g, p) for g, p in _CRDS.values()}:
        try:
            counts[plural] = len(_k8s_get(endpoint, f"/apis/{gv}/{plural}", token, ctx).get("items", []))
        except Exception:
            counts[plural] = None
    injected = []
    try:
        ns = _k8s_get(endpoint, "/api/v1/namespaces", token, ctx)
        for n in ns.get("items", []):
            labels = n.get("metadata", {}).get("labels", {}) or {}
            # match value, not mere presence — `istio-injection: disabled` is an explicit opt-OUT
            if labels.get("istio-injection") == "enabled" or labels.get("istio.io/rev"):
                injected.append(n["metadata"]["name"])
    except Exception:
        pass
    return {"counts": counts, "injected_namespaces": injected}


def lambda_handler(event, context):
    params = event if isinstance(event, dict) else json.loads(event)
    tool_name = resolve_tool_name(params, context)
    args = params.get("arguments", params)
    target_account_id = args.pop("target_account_id", None) if isinstance(args, dict) else None
    role_arn = get_role_arn(target_account_id) if target_account_id else None
    region = args.get("region", "ap-northeast-2") if isinstance(args, dict) else "ap-northeast-2"

    if tool_name not in _CRDS and tool_name != "mesh_overview":
        return {"statusCode": 400, "body": json.dumps({"error": "Unknown tool: " + str(tool_name)})}

    cluster_name = args.get("cluster_name") if isinstance(args, dict) else None
    if not cluster_name:
        return {"statusCode": 400, "body": json.dumps({"error": "cluster_name is required"})}

    try:
        session = _eks_session(region, role_arn, cluster_name)
        if tool_name == "mesh_overview":
            return {"statusCode": 200, "body": json.dumps(_mesh_overview(session))}
        gv, plural = _CRDS[tool_name]
        items = _list_crd(session, gv, plural, args.get("namespace"))
        return {"statusCode": 200, "body": json.dumps({plural: items})}
    except ValueError as e:
        return {"statusCode": 400, "body": json.dumps({"error": str(e)})}  # bad input (e.g. namespace)
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
