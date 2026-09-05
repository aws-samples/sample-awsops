
# NOTE (i18n lockstep): the Korean `title` strings below are REGISTERED in
# web/lib/i18n-terms.ts (the web UI renders them through tt()). Adding or renaming a title
# here requires the matching TERMS entry there, or the chip/card stays Korean in en/zh/ja.
"""Deterministic diagnostic-signal catalog for Prometheus/Mimir/Loki/Tempo datasources.

A curated map of ops diagnostic INTENTS → standard PromQL templates (cadvisor / node-exporter /
kube-state-metrics names). `build_signals(kind, schema)` is PURE — no DB, no boto3, no egress: it
checks each signal's required metrics against the instance's cached schema and emits a row per
signal, `ready` (with a runnable query) when every required metric is present, else `unavailable`
(with the missing names). The heavy work (which queries to run) is thus pre-computed at
datasource-index time; the diagnosis worker only executes the stored `ready` queries.

The catalog is intentionally datasource-AGNOSTIC except for kind→tool: prometheus→prometheus_query,
mimir→mimir_query (identical PromQL), loki→loki_query_range, tempo→tempo_search. Metric names are
module constants — never user input — so a poisoned schema can only make a signal `unavailable`,
never inject into a query.

`CATALOG_VERSION` is mixed into the per-instance schema hash so editing this catalog forces a
rebuild even when the datasource's metric set is unchanged.
"""

CATALOG_VERSION = "v5"  # bumped 2026-08-04, twice, for two different UPGRADE-PATH reasons (neither is a
                         # catalog edit) — main is on "v1"; v2/v3/v4 existed only in intermediate commits
                         # of this PR, so deployed instances jump v1 -> v5 in one step:
                         #   v3 -> v4: v3 encoded "generation budget exhausted" as the PLAIN schema hash,
                         #     which is indistinguishable from the legitimate "conclusively nothing to
                         #     build" row that must keep skipping — a row written that way under v3 would
                         #     never generate again.
                         #   v4 -> v5: the weekly-retry marker moved OUT of schema_version entirely, into
                         #     its own bookkeeping row (db.BUDGET_KEY, see datasource_index.py). v5's code
                         #     only ever reads the marker from that dedicated row, which no pre-v5 instance
                         #     has, so without this bump every already-capped/parked instance would
                         #     silently read as "no budget, fresh start" on rollout — an UNDOCUMENTED reset
                         #     of every existing cap (Codex stop-gate).
                         # Each bump changes every hash once: content rebuilds once, and the fresh budget
                         # that comes with a "new" schema_version is the INTENDED behaviour of a version
                         # bump, not a silent side effect of one. From v5 on, a ready/settled outcome
                         # stores the PLAIN version with no bookkeeping row at all; only an active or
                         # exhausted-this-week retry keeps one, in `meta.budget`, never in schema_version.

# kind → connector tool name (PromQL is identical for both)
_KIND_TOOL = {
    "prometheus": "prometheus_query", "mimir": "mimir_query", "loki": "loki_query_range",
    "tempo": "tempo_search", "jaeger": "jaeger_search",
    "dynatrace": "dynatrace_query", "datadog": "datadog_query",
    "clickhouse": "clickhouse_query",
}

# The connector's own argument name for the expression. Kept NEXT TO the tool map rather than derived from
# the tool's name prefix, which silently sends the wrong key if a tool is ever renamed (review MINOR).
TOOL_EXPR_ARG = {"clickhouse_query": "sql"}
DEFAULT_EXPR_ARG = "query"


def expr_arg_for_tool(tool):
    return TOOL_EXPR_ARG.get(tool, DEFAULT_EXPR_ARG)

