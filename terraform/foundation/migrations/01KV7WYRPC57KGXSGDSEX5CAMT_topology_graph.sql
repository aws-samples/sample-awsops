-- ADR-043 Step 1: materialized topology graph (Postgres edge-table ontology; Neptune deferred).
-- The relationship ontology lives in web/lib/flow-topology.ts; the TS materializer (graph-store.ts)
-- reads synced inventory, runs buildFlowGraph, and upserts here under a fresh run_id, then
-- mark-sweeps stale rows (the only writer). Read paths use recursive-CTE traversal (graph-query.ts).
-- Read-only posture: derived from inventory; never mutates AWS.

CREATE TABLE IF NOT EXISTS topology_nodes (
  account_id  text        NOT NULL DEFAULT 'self',
  id          text        NOT NULL,                 -- builder node id, e.g. 'alb:<arn>', 'cf:<id>'
  kind        text        NOT NULL,
  label       text        NOT NULL DEFAULT '',
  meta        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  run_id      text        NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS topology_edges (
  id          bigserial   PRIMARY KEY,
  account_id  text        NOT NULL DEFAULT 'self',
  source      text        NOT NULL,
  target      text        NOT NULL,
  rel         text        NOT NULL DEFAULT 'edge',
  confidence  text        NOT NULL DEFAULT 'observed',  -- observed | inferred (ADR-040 convention)
  run_id      text        NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, source, target, rel)              -- idempotent ON CONFLICT upsert key
);

CREATE INDEX IF NOT EXISTS topology_edges_source_idx ON topology_edges (account_id, source);
CREATE INDEX IF NOT EXISTS topology_edges_target_idx ON topology_edges (account_id, target);
CREATE INDEX IF NOT EXISTS topology_nodes_kind_idx   ON topology_nodes (account_id, kind);
