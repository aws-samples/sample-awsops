"""
Jaeger read-only MCP Lambda — trace search + trace fetch + service discovery against a
user-registered Jaeger Query endpoint (v1 datasource family parity). Uses datasource_http
(credential load, SSRF host guard, auth, no-redirect HTTP).

READ-ONLY by construction. Jaeger specifics: the HTTP query API takes start/end in unix
MICROSECONDS; a search needs a `service`; responses are enveloped as {"data": [...]}. The
`query` arg accepts either a bare service name ("frontend") or a query-string of search
params ("service=frontend&operation=GET /api&limit=20&tags={\"error\":\"true\"}") — the
Explore console sends one string, v1-style. Trace payloads can be large → byte-bounded.
Stdlib + boto3 only.
"""
import json
import re
import time
from urllib.parse import parse_qs, quote, urlencode

from cross_account import resolve_tool_name
from datasource_http import (
    NotConnected, SsrfBlocked, assert_host_allowed, auth_headers, health, http_json, load_datasource,
    set_request_conn,
)

SLUG = "jaeger"
MAX_TRACES = 50
MAX_TOTAL_BYTES = 1_000_000
_REL = re.compile(r"^(\d+)([smhdw])$")
_UNIT = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
_HEX = re.compile(r"^[0-9a-fA-F]+$")
_ALLOWED_SEARCH_KEYS = {"service", "operation", "tags", "limit", "minDuration", "maxDuration", "lookback"}


class _ApiError(Exception):
    pass


def _parse_time_us(v, default_delta_s=None):
    """now / '1h'/'30m' (now-delta) / unix-seconds → unix MICROSECONDS string (Jaeger API unit)."""
    now = int(time.time())
    if v is None:
        sec = now - default_delta_s if default_delta_s else now
    else:
        s = str(v).strip()
        m = _REL.match(s)
        sec = now - int(m.group(1)) * _UNIT[m.group(2)] if m else int(float(s))
    return str(sec * 1_000_000)


def _ds():
    creds = load_datasource(SLUG)
    assert_host_allowed(creds["endpoint"])
    return creds


def _get(creds, path, params=None):
    url = creds["endpoint"].rstrip("/") + path + ("?" + urlencode(params, doseq=True) if params else "")
    status, data = http_json("GET", url, headers=auth_headers(creds))
    if status >= 400:  # Jaeger errors carry {"errors":[...]} — success = HTTP 2xx
        raise _ApiError(f"Jaeger HTTP {status}: {str(data.get('errors') or data.get('raw') or data)[:300]}")
    return data


def _byte_bound(obj):
    body = json.dumps(obj, default=str, ensure_ascii=False)
    if len(body.encode("utf-8")) <= MAX_TOTAL_BYTES:
        return obj, False
    return {"truncated": True, "note": f"trace payload exceeded {MAX_TOTAL_BYTES} bytes; fetch fewer/narrower",
            "preview": body[:2000]}, True


def _search_params(query):
    """Bare service name OR a query-string of allowed Jaeger search params → params dict."""
    q = (query or "").strip()
    if not q:
        raise _ApiError("query required: a service name or service=...&operation=...&tags=...")
    if "=" not in q:
        return {"service": q}
    parsed = parse_qs(q, keep_blank_values=False)
    params = {k: v[0] for k, v in parsed.items() if k in _ALLOWED_SEARCH_KEYS and v}
    if "service" not in params:
        raise _ApiError("search params must include service=<name>")
    return params


def jaeger_search(args):
    try:
        params = _search_params(args.get("query"))
    except _ApiError as e:
        return err(str(e))
    params.setdefault("limit", "20")
    params["limit"] = str(min(int(params["limit"]), MAX_TRACES))
    params["start"] = _parse_time_us(args.get("start"), 3600)
    params["end"] = _parse_time_us(args.get("end"))
    data = _get(_ds(), "/api/traces", params)
    traces = data.get("data", []) if isinstance(data, dict) else []
    # Compact rows for the console/agent: full span trees are huge — summarize per trace.
    rows = []
    for t in traces[:MAX_TRACES]:
        spans = t.get("spans", []) if isinstance(t, dict) else []
        procs = t.get("processes", {}) if isinstance(t, dict) else {}
        root = min(spans, key=lambda s: s.get("startTime", 0)) if spans else {}
        dur_us = max((s.get("startTime", 0) + s.get("duration", 0)) for s in spans) - root.get("startTime", 0) if spans else 0
        svc = ""
        pid = root.get("processID")
        if pid and isinstance(procs.get(pid), dict):
            svc = procs[pid].get("serviceName", "")
        rows.append({
            "traceID": t.get("traceID", ""),
            "rootServiceName": svc,
            "rootTraceName": root.get("operationName", ""),
            "spanCount": len(spans),
            "durationMs": round(dur_us / 1000, 1),
            "startTime": root.get("startTime", 0),
        })
    payload, btr = _byte_bound({"traces": rows})
    return ok(payload if btr else {"truncated": len(traces) > MAX_TRACES, **payload})


def jaeger_get_trace(args):
    tid = (args.get("trace_id") or "").strip()
    if not tid or not _HEX.match(tid):
        return err("trace_id must be a hex string")
    data = _get(_ds(), f"/api/traces/{quote(tid, safe='')}")
    payload, btr = _byte_bound(data if isinstance(data, dict) else {"trace": data})
    return ok(payload)


def jaeger_services(args):
    data = _get(_ds(), "/api/services")
    services = data.get("data", []) if isinstance(data, dict) else []
    return ok({"services": services if isinstance(services, list) else []})


def jaeger_operations(args):
    svc = (args.get("service") or "").strip()
    if not svc:
        return err("service required")
    data = _get(_ds(), f"/api/services/{quote(svc, safe='')}/operations")
    ops = data.get("data", []) if isinstance(data, dict) else []
    return ok({"operations": ops if isinstance(ops, list) else []})


def jaeger_schema(args):
    """Service names (the query-gen 'vocabulary' — a Jaeger search is service-anchored)."""
    data = _get(_ds(), "/api/services")
    services = data.get("data", []) if isinstance(data, dict) else []
    services = services if isinstance(services, list) else []
    return ok({"services": services[:100], "truncated": len(services) > 100})


def jaeger_health(args):
    """Connectivity probe for the pre-save Test / status badge: GET /api/services."""
    return ok(health(load_datasource(SLUG), "/api/services"))


_TOOLS = {
    "jaeger_search": jaeger_search, "jaeger_get_trace": jaeger_get_trace,
    "jaeger_services": jaeger_services, "jaeger_operations": jaeger_operations,
    "jaeger_schema": jaeger_schema, "jaeger_health": jaeger_health,
}


def lambda_handler(event, context):
    params = event if isinstance(event, dict) else json.loads(event)
    t = resolve_tool_name(params, context)
    args = params.get("arguments", params)
    inst = args.get("instance_id") if isinstance(args, dict) else None
    conn = params.get("conn_config")
    if isinstance(args, dict):
        args.pop("target_account_id", None)
        args.pop("instance_id", None)
    try:
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
        return err(f"jaeger error: {e}")
    finally:
        set_request_conn(None)


def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str, ensure_ascii=False)}


def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
