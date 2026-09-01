-- Datasource dashboard cards: schema-driven pre-built card set with stored queries
-- (docs/superpowers/specs/2026-08-28-datasource-dashboard-cards-design.md).
-- Third pre-built-content family next to datasource_diag_signals / datasource_graph_queries:
-- built by scripts/v2/workers/datasource_index.py from the cached schema, read by
-- GET /api/datasources/[id]/cards, executed live at view time via POST /api/datasources/query.
-- Deterministic catalog only — no LLM rows, so no budget/provenance machinery.
-- (No `-- since:` header on purpose: the runner stamps the deploying app's version, which
-- stays truthful across a release cut — the FinOps migrations' stale-header lesson.)
CREATE TABLE IF NOT EXISTS datasource_dashboard_cards (
  account_id     text NOT NULL DEFAULT 'self',
  integration_id bigint NOT NULL,
  card_key       text NOT NULL,
  title          text NOT NULL,
  viz            text NOT NULL,
  unit           text NOT NULL DEFAULT '',
  status         text NOT NULL,
  query          jsonb,
  missing        jsonb NOT NULL DEFAULT '[]'::jsonb,
  schema_version text NOT NULL DEFAULT '',
  built_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, integration_id, card_key)
);
