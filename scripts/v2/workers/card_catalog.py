"""Deterministic dashboard-card catalog — the third pre-built-content family
(next to diagnosis/signal_catalog.py and graph_catalog.py; flat next to
datasource_index.py like graph_catalog, and bundled flat in workers.tf's archive_file).

build_cards(kind, schema) is PURE: no DB, no AWS SDK, no egress. Expressions are module
constants; the ONLY schema-derived splice is the ClickHouse table identifier, validated
against _IDENT before use — a poisoned schema can only make a card `unavailable`, never
inject into a query.

CARD_CATALOG_VERSION is mixed into the per-instance card schema hash
(datasource_index._card_schema_version) so editing this catalog forces a rebuild even
when the datasource's schema is unchanged.

A truncated schema cache (schema.truncated) makes absence UNKNOWABLE: unmatched
requirements become status "unknown", never a confident "missing" (honest-degrade).
"""
import re

# NOTE (i18n lockstep): the Korean `title` strings below are REGISTERED in
# web/lib/i18n-terms.ts (the web UI renders them through tt()). Adding or renaming a title
# here requires the matching TERMS entry there, or the chip/card stays Korean in en/zh/ja.

# v5: expand Prometheus/Mimir operational cards 5 → 13 (targets, CPU, memory, disk, load, network,
# containers, restarts), selective rebuild hash (required-metric presence/probe + truncation only),
# and build-time live validation of the stored queries via the same instant/range tool the UI runs.
# v4: trace discriminator requires a trace-ONLY column (Duration/ParentSpanId/SpanKind) — the
# standard otel_logs table carries SpanId too, so SpanId must not qualify a table as traces.
# v3: sum(up) (count(up==1) is an EMPTY vector during a total outage — must render 0, not "값 없음"),
# schema `probed` support (definitive per-name presence despite the 500-name cap).
# v2: accept db-qualified table names (per-segment validated + quoted) — clickhouse_mcp introspection emits f"{database}.{name}"
CARD_CATALOG_VERSION = "v5"

_IDENT = re.compile(r"^[A-Za-z0-9_]+$")
_RANGE_1H = {"window": 3600, "step": 60}

_PROM_CARDS = [
    # sum(up), not count(up == 1): up∈{0,1} makes them equal while any target is up, but during a
    # TOTAL outage count(up == 1) is an empty instant vector (renders "값 없음") whereas sum(up)
    # still evaluates over the down series and renders the honest 0.
    {"card_key": "up_targets", "title": "정상 타깃 수", "viz": "stat", "unit": "",
     "requires": ["up"], "expr": "sum(up)", "range": None},
    {"card_key": "down_targets", "title": "다운된 타깃 수", "viz": "stat", "unit": "",
     "requires": ["up"], "expr": "sum(up == bool 0)", "range": None},
    {"card_key": "cpu_usage", "title": "노드 CPU 사용률", "viz": "timeseries", "unit": "%",
     "requires": ["node_cpu_seconds_total"],
     "expr": '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)', "range": _RANGE_1H},
    {"card_key": "node_cpu_top5", "title": "CPU 사용률 높은 노드 Top5", "viz": "timeseries", "unit": "%",
     "requires": ["node_cpu_seconds_total"],
     "expr": 'topk(5, 100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100))',
     "range": _RANGE_1H},
    {"card_key": "memory_available", "title": "가용 메모리", "viz": "timeseries", "unit": "bytes",
     "requires": ["node_memory_MemAvailable_bytes"],
     "expr": "sum(node_memory_MemAvailable_bytes)", "range": _RANGE_1H},
    {"card_key": "node_memory_usage_top5", "title": "메모리 사용률 높은 노드 Top5",
     "viz": "timeseries", "unit": "%",
     "requires": ["node_memory_MemAvailable_bytes", "node_memory_MemTotal_bytes"],
     "expr": "topk(5, 100 * (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)))",
     "range": _RANGE_1H},
    {"card_key": "node_disk_usage_top5", "title": "디스크 사용률 높은 노드 Top5",
     "viz": "timeseries", "unit": "%",
     "requires": ["node_filesystem_avail_bytes", "node_filesystem_size_bytes"],
     "expr": 'topk(5, max by (instance) (100 * (1 - '
             '(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay",mountpoint!~"/run.*"} '
             '/ node_filesystem_size_bytes{fstype!~"tmpfs|overlay",mountpoint!~"/run.*"}))))',
     "range": _RANGE_1H},
    {"card_key": "node_load1_top5", "title": "로드 애버리지 높은 노드 Top5",
     "viz": "timeseries", "unit": "",
     "requires": ["node_load1"], "expr": "topk(5, node_load1)", "range": _RANGE_1H},
    {"card_key": "node_network_receive_top5", "title": "네트워크 수신량 높은 노드 Top5",
     "viz": "timeseries", "unit": "bytes/s",
     "requires": ["node_network_receive_bytes_total"],
     "expr": 'topk(5, sum by (instance) (rate(node_network_receive_bytes_total{device!="lo"}[5m])))',
     "range": _RANGE_1H},
    {"card_key": "node_network_transmit_top5", "title": "네트워크 송신량 높은 노드 Top5",
     "viz": "timeseries", "unit": "bytes/s",
     "requires": ["node_network_transmit_bytes_total"],
     "expr": 'topk(5, sum by (instance) (rate(node_network_transmit_bytes_total{device!="lo"}[5m])))',
     "range": _RANGE_1H},
    {"card_key": "container_cpu", "title": "네임스페이스별 컨테이너 CPU Top5", "viz": "timeseries", "unit": "cores",
     "requires": ["container_cpu_usage_seconds_total"],
     "expr": "topk(5, sum by (namespace) (rate(container_cpu_usage_seconds_total[5m])))", "range": _RANGE_1H},
    {"card_key": "container_memory_top5", "title": "네임스페이스별 컨테이너 메모리 Top5",
     "viz": "timeseries", "unit": "bytes",
     "requires": ["container_memory_working_set_bytes"],
     "expr": 'topk(5, sum by (namespace) (container_memory_working_set_bytes{container!="",image!=""}))',
     "range": _RANGE_1H},
    {"card_key": "pod_restarts", "title": "최근 1시간 파드 재시작", "viz": "stat", "unit": "",
     "requires": ["kube_pod_container_status_restarts_total"],
     "expr": "sum(increase(kube_pod_container_status_restarts_total[1h]))", "range": None},
]

