-- Pre-built topology-graph queries per registered datasource instance: a static catalog
-- (graph_catalog.py) resolved against each instance's cached schema (datasource_schemas),
-- stored ready-to-run, so rebuildTraceGraph never computes SQL/PromQL ad hoc.
-- Separate from datasource_diag_signals: that table's two consumers (diagnosis planner, Explore
-- chips) unconditionally read every row for an instance — mixing graph rows in would force both
-- to filter for no shared benefit. Idempotent ULID migration.
-- integration_id is BIGINT to match datasource_schemas.integration_id / integrations.id.
CREATE TABLE IF NOT EXISTS datasource_graph_queries (
  account_id      text        NOT NULL DEFAULT 'self',
  integration_id  bigint      NOT NULL,
  query_key       text        NOT NULL,                    -- 'trace_spans' | 'servicegraph_calls'
  status          text        NOT NULL CHECK (status IN ('ready', 'unavailable')),  -- guard bad writes
  query           jsonb,                                   -- ready: {tool, mapper, args_template}
  missing         jsonb,                                   -- unavailable: missing schema elements
  meta            jsonb       NOT NULL DEFAULT '{}'::jsonb, -- {kind, provenance:'catalog'|'generated'}
  schema_version  text,                                     -- hash(schema)+CATALOG_VERSION used at build
  built_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, integration_id, query_key)
);
CREATE INDEX IF NOT EXISTS dgq_instance_idx ON datasource_graph_queries (account_id, integration_id, status);
