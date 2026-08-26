-- Pre-built datasource diagnostic signals (Prometheus/Mimir): deterministic signal catalog
-- resolved against each instance's cached schema (datasource_schemas), stored ready-to-run.
-- Dual consumer: the AI-diagnosis worker (executes ready signals) and the Explore quick-query UI.
-- Read-only posture (ADR-007 governed external-data read; no AWS mutation). Idempotent ULID migration.
-- integration_id is BIGINT to match datasource_schemas.integration_id / integrations.id.
CREATE TABLE IF NOT EXISTS datasource_diag_signals (
  account_id      text        NOT NULL DEFAULT 'self',
  integration_id  bigint      NOT NULL,
  signal_key      text        NOT NULL,                    -- 'container_cpu_throttling', 'oom_kills', …
  title           text        NOT NULL,                    -- human label (Explore button / report)
  status          text        NOT NULL CHECK (status IN ('ready', 'unavailable')),  -- guard bad writes
  query           jsonb,                                   -- ready: {tool, queries:[{expr,label}]}
  missing_metrics jsonb,                                   -- unavailable: ["metric_a", …] (utilization reason)
  meta            jsonb       NOT NULL DEFAULT '{}'::jsonb, -- {pillar, threshold, kind, unit}
  schema_version  text,                                    -- hash(metrics)+CATALOG_VERSION used at build
  built_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, integration_id, signal_key)
);
CREATE INDEX IF NOT EXISTS dds_instance_idx ON datasource_diag_signals (account_id, integration_id, status);
