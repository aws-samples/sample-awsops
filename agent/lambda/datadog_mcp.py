"""
Datadog read-only MCP Lambda — metrics timeseries query + metric discovery + key validation against
the Datadog API (v1 datasource family parity). Uses datasource_http (credential load, SSRF host
guard, no-redirect HTTP).

READ-ONLY by construction. Datadog specifics: auth is TWO headers (DD-API-KEY + DD-APPLICATION-KEY)
— carried either as dedicated `apiKey`/`appKey` credential fields or as the generic custom-header
pair; endpoint = the API site base (https://api.datadoghq.com / api.us5.datadoghq.com / …);
timestamps are unix SECONDS. Stdlib + boto3 only.
"""
import json
import re
import time
from urllib.parse import urlencode

from cross_account import resolve_tool_name
from datasource_http import (
    NotConnected, SsrfBlocked, assert_host_allowed, auth_headers, http_json, load_datasource,
    set_request_conn,
)

SLUG = "datadog"
MAX_SERIES = 50
MAX_POINTS = 1500
_REL = re.compile(r"^(\d+)([smhdw])$")
_UNIT = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}


class _ApiError(Exception):
    pass


def _parse_time_s(v, default_delta_s=None):
    now = int(time.time())
    if v is None:
        return str(now - default_delta_s) if default_delta_s else str(now)
    s = str(v).strip()
    m = _REL.match(s)
    if m:
        return str(now - int(m.group(1)) * _UNIT[m.group(2)])
    return str(int(float(s)))


def _headers(creds):
    """DD dual-key headers: dedicated apiKey/appKey fields win; else the generic custom-header pair
    (headerName/headerValue [+2]) from auth_headers covers users who configured them directly."""
    h = dict(auth_headers(creds))
    if creds.get("apiKey"):
        h["DD-API-KEY"] = str(creds["apiKey"])
    if creds.get("appKey"):
        h["DD-APPLICATION-KEY"] = str(creds["appKey"])
    return h


def _ds():
    creds = load_datasource(SLUG)
    assert_host_allowed(creds["endpoint"])
    return creds


def _get(creds, path, params=None):
    url = creds["endpoint"].rstrip("/") + path + ("?" + urlencode(params, doseq=True) if params else "")
    status, data = http_json("GET", url, headers=_headers(creds))
    if status >= 400:
        errs = data.get("errors") if isinstance(data, dict) else None
        raise _ApiError(f"Datadog HTTP {status}: {str(errs or (data.get('raw') if isinstance(data, dict) else data))[:300]}")
    return data


def datadog_query(args):
    query = (args.get("query") or "").strip()
    if not query:
        return err("query required — e.g. avg:system.cpu.user{*}")
    params = {
        "query": query,
        "from": _parse_time_s(args.get("start"), 3600),
        "to": _parse_time_s(args.get("end")),
    }
    data = _get(_ds(), "/api/v1/query", params)
    series = data.get("series", []) if isinstance(data, dict) else []
    out = []
    for s in series[:MAX_SERIES]:
        if not isinstance(s, dict):
            continue
        pts = s.get("pointlist") or []
        out.append({
            "metric": s.get("metric", ""), "scope": s.get("scope", ""),
            "unit": (s.get("unit") or [{}])[0].get("name") if isinstance(s.get("unit"), list) and s.get("unit") else None,
            "pointlist": pts[:MAX_POINTS],
        })
    return ok({"series": out, "truncated": len(series) > MAX_SERIES,
               "status": data.get("status") if isinstance(data, dict) else None})


def datadog_schema(args):
    """Actively-reporting metric names from the last hour (query-gen vocabulary)."""
    data = _get(_ds(), "/api/v1/metrics", {"from": _parse_time_s(None, 3600)})
    metrics = data.get("metrics", []) if isinstance(data, dict) else []
    metrics = metrics if isinstance(metrics, list) else []
    return ok({"metrics": metrics[:200], "truncated": len(metrics) > 200})


def datadog_health(args):
    """Key validation probe: GET /api/v1/validate (API key), then a 1-metric list (app key scope)."""
    creds = load_datasource(SLUG)
    assert_host_allowed(creds["endpoint"])
    try:
        v = _get(creds, "/api/v1/validate")
        return ok({"ok": bool(isinstance(v, dict) and v.get("valid"))})
    except _ApiError as e:
        return ok({"ok": False, "error": str(e)})


_TOOLS = {
    "datadog_query": datadog_query, "datadog_schema": datadog_schema, "datadog_health": datadog_health,
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
        return err(f"datadog error: {e}")
    finally:
        set_request_conn(None)


def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str, ensure_ascii=False)}


def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
