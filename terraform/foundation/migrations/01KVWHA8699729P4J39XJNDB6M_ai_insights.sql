-- AI Insights dashboard cache: the periodic insight worker writes LLM-synthesized operational
-- observations (K8s events + CloudWatch alarms + cost anomalies) here; the Overview dashboard reads
-- the latest row. Read-only posture (ADR-007 governed reads; no AWS mutation). Idempotent ULID migration.
-- Gated by ai_insights_enabled (the table is harmless/empty when the feature is off).
CREATE TABLE IF NOT EXISTS ai_insights (
  id            bigserial   PRIMARY KEY,
  account_id    text        NOT NULL DEFAULT 'self',
  status        text        NOT NULL CHECK (status IN ('succeeded', 'partial', 'failed')),
  insights      jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- [{severity, title, detail, source, refs}]
  sources_used  jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- {k8s: n, cloudwatch: n, cost: n}
  model         text,
  error         text,
  generated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_insights_latest_idx ON ai_insights (account_id, generated_at DESC);
