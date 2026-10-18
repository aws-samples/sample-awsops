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
    set_request_conn, request_timeout, finite_number, observed_payload,
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
    if creds.get("authType") in (None, "custom_header") and creds.get("apiKey"):
        h["DD-API-KEY"] = str(creds["apiKey"])
    if creds.get("authType") in (None, "custom_header") and creds.get("appKey"):
        h["DD-APPLICATION-KEY"] = str(creds["appKey"])
    return h


def _ds():
    creds = load_datasource(SLUG)
    assert_host_allowed(creds["endpoint"])
    return creds


def _get(creds, path, params=None):
    url = creds["endpoint"].rstrip("/") + path + ("?" + urlencode(params, doseq=True) if params else "")
    status, data = http_json("GET", url, headers=_headers(creds), timeout=request_timeout(creds))
    if status >= 400:
        errs = data.get("errors") if isinstance(data, dict) else None
        raise _ApiError(f"Datadog HTTP {status}: {str(errs or (data.get('raw') if isinstance(data, dict) else data))[:300]}")
    return observed_payload(data, status)


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
    if isinstance(data, dict) and (data.get("status") == "error" or data.get("errors") or data.get("error")):
        return ok({"series": [], "truncated": False, "collectionStatus": "error"})
    series = data.get("series") if isinstance(data, dict) else None
    if not isinstance(data, dict) or data.get("status") != "ok" or not isinstance(series, list):
        return ok({"series": [], "truncated": False, "collectionStatus": "unknown"})
    out = []
    truncated = len(series) > MAX_SERIES
    invalid = False
    for s in series[:MAX_SERIES]:
        if not isinstance(s, dict) or not isinstance(s.get("metric"), str) or not isinstance(s.get("pointlist"), list):
            invalid = True
            continue
        pts = s["pointlist"]
        truncated = truncated or len(pts) > MAX_POINTS
        points = []
        for point in pts[:MAX_POINTS]:
            if (not isinstance(point, list) or len(point) != 2
                    or not finite_number(point[0], 8640000000000000)
                    or point[1] is not None and not finite_number(point[1])):
                invalid = True
                continue
            points.append(point)
        units = s.get("unit")
        unit = units[0].get("name") if isinstance(units, list) and units and isinstance(units[0], dict) else None
        out.append({
            "metric": s.get("metric", ""), "scope": s.get("scope", ""),
            "unit": unit, "pointlist": points,
        })
    http_status = getattr(data, "http_status", 200)
    state = "unknown" if invalid or http_status not in (200, 206) else "partial" if truncated or http_status == 206 else "ok" if out else "empty"
    return ok({"series": out, "truncated": truncated,
               "collectionStatus": state,
               "status": data.get("status") if isinstance(data, dict) else None})


def datadog_schema(args):
    """Actively-reporting metric names from the last hour (query-gen vocabulary)."""
    data = _get(_ds(), "/api/v1/metrics", {"from": _parse_time_s(None, 3600)})
    metrics = data.get("metrics", []) if isinstance(data, dict) else []
    metrics = metrics if isinstance(metrics, list) else []
    return ok({"metrics": metrics[:200], "truncated": len(metrics) > 200})


def datadog_health(args):
    """Validate configured API keys, then metric-query access (key pair or bearer)."""
    creds = load_datasource(SLUG)
    assert_host_allowed(creds["endpoint"])
    try:
        # The API-key validator does not validate bearer access tokens. Those use
        # the supported metric-query operation itself as the authentication proof.
        if any(name.lower() == "dd-api-key" for name in _headers(creds)):
            v = _get(creds, "/api/v1/validate")
            if not isinstance(v, dict) or v.get("valid") is not True:
                return ok({"ok": False, "error": "Datadog API key validation failed"})
        end = int(time.time())
        # A one-minute, single-metric query with a probe-only host filter verifies
        # metric-query permission without fetching the fleet's real metric series.
        probe = _get(creds, "/api/v1/query", {
            "query": "avg:system.cpu.user{host:awsops-connection-probe}",
            "from": str(end - 60), "to": str(end),
        })
        verified = isinstance(probe, dict) and probe.get("status") == "ok" and isinstance(probe.get("series"), list)
        return ok({"ok": verified, **({} if verified else {"error": "Datadog metric-query access could not be verified"})})
    except _ApiError:
        return ok({"ok": False, "error": "Datadog credentials or metric-query access could not be verified"})


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
