-- AI multi-source query: cached, introspected datasource schema per connector (account-scoped).
-- Idempotent (ULID migration; make migrate runs ULID files in order). No FK — standalone cache table.
CREATE TABLE IF NOT EXISTS datasource_schemas (
  account_id  text        NOT NULL,
  slug        text        NOT NULL,
  kind        text,
  schema      jsonb       NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, slug)
);