# First present label wins as the stream anchor — {job=~".+"} matches every stream that
# HAS the label, which is the broadest read-only selector LogQL allows (no bare {}).
_LOKI_ANCHORS = ["job", "app", "namespace"]
_LOKI_CARDS = [
    {"card_key": "log_volume", "title": "로그 볼륨 (5m)", "viz": "timeseries", "unit": "lines",
     "expr_tpl": 'sum(count_over_time({{{anchor}=~".+"}}[5m]))'},
    {"card_key": "error_rate", "title": "에러 로그 (5m)", "viz": "timeseries", "unit": "lines",
     "expr_tpl": 'sum(count_over_time({{{anchor}=~".+"}} |~ "(?i)error" [5m]))'},
]

_TEMPO_CARDS = [
    {"card_key": "slow_traces", "title": "느린 트레이스 (>1s)", "viz": "table", "expr": "{ duration > 1s }"},
    {"card_key": "error_traces", "title": "에러 트레이스", "viz": "table", "expr": "{ status = error }"},
]


def _row(card_key, title, viz, unit, status, tool=None, expr=None, rng=None, missing=None):
    """status is one of "ready" | "unavailable" | "unknown" ("unknown" = the requirement was not
    found but the schema cache is truncated, so its absence could not be determined)."""
    return {
        "card_key": card_key, "title": title, "viz": viz, "unit": unit, "status": status,
        "query": ({"tool": tool, "expr": expr, "range": rng} if status == "ready" else None),
        "missing": list(missing or []),
    }


def _absent_status(truncated):
    """A requirement not found in the schema: confidently missing, or merely undetermined?"""
    return "unknown" if truncated else "unavailable"


def _quote_identifier(name):
    """Backtick-quote a ClickHouse identifier per dot-separated segment (`db`.`table`) — mirrors
    graph_catalog._quote_identifier. Wrapping the whole `db.table` string in one pair makes
    ClickHouse read it as a SINGLE identifier containing a dot → UNKNOWN_TABLE."""
    return ".".join("`" + part + "`" for part in str(name).split("."))


def required_metrics():
    """Union of every Prometheus/Mimir card requirement — callers (datasource_index) pass this as
    `probe_metrics` to `{kind}_schema` so a truncated 500-name list still yields definitive
    matches (the cap is alphabetical, so on real instances the required names are capped out)."""
    return sorted({m for c in _PROM_CARDS for m in c["requires"]})


def _prom(kind, schema, truncated=False):
    metrics = {m for m in (schema.get("metrics") or []) if isinstance(m, str)}
    # Names the connector probed INDIVIDUALLY (schema.probed) have definitive presence/absence even
    # when the bulk name list is truncated — only unprobed misses degrade to "unknown".
    probed = {m for m in (schema.get("probed") or []) if isinstance(m, str)}
    tool = "prometheus_query" if kind == "prometheus" else "mimir_query"
    out = []
    for c in _PROM_CARDS:
        miss = [m for m in c["requires"] if m not in metrics]
        if miss:
            status = "unavailable" if all(m in probed for m in miss) else _absent_status(truncated)
            out.append(_row(c["card_key"], c["title"], c["viz"], c["unit"], status, missing=miss))
        else:
            out.append(_row(c["card_key"], c["title"], c["viz"], c["unit"], "ready", tool, c["expr"], c["range"]))
    return out


