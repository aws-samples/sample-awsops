-- since: 2.4.0
-- Datasource instances (multi-instance + naming) — Phase 0a, ADDITIVE only (no PK swap here).
-- Datasources become `integrations` rows (category derived: egress + read + a query-language kind).
-- Additive + idempotent. The PK swap + backfill is the next migration
-- (01KVB3MDTTSJ3WNTJ2DCPDWJS9_datasource_instances_backfill.sql). Do NOT write schema_migrations
-- (the runner stamps it).

-- (a) datasource_schemas: per-INSTANCE cache key. Add the bigint FK-ish column now (nullable until
--     the backfill maps it), so two instances of one kind no longer clobber one cache row.
ALTER TABLE datasource_schemas ADD COLUMN IF NOT EXISTS integration_id BIGINT;

-- (b) integrations: default-per-kind flag + the datasource auth method (so the list/UI shows the auth
--     method WITHOUT reading the secret). `auth_mode` stays reserved for ingress webhook auth — do not
--     overload it; `ds_auth_type` is the datasource (egress READ) auth selector.
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS is_default   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS ds_auth_type TEXT;

-- (c) Expand the egress kind set to admit the 4 missing datasource kinds (clickhouse/mimir/loki/tempo).
--     The original constraint was added under a pg_constraint existence guard; to CHANGE its definition
--     we DROP then re-ADD. DROP IF EXISTS + unconditional ADD is idempotent (same end state on re-run);
--     the new set is a SUPERSET so all existing rows still satisfy it. BOTH conditional branches are
--     reproduced verbatim — the ingress set is unchanged (dropping a branch would break webhooks).
--     SOURCE OF TRUTH: mirror of web/lib/integration-validation.ts INTEGRATION_KINDS_EGRESS.
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_kind_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_kind_check CHECK (
  (direction = 'egress'  AND kind IN ('grafana','datadog','splunk','prometheus','newrelic','notion','confluence','jira','servicenow','slack','github','gitlab','custom_mcp','clickhouse','mimir','loki','tempo'))
  OR
  (direction = 'ingress' AND kind IN ('cloudwatch_sns','alertmanager','grafana_alert','pagerduty','datadog_monitor','generic_webhook'))
);

-- (d) At most one default datasource instance per kind (integrations is GLOBAL — no account_id column).
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_default_per_kind ON integrations (kind) WHERE is_default;