# Each entry: key, title, pillar, required_metrics, queries[{expr,label}], threshold, unit.
# `topk(10, …)` bounds the result; aggregations use clamp_min to avoid divide-by-zero.
CATALOG = [
    {
        "key": "container_cpu_throttling", "title": "컨테이너 CPU 스로틀링", "pillar": "performance",
        "matcher": "metrics", "kinds": ("prometheus", "mimir"),
        "required_metrics": ["container_cpu_cfs_throttled_periods_total", "container_cpu_cfs_periods_total"],
        "queries": [{
            "label": "throttled_ratio",
            "expr": ("topk(10, sum by(namespace,pod)(rate(container_cpu_cfs_throttled_periods_total[5m])) "
                     "/ clamp_min(sum by(namespace,pod)(rate(container_cpu_cfs_periods_total[5m])), 1))"),
        }],
        "threshold": 0.25, "unit": "ratio",
    },
    {
        "key": "oom_kills", "title": "OOM Kill", "pillar": "reliability",
        "matcher": "metrics", "kinds": ("prometheus", "mimir"),
        "required_metrics": ["kube_pod_container_status_last_terminated_reason"],
        "queries": [{
            "label": "oomkilled_pods",
            "expr": ('topk(10, sum by(namespace,pod)(max_over_time('
                     'kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}[1h])))'),
        }],
        "threshold": 0, "unit": "count",
    },
    {
        "key": "node_memory_pressure", "title": "노드 메모리 압박", "pillar": "reliability",
        "matcher": "metrics", "kinds": ("prometheus", "mimir"),
        "required_metrics": ["node_memory_MemAvailable_bytes", "node_memory_MemTotal_bytes"],
        "queries": [{
            "label": "mem_used_ratio",
            "expr": "topk(10, 1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))",
        }],
        "threshold": 0.85, "unit": "ratio",
    },
    {
        "key": "node_disk_usage", "title": "노드 디스크 사용률", "pillar": "reliability",
        "matcher": "metrics", "kinds": ("prometheus", "mimir"),
        "required_metrics": ["node_filesystem_avail_bytes", "node_filesystem_size_bytes"],
        "queries": [{
            "label": "disk_used_ratio",
            "expr": ('topk(10, 1 - (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} '
                     "/ node_filesystem_size_bytes))"),
        }],
        "threshold": 0.85, "unit": "ratio",
    },
    {
        "key": "network_pps", "title": "네트워크 PPS·드롭", "pillar": "performance",
        "matcher": "metrics", "kinds": ("prometheus", "mimir"),
        "required_metrics": ["node_network_receive_packets_total", "node_network_receive_drop_total"],
        "queries": [
            {"label": "rx_pps", "expr": "topk(10, rate(node_network_receive_packets_total[5m]))"},
            {"label": "rx_drop", "expr": "topk(10, rate(node_network_receive_drop_total[5m]))"},
        ],
        "threshold": 0, "unit": "pps",
    },
    {
        "key": "pod_right_sizing", "title": "Pod 라이트사이징", "pillar": "cost",
        "matcher": "metrics", "kinds": ("prometheus", "mimir"),
        "required_metrics": ["container_memory_working_set_bytes", "kube_pod_container_resource_requests"],
        "queries": [
            {"label": "mem_usage_p95",
             "expr": ("topk(10, quantile_over_time(0.95, "
                      "(sum by(namespace,pod)(container_memory_working_set_bytes))[1h:5m]))")},
            {"label": "mem_requests",
             "expr": 'sum by(namespace,pod)(kube_pod_container_resource_requests{resource="memory"})'},
        ],
        "threshold": 0.30, "unit": "ratio",
    },
    {
        "key": "cpu_saturation", "title": "노드 CPU 포화", "pillar": "performance",
        "matcher": "metrics", "kinds": ("prometheus", "mimir"),
        "required_metrics": ["node_cpu_seconds_total"],
        "queries": [{
            "label": "cpu_busy_ratio",
            "expr": 'topk(10, 1 - avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])))',
        }],
        "threshold": 0.85, "unit": "ratio",
    },
    {
        "key": "pod_restarts", "title": "Pod 재시작", "pillar": "reliability",
        "matcher": "metrics", "kinds": ("prometheus", "mimir"),
        "required_metrics": ["kube_pod_container_status_restarts_total"],
        "queries": [{
            "label": "restarts_1h",
            "expr": "topk(10, sum by(namespace,pod)(increase(kube_pod_container_status_restarts_total[1h])))",
        }],
        "threshold": 3, "unit": "count",
    },
    {
        "key": "loki_error_count", "title": "에러 로그 수(5분)", "pillar": "reliability",
        "matcher": "labels", "kinds": ("loki",),
        "required_labels": ["job"],
        "queries": [{
            "label": "error_rate",
            "expr": 'sum by(job) (count_over_time({job=~".+"} |~ "(?i)error|exception|fatal" [5m]))',
        }],
        "threshold": 0, "unit": "count",
    },
    {
        "key": "loki_log_volume_by_namespace", "title": "네임스페이스별 로그량", "pillar": "cost",
        "matcher": "labels", "kinds": ("loki",),
        "required_labels": ["namespace"],
        "queries": [{
            "label": "volume",
            "expr": 'sum by(namespace) (count_over_time({namespace=~".+"} [5m]))',
        }],
        "threshold": 0, "unit": "count",
    },
    {
        "key": "loki_panic_grep", "title": "Panic·Fatal 로그", "pillar": "reliability",
        "matcher": "labels", "kinds": ("loki",),
        "required_labels": ["job"],
        "queries": [{
            "label": "panic_count",
            "expr": 'sum(count_over_time({job=~".+"} |~ "(?i)panic|fatal" [15m]))',
        }],
        "threshold": 0, "unit": "count",
    },
    {
        "key": "trace_recent_errors", "title": "최근 에러 트레이스", "pillar": "reliability",
        "matcher": "tags_or_services", "kinds": ("tempo",),
        "queries": [{"label": "error_traces", "expr": '{ status = error }'}],
        "threshold": 0, "unit": "count",
    },
    {
        "key": "trace_slow_requests", "title": "느린 요청 상위", "pillar": "performance",
        "matcher": "tags_or_services", "kinds": ("tempo",),
        "queries": [{"label": "slow_traces", "expr": '{ duration > 500ms }'}],
        "threshold": 500, "unit": "ms",
    },
]


