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
    NotConnected, SsrfBlocked, assert_host_allowed, auth_headers, http_json, load_datasource,
    query_probe, set_request_conn, request_timeout, observed_payload, finite_number, HTTP_TIMEOUT,
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


def _get(creds, path, params, *, verify="query", timeout=None):
    url = creds["endpoint"].rstrip("/") + path + ("?" + urlencode(params, doseq=True) if params else "")
    status, data = http_json("GET", url, headers=_headers(creds),
                             timeout=timeout if timeout is not None else request_timeout(creds))
    if status >= 400:
        raise _ApiError(f"Loki HTTP {status}: {str(data.get('raw') or data.get('error') or data)[:300]}")
    if verify == "raw":  # buildinfo has no status/data envelope
        if isinstance(data, dict):
            return observed_payload(data, status)
        raise _ApiError("Loki response could not be verified")
    if isinstance(data, dict) and data.get("status") and data.get("status") != "success":
        raise _ApiError(f"Loki query failed: {data.get('error', 'unknown')}")
    if verify == "list" and isinstance(data, dict) and data.get("status") == "success" and "data" not in data:
        data = {**data, "data": []}  # older Loki omits `data` on empty label results
    if not isinstance(data, dict) or data.get("status") != "success" or "data" not in data:
        raise _ApiError("Loki response could not be verified")
    result = observed_payload(data["data"], status)
    if isinstance(result, dict):
        result.source_partial = bool(data.get("warnings") or data.get("partial") or data.get("truncated"))
        result.source_unverified = (
            "warnings" in data and (not isinstance(data["warnings"], list)
                                   or not all(isinstance(value, str) for value in data["warnings"]))
            or any(key in data and type(data[key]) is not bool for key in ("partial", "truncated"))
        )
    return result


def _valid_row(row, kind):
    if not isinstance(row, dict):
        return False
    labels = row.get("stream" if kind == "streams" else "metric")
    if not isinstance(labels, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in labels.items()):
        return False
    samples = row.get("values") if kind != "vector" else [row.get("value")]
    if not isinstance(samples, list):
        return False
    for pair in samples[:MAX_LINES_PER_STREAM]:
        if not isinstance(pair, list) or len(pair) != 2 or type(pair[0]) not in (str, int, float):
            return False
        try:
            if not finite_number(float(pair[0]), 8640000000000000000000 if kind == "streams" else 8640000000000):
                return False
        except (ValueError, OverflowError):
            return False
        if kind == "streams":
            if not isinstance(pair[1], str):
                return False
        elif (type(pair[1]) not in (str, int, float)
              or isinstance(pair[1], str) and not re.fullmatch(r"(?:NaN|[+-]?Inf|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)", pair[1])
              or not isinstance(pair[1], str) and not finite_number(pair[1])):
            return False
    return True


def _query_response(data, requested=None):
    """Normalize a Loki query envelope. `requested` is the caller's `limit`: Loki returns at most
    that many log lines with no marker, so reaching it is disclosed as `limitSaturated` and the
    result is `partial` — more lines may exist (mirrors Jaeger's requested/returned contract)."""
    valid = (isinstance(data, dict) and data.get("resultType") in ("streams", "matrix", "vector")
             and isinstance(data.get("result"), list) and not getattr(data, "source_unverified", False))
    kind = data.get("resultType") if isinstance(data, dict) else None
    source_rows = data.get("result") if isinstance(data, dict) else None
    source_rows = source_rows if isinstance(source_rows, list) else []
    retained = source_rows[:MAX_STREAMS]
    rows = [row for row in retained if _valid_row(row, kind)] if kind in ("streams", "matrix", "vector") else []
    valid = valid and len(rows) == len(retained)
    bounded, truncated = _bound({"resultType": kind, "result": rows})
    truncated = truncated or len(source_rows) > MAX_STREAMS
    upstream_lines = sum(len(row.get("values") or []) for row in rows) if kind == "streams" else 0
    emitted = bounded.get("result", []) if isinstance(bounded, dict) else []
    returned = sum(len(row.get("values") or []) for row in emitted) if kind == "streams" else len(emitted)
    saturated = kind == "streams" and bool(requested) and upstream_lines >= requested
    status = getattr(data, "http_status", 200)
    state = ("unknown" if not valid or status not in (200, 206) else
             "partial" if truncated or saturated or status == 206 or getattr(data, "source_partial", False) else
             "ok" if data["result"] else "empty")
    return ok({"truncated": truncated, **(bounded if isinstance(bounded, dict) else {"result": None}),
               "collectionStatus": state,
               **({"requestedLimit": requested, "returnedCount": returned, "limitSaturated": saturated} if requested else {})})


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
    return _query_response(data, _requested(params["limit"]))


