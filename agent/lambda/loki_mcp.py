"""
Loki read-only MCP Lambda — query logs by LogQL (instant/range) + label discovery against a
user-registered Loki endpoint. Third of the v1 datasource family; uses datasource_http
(credential load, SSRF host guard, auth, no-redirect HTTP).

READ-ONLY by construction (Loki query API can't write; LogQL has no server-side fetch) → no SQL
guard. Loki specifics: start/end are unix NANOSECONDS; multi-tenant via optional X-Scope-OrgID;
log lines are arbitrary-length → bound streams, lines/stream, a global line budget AND a total-byte
budget (a single oversized line is capped). Stdlib + boto3 only.
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

SLUG = "loki"
DEFAULT_LIMIT = 100
MAX_STREAMS = 50
MAX_LINES_PER_STREAM = 200
MAX_TOTAL_LINES = 5000
MAX_LINE_BYTES = 4096       # cap an individual oversized log line
MAX_TOTAL_BYTES = 1_000_000  # ~1 MB of log text, well under the 6 MB Lambda limit

_REL = re.compile(r"^(\d+)([smhdw])$")
_UNIT = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}


def _parse_time_ns(v, default_delta_s=None):
    """now / '1h'/'30m' (now-delta) / unix-seconds / unix-ns / ISO → unix NANOSECONDS string (int math)."""
    now_ns = int(time.time()) * 1_000_000_000
    if v is None:
        return str(now_ns - default_delta_s * 1_000_000_000) if default_delta_s else str(now_ns)
    s = str(v).strip()
    m = _REL.match(s)
    if m:
        return str(now_ns - int(m.group(1)) * _UNIT[m.group(2)] * 1_000_000_000)
    if s.isdigit():
        return s if len(s) >= 16 else str(int(s) * 1_000_000_000)  # already ns vs seconds
    return s  # ISO passthrough (Loki accepts RFC3339)


def _headers(creds):
    h = dict(auth_headers(creds))
    if creds.get("org_id"):
        h["X-Scope-OrgID"] = str(creds["org_id"])
    return h


class _ApiError(Exception):
    pass


def _ds():
    creds = load_datasource(SLUG)
    assert_host_allowed(creds["endpoint"])
    return creds


def _get(creds, path, params):
    url = creds["endpoint"].rstrip("/") + path + ("?" + urlencode(params, doseq=True) if params else "")
    status, data = http_json("GET", url, headers=_headers(creds))
    if status >= 400:
        raise _ApiError(f"Loki HTTP {status}: {str(data.get('raw') or data.get('error') or data)[:300]}")
    if isinstance(data, dict) and data.get("status") and data.get("status") != "success":
        raise _ApiError(f"Loki query failed: {data.get('error', 'unknown')}")
    return data.get("data") if isinstance(data, dict) else data


def _bound(data):
    if not isinstance(data, dict) or not isinstance(data.get("result"), list):
        return data, False
    result = data["result"]
    truncated = len(result) > MAX_STREAMS
    result = result[:MAX_STREAMS]
    lines_budget = MAX_TOTAL_LINES
    bytes_budget = MAX_TOTAL_BYTES
    out = []
    for stream in result:
        s = dict(stream)
        vals = s.get("values")
        if isinstance(vals, list):
            kept = []
            for entry in vals[:MAX_LINES_PER_STREAM]:
                if lines_budget <= 0 or bytes_budget <= 0:
                    truncated = True
                    break
                ts, line = (entry + ["", ""])[:2] if isinstance(entry, list) else (None, str(entry))
                line = str(line)
                enc = line.encode("utf-8")
                if len(enc) > MAX_LINE_BYTES:
                    line = enc[:MAX_LINE_BYTES].decode("utf-8", "ignore") + "…[truncated]"
                    enc = line.encode("utf-8")
                    truncated = True
                kept.append([ts, line])
                lines_budget -= 1
                bytes_budget -= len(enc)
            if len(vals) > len(kept):
                truncated = True
            s["values"] = kept
        out.append(s)
    return {"resultType": data.get("resultType"), "result": out}, truncated


def loki_query_range(args):
    query = (args.get("query") or "").strip()
    if not query:
        return err("query (LogQL) required")
    params = {"query": query, "start": _parse_time_ns(args.get("start"), 3600), "end": _parse_time_ns(args.get("end")),
              "limit": str(args.get("limit") or DEFAULT_LIMIT), "direction": args.get("direction") or "backward"}
    if args.get("step"):
        params["step"] = str(args["step"])
    data = _get(_ds(), "/loki/api/v1/query_range", params)
    bounded, tr = _bound(data)
    return ok({"truncated": tr, **(bounded if isinstance(bounded, dict) else {"result": bounded})})


def loki_query(args):
    query = (args.get("query") or "").strip()
    if not query:
        return err("query (LogQL) required")
    params = {"query": query, "limit": str(args.get("limit") or DEFAULT_LIMIT)}
    if args.get("time"):
        params["time"] = _parse_time_ns(args.get("time"))
    data = _get(_ds(), "/loki/api/v1/query", params)
    bounded, tr = _bound(data)
    return ok({"truncated": tr, **(bounded if isinstance(bounded, dict) else {"result": bounded})})


def loki_labels(args):
    data = _get(_ds(), "/loki/api/v1/labels", {})
    names = data if isinstance(data, list) else []
    return ok({"labels": names[:1000], "truncated": len(names) > 1000})


def loki_label_values(args):
    label = (args.get("label") or "").strip()
    if not label:
        return err("label required")
    data = _get(_ds(), f"/loki/api/v1/label/{quote(label, safe='')}/values", {})
    values = data if isinstance(data, list) else []
    return ok({"values": values[:1000], "truncated": len(values) > 1000})


def loki_schema(args):
    creds = _ds()
    try:  # best-effort server version for version-aware LogQL
        bi = _get(creds, "/loki/api/v1/status/buildinfo", {})
        version = bi.get("version") if isinstance(bi, dict) else None
    except _ApiError:
        version = None
    try:
        labels = _get(creds, "/loki/api/v1/labels", {})
    except _ApiError:
        labels = []
    labels = labels if isinstance(labels, list) else []
    return ok({"version": version, "labels": labels[:200], "truncated": len(labels) > 200})


_TOOLS = {
    "loki_query_range": loki_query_range, "loki_query": loki_query,
    "loki_labels": loki_labels, "loki_label_values": loki_label_values, "loki_schema": loki_schema,
}


def loki_health(args):
    """Connectivity probe for the pre-save Test / status badge: GET /ready."""
    return ok(health(load_datasource(SLUG), "/ready"))


_TOOLS["loki_health"] = loki_health


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
        return err(f"loki error: {e}")
    finally:
        set_request_conn(None)  # guaranteed reset — no warm-container bleed


def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str, ensure_ascii=False)}


def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
