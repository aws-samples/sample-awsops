"""Deterministic topology-graph query catalog, resolved against a datasource's cached schema.

Mirrors diagnosis/signal_catalog.py's contract exactly, but for pre-built GRAPH queries instead of
diagnostic ones: `build_graph_queries(kind, schema)` is PURE (no DB, no boto3, no egress) — it checks
the cached schema for the table/metric shape a graph query needs and emits one row per query_key,
`ready` (with a runnable query) when the shape is present, else `unavailable` (with what's missing).

Per-kind capability (capability-driven, not identical across kinds — only ClickHouse and Tempo carry
span-level parent/child call data; Prometheus/Mimir can only contribute `calls` edges when a
service-graph metric exists; Loki structurally cannot contribute call-graph data at all):

- clickhouse -> 'trace_spans': ready when a table matches the OTel ClickHouse exporter's default
  column shape (TraceId/SpanId/ParentSpanId/ServiceName/Timestamp/Duration/ResourceAttributes/
  SpanAttributes). Uses the table's ACTUAL name — not a hardcoded 'otel_traces' — so a renamed table
  still matches.
- tempo -> 'trace_spans': ready whenever the schema was successfully introspected at all (a reachable
  Tempo endpoint is the only capability needed; the search+get-trace API shape is fixed).
- prometheus/mimir -> 'servicegraph_calls': ready when 'traces_service_graph_request_total' (Tempo
  metrics-generator) or 'istio_requests_total' (Istio mesh) is present in schema['metrics'].
- loki -> both keys always 'unavailable' (logs carry no call-relationship data; a permanent row
  documents WHY rather than silently contributing nothing).

`CATALOG_VERSION` is mixed into the per-instance schema hash (by the caller, datasource_index.py) so
editing this catalog forces a rebuild even when the datasource's schema is unchanged.
"""

# v3: preserve span operation/status/links and metric identity scopes. Rebuild cached queries so
# source adapters receive metadata before aggregation, and both time bounds share one anchor.
CATALOG_VERSION = "v3"

# The OTel ClickHouse exporter's default `otel_traces` column shape. A table matching this column
# SET (regardless of its actual name) is treated as the span source.
_OTEL_REQUIRED_COLUMNS = {
    "TraceId", "SpanId", "ParentSpanId", "ServiceName", "Timestamp", "Duration",
    "ResourceAttributes", "SpanAttributes",
}

_SERVICEGRAPH_METRIC = "traces_service_graph_request_total"
_ISTIO_METRIC = "istio_requests_total"

# Keep these suffixes in sync with trace-source.ts METRIC_IDENTITY_LABELS. Retain shared labels and
# both endpoint conventions: Tempo's client/server and Istio's source/destination. Missing labels
# don't introduce series, while dropping a present label would merge unrelated service identities.
_IDENTITY_LABEL_SUFFIXES = (
    "cloud_account_id", "account_id", "cloud_region", "region",
    "deployment_environment_name", "deployment_environment", "environment", "service_namespace",
    "k8s_namespace_name", "k8s_namespace", "workload_namespace", "namespace",
    "k8s_cluster_name", "k8s_cluster", "cluster",
)
_IDENTITY_LABELS = tuple(
    f"{prefix}{suffix}"
    for prefix in ("", "client_", "server_", "source_", "destination_")
    for suffix in _IDENTITY_LABEL_SUFFIXES
)


def _quote_identifier(name):
    """Backtick-quote a ClickHouse identifier, doubling any inner backtick (ClickHouse's escape
    convention). The table name comes from this instance's own introspected schema (SHOW TABLES),
    not attacker-controlled user input, but a bare f-string interpolation is still an
    identifier-injection smell worth closing (co-agent consensus review finding, 2026-07-08).

    A `db.table` name (the shape clickhouse_mcp's introspection emits — `f"{database}.{name}"`) must
    have EACH dot-separated part quoted independently → `db`.`table`. Wrapping the whole string in one
    pair (`` `db.table` ``) makes ClickHouse read it as a SINGLE identifier literally containing a dot,
    resolved against the CURRENT database → UNKNOWN_TABLE (the trace layer silently stayed empty)."""
    return ".".join("`" + part.replace("`", "``") + "`" for part in str(name).split("."))


