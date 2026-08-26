"""Tests for signal_catalog — pure, deterministic build of diagnostic signals from a cached schema.

build_signals(kind, schema) is pure (no DB, no boto3): given a datasource kind and its cached
introspected schema (with a `metrics` name list), it resolves the curated catalog into per-signal
rows {signal_key, title, status, query, missing_metrics, meta}. A signal is `ready` iff every
required metric is present in schema['metrics']; otherwise `unavailable` with the missing names.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import signal_catalog as sc  # noqa: E402

# every metric any v1 signal needs — a fully-instrumented kube-prometheus-stack cluster
ALL_METRICS = [
    "container_cpu_cfs_throttled_periods_total", "container_cpu_cfs_periods_total",
    "kube_pod_container_status_last_terminated_reason",
    "node_memory_MemAvailable_bytes", "node_memory_MemTotal_bytes",
    "node_filesystem_avail_bytes", "node_filesystem_size_bytes",
    "node_network_receive_packets_total", "node_network_receive_drop_total",
    "container_memory_working_set_bytes", "kube_pod_container_resource_requests",
    "node_cpu_seconds_total", "kube_pod_container_status_restarts_total",
]


def _by_key(rows):
    return {r["signal_key"]: r for r in rows}


class TestFullSchemaAllReady:
    def test_all_signals_ready_for_prometheus(self):
        rows = sc.build_signals("prometheus", {"metrics": ALL_METRICS})
        by = _by_key(rows)
        assert len(rows) == len(sc.CATALOG)
        for key in (s["key"] for s in sc.CATALOG):
            assert by[key]["status"] == "ready", f"{key} should be ready"
            assert by[key]["query"]["tool"] == "prometheus_query"
            assert by[key]["query"]["queries"], "ready signal must carry at least one query"
            assert "threshold" in by[key]["meta"]

    def test_kind_maps_to_tool_mimir(self):
        rows = sc.build_signals("mimir", {"metrics": ALL_METRICS})
        assert all(r["query"]["tool"] == "mimir_query" for r in rows if r["status"] == "ready")

    def test_multi_query_signals_carry_a_list(self):
        by = _by_key(sc.build_signals("prometheus", {"metrics": ALL_METRICS}))
        # network_pps (pps + drop) and pod_right_sizing (usage + requests) are multi-query
        assert len(by["network_pps"]["query"]["queries"]) == 2
        assert len(by["pod_right_sizing"]["query"]["queries"]) == 2


class TestMissingMetrics:
    def test_signal_unavailable_when_metric_absent(self):
        # drop the throttling metrics → container_cpu_throttling must be unavailable
        metrics = [m for m in ALL_METRICS if "cfs_throttled" not in m]
        by = _by_key(sc.build_signals("prometheus", {"metrics": metrics}))
        s = by["container_cpu_throttling"]
        assert s["status"] == "unavailable"
        assert "container_cpu_cfs_throttled_periods_total" in s["missing_metrics"]
        assert s.get("query") is None  # unavailable signals carry no runnable query

    def test_network_pps_needs_both_packets_and_drop(self):
        metrics = [m for m in ALL_METRICS if "drop_total" not in m]  # drop metric missing
        by = _by_key(sc.build_signals("prometheus", {"metrics": metrics}))
        assert by["network_pps"]["status"] == "unavailable"
        assert "node_network_receive_drop_total" in by["network_pps"]["missing_metrics"]


class TestEmptyAndDefensive:
    def test_empty_metrics_all_unavailable(self):
        rows = sc.build_signals("prometheus", {"metrics": []})
        assert rows and all(r["status"] == "unavailable" for r in rows)

    def test_missing_metrics_key_does_not_raise(self):
        rows = sc.build_signals("prometheus", {})  # no 'metrics' key
        assert all(r["status"] == "unavailable" for r in rows)

    def test_none_schema_does_not_raise(self):
        rows = sc.build_signals("prometheus", None)
        assert all(r["status"] == "unavailable" for r in rows)


class TestCatalogShape:
    def test_catalog_version_is_stable_string(self):
        assert isinstance(sc.CATALOG_VERSION, str) and sc.CATALOG_VERSION

    def test_disk_query_uses_unescaped_pipe(self):
        by = _by_key(sc.build_signals("prometheus", {"metrics": ALL_METRICS}))
        expr = by["node_disk_usage"]["query"]["queries"][0]["expr"]
        assert "tmpfs|overlay" in expr and "\\|" not in expr

    def test_oom_uses_window_max_not_instant(self):
        by = _by_key(sc.build_signals("prometheus", {"metrics": ALL_METRICS}))
        assert "max_over_time" in by["oom_kills"]["query"]["queries"][0]["expr"]
