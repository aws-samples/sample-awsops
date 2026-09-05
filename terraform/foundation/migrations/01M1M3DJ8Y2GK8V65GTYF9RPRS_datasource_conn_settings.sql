-- since: 2.1.0
-- Gap-audit L203: per-datasource connection settings (v1 parity — request timeout, and the
-- ClickHouse database name; v1's result-cache TTL is deliberately NOT ported: the v2 thin-BFF
-- query path is uncached by design, and a per-datasource result cache would need its own
-- staleness-disclosure machinery — recorded as a disclosed deviation in the gap audit).
-- One JSONB blob on the integrations row (the datasource instance row): validated server-side
-- by web/lib/datasources.ts sanitizeDsSettings (timeoutS int 1..60, database identifier-only).
-- Additive + idempotent. Do NOT write schema_migrations (the runner stamps it).
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS ds_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
