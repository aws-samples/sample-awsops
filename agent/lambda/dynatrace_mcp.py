"""
Dynatrace read-only MCP Lambda — Metrics API v2 query + problems feed + metric discovery against a
user-registered Dynatrace environment (v1 datasource family parity). Uses datasource_http
(credential load, SSRF host guard, no-redirect HTTP).

READ-ONLY by construction. Dynatrace specifics: auth is `Authorization: Api-Token <token>` — NOT
Bearer — so the UI's `bearer` authType (token field) is translated here; timestamps accept the
native relative form (now-1h) or unix MILLISECONDS. Endpoint = the environment URL
(https://{env}.live.dynatrace.com or an ActiveGate URL). Stdlib + boto3 only.
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

SLUG = "dynatrace"
MAX_SERIES = 50
_REL = re.compile(r"^(\d+)([smhdw])$")
_NATIVE = re.compile(r"^now(-\d+[smhdw])?$")


class _ApiError(Exception):
    pass


def _parse_time(v, default="now-1h"):
    """Dynatrace-native ('now-1h') passthrough / '1h' → 'now-1h' / unix sec|ms → ms string."""
    if v is None:
        return default
    s = str(v).strip()
    if _NATIVE.match(s):
        return s
    if _REL.match(s):
        return f"now-{s}"
    n = int(float(s))
    return str(n * 1000 if n < 10**12 else n)  # seconds → ms


def _headers(creds):
    """Api-Token scheme: an explicit token (authType bearer) becomes `Authorization: Api-Token …`;
    custom-header auth passes through unchanged (auth_headers refuses to set Authorization itself)."""
    h = dict(auth_headers(creds))
    if creds.get("token"):
        h["Authorization"] = f"Api-Token {creds['token']}"
    return h


def _ds():
    creds = load_datasource(SLUG)
    assert_host_allowed(creds["endpoint"])
    return creds


def _get(creds, path, params=None):
    url = creds["endpoint"].rstrip("/") + path + ("?" + urlencode(params, doseq=True) if params else "")
    status, data = http_json("GET", url, headers=_headers(creds))
    if status >= 400:
        detail = data.get("error") if isinstance(data, dict) else None
        msg = detail.get("message") if isinstance(detail, dict) else (detail or data.get("raw") if isinstance(data, dict) else data)
        raise _ApiError(f"Dynatrace HTTP {status}: {str(msg)[:300]}")
    return data


def dynatrace_query(args):
    selector = (args.get("query") or "").strip()
    if not selector:
        return err("query (metricSelector) required — e.g. builtin:host.cpu.usage:avg")
    params = {
        "metricSelector": selector,
        "from": _parse_time(args.get("start"), "now-1h"),
        "to": _parse_time(args.get("end"), "now"),
    }
    if args.get("resolution"):
        params["resolution"] = str(args["resolution"])
    data = _get(_ds(), "/api/v2/metrics/query", params)
    result = data.get("result", []) if isinstance(data, dict) else []
    out = []
    for metric in result[:MAX_SERIES]:
        if not isinstance(metric, dict):
            continue
        out.append({
            "metricId": metric.get("metricId", ""),
            "data": [
                {
                    "dimensions": d.get("dimensions", []),
                    "timestamps": d.get("timestamps", []),
                    "values": d.get("values", []),
                }
                for d in (metric.get("data") or [])[:MAX_SERIES]
                if isinstance(d, dict)
            ],
        })
    return ok({"result": out, "truncated": len(result) > MAX_SERIES,
               "resolution": data.get("resolution") if isinstance(data, dict) else None})


def dynatrace_problems(args):
    params = {"from": _parse_time(args.get("start"), "now-2h"), "pageSize": "50"}
    data = _get(_ds(), "/api/v2/problems", params)
    problems = data.get("problems", []) if isinstance(data, dict) else []
    rows = [
        {
            "title": p.get("title", ""), "severityLevel": p.get("severityLevel", ""),
            "status": p.get("status", ""), "impactLevel": p.get("impactLevel", ""),
            "startTime": p.get("startTime"), "endTime": p.get("endTime"),
            "affectedEntities": len(p.get("affectedEntities") or []),
        }
        for p in problems if isinstance(p, dict)
    ]
    return ok({"problems": rows, "totalCount": data.get("totalCount") if isinstance(data, dict) else len(rows)})


def dynatrace_schema(args):
    """Metric ids (query-gen vocabulary for metricSelector)."""
    data = _get(_ds(), "/api/v2/metrics", {"pageSize": "200", "fields": "metricId"})
    metrics = [m.get("metricId", "") for m in (data.get("metrics") or []) if isinstance(m, dict)] if isinstance(data, dict) else []
    metrics = [m for m in metrics if m]
    return ok({"metrics": metrics[:200], "truncated": bool(isinstance(data, dict) and data.get("nextPageKey"))})


def dynatrace_health(args):
    """Connectivity + token probe: metrics list pageSize=1 (requires metrics.read scope)."""
    creds = load_datasource(SLUG)
    assert_host_allowed(creds["endpoint"])
    try:
        _get(creds, "/api/v2/metrics", {"pageSize": "1"})
        return ok({"ok": True})
    except _ApiError as e:
        return ok({"ok": False, "error": str(e)})


_TOOLS = {
    "dynatrace_query": dynatrace_query, "dynatrace_problems": dynatrace_problems,
    "dynatrace_schema": dynatrace_schema, "dynatrace_health": dynatrace_health,
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
        return err(f"dynatrace error: {e}")
    finally:
        set_request_conn(None)


def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str, ensure_ascii=False)}


def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
