"""
Mimir read-only MCP Lambda — PromQL instant/range + label/series discovery against a user-registered
Grafana Mimir endpoint. Final of the v1 datasource family; uses datasource_http. Mimir is
Prometheus-API-compatible under a /prometheus prefix and multi-tenant (X-Scope-OrgID).

READ-ONLY by construction (no SQL guard). SSRF via datasource_http. Stdlib + boto3 only.
"""
import json
import re
import time
from urllib.parse import urlencode

from cross_account import resolve_tool_name
from datasource_http import (
    NotConnected, SsrfBlocked, assert_host_allowed, auth_headers, health, http_json, load_datasource,
    set_request_conn,
)

SLUG = "mimir"
BASE = "/prometheus/api/v1"
MAX_SERIES = 50
# Schema metric-name cap (was 500 — alphabetical truncation dropped every `node_*`/`kube_*` family on
# real kube-prometheus stacks, so NL→PromQL generation never saw the metrics users asked about).
# 3000 names ≈ 120KB of JSON — inside the web cache's 256KB row bound with the 200-label list.
SCHEMA_METRIC_CAP = 3000

MAX_POINTS_PER_SERIES = 500
MAX_TOTAL_SAMPLES = 5000
_REL = re.compile(r"^(\d+)([smhdw])$")
_UNIT = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}


class _ApiError(Exception):
    pass


def _parse_time(v, default_delta_s=None):
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


def _get(creds, path, params, http_timeout=None):
    url = creds["endpoint"].rstrip("/") + path + ("?" + urlencode(params, doseq=True) if params else "")
    kwargs = {"headers": _headers(creds)}
    if http_timeout is not None:
        kwargs["timeout"] = http_timeout
    status, data = http_json("GET", url, **kwargs)
    if status >= 400:
        raise _ApiError(f"Mimir HTTP {status}: {str(data.get('raw') or data.get('error') or data)[:300]}")
    if isinstance(data, dict) and data.get("status") and data.get("status") != "success":
        raise _ApiError(f"Mimir query failed ({data.get('errorType', 'error')}): {data.get('error', 'unknown')}")
    return data.get("data") if isinstance(data, dict) else data


def _bound(data):
    if not isinstance(data, dict) or not isinstance(data.get("result"), list):
        return data, False
    result = data["result"]
    truncated = len(result) > MAX_SERIES
    result = result[:MAX_SERIES]
    budget = MAX_TOTAL_SAMPLES
    out = []
    for series in result:
        s = dict(series)
        vals = s.get("values")
        if isinstance(vals, list):
            allowed = min(MAX_POINTS_PER_SERIES, max(0, budget))
            if len(vals) > allowed:
                truncated = True
            s["values"] = vals[:allowed]
            budget -= len(s["values"])
        out.append(s)
    return {"resultType": data.get("resultType"), "result": out}, truncated


def _timeout_param(v):
    """Optional Prometheus-API `timeout` (e.g. "5s"), clamped to 1..60s. Same knob prometheus_mcp.py grew:
    the connector bounds response SIZE but had no execution bound, which matters now that a caller can run
    model-written PromQL through it (review — the diag-signal dry run passes 5s for mimir too)."""
    # No digit cap: `\d{1,3}` made "1000" or "3600s" fall through to None, i.e. NO bound — a clamp that
    # fails open for exactly the values that need clamping (review MINOR). Only non-numeric input is None.
    # `v or ""` turns numeric 0 into "" (falsy), which then fails the match and returns None —
    # i.e. NO bound for exactly the value that most needs clamping. Only skip on a true absence.
    if v is None or v == "":
        return None
    m = re.fullmatch(r"\s*(\d+)s?\s*", str(v))
    return f"{max(1, min(60, int(m.group(1))))}s" if m else None


def mimir_query(args):
    query = (args.get("query") or "").strip()
    if not query:
        return err("query (PromQL) required")
    params = {"query": query, "time": _parse_time(args.get("time"))}
    timeout = _timeout_param(args.get("timeout"))
    if timeout:
        params["timeout"] = timeout
    data = _get(_ds(), f"{BASE}/query", params)
    bounded, tr = _bound(data)
    return ok({"truncated": tr, **(bounded if isinstance(bounded, dict) else {"result": bounded})})


def mimir_query_range(args):
    query = (args.get("query") or "").strip()
    if not query:
        return err("query (PromQL) required")
    params = {"query": query, "start": _parse_time(args.get("start"), 3600),
              "end": _parse_time(args.get("end")), "step": str(args.get("step") or "60")}
    timeout = _timeout_param(args.get("timeout"))
    if timeout:
        params["timeout"] = timeout
    data = _get(_ds(), f"{BASE}/query_range", params)
    bounded, tr = _bound(data)
    return ok({"truncated": tr, **(bounded if isinstance(bounded, dict) else {"result": bounded})})


def mimir_labels(args):
    data = _get(_ds(), f"{BASE}/labels", {})
    names = data if isinstance(data, list) else []
    return ok({"labels": names[:1000], "truncated": len(names) > 1000})


def mimir_series(args):
    match = (args.get("match") or "").strip()
    if not match:
        return err("match (series selector) required")
    data = _get(_ds(), f"{BASE}/series", {"match[]": match})
    series = data if isinstance(data, list) else []
    return ok({"series": series[:MAX_SERIES], "truncated": len(series) > MAX_SERIES})


