-- since: 2.0.0
-- prevention_insights — ADR-032 Phase 4 cross-incident proactive-prevention tier.
-- The per-incident prevention_recommendations table (v5) is UNCHANGED. Recurring
-- insights span multiple incidents (no single owner), so they live here.
-- Always-present + inert when the lifecycle flag is off (no incidents ⇒ no rows).
-- Converted from the provisional integer "v10" block (collided with opencost_config —
-- the collision that motivated this ULID mechanism). Live DB may already have the
-- table from the legacy path: IF NOT EXISTS keeps this idempotent.
CREATE TABLE IF NOT EXISTS prevention_insights (
  id                  BIGSERIAL PRIMARY KEY,
  dedup_key           TEXT NOT NULL UNIQUE,                 -- sha256(category + scope_ref): idempotent UPSERT key
  category            TEXT NOT NULL,                        -- observability|testing|code|infra
  scope_ref           TEXT NOT NULL,                        -- "<rca.category>::<service|resource>"
  recommendation      TEXT NOT NULL,                        -- deterministic base recommendation
  narration           TEXT,                                 -- optional Haiku enrichment (hypothesis; nullable).
                                                            -- NOT yet written by prevention_loop.py — reserved for the
                                                            -- planned narration follow-up (PR #36 review: intentional, not dead).
  llm_model           TEXT,                                 -- ditto (reserved with narration)
  recurrence_count    INT NOT NULL DEFAULT 1,
  source_incident_ids JSONB NOT NULL DEFAULT '[]'::jsonb,   -- evidence: the incidents that recurred
  evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {services[], severities[], window_days}
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','addressed','dismissed')),
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prevention_insights_open ON prevention_insights (last_seen_at DESC) WHERE status = 'open';
