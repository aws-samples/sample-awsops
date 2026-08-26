"""
OpenSearch read MCP Lambda — search an account's OpenSearch domain logs (AWS-native, sigv4 `es`).
OpenSearch 로그 조회 MCP Lambda — 인시던트 트리아지용 시간범위 로그 검색.

READ-ONLY: list domains / search logs / cat indices. No token (AWS-native — signs with the Lambda's
IAM role via sigv4 `es`; cross-account uses the assumed read-only role's creds). Non-VPC by default
(reaches public-endpoint + IAM domains); a VPC-only domain needs opensearch_vpc_enabled (ai.tf).
Stdlib + boto3/botocore only (botocore.auth.SigV4Auth — no third-party HTTP/signing lib).
"""
import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlparse

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from cross_account import get_client, get_credentials, get_role_arn, resolve_tool_name

REGION_DEFAULT = "ap-northeast-2"
DEFAULT_SIZE = 20
MAX_SIZE = 50
HTTP_TIMEOUT = 12


def _resolve_endpoint(domain, region, role_arn):
    """Public domains expose DomainStatus.Endpoint; VPC domains expose Endpoints['vpc']."""
    c = get_client("opensearch", region, role_arn)
    st = c.describe_domain(DomainName=domain).get("DomainStatus", {})
    ep = st.get("Endpoint") or (st.get("Endpoints") or {}).get("vpc")
    if not ep:
        raise ValueError(f"no reachable endpoint for OpenSearch domain '{domain}'")
    return ep if ep.startswith("http") else f"https://{ep}"


def _clamp_size(size):
    try:
        n = int(size)
    except (TypeError, ValueError):
        return DEFAULT_SIZE
    return max(1, min(MAX_SIZE, n))


def _parse_start(start):
    """'1h'/'30m'/'2d' → ES 'now-1h'; otherwise pass through (ISO timestamp); None → last 1h."""
    if not start:
        return "now-1h"
    s = str(start)
    if s[:-1].isdigit() and s[-1:] in ("s", "m", "h", "d", "w"):
        return f"now-{s}"
    return s


def _search_body(query, start, end, size, time_field):
    tf = time_field or "@timestamp"
    rng = {"gte": _parse_start(start)}
    if end:
        rng["lte"] = end
    must = [{"range": {tf: rng}}]
    if query:
        must.append({"query_string": {"query": query}})
    return {"size": _clamp_size(size), "sort": [{tf: {"order": "desc"}}], "query": {"bool": {"must": must}}}


def _signed_request(method, url, body_bytes, region, target_account_id):
    """Sign the EXACT body bytes with sigv4 'es' and send those same bytes. Returns (status, dict)."""
    creds = get_credentials(target_account_id)
    headers = {"Content-Type": "application/json", "Host": urlparse(url).netloc}
    aws_req = AWSRequest(method=method, url=url, data=body_bytes, headers=headers)
    SigV4Auth(creds, "es", region).add_auth(aws_req)
    req = urllib.request.Request(url, data=(body_bytes if method != "GET" else None),
                                 method=method, headers=dict(aws_req.headers))
    try:
        resp = urllib.request.urlopen(req, timeout=HTTP_TIMEOUT)
        return resp.getcode(), json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read() or b"{}")
        except ValueError:
            data = {}
        return e.code, data


# ---- Tools (read-only) ----
def list_opensearch_domains(args, region, target_account_id):
    role_arn = get_role_arn(target_account_id) if target_account_id else None
    c = get_client("opensearch", region, role_arn)
    names = [d["DomainName"] for d in c.list_domain_names().get("DomainNames", [])]
    if not names:
        return ok({"domains": [], "message": "no OpenSearch domains in this account/region"})
    out = []
    for n in names:
        try:
            st = c.describe_domain(DomainName=n).get("DomainStatus", {})
            out.append({"name": n, "endpoint": st.get("Endpoint") or (st.get("Endpoints") or {}).get("vpc"),
                        "engineVersion": st.get("EngineVersion")})
        except Exception as e:  # noqa: BLE001
            out.append({"name": n, "error": str(e)[:120]})
    return ok({"domains": out})


def search_opensearch_logs(args, region, target_account_id):
    domain = (args.get("domain") or "").strip()
    if not domain:
        return err("domain required")
    role_arn = get_role_arn(target_account_id) if target_account_id else None
    endpoint = _resolve_endpoint(domain, region, role_arn)
    index = (args.get("index") or "_all").strip()
    body = _search_body(args.get("query"), args.get("start"), args.get("end"),
                        args.get("size"), args.get("time_field"))
    body_bytes = json.dumps(body).encode()
    status, data = _signed_request("POST", f"{endpoint}/{index}/_search", body_bytes, region, target_account_id)
    if status >= 400:
        return err(f"OpenSearch search failed ({status}): {(data.get('error') or data)}")
    hits = (data.get("hits") or {})
    rows = hits.get("hits", [])[:MAX_SIZE]
    total = (hits.get("total") or {})
    return ok({"domain": domain, "index": index, "count": len(rows),
               "total": total.get("value") if isinstance(total, dict) else total,
               "hits": [{"_index": h.get("_index"), "_id": h.get("_id"), "_source": h.get("_source")} for h in rows]})


def opensearch_indices(args, region, target_account_id):
    domain = (args.get("domain") or "").strip()
    if not domain:
        return err("domain required")
    role_arn = get_role_arn(target_account_id) if target_account_id else None
    endpoint = _resolve_endpoint(domain, region, role_arn)
    status, data = _signed_request("GET", f"{endpoint}/_cat/indices?format=json", b"", region, target_account_id)
    if status >= 400:
        return err(f"OpenSearch _cat/indices failed ({status})")
    return ok({"domain": domain, "indices": data})


def opensearch_schema(args, region, target_account_id):
    """Normalized schema for caching: each domain's endpoint + its indices (bounded)."""
    role_arn = get_role_arn(target_account_id) if target_account_id else None
    c = get_client("opensearch", region, role_arn)
    names = [d["DomainName"] for d in c.list_domain_names().get("DomainNames", [])][:20]
    domains = []
    for n in names:
        try:
            endpoint = _resolve_endpoint(n, region, role_arn)
            status, data = _signed_request("GET", f"{endpoint}/_cat/indices?format=json", b"", region, target_account_id)
            idx = [i.get("index") for i in data][:100] if status < 400 and isinstance(data, list) else []
            domains.append({"name": n, "indices": idx, "truncated": len(idx) >= 100})
        except Exception as e:  # noqa: BLE001
            domains.append({"name": n, "error": str(e)[:120]})
    return ok({"domains": domains})


_TOOLS = {
    "list_opensearch_domains": list_opensearch_domains,
    "search_opensearch_logs": search_opensearch_logs,
    "opensearch_indices": opensearch_indices,
    "opensearch_schema": opensearch_schema,
}


def lambda_handler(event, context):
    params = event if isinstance(event, dict) else json.loads(event)
    t = resolve_tool_name(params, context)
    args = params.get("arguments", params)
    if not isinstance(args, dict):
        args = {}
    target_account_id = args.pop("target_account_id", None)
    region = args.get("region", REGION_DEFAULT)
    fn = _TOOLS.get(t)
    if fn is None:
        return err(f"unknown tool: {t}")
    try:
        return fn(args, region, target_account_id)
    except ValueError as e:
        return err(str(e))
    except Exception as e:  # noqa: BLE001 — never leak a stack trace to the gateway
        return err(f"opensearch error: {e}")


def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str)}


def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
