-- since: 2.3.0
-- Custom Agent Platform P2 (ADR-039) — Integrations axis: ingress + direction columns + kind CHECK.
-- Additive + idempotent. Depends on the P1 migration having created the `integrations` table and the
-- `agent_spaces.enabled_integration_ids` column. Do NOT write schema_migrations (the runner stamps it).

-- (a) integrations: direction + ingress columns (additive, idempotent).
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS direction         TEXT NOT NULL DEFAULT 'egress';
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS auth_mode         TEXT;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS receive_path      TEXT;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS inbound_auth_ref  TEXT;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS source_allowlist  JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS trigger_target    TEXT;

-- (b) direction CHECK + direction-CONDITIONAL kind CHECK (ADD CONSTRAINT is not idempotent → pg_constraint guard).
-- SOURCE OF TRUTH: these kind/direction value sets are shared with
-- web/lib/integration-validation.ts INTEGRATION_KINDS_EGRESS / INTEGRATION_KINDS_INGRESS — keep in sync.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integrations_direction_check') THEN
    ALTER TABLE integrations ADD CONSTRAINT integrations_direction_check
      CHECK (direction IN ('egress','ingress'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integrations_kind_check') THEN
    ALTER TABLE integrations ADD CONSTRAINT integrations_kind_check CHECK (
      (direction = 'egress'  AND kind IN ('grafana','datadog','splunk','prometheus','newrelic','notion','confluence','jira','servicenow','slack','github','gitlab','custom_mcp'))
      OR
      (direction = 'ingress' AND kind IN ('cloudwatch_sns','alertmanager','grafana_alert','pagerduty','datadog_monitor','generic_webhook'))
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_integrations_dir_enabled ON integrations (direction, enabled) WHERE enabled = true;

-- (c) agent_spaces: per-account ADR-011 private-egress opt-in + the §10 default-off non-admin authoring flag.
ALTER TABLE agent_spaces ADD COLUMN IF NOT EXISTS allow_private_datasource BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agent_spaces ADD COLUMN IF NOT EXISTS non_admin_authoring      BOOLEAN NOT NULL DEFAULT false;
