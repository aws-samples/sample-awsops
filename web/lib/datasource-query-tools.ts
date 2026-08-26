// Read-only query tool catalog for datasource instances, extracted out of the route handler.
// Next.js App Router route files may only export HTTP-method handlers + route config (dynamic, etc.);
// exporting arbitrary consts (TOOL/QUERYABLE_KINDS) from route.ts fails the Next.js route type check.
// The route + its test import these from here instead.
// SECURITY: every tool here is a READ-only verb (_query / _query_range / _search) — no mutating tool reachable.

export const CLICKHOUSE_MAX_ROWS = 500;

export interface ToolSpec {
  instant: string;
  range?: string;
  arg: 'query' | 'sql';
  extra?: Record<string, unknown>;
}

export const TOOL: Record<string, ToolSpec> = {
  prometheus: { instant: 'prometheus_query', range: 'prometheus_query_range', arg: 'query' },
  mimir: { instant: 'mimir_query', range: 'mimir_query_range', arg: 'query' },
  loki: { instant: 'loki_query', range: 'loki_query_range', arg: 'query' },
  tempo: { instant: 'tempo_search', arg: 'query' },
  clickhouse: { instant: 'clickhouse_query', arg: 'sql', extra: { max_rows: CLICKHOUSE_MAX_ROWS } },
  // v1 datasource-family completion (2026-07-21): trace search / metricSelector / metric query —
  // all instant-style (the connector applies its own 1h lookback default; no *_query_range tool).
  jaeger: { instant: 'jaeger_search', arg: 'query' },
  dynatrace: { instant: 'dynatrace_query', arg: 'query' },
  datadog: { instant: 'datadog_query', arg: 'query' },
};

export const QUERYABLE_KINDS = Object.keys(TOOL);
