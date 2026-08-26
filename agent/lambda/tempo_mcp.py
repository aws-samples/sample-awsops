"""
Tempo read-only MCP Lambda — TraceQL search + trace fetch + tag discovery against a user-registered
Tempo endpoint. Fourth of the v1 datasource family; uses datasource_http (credential load, SSRF host
guard, auth, no-redirect HTTP).

READ-ONLY by construction. Tempo specifics: start/end are unix SECONDS; multi-tenant via optional
X-Scope-OrgID; trace_id is hex-validated then URL-quoted (path injection defense); the search/trace
responses have NO envelope `status` field → success = HTTP 2xx. Trace payloads can be multi-MB →
bound trace count + per-trace bytes (UTF-8) + ensure_ascii=False. Stdlib + boto3 only.
"""
import json
import re
import time
from urllib.parse import quote, urlencode

from cross_account import resolve_tool_name
from datasource_http import (
    NotConnected, SsrfBlocked, assert_host_allowed, auth_headers, health, http_json, load_datasource,
    set_request_conn,
)

SLUG = "tempo"
MAX_TRACES = 50
MAX_TOTAL_BYTES = 1_000_000  # cap serialized trace payload well under the 6 MB Lambda limit
_REL = re.compile(r"^(\d+)([smhdw])$")
_UNIT = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
_HEX = re.compile(r"^[0-9a-fA-F]+$")


class _ApiError(Exception):
    pass


def _parse_time_s(v, default_delta_s=None):
    """now / '1h'/'30m' (now-delta) / unix-seconds passthrough → unix SECONDS string (integer)."""
    now = int(time.time())
    if v is None:
        return str(now - default_delta_s) if default_delta_s else str(now)
    s = str(v).strip()
    m = _REL.match(s)
    if m:
        return str(now - int(m.group(1)) * _UNIT[m.group(2)])
    return s


def _headers(creds):
    h = dict(auth_headers(creds))
    if creds.get("org_id"):
        h["X-Scope-OrgID"] = str(creds["org_id"])
    return h


def _ds():
    creds = load_datasource(SLUG)
    assert_host_allowed(creds["endpoint"])
    return creds


def _get(creds, path, params=None):
    url = creds["endpoint"].rstrip("/") + path + ("?" + urlencode(params, doseq=True) if params else "")
    status, data = http_json("GET", url, headers=_headers(creds))
    if status >= 400:  # Tempo has no envelope status → HTTP 2xx is success
        raise _ApiError(f"Tempo HTTP {status}: {str(data.get('raw') or data.get('error') or data)[:300]}")
    return data


def _byte_bound(obj):
    """Serialize; if over the UTF-8 byte budget, return a truncated marker payload."""
    body = json.dumps(obj, default=str, ensure_ascii=False)
    if len(body.encode("utf-8")) <= MAX_TOTAL_BYTES:
        return obj, False
    return {"truncated": True, "note": f"trace payload exceeded {MAX_TOTAL_BYTES} bytes; fetch fewer/narrower",
            "preview": body[:2000]}, True


def tempo_search(args):
    query = (args.get("query") or "").strip()
    if not query:
        return err("query (TraceQL) required")
    params = {"q": query, "start": _parse_time_s(args.get("start"), 3600), "end": _parse_time_s(args.get("end"))}
    if args.get("limit"):
        params["limit"] = str(args["limit"])
    data = _get(_ds(), "/api/search", params)
    traces = data.get("traces", []) if isinstance(data, dict) else []
    truncated = len(traces) > MAX_TRACES
    payload, btr = _byte_bound({"traces": traces[:MAX_TRACES], "metrics": data.get("metrics") if isinstance(data, dict) else None})
    if btr:
        return ok(payload)
    return ok({"truncated": truncated, **payload})


def tempo_get_trace(args):
    tid = (args.get("trace_id") or "").strip()
    if not tid or not _HEX.match(tid):
        return err("trace_id must be a hex string")
    data = _get(_ds(), f"/api/traces/{quote(tid, safe='')}")
    payload, btr = _byte_bound(data if isinstance(data, dict) else {"trace": data})
    return ok({"truncated": btr, **(payload if isinstance(payload, dict) else {"trace": payload})}) if not btr else ok(payload)


def tempo_search_tags(args):
    data = _get(_ds(), "/api/search/tags")
    return ok(data if isinstance(data, dict) else {"tags": data})


def tempo_tag_values(args):
    tag = (args.get("tag") or "").strip()
    if not tag:
        return err("tag required")
    data = _get(_ds(), f"/api/search/tag/{quote(tag, safe='')}/values")
    return ok(data if isinstance(data, dict) else {"values": data})


def tempo_schema(args):
    creds = _ds()
    try:  # best-effort server version for version-aware TraceQL
        bi = _get(creds, "/api/status/buildinfo")
        version = bi.get("version") if isinstance(bi, dict) else None
    except _ApiError:
        version = None
    data = _get(creds, "/api/search/tags")
    tags = data.get("tagNames") if isinstance(data, dict) else data
    tags = tags if isinstance(tags, list) else []
    return ok({"version": version, "tags": tags[:200], "truncated": len(tags) > 200})


_TOOLS = {
    "tempo_search": tempo_search, "tempo_get_trace": tempo_get_trace,
    "tempo_search_tags": tempo_search_tags, "tempo_tag_values": tempo_tag_values, "tempo_schema": tempo_schema,
}


def tempo_health(args):
    """Connectivity probe for the pre-save Test / status badge: GET /ready."""
    return ok(health(load_datasource(SLUG), "/ready"))


_TOOLS["tempo_health"] = tempo_health


def lambda_handler(event, context):
    params = event if isinstance(event, dict) else json.loads(event)
    t = resolve_tool_name(params, context)
    args = params.get("arguments", params)
    inst = args.get("instance_id") if isinstance(args, dict) else None
    conn = params.get("conn_config")
    if isinstance(args, dict):
        args.pop("target_account_id", None)
        args.pop("instance_id", None)        # routing arg, not a tool arg
    try:
        # BFF inline conn (trusted) > per-instance secret (credential-blind worker) > kind-mirror default.
        if conn:
            set_request_conn(conn)
        elif inst is not None:
            set_request_conn(load_datasource(SLUG, instance_id=inst))
        else:
            set_request_conn(None)
        fn = _TOOLS.get(t)
        if fn is None:
            return err(f"unknown tool: {t}")
        return fn(args)
    except (NotConnected, SsrfBlocked, _ApiError) as e:
        return err(str(e))
    except Exception as e:  # noqa: BLE001
        return err(f"tempo error: {e}")
    finally:
        set_request_conn(None)  # guaranteed reset — no warm-container bleed


def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str, ensure_ascii=False)}


def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