def mimir_schema(args):
    creds = _ds()
    base = BASE
    try:  # best-effort server version for version-aware PromQL
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
        metrics = None
    labels = labels if isinstance(labels, list) else []
    metrics_ok = isinstance(metrics, list)  # a FAILED bulk fetch is not an empty schema
    metrics = metrics if metrics_ok else []
    # A failed metric fetch surfaces as truncation: absence is then UNDETERMINED (cards degrade to
    # "unknown"), never a confident "unavailable" derived from an empty list.
    out = {"version": version, "metrics": metrics[:SCHEMA_METRIC_CAP], "labels": labels[:200],
           "truncated": (not metrics_ok) or len(metrics) > SCHEMA_METRIC_CAP or len(labels) > 200}
    # Same rationale as prometheus_schema: caller-named metrics are decided by local membership in
    # the full un-capped in-memory list — definitive, zero extra network calls. A failed bulk fetch
    # skips this (nothing decided) and `truncated` degrades absence to "unknown".
    probe = args.get("probe_metrics") if isinstance(args, dict) else None
    if isinstance(probe, list) and metrics_ok:
        wanted = [m for m in (str(x).strip() for x in probe)
                  if m and re.match(r"^[a-zA-Z_:][a-zA-Z0-9_:]*$", m)][:24]
        full = set(metrics)
        kept = set(out["metrics"])
        out["metrics"] = out["metrics"] + sorted((full & set(wanted)) - kept)
        out["probed"] = sorted(set(wanted))
    return ok(out)


def mimir_metric_meta(args):
    metrics = args.get("metrics")
    if not isinstance(metrics, list):
        metrics = []
    # Validate metric names (Prometheus name grammar) before building a `match[]` selector — drops
    # malformed/injection-y inputs (e.g. embedded `"`/`\`) rather than forming a bad selector.
    metrics = [m for m in (str(x).strip() for x in metrics) if m and re.match(r"^[a-zA-Z_:][a-zA-Z0-9_:]*$", m)][:12]
    if not metrics:
        return ok({})

    creds = _ds()
    base = BASE
    out = {}
    # Operation-wide budget (mirrors prometheus_mcp): 12 × 2 × 3s = 72s worst case would exceed the
    # connector Lambda's 60s timeout and lose every partial result — stop probing when spent.
    _budget_start = time.monotonic()
    _META_BUDGET_SEC = 40
    for m in metrics:
        if time.monotonic() - _budget_start > _META_BUDGET_SEC:
            out[m] = {"exists": None, "type": None, "labels": [],
                      "error": "metadata time budget exhausted — retry with fewer metrics"}
            continue
        # Per-metric scope (metadata?metric=<m>) — never download the server-wide metadata map.
        entry = {"exists": False, "type": None, "labels": []}
        try:
            meta_resp = _get(creds, f"{base}/metadata", {"metric": m}, http_timeout=3)
            # A 200 whose body isn't the API shape (a proxy splash page, etc.) proves nothing —
            # conclude absence only from a shape-valid dict response; otherwise stay unknown.
            if isinstance(meta_resp, dict):
                v = meta_resp.get(m)
                entry["exists"] = isinstance(v, list) and bool(v)
            else:
                v = None
                entry["exists"] = None
            entry["type"] = v[0].get("type") if isinstance(v, list) and v and isinstance(v[0], dict) else None
            labels_data = _get(
                creds, f"{base}/labels", {"match[]": f'{{__name__="{m}"}}'}, http_timeout=3)
            if isinstance(labels_data, list) and "__name__" in labels_data:
                entry["exists"] = True
            labels = [lb for lb in (labels_data if isinstance(labels_data, list) else []) if lb != "__name__"]
            if len(labels) > 200:  # bound high-cardinality label sets (mirrors *_labels [:N] convention)
                entry["labels"], entry["labels_truncated"] = labels[:200], True
            else:
                entry["labels"] = labels
        except _ApiError as e:  # HTTP 429/5xx or a non-success API status — the backend, not the metric
            entry["error"] = str(e)[:200]
            if entry["exists"] is not True:  # metadata may already have proven existence (labels failed)
                entry["exists"] = None  # unknown, not "absent"
        except OSError as e:  # socket.timeout/URLError from the 3s deadline — this metric's error, not the whole call's
            entry["error"] = f"upstream unreachable: {str(e)[:150]}"
            if entry["exists"] is not True:
                entry["exists"] = None  # unknown, not "absent"
        out[m] = entry

    return ok(out)


_TOOLS = {"mimir_query": mimir_query, "mimir_query_range": mimir_query_range,
          "mimir_labels": mimir_labels, "mimir_series": mimir_series, "mimir_schema": mimir_schema,
          "mimir_metric_meta": mimir_metric_meta}


def mimir_health(args):
    """Connectivity probe for the pre-save Test / status badge: GET /ready."""
    return ok(health(load_datasource(SLUG), "/ready"))


_TOOLS["mimir_health"] = mimir_health


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
        return err(f"mimir error: {e}")
    finally:
        set_request_conn(None)  # guaranteed reset — no warm-container bleed


def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str, ensure_ascii=False)}


def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
