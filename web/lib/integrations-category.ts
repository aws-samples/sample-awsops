// web/lib/integrations-category.ts
// Derives the user-facing category of an `integrations` row for the Integrations hub tabs.
// Datasource = observability backends you query read-only (a query language). Connector = every
// other external service (Notion-class) + ingress webhook sources. Skills live in their own table.
//
// SOURCE OF TRUTH (kept in lockstep by integration-validation.test.ts): the 5 datasource kinds here
// must all be members of INTEGRATION_KINDS_EGRESS (web/lib/integration-validation.ts) and of the
// migration's integrations_kind_check egress set.
import type { Direction, Capability } from '@/lib/integrations';

/** Egress observability kinds that have a query language (Datasources tab + Explore). */
export const DATASOURCE_KINDS = ['prometheus', 'mimir', 'loki', 'tempo', 'clickhouse', 'jaeger', 'dynatrace', 'datadog'] as const;
export type DatasourceKind = (typeof DATASOURCE_KINDS)[number];

export type IntegrationCategory = 'datasource' | 'connector';

export function isDatasourceKind(kind: string): kind is DatasourceKind {
  return (DATASOURCE_KINDS as readonly string[]).includes(kind);
}

/**
 * A row is a `datasource` iff it is an egress, read-only observability backend (a query target);
 * everything else — Notion-class egress services, read_write, and all ingress sources — is a
 * `connector`.
 */
export function integrationCategory(row: {
  kind: string;
  direction: Direction;
  capability: Capability;
}): IntegrationCategory {
  if (row.direction === 'egress' && row.capability === 'read' && isDatasourceKind(row.kind)) {
    return 'datasource';
  }
  return 'connector';
}
