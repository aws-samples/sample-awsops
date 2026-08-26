"""
Prometheus read-only MCP Lambda — PromQL instant/range queries + label/series discovery against a
user-registered Prometheus endpoint. Second of the v1 datasource family; uses the shared
datasource_http helper (credential load, SSRF host guard, auth, no-redirect HTTP).

READ-ONLY by construction: the Prometheus HTTP query API (/api/v1/query[_range], /labels, /series)
only evaluates PromQL / reads metadata — it cannot write and PromQL cannot trigger server-side
fetches, so (unlike ClickHouse SQL) there is no statement guard / table-function class. The only
attack surface is the endpoint, guarded by datasource_http.assert_host_allowed (+ endpoint SSRF
validation on credential save). Stdlib + boto3 only.
"""
import json
import re
import time
from urllib.parse import urlencode

from cross_account import resolve_tool_name
from datasource_http import (
    NotConnected,
    SsrfBlocked,
    assert_host_allowed,
    auth_headers,
    health,
    http_json,
    load_datasource,
    set_request_conn,
)

SLUG = "prometheus"
MAX_SERIES = 50
MAX_POINTS_PER_SERIES = 500
MAX_TOTAL_SAMPLES = 5000

_REL = re.compile(r"^(\d+)([smhdw])$")
_UNIT = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}


def _now():
    return int(time.time())


def _parse_time(v, default_delta=None):
    """now (default) / '1h'/'30m'/'2d' (now-delta) / ISO-ish or unix passthrough → unix-seconds string."""
    if v is None:
        if default_delta:
            return str(_now() - default_delta)
        return str(_now())
    s = str(v).strip()
    m = _REL.match(s)
    if m:
        return str(_now() - int(m.group(1)) * _UNIT[m.group(2)])
    return s  # caller-supplied ISO/unix passthrough (Prometheus accepts RFC3339 or unix)


def _ds():
    creds = load_datasource(SLUG)
    assert_host_allowed(creds["endpoint"])
    return creds


def _get(creds, path, params):
    url = creds["endpoint"].rstrip("/") + path + ("?" + urlencode(params, doseq=True) if params else "")
    status, data = http_json("GET", url, headers=auth_headers(creds))
    if status >= 400:
        raise _ApiError(f"Prometheus HTTP {status}: {str(data.get('raw') or data.get('error') or data)[:300]}")
    if isinstance(data, dict) and data.get("status") and data.get("status") != "success":
        raise _ApiError(f"Prometheus query failed ({data.get('errorType', 'error')}): {data.get('error', 'unknown')}")
    return data.get("data") if isinstance(data, dict) else data


class _ApiError(Exception):
    pass


def _bound(data):
    """Cap series, points-per-series, and a global sample budget for matrix/vector results."""
    if not isinstance(data, dict):
        return data, False
    result = data.get("result")
    if not isinstance(result, list):
        return data, False
    truncated = len(result) > MAX_SERIES
    result = result[:MAX_SERIES]
    budget = MAX_TOTAL_SAMPLES
    out = []
    for series in result:
        s = dict(series)
        vals = s.get("values")
        if isinstance(vals, list):
            if len(vals) > MAX_POINTS_PER_SERIES:
                truncated = True
            allowed = min(MAX_POINTS_PER_SERIES, max(0, budget))
            if len(vals) > allowed:
                truncated = True
            s["values"] = vals[:allowed]
            budget -= len(s["values"])
        out.append(s)
    return {"resultType": data.get("resultType"), "result": out}, truncated


def prometheus_query(args):
    query = (args.get("query") or "").strip()
    if not query:
        return err("query (PromQL) required")
    data = _get(_ds(), "/api/v1/query", {"query": query, "time": _parse_time(args.get("time"))})
    bounded, truncated = _bound(data)
    return ok({"truncated": truncated, **(bounded if isinstance(bounded, dict) else {"result": bounded})})


def prometheus_query_range(args):
    query = (args.get("query") or "").strip()
    if not query:
        return err("query (PromQL) required")
    start = _parse_time(args.get("start"), default_delta=3600)
    end = _parse_time(args.get("end"))
    step = str(args.get("step") or "60").strip()
    data = _get(_ds(), "/api/v1/query_range", {"query": query, "start": start, "end": end, "step": step})
    bounded, truncated = _bound(data)
    return ok({"truncated": truncated, **(bounded if isinstance(bounded, dict) else {"result": bounded})})


def prometheus_labels(args):
    data = _get(_ds(), "/api/v1/labels", {})
    names = data if isinstance(data, list) else []
    return ok({"labels": names[:1000], "truncated": len(names) > 1000})