def loki_query(args):
    query = (args.get("query") or "").strip()
    if not query:
        return err("query (LogQL) required")
    params = {"query": query, "limit": str(args.get("limit") or DEFAULT_LIMIT)}
    if args.get("time"):
        params["time"] = _parse_time_ns(args.get("time"))
    data = _get(_ds(), "/loki/api/v1/query", params)
    return _query_response(data, _requested(params["limit"]))


def _requested(limit):
    """The positive integer limit actually sent to Loki, or None when it was not a usable number."""
    return int(limit) if re.fullmatch(r"[1-9]\d{0,8}", str(limit)) else None


def loki_labels(args):
    data = _get(_ds(), "/loki/api/v1/labels", {}, verify="list", timeout=HTTP_TIMEOUT)
    names = data if isinstance(data, list) else []
    return ok({"labels": names[:1000], "truncated": len(names) > 1000})


def loki_label_values(args):
    label = (args.get("label") or "").strip()
    if not label:
        return err("label required")
    data = _get(_ds(), f"/loki/api/v1/label/{quote(label, safe='')}/values", {}, verify="list", timeout=HTTP_TIMEOUT)
    values = data if isinstance(data, list) else []
    return ok({"values": values[:1000], "truncated": len(values) > 1000})


def loki_schema(args):
    creds = _ds()
    try:  # best-effort server version for version-aware LogQL
        bi = _get(creds, "/loki/api/v1/status/buildinfo", {}, verify="raw", timeout=HTTP_TIMEOUT)
        # Loki itself serves buildinfo bare; a gateway may wrap it in a status/data envelope.
        info = bi.get("data") if isinstance(bi, dict) and isinstance(bi.get("data"), dict) and "version" in bi["data"] else bi
        version = info.get("version") if isinstance(info, dict) else None
    except _ApiError:
        version = None
    try:
        labels = _get(creds, "/loki/api/v1/labels", {}, verify="list", timeout=HTTP_TIMEOUT)
    except _ApiError:
        labels = None
    labels_ok = isinstance(labels, list)  # a FAILED label fetch is not an empty schema
    labels = labels if labels_ok else []
    # Failure surfaces as truncation (mirrors prometheus/mimir): absence is then UNDETERMINED —
    # cards degrade to "unknown" instead of a confident "unavailable" persisted over a good cache.
    return ok({"version": version, "labels": labels[:200],
               "truncated": (not labels_ok) or len(labels) > 200})


_TOOLS = {
    "loki_query_range": loki_query_range, "loki_query": loki_query,
    "loki_labels": loki_labels, "loki_label_values": loki_label_values, "loki_schema": loki_schema,
}


def loki_health(args):
    """Verify the tenant-scoped query endpoint with a one-minute, one-line search, judged by the
    same `_query_response` verdict the query tools use."""
    def run():
        end = int(time.time())
        data = _get(_ds(), "/loki/api/v1/query_range", {
            "query": '{service_name="awsops-connection-probe"}',
            "start": str((end - 60) * 1_000_000_000), "end": str(end * 1_000_000_000),
            "limit": "1",
        })
        return json.loads(_query_response(data, 1)["body"]).get("collectionStatus")
    return ok(query_probe(run, "Loki tenant query access could not be verified"))


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
