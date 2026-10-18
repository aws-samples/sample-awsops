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
  timeWindow?: boolean;
}

export const TOOL: Record<string, ToolSpec> = {
  prometheus: { instant: 'prometheus_query', range: 'prometheus_query_range', arg: 'query' },
  mimir: { instant: 'mimir_query', range: 'mimir_query_range', arg: 'query' },
  loki: { instant: 'loki_query', range: 'loki_query_range', arg: 'query' },
  tempo: { instant: 'tempo_search', arg: 'query', timeWindow: true },
  clickhouse: { instant: 'clickhouse_query', arg: 'sql', extra: { max_rows: CLICKHOUSE_MAX_ROWS } },
  // Search/metrics APIs accept start/end even though they use one tool for every window.
  jaeger: { instant: 'jaeger_search', arg: 'query', timeWindow: true },
  dynatrace: { instant: 'dynatrace_query', arg: 'query', timeWindow: true },
  datadog: { instant: 'datadog_query', arg: 'query', timeWindow: true },
};

export const QUERYABLE_KINDS = Object.keys(TOOL);
export const TIME_WINDOW_KINDS = Object.entries(TOOL).filter(([, spec]) => spec.range || spec.timeWindow).map(([kind]) => kind);
export const EXECUTION_TIMEOUT_KINDS = new Set(['prometheus', 'mimir', 'clickhouse']);
export const EFFECTIVE_TIMEOUT_CAP = 55;
