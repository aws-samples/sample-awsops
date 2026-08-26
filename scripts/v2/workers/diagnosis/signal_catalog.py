"""Deterministic diagnostic-signal catalog for Prometheus/Mimir datasources.

A curated map of ops diagnostic INTENTS → standard PromQL templates (cadvisor / node-exporter /
kube-state-metrics names). `build_signals(kind, schema)` is PURE — no DB, no boto3, no egress: it
checks each signal's required metrics against the instance's cached schema and emits a row per
signal, `ready` (with a runnable query) when every required metric is present, else `unavailable`
(with the missing names). The heavy work (which queries to run) is thus pre-computed at
datasource-index time; the diagnosis worker only executes the stored `ready` queries.

The catalog is intentionally datasource-AGNOSTIC except for kind→tool: prometheus→prometheus_query,
mimir→mimir_query (identical PromQL). Metric names are module constants — never user input — so a
poisoned schema can only make a signal `unavailable`, never inject into a query.

`CATALOG_VERSION` is mixed into the per-instance schema hash so editing this catalog forces a
rebuild even when the datasource's metric set is unchanged.
"""

CATALOG_VERSION = "v1"

# kind → connector tool name (PromQL is identical for both)
_KIND_TOOL = {"prometheus": "prometheus_query", "mimir": "mimir_query"}

# Each entry: key, title, pillar, required_metrics, queries[{expr,label}], threshold, unit.
# `topk(10, …)` bounds the result; aggregations use clamp_min to avoid divide-by-zero.
CATALOG = [
    {
        "key": "container_cpu_throttling", "title": "컨테이너 CPU 스로틀링", "pillar": "performance",
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
        "required_metrics": ["node_memory_MemAvailable_bytes", "node_memory_MemTotal_bytes"],
        "queries": [{
            "label": "mem_used_ratio",
            "expr": "topk(10, 1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))",
        }],
        "threshold": 0.85, "unit": "ratio",
    },
    {
        "key": "node_disk_usage", "title": "노드 디스크 사용률", "pillar": "reliability",
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
        "required_metrics": ["node_network_receive_packets_total", "node_network_receive_drop_total"],
        "queries": [
            {"label": "rx_pps", "expr": "topk(10, rate(node_network_receive_packets_total[5m]))"},
            {"label": "rx_drop", "expr": "topk(10, rate(node_network_receive_drop_total[5m]))"},
        ],
        "threshold": 0, "unit": "pps",
    },
    {
        "key": "pod_right_sizing", "title": "Pod 라이트사이징", "pillar": "cost",
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
        "required_metrics": ["node_cpu_seconds_total"],
        "queries": [{
            "label": "cpu_busy_ratio",
            "expr": 'topk(10, 1 - avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])))',
        }],
        "threshold": 0.85, "unit": "ratio",
    },
    {
        "key": "pod_restarts", "title": "Pod 재시작", "pillar": "reliability",
        "required_metrics": ["kube_pod_container_status_restarts_total"],
        "queries": [{
            "label": "restarts_1h",
            "expr": "topk(10, sum by(namespace,pod)(increase(kube_pod_container_status_restarts_total[1h])))",
        }],
        "threshold": 3, "unit": "count",
    },
]


def build_signals(kind, schema):
    """Resolve the catalog against a cached schema. Pure; never raises.

    kind: 'prometheus' | 'mimir' (others → tool falls back to '<kind>_query' but typically unused).
    schema: the cached introspected schema dict; uses schema['metrics'] (list of metric-name strings).
    Returns a list of rows: {signal_key, title, status, query|None, missing_metrics|None, meta}.
    """
    tool = _KIND_TOOL.get(kind, f"{kind}_query")
    have = set()
    if isinstance(schema, dict):
        have = {m for m in (schema.get("metrics") or []) if isinstance(m, str)}

    rows = []
    for sig in CATALOG:
        missing = [m for m in sig["required_metrics"] if m not in have]
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