def _clickhouse_trace_spans(schema):
    tables = (schema or {}).get("tables") or []
    for t in tables:
        if not isinstance(t, dict):
            continue
        cols = {c.get("name") for c in (t.get("columns") or []) if isinstance(c, dict)}
        if _OTEL_REQUIRED_COLUMNS.issubset(cols):
            # SpanKind isn't in the required set (older/custom exporters may omit it) but the SELECT
            # always requests it — include it only when the table actually has it, else the query
            # errors at ClickHouse execution time on a table that otherwise matched.
            select_cols = "TraceId, SpanId, ParentSpanId, ServiceName" + (
                ", SpanKind" if "SpanKind" in cols else ""
            ) + ", Timestamp, Duration, ResourceAttributes, SpanAttributes"
            for optional in ("SpanName", "StatusCode", "Links.TraceId", "Links.SpanId"):
                if optional in cols:
                    # Nested subcolumns are a single quoted identifier, unlike db.table names.
                    select_cols += ", " + (f"`{optional}`" if "." in optional else optional)
            sql = (
                f"SELECT {select_cols} FROM {_quote_identifier(t.get('name'))} "
                "WHERE Timestamp >= now() - INTERVAL {window} MINUTE AND Timestamp <= now() "
                "ORDER BY Timestamp DESC LIMIT {cap}"
            )
            return {
                "query_key": "trace_spans", "status": "ready",
                "query": {"tool": "clickhouse_query", "mapper": "otel_v1", "args_template": {"sql": sql}},
                "missing": None, "meta": {"kind": "clickhouse", "provenance": "catalog"},
            }
    return {
        "query_key": "trace_spans", "status": "unavailable", "query": None,
        "missing": ["no table matching the OTel exporter's span column shape"],
        "meta": {"kind": "clickhouse", "provenance": "catalog"},
    }


def _tempo_trace_spans(schema):
    meta = {"kind": "tempo", "provenance": "catalog"}
    if not isinstance(schema, dict):
        return {"query_key": "trace_spans", "status": "unavailable", "query": None,
                "missing": ["datasource has never been introspected"], "meta": meta}
    return {
        "query_key": "trace_spans", "status": "ready",
        "query": {"tool": "tempo_search", "mapper": "tempo_v1",
                   "args_template": {"query": "{}", "limit": 20}},
        "missing": None, "meta": meta,
    }


def _servicegraph_calls(kind, schema):
    tool = f"{kind}_query"
    meta = {"kind": kind, "provenance": "catalog"}
    metrics = set()
    if isinstance(schema, dict):
        metrics = {m for m in (schema.get("metrics") or []) if isinstance(m, str)}
    if _SERVICEGRAPH_METRIC in metrics:
        labels = ",".join(("client", "server") + _IDENTITY_LABELS)
        expr = f"sum by ({labels}) (increase({_SERVICEGRAPH_METRIC}[{{window}}m]))"
        return {"query_key": "servicegraph_calls", "status": "ready",
                "query": {"tool": tool, "mapper": "servicegraph_v1", "args_template": {"query": expr}},
                "missing": None, "meta": meta}
    if _ISTIO_METRIC in metrics:
        labels = ",".join(("source_workload", "destination_workload") + _IDENTITY_LABELS)
        expr = f"sum by ({labels}) (increase({_ISTIO_METRIC}[{{window}}m]))"
        return {"query_key": "servicegraph_calls", "status": "ready",
                "query": {"tool": tool, "mapper": "istio_v1", "args_template": {"query": expr}},
                "missing": None, "meta": meta}
    return {"query_key": "servicegraph_calls", "status": "unavailable", "query": None,
            "missing": [_SERVICEGRAPH_METRIC, _ISTIO_METRIC], "meta": meta}


def _unavailable_row(query_key, kind, reason):
    return {"query_key": query_key, "status": "unavailable", "query": None,
            "missing": [reason], "meta": {"kind": kind, "provenance": "catalog"}}


def build_graph_queries(kind, schema):
    """Resolve the catalog against a cached schema for one datasource kind. Never raises.

    Returns a list of rows: {query_key, status, query|None, missing|None, meta}.
    """
    if kind == "clickhouse":
        return [_clickhouse_trace_spans(schema)]
    if kind == "tempo":
        return [_tempo_trace_spans(schema)]
    if kind in ("prometheus", "mimir"):
        return [_servicegraph_calls(kind, schema)]
    if kind == "loki":
        return [
            _unavailable_row("trace_spans", "loki", "logs carry no call-graph data"),
            _unavailable_row("servicegraph_calls", "loki", "logs carry no call-graph data"),
        ]
    # unknown kind: never raise, just report nothing usable
    return [_unavailable_row("trace_spans", kind, f"unknown kind: {kind}")]