def _missing_for(sig, schema):
    """Return the list of missing required items for one catalog entry, per its matcher. Pure;
    never raises. An entry with an unrecognized/absent matcher is treated as always-missing
    (defensive — every entry added in this module must declare a matcher)."""
    matcher = sig.get("matcher")
    if matcher == "metrics":
        have = set()
        if isinstance(schema, dict):
            have = {m for m in (schema.get("metrics") or []) if isinstance(m, str)}
        return [m for m in sig["required_metrics"] if m not in have]
    if matcher == "labels":
        have = set()
        if isinstance(schema, dict):
            have = {l for l in (schema.get("labels") or []) if isinstance(l, str)}
        return [l for l in sig["required_labels"] if l not in have]
    if matcher == "tags_or_services":
        # ready whenever the schema was successfully introspected at all (mirrors
        # graph_catalog._tempo_trace_spans: a reachable endpoint is the only capability needed)
        return [] if isinstance(schema, dict) else ["datasource has never been introspected"]
    return ["unrecognized matcher"]


def build_signals(kind, schema):
    """Resolve the catalog against a cached schema. Pure; never raises.

    kind: one of the 5 WIRED kinds ('prometheus' | 'mimir' | 'loki' | 'tempo' | 'clickhouse'); clickhouse
    has no deterministic entries (fallback-only) and jaeger/dynatrace/datadog are not wired into the index
    pipeline at all, so both return []. schema: the cached introspected schema dict — shape varies by kind
    (metrics/labels/tags/tables/services — see web/lib/datasource-schema.ts's docstring).
    Returns a list of rows: {signal_key, title, status, query|None, missing_metrics|None, meta}.
    """
    tool = _KIND_TOOL.get(kind, f"{kind}_query")
    rows = []
    for sig in CATALOG:
        if kind not in sig["kinds"]:
            continue
        missing = _missing_for(sig, schema)
        meta = {"pillar": sig["pillar"], "threshold": sig["threshold"],
                "kind": kind, "unit": sig["unit"]}
        if missing:
            rows.append({
                "signal_key": sig["key"], "title": sig["title"], "status": "unavailable",
                "query": None, "missing_metrics": missing, "meta": meta,
            })
        else:
            rows.append({
                "signal_key": sig["key"], "title": sig["title"], "status": "ready",
                "query": {"tool": tool, "queries": [dict(q) for q in sig["queries"]]},
                "missing_metrics": None, "meta": meta,
            })
    return rows
