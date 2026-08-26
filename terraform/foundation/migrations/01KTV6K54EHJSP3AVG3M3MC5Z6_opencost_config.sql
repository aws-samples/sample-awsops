-- since: 2.0.0
-- opencost_config — read-only OpenCost install config. The dashboard SAVES a cluster-scoped
-- helm version + values; install is out-of-band (AWSops never writes the cluster — ADR-035 pattern).
-- First ULID migration: replaces the provisional integer "v10" block that collided with
-- ADR-032 prevention_insights (both grabbed v10). See migrations/README.md.
CREATE TABLE IF NOT EXISTS opencost_config (
  cluster       TEXT PRIMARY KEY,
  chart_version TEXT,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