def _loki(schema, truncated=False):
    labels = {l for l in (schema.get("labels") or []) if isinstance(l, str)}
    anchor = next((a for a in _LOKI_ANCHORS if a in labels), None)
    out = []
    for c in _LOKI_CARDS:
        if anchor is None:
            out.append(_row(c["card_key"], c["title"], c["viz"], c["unit"],
                            _absent_status(truncated), missing=_LOKI_ANCHORS))
        else:
            out.append(_row(c["card_key"], c["title"], c["viz"], c["unit"], "ready",
                            "loki_query_range", c["expr_tpl"].format(anchor=anchor), _RANGE_1H))
    return out


def _tempo():
    # TraceQL structural queries need no specific tag — always ready once a tempo schema row exists.
    return [_row(c["card_key"], c["title"], c["viz"], "", "ready", "tempo_search", c["expr"], None)
            for c in _TEMPO_CARDS]


def _valid_table_name(name):
    """A table name is usable when it is 1 or 2 dot-separated segments (table or db.table — the
    shape clickhouse_mcp introspection emits) and EVERY segment matches _IDENT."""
    if not isinstance(name, str):
        return False
    parts = name.split(".")
    return 1 <= len(parts) <= 2 and all(_IDENT.match(p) for p in parts)


def _clickhouse(schema, truncated=False):
    tables = [t for t in (schema.get("tables") or []) if isinstance(t, dict)]

    def colnames(t):
        return {c.get("name") for c in (t.get("columns") or []) if isinstance(c, dict)}

    def basename(t):
        n = t.get("name")
        return str(n).split(".")[-1] if isinstance(n, str) else None

    def is_trace_table(t):
        # Only a trace-ONLY column (Duration/ParentSpanId/SpanKind) discriminates a TRACE table —
        # the standard otel_logs table carries Timestamp+TraceId+SpanId (+ServiceName), so accepting
        # SpanId as a discriminator confidently mislabels log rows as spans (a logs-only OTel
        # pipeline would get "스팬 수" cards counting log lines). Mirrors graph_catalog, which
        # requires Duration/ParentSpanId in _OTEL_REQUIRED_COLUMNS for the same reason.
        cols = colnames(t)
        return {"Timestamp", "TraceId"} <= cols and bool({"Duration", "ParentSpanId", "SpanKind"} & cols)

    # The exact-name match still requires Timestamp — the stored queries filter on it, so an
    # otel_traces table without it would be marked ready only to fail on every view.
    target = next((t for t in tables if basename(t) == "otel_traces" and "Timestamp" in colnames(t)), None)
    if target is None:
        target = next((t for t in tables if is_trace_table(t)), None)
    name = target.get("name") if target else None
    if not _valid_table_name(name):
        missing = ["otel_traces (or a table with Timestamp+TraceId and a Duration/ParentSpanId/SpanKind column)"]
        # A structurally invalid identifier is NOT an absence truncation could explain — it stays
        # a confident `unavailable`. Only a genuinely absent table degrades to `unknown`.
        status = "unavailable" if target is not None else _absent_status(truncated)
        return [
            _row("otel_span_rate", "최근 1시간 스팬 수", "stat", "spans", status, missing=missing),
            _row("top_services", "서비스별 스팬 Top5 (1h)", "table", "", status, missing=missing),
        ]
    quoted = _quote_identifier(name)
    out = [_row("otel_span_rate", "최근 1시간 스팬 수", "stat", "spans", "ready", "clickhouse_query",
                f"SELECT count() AS value FROM {quoted} WHERE Timestamp > now() - INTERVAL 1 HOUR", None)]
    if "ServiceName" in colnames(target):
        out.append(_row("top_services", "서비스별 스팬 Top5 (1h)", "table", "", "ready", "clickhouse_query",
                        f"SELECT ServiceName, count() AS spans FROM {quoted} "
                        "WHERE Timestamp > now() - INTERVAL 1 HOUR GROUP BY ServiceName ORDER BY spans DESC LIMIT 5", None))
    else:
        out.append(_row("top_services", "서비스별 스팬 Top5 (1h)", "table", "",
                        _absent_status(truncated), missing=["ServiceName"]))
    return out


def build_cards(kind, schema):
    """Pure: kind + cached schema dict → card rows. Unknown kind / no schema → []."""
    if not isinstance(schema, dict):
        return []
    truncated = schema.get("truncated") is True
    if kind in ("prometheus", "mimir"):
        return _prom(kind, schema, truncated)
    if kind == "loki":
        return _loki(schema, truncated)
    if kind == "tempo":
        # Tempo cards have no schema requirements — truncation cannot affect them.
        return _tempo()
    if kind == "clickhouse":
        return _clickhouse(schema, truncated)
    return []