def prometheus_series(args):
    match = (args.get("match") or "").strip()
    if not match:
        return err("match (series selector) required")
    data = _get(_ds(), "/api/v1/series", {"match[]": match})
    series = data if isinstance(data, list) else []
    return ok({"series": series[:MAX_SERIES], "truncated": len(series) > MAX_SERIES})


def prometheus_schema(args):
    creds = _ds()
    base = "/api/v1"
    try:  # version is best-effort — a missing/old buildinfo never fails the schema fetch (names matter most)
        bi = _get(creds, f"{base}/status/buildinfo", {})
        version = bi.get("version") if isinstance(bi, dict) else None
    except _ApiError:
        version = None
    try:
        labels = _get(creds, f"{base}/labels", {})
    except _ApiError:
        labels = []
    try:
        metrics = _get(creds, f"{base}/label/__name__/values", {})
    except _ApiError:
        metrics = []
    labels = labels if isinstance(labels, list) else []
    metrics = metrics if isinstance(metrics, list) else []
    return ok({"version": version, "metrics": metrics[:500], "labels": labels[:200],
               "truncated": len(metrics) > 500 or len(labels) > 200})


def prometheus_health(args):
    """Connectivity probe for the pre-save Test / status badge: GET /-/healthy."""
    return ok(health(_ds(), "/-/healthy"))


def prometheus_metric_meta(args):
    metrics = args.get("metrics")
    if not isinstance(metrics, list):
        metrics = []
    # Validate metric names (Prometheus name grammar) before building a `match[]` selector — drops
    # malformed/injection-y inputs (e.g. embedded `"`/`\`) rather than forming a bad selector.
    metrics = [m for m in (str(x).strip() for x in metrics) if m and re.match(r"^[a-zA-Z_:][a-zA-Z0-9_:]*$", m)][:12]
    if not metrics:
        return ok({})

    creds = _ds()
    base = "/api/v1"
    out = {}
    for m in metrics:
        # Per-metric scope (metadata?metric=<m>) — never download the server-wide metadata map.
        entry = {"type": None, "labels": []}
        try:
            meta_resp = _get(creds, f"{base}/metadata", {"metric": m})
            meta = meta_resp if isinstance(meta_resp, dict) else {}
            v = meta.get(m)
            entry["type"] = v[0].get("type") if isinstance(v, list) and v and isinstance(v[0], dict) else None
            labels_data = _get(creds, f"{base}/labels", {"match[]": f'{{__name__="{m}"}}'})
            labels = [lb for lb in (labels_data if isinstance(labels_data, list) else []) if lb != "__name__"]
            if len(labels) > 200:  # bound high-cardinality label sets (mirrors *_labels [:N] convention)
                entry["labels"], entry["labels_truncated"] = labels[:200], True
            else:
                entry["labels"] = labels
        except _ApiError as e:
            entry["error"] = str(e)[:200]
        out[m] = entry

    return ok(out)


_TOOLS = {
    "prometheus_query": prometheus_query,
    "prometheus_query_range": prometheus_query_range,
    "prometheus_labels": prometheus_labels,
    "prometheus_series": prometheus_series, "prometheus_schema": prometheus_schema,
    "prometheus_health": prometheus_health,
    "prometheus_metric_meta": prometheus_metric_meta,
}


def lambda_handler(event, context):
    params = event if isinstance(event, dict) else json.loads(event)
    t = resolve_tool_name(params, context)
    args = params.get("arguments", params)
    inst = args.get("instance_id") if isinstance(args, dict) else None
    conn = params.get("conn_config")
    if isinstance(args, dict):
        args.pop("target_account_id", None)  # account-agnostic (HTTP endpoint)
        args.pop("instance_id", None)        # routing arg, not a tool arg
    try:
        # Resolution precedence: BFF inline conn (trusted) > per-instance secret (credential-blind
        # worker path: only an id is sent, the connector reads the secret) > kind-mirror default.
        if conn:
            set_request_conn(conn)
        elif inst is not None:
            set_request_conn(load_datasource(SLUG, instance_id=inst))  # raises NotConnected if no such instance
        else:
            set_request_conn(None)
        fn = _TOOLS.get(t)
        if fn is None:
            return err(f"unknown tool: {t}")
        return fn(args)
    except (NotConnected, SsrfBlocked, _ApiError) as e:
        return err(str(e))
    except Exception as e:  # noqa: BLE001 — never leak a stack trace / credentials
        return err(f"prometheus error: {e}")
    finally:
        set_request_conn(None)  # guaranteed reset — no warm-container bleed


def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str)}


def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
