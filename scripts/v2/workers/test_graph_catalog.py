"""Tests for graph_catalog — pure, deterministic build of pre-computed topology-graph queries
from a cached datasource schema (mirrors diagnosis/signal_catalog.py's contract, for graph
queries instead of diagnostic ones).

build_graph_queries(kind, schema) is pure (no DB, no boto3): given a datasource kind and its cached
introspected schema, it resolves a small per-kind catalog into rows
{query_key, status, query, missing, meta}.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import graph_catalog as gc  # noqa: E402

OTEL_COLUMNS = [
    {"name": "TraceId", "type": "String"}, {"name": "SpanId", "type": "String"},
    {"name": "ParentSpanId", "type": "String"}, {"name": "ServiceName", "type": "String"},
    {"name": "SpanKind", "type": "String"}, {"name": "Timestamp", "type": "DateTime64(9)"},
    {"name": "Duration", "type": "UInt64"},
    {"name": "ResourceAttributes", "type": "Map(String, String)"},
    {"name": "SpanAttributes", "type": "Map(String, String)"},
]

# Required-only shape (no SpanKind) — a table matching _OTEL_REQUIRED_COLUMNS but lacking the
# optional SpanKind column, e.g. an older/custom exporter. Regression for the MINOR review finding:
# the emitted SELECT must never reference a column the matched table doesn't actually have.
OTEL_COLUMNS_NO_SPANKIND = [c for c in OTEL_COLUMNS if c["name"] != "SpanKind"]


def _by_key(rows):
    return {r["query_key"]: r for r in rows}


class TestClickhouse:
    def test_ready_when_a_table_matches_the_otel_exporter_shape(self):
        schema = {"tables": [{"name": "otel_traces", "columns": OTEL_COLUMNS}]}
        by = _by_key(gc.build_graph_queries("clickhouse", schema))
        row = by["trace_spans"]
        assert row["status"] == "ready"
        assert row["query"]["tool"] == "clickhouse_query"
        assert row["query"]["mapper"] == "otel_v1"
        assert "otel_traces" in row["query"]["args_template"]["sql"]
        assert row["meta"] == {"kind": "clickhouse", "provenance": "catalog"}

    def test_ready_uses_the_actual_table_name_not_a_hardcoded_default(self):
        schema = {"tables": [{"name": "my_custom_spans", "columns": OTEL_COLUMNS}]}
        by = _by_key(gc.build_graph_queries("clickhouse", schema))
        assert "my_custom_spans" in by["trace_spans"]["query"]["args_template"]["sql"]

    def test_the_table_name_is_backtick_quoted_as_a_clickhouse_identifier(self):
        # co-agent consensus review finding (2026-07-08): a bare f-string interpolation of the
        # introspected table name is an identifier-injection smell — quote it like any other
        # untrusted identifier, even though in practice it comes from this instance's own
        # SHOW TABLES output, not attacker-controlled user input.
        schema = {"tables": [{"name": "my_custom_spans", "columns": OTEL_COLUMNS}]}
        by = _by_key(gc.build_graph_queries("clickhouse", schema))
        assert "`my_custom_spans`" in by["trace_spans"]["query"]["args_template"]["sql"]

    def test_a_backtick_in_the_table_name_is_escaped_by_doubling(self):
        weird = "my`spans"
        schema = {"tables": [{"name": weird, "columns": OTEL_COLUMNS}]}
        by = _by_key(gc.build_graph_queries("clickhouse", schema))
        assert "`my``spans`" in by["trace_spans"]["query"]["args_template"]["sql"]

    def test_a_db_qualified_table_name_quotes_each_segment_separately(self):
        # Regression: clickhouse_mcp introspection emits `f"{database}.{name}"` (e.g. otel.otel_traces).
        # Wrapping the whole thing in one backtick pair (`otel.otel_traces`) makes ClickHouse read it
        # as a single dotted identifier in the CURRENT db → UNKNOWN_TABLE → the trace layer stayed
        # empty. Each segment must be quoted independently.
        schema = {"tables": [{"name": "otel.otel_traces", "columns": OTEL_COLUMNS}]}
        by = _by_key(gc.build_graph_queries("clickhouse", schema))
        sql = by["trace_spans"]["query"]["args_template"]["sql"]
        assert "`otel`.`otel_traces`" in sql
        assert "`otel.otel_traces`" not in sql

    def test_unavailable_when_no_table_matches(self):
        schema = {"tables": [{"name": "unrelated", "columns": [{"name": "x", "type": "Int64"}]}]}
        by = _by_key(gc.build_graph_queries("clickhouse", schema))
        assert by["trace_spans"]["status"] == "unavailable"
        assert by["trace_spans"]["query"] is None
        assert by["trace_spans"]["missing"]

    def test_unavailable_when_schema_missing_or_none(self):
        assert _by_key(gc.build_graph_queries("clickhouse", {}))["trace_spans"]["status"] == "unavailable"
        assert _by_key(gc.build_graph_queries("clickhouse", None))["trace_spans"]["status"] == "unavailable"

    def test_ready_query_omits_spankind_when_the_table_lacks_it(self):
        # Regression: the SELECT must not reference SpanKind on a table that matched via the
        # required-columns set alone (SpanKind is optional) — else the query 500s at execution time.
        schema = {"tables": [{"name": "otel_traces", "columns": OTEL_COLUMNS_NO_SPANKIND}]}
        by = _by_key(gc.build_graph_queries("clickhouse", schema))
        row = by["trace_spans"]
        assert row["status"] == "ready"
        assert "SpanKind" not in row["query"]["args_template"]["sql"]

    def test_ready_query_includes_spankind_when_the_table_has_it(self):
        schema = {"tables": [{"name": "otel_traces", "columns": OTEL_COLUMNS}]}
        by = _by_key(gc.build_graph_queries("clickhouse", schema))
        assert "SpanKind" in by["trace_spans"]["query"]["args_template"]["sql"]

    def test_clickhouse_never_produces_servicegraph_calls(self):
        schema = {"tables": [{"name": "otel_traces", "columns": OTEL_COLUMNS}]}
        by = _by_key(gc.build_graph_queries("clickhouse", schema))
        assert "servicegraph_calls" not in by


class TestTempo:
    def test_ready_whenever_schema_was_introspected(self):
        by = _by_key(gc.build_graph_queries("tempo", {"tags": ["service.name"]}))
        row = by["trace_spans"]
        assert row["status"] == "ready"
        assert row["query"]["tool"] == "tempo_search"
        assert row["query"]["mapper"] == "tempo_v1"

    def test_unavailable_when_never_introspected(self):
        by = _by_key(gc.build_graph_queries("tempo", None))
        assert by["trace_spans"]["status"] == "unavailable"


class TestPrometheusMimirServiceGraph:
    def test_ready_servicegraph_v1_when_tempo_metrics_generator_metric_present(self):
        schema = {"metrics": ["traces_service_graph_request_total", "up"]}
        by = _by_key(gc.build_graph_queries("prometheus", schema))
        row = by["servicegraph_calls"]
        assert row["status"] == "ready" and row["query"]["mapper"] == "servicegraph_v1"
        assert row["query"]["tool"] == "prometheus_query"

    def test_ready_istio_v1_when_only_istio_metric_present(self):
        schema = {"metrics": ["istio_requests_total"]}
        by = _by_key(gc.build_graph_queries("mimir", schema))
        row = by["servicegraph_calls"]
        assert row["status"] == "ready" and row["query"]["mapper"] == "istio_v1"
        assert row["query"]["tool"] == "mimir_query"

    def test_servicegraph_metric_takes_precedence_over_istio_when_both_present(self):
        schema = {"metrics": ["traces_service_graph_request_total", "istio_requests_total"]}
        by = _by_key(gc.build_graph_queries("prometheus", schema))
        assert by["servicegraph_calls"]["query"]["mapper"] == "servicegraph_v1"

    def test_unavailable_when_neither_metric_present(self):
        by = _by_key(gc.build_graph_queries("prometheus", {"metrics": ["up"]}))
        row = by["servicegraph_calls"]
        assert row["status"] == "unavailable"
        assert "traces_service_graph_request_total" in row["missing"]
        assert "istio_requests_total" in row["missing"]

    def test_prom_mimir_never_produce_trace_spans(self):
        by = _by_key(gc.build_graph_queries("prometheus", {"metrics": ["traces_service_graph_request_total"]}))
        assert "trace_spans" not in by


class TestLoki:
    def test_always_unavailable_both_keys_structural(self):
        by = _by_key(gc.build_graph_queries("loki", {"labels": ["job", "namespace"]}))
        assert by["trace_spans"]["status"] == "unavailable"
        assert by["servicegraph_calls"]["status"] == "unavailable"
        assert by["trace_spans"]["query"] is None


class TestCatalogShape:
    def test_catalog_version_is_stable_string(self):
        assert isinstance(gc.CATALOG_VERSION, str) and gc.CATALOG_VERSION

    def test_unknown_kind_all_unavailable_never_raises(self):
        rows = gc.build_graph_queries("notion", {"anything": True})
        assert rows and all(r["status"] == "unavailable" for r in rows)
