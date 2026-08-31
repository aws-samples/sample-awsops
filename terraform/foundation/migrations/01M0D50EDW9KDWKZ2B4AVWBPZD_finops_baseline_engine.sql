-- since: 0.8.0
-- ADR-020: FinOps baseline-recommendations engine (extends ADR-012). Three tables:
--   finops_runs      — one row per daily batch invocation (status/timing/CE API-call metering).
--   finops_findings  — the deterministic rule engine's output. Upserted on (rule_id, resource_id) so
--     a daily re-run of a still-true finding updates last_seen_at instead of duplicating; a finding
--     that stops reproducing is NOT deleted (silently vanishing "was this fixed?" is worse than a
--     stale row) — the engine marks it resolved_at instead (see engine.py).
--   finops_exceptions — user-reported false positives, accumulated read-only signal for future rule
--     tuning (ADR-020 Positive consequence). Never consulted to suppress findings automatically in
--     this version — a human still has to look.
-- monthly_savings_usd is nullable BY DESIGN (ADR-020 invariant: "can't be computed" is NULL, never 0 —
-- 0 would silently pollute a SUM()).
CREATE TABLE finops_runs (
  id            BIGSERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  rules_evaluated INT,
  findings_count  INT,
  ce_api_calls    INT NOT NULL DEFAULT 0,
  error         TEXT
);

CREATE TABLE finops_findings (
  id                  BIGSERIAL PRIMARY KEY,
  run_id              BIGINT REFERENCES finops_runs(id) ON DELETE SET NULL,
  rule_id             TEXT NOT NULL,
  -- '' (not NULL) for account-level findings with no single resource — a UNIQUE constraint on a
  -- nullable column would not dedupe two NULLs, defeating the upsert-on-conflict below.
  resource_id         TEXT NOT NULL DEFAULT '',
  title               TEXT NOT NULL,
  category            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_review', 'resolved')),
  monthly_savings_usd NUMERIC,
  evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,
  guard_hits          TEXT[] NOT NULL DEFAULT '{}',
  explanation_ko      TEXT,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ,
  UNIQUE (rule_id, resource_id)
);
CREATE INDEX finops_findings_status_idx ON finops_findings (status) WHERE status != 'resolved';

CREATE TABLE finops_exceptions (
  id            BIGSERIAL PRIMARY KEY,
  finding_id    BIGINT REFERENCES finops_findings(id) ON DELETE CASCADE,
  reported_by   TEXT NOT NULL,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
