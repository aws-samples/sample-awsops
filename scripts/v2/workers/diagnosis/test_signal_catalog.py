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
        prom_keys = [s["key"] for s in sc.CATALOG if "prometheus" in s["kinds"]]
        assert len(rows) == len(prom_keys)
        for key in prom_keys:
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


class TestMatcherDispatch:
    def test_existing_entries_are_tagged_metrics_matcher(self):
        assert all(sig.get("matcher") == "metrics" for sig in sc.CATALOG if sig["key"] in
                   ("container_cpu_throttling", "oom_kills", "node_memory_pressure",
                    "node_disk_usage", "network_pps", "pod_right_sizing", "cpu_saturation",
                    "pod_restarts"))

    def test_metrics_matcher_behavior_unchanged(self):
        # exact assertions from TestFullSchemaAllReady, re-run post-refactor as a regression guard
        rows = sc.build_signals("prometheus", {"metrics": ALL_METRICS})
        by = _by_key(rows)
        for key in ("container_cpu_throttling", "oom_kills", "node_memory_pressure",
                    "node_disk_usage", "network_pps", "pod_right_sizing", "cpu_saturation",
                    "pod_restarts"):
            assert by[key]["status"] == "ready"


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


class TestKindScoping:
    def test_existing_k8s_entries_scoped_to_prometheus_and_mimir(self):
        for sig in sc.CATALOG:
            if sig["key"] in ("container_cpu_throttling", "oom_kills", "node_memory_pressure",
                              "node_disk_usage", "network_pps", "pod_right_sizing",
                              "cpu_saturation", "pod_restarts"):
                assert sig["kinds"] == ("prometheus", "mimir"), sig["key"]

    def test_build_signals_omits_entries_outside_their_kind(self):
        rows = sc.build_signals("loki", {"labels": ["job", "level"]})
        keys = {r["signal_key"] for r in rows}
        assert "cpu_saturation" not in keys


class TestClickhouseHasNoDeterministicSignals:
    def test_clickhouse_yields_zero_catalog_rows(self):
        # the 3 system.* signals were dropped (Fix 1): they always 400 at the connector's
        # read-only guard (SYSTEM keyword rejected) — clickhouse now falls through to the LLM
        # hybrid fallback instead of a deterministic catalog row.
        rows = sc.build_signals("clickhouse", {"tables": []})
        assert rows == []


class TestLokiLabelSignals:
    def test_loki_signals_ready_when_labels_present(self):
        rows = sc.build_signals("loki", {"labels": ["job", "namespace", "level"]})
        by = _by_key(rows)
        for key in ("loki_error_count", "loki_log_volume_by_namespace", "loki_panic_grep"):
            assert by[key]["status"] == "ready"
            assert by[key]["query"]["tool"] == "loki_query_range"

    def test_loki_signal_unavailable_when_required_label_missing(self):
        rows = sc.build_signals("loki", {"labels": ["level"]})  # no 'job', no 'namespace'
        by = _by_key(rows)
        assert by["loki_error_count"]["status"] == "unavailable"
        assert "job" in by["loki_error_count"]["missing_metrics"]
        assert by["loki_log_volume_by_namespace"]["status"] == "unavailable"


class TestTraceAndApmSignals:
    def test_tempo_signals_ready_whenever_introspected(self):
        rows = sc.build_signals("tempo", {"tags": ["service.name"]})
        by = _by_key(rows)
        assert by["trace_recent_errors"]["status"] == "ready"
        assert by["trace_recent_errors"]["query"]["tool"] == "tempo_search"

    def test_trace_expr_uses_spaced_traceql_house_style(self):
        # matches sources.py's '{ status = error }' / ExplorePanel's '{ duration > 500ms }' style
        by = _by_key(sc.build_signals("tempo", {"tags": ["service.name"]}))
        assert by["trace_recent_errors"]["query"]["queries"][0]["expr"] == '{ status = error }'
        assert by["trace_slow_requests"]["query"]["queries"][0]["expr"] == '{ duration > 500ms }'

    def test_jaeger_gets_zero_trace_signals(self):
        # jaeger's query grammar (service=<name>, no TraceQL) is incompatible with these entries —
        # dropped from `kinds` entirely (Fix 2); jaeger relies on the LLM hybrid fallback instead.
        rows = sc.build_signals("jaeger", {"services": ["frontend"]})
        assert rows == []

    def test_dynatrace_and_datadog_have_no_catalog_entries(self):
        # dynatrace/datadog were never wired into the production dispatch pipeline
        # (datasource_index_dispatcher.py / workers.tf only list prometheus/mimir/loki/tempo/
        # clickhouse) — their entries were dead code and were dropped (Fix 3).
        assert sc.build_signals("dynatrace", {"metrics": ["builtin:host.cpu.usage"]}) == []
        assert sc.build_signals("datadog", {"metrics": ["system.cpu.user"]}) == []
