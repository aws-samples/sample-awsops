"""card_catalog.build_cards — deterministic dashboard-card matching per connector kind."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import card_catalog as cc  # noqa: E402


def test_prometheus_ready_and_unavailable_split():
    schema = {"metrics": ["up", "node_cpu_seconds_total"], "labels": []}
    rows = cc.build_cards("prometheus", schema)
    by = {r["card_key"]: r for r in rows}
    assert by["up_targets"]["status"] == "ready"
    assert by["up_targets"]["query"]["tool"] == "prometheus_query"
    assert by["cpu_usage"]["status"] == "ready"
    assert by["memory_available"]["status"] == "unavailable"
    assert "node_memory_MemAvailable_bytes" in by["memory_available"]["missing"]
    # ready timeseries cards carry a stored range
    assert by["cpu_usage"]["query"]["range"] == {"window": 3600, "step": 60}
    # unavailable cards carry no query at all
    assert by["memory_available"]["query"] is None


def test_prometheus_operational_catalog_covers_resource_pressure_and_network():
    schema = {"metrics": [
        "up",
        "node_cpu_seconds_total",
        "node_memory_MemAvailable_bytes",
        "node_memory_MemTotal_bytes",
        "node_filesystem_avail_bytes",
        "node_filesystem_size_bytes",
        "node_load1",
        "node_network_receive_bytes_total",
        "node_network_transmit_bytes_total",
        "container_cpu_usage_seconds_total",
        "container_memory_working_set_bytes",
        "kube_pod_container_status_restarts_total",
    ]}
    rows = cc.build_cards("prometheus", schema)
    by = {r["card_key"]: r for r in rows}
    assert len(rows) == 13
    assert {
        "up_targets", "down_targets", "cpu_usage", "node_cpu_top5",
        "memory_available", "node_memory_usage_top5", "node_disk_usage_top5",
        "node_load1_top5", "node_network_receive_top5", "node_network_transmit_top5",
        "container_cpu", "container_memory_top5", "pod_restarts",
    } == set(by)
    assert by["node_memory_usage_top5"]["query"]["expr"] == (
        "topk(5, 100 * (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)))"
    )
    assert by["down_targets"]["query"]["expr"] == "sum(up == bool 0)"
    assert "max by (instance)" in by["node_disk_usage_top5"]["query"]["expr"]
    assert by["node_disk_usage_top5"]["query"]["range"] == {"window": 3600, "step": 60}


def test_mimir_uses_mimir_tool():
    rows = cc.build_cards("mimir", {"metrics": ["up"], "labels": []})
    by = {r["card_key"]: r for r in rows}
    assert by["up_targets"]["query"]["tool"] == "mimir_query"


def test_loki_anchor_label_fallback():
    rows = cc.build_cards("loki", {"labels": ["app"]})
    by = {r["card_key"]: r for r in rows}
    assert by["log_volume"]["status"] == "ready"
    assert '{app=~".+"}' in by["log_volume"]["query"]["expr"]
    none = {r["card_key"]: r for r in cc.build_cards("loki", {"labels": ["whatever"]})}
    assert none["log_volume"]["status"] == "unavailable"
    assert set(none["log_volume"]["missing"]) == {"job", "app", "namespace"}


def test_tempo_always_ready():
    rows = cc.build_cards("tempo", {"tags": []})
    assert all(r["status"] == "ready" for r in rows)
    assert {r["card_key"] for r in rows} == {"slow_traces", "error_traces"}


def test_clickhouse_table_resolution_and_identifier_guard():
    # SHOW TABLES fallback shape: an unqualified name still matches and is quoted
    good = {"tables": [{"name": "otel_traces", "columns": [{"name": "Timestamp"}, {"name": "TraceId"}, {"name": "ServiceName"}]}]}
    by = {r["card_key"]: r for r in cc.build_cards("clickhouse", good)}
    assert by["otel_span_rate"]["status"] == "ready"
    assert "FROM `otel_traces`" in by["otel_span_rate"]["query"]["expr"]
    # the aggregate is aliased so the stat renderer's rows[0].value lookup finds it
    assert "count() AS value" in by["otel_span_rate"]["query"]["expr"]
    assert by["top_services"]["status"] == "ready"
    # heuristic fallback: Timestamp+TraceId + a trace-only column (Duration), non-otel name
    heur = {"tables": [{"name": "spans_v2", "columns": [{"name": "Timestamp"}, {"name": "TraceId"}, {"name": "Duration"}]}]}
    by2 = {r["card_key"]: r for r in cc.build_cards("clickhouse", heur)}
    assert "FROM `spans_v2`" in by2["otel_span_rate"]["query"]["expr"]
    assert by2["top_services"]["status"] == "unavailable"  # no ServiceName column
    # a table name failing the identifier charset is NEVER spliced
    evil = {"tables": [{"name": "otel_traces; DROP TABLE x", "columns": [
        {"name": "Timestamp"}, {"name": "TraceId"}, {"name": "Duration"}]}]}
    by3 = {r["card_key"]: r for r in cc.build_cards("clickhouse", evil)}
    assert by3["otel_span_rate"]["status"] == "unavailable"
    # 3+ dot segments are rejected (only `table` or `db.table` are accepted)
    deep = {"tables": [{"name": "a.b.c", "columns": [
        {"name": "Timestamp"}, {"name": "TraceId"}, {"name": "Duration"}]}]}
    by4 = {r["card_key"]: r for r in cc.build_cards("clickhouse", deep)}
    assert by4["otel_span_rate"]["status"] == "unavailable"
    assert by4["top_services"]["status"] == "unavailable"


def test_clickhouse_logs_table_never_matches_as_traces():
    # The REAL otel_logs shape: it carries Timestamp+TraceId+SpanId+ServiceName — SpanId alone must
    # NOT qualify it as a trace table, or a logs-only pipeline reports log rows as span counts.
    logs_only = {"tables": [{"name": "otel.otel_logs", "columns": [
        {"name": "Timestamp"}, {"name": "TraceId"}, {"name": "SpanId"},
        {"name": "ServiceName"}, {"name": "Body"}]}]}
    by = {r["card_key"]: r for r in cc.build_cards("clickhouse", logs_only)}
    assert by["otel_span_rate"]["status"] == "unavailable"
    assert by["top_services"]["status"] == "unavailable"
    # Duration is an equally valid discriminator
    dur = {"tables": [{"name": "spans", "columns": [
        {"name": "Timestamp"}, {"name": "TraceId"}, {"name": "Duration"}]}]}
    by2 = {r["card_key"]: r for r in cc.build_cards("clickhouse", dur)}
    assert by2["otel_span_rate"]["status"] == "ready"


def test_clickhouse_exact_name_requires_timestamp():
    # An otel_traces-NAMED table without Timestamp must not be marked ready — its stored queries
    # filter on Timestamp and would fail on every view.
    no_ts = {"tables": [{"name": "otel_traces", "columns": [{"name": "TraceId"}, {"name": "SpanId"}]}]}
    by = {r["card_key"]: r for r in cc.build_cards("clickhouse", no_ts)}
    assert by["otel_span_rate"]["status"] == "unavailable"


def test_clickhouse_db_qualified_table_name():
    # clickhouse_mcp introspection emits f"{database}.{name}" — the last segment must match
    # otel_traces and every segment is quoted independently (`otel`.`otel_traces`).
    qualified = {"tables": [{"name": "otel.otel_traces", "columns": [
        {"name": "Timestamp"}, {"name": "TraceId"}, {"name": "ServiceName"}]}]}
    by = {r["card_key"]: r for r in cc.build_cards("clickhouse", qualified)}
    assert by["otel_span_rate"]["status"] == "ready"
    assert by["top_services"]["status"] == "ready"
    assert "FROM `otel`.`otel_traces`" in by["otel_span_rate"]["query"]["expr"]
    assert "FROM `otel`.`otel_traces`" in by["top_services"]["query"]["expr"]


def test_truncated_schema_yields_unknown_not_missing():
    schema = {"metrics": ["a_metric"], "truncated": True}
    rows = cc.build_cards("prometheus", schema)
    unmatched = [r for r in rows if r["status"] != "ready"]
    assert unmatched, "fixture must leave some cards unmatched"
    assert all(r["status"] == "unknown" for r in unmatched)
    assert all(r["missing"] for r in unmatched)  # still reports WHICH names were unmatched
    # without the flag, the very same schema is a confident `unavailable`
    plain = cc.build_cards("prometheus", {"metrics": ["a_metric"]})
    assert all(r["status"] == "unavailable" for r in plain if r["status"] != "ready")


def test_probed_names_are_definitive_despite_truncation():
    # A truncated schema normally degrades unmatched requirements to "unknown" — but a name the
    # connector probed INDIVIDUALLY (schema.probed) is definitively absent → confident "unavailable".
    schema = {"metrics": ["up"], "truncated": True,
              "probed": ["up", "node_cpu_seconds_total", "node_memory_MemAvailable_bytes"]}
    by = {r["card_key"]: r for r in cc.build_cards("prometheus", schema)}
    assert by["up_targets"]["status"] == "ready"
    assert by["cpu_usage"]["status"] == "unavailable"          # probed and absent — definitive
    assert by["memory_available"]["status"] == "unavailable"   # probed and absent — definitive
    assert by["pod_restarts"]["status"] == "unknown"           # not probed — still undetermined


def test_required_metrics_covers_every_prom_card():
    req = cc.required_metrics()
    assert req == sorted(req)
    for c in cc._PROM_CARDS:
        assert all(m in req for m in c["requires"])


def test_up_targets_uses_sum_not_count():
    # count(up == 1) is an EMPTY vector during a total outage (renders "값 없음"); sum(up) renders 0.
    by = {r["card_key"]: r for r in cc.build_cards("prometheus", {"metrics": ["up"]})}
    assert by["up_targets"]["query"]["expr"] == "sum(up)"


def test_unknown_kind_and_missing_schema():
    assert cc.build_cards("jaeger", {"tags": []}) == []
    assert cc.build_cards("prometheus", None) == []


def test_purity_no_forbidden_imports():
    import inspect
    src = inspect.getsource(cc)
    for banned in ("boto3", "urllib", "requests", "pg8000", "psycopg"):
        assert banned not in src
