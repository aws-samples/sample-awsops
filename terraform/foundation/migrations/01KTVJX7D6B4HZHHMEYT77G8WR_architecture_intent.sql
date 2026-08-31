-- since: 2.1.0
-- architecture_intent — operator-confirmed "intended" model (the should-be). One ACTIVE
-- row per (kind,target,params-hash); drafts may coexist. JSONB doc + topology fingerprint
-- so a confirmed invariant auto-flags stale when the live topology diverges (§8R3).
-- The LLM only PROPOSES candidates (status='draft', provenance='ai_proposed'); an admin
-- PROMOTES to 'active'. Only 'active' rows are evaluated by the deterministic engine.
-- NOTE: the runner stamps schema_migrations itself — do NOT INSERT it here.
-- touch_updated_at() lives in the baseline schema.sql.
CREATE TABLE IF NOT EXISTS architecture_intent (
  id                  BIGSERIAL    PRIMARY KEY,
  kind                TEXT         NOT NULL,
  target              TEXT,
  params              JSONB        NOT NULL DEFAULT '{}'::jsonb,
  severity            TEXT         NOT NULL DEFAULT 'warning'
                        CHECK (severity IN ('info','warning','critical')),
  status              TEXT         NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','rejected')),
  provenance          TEXT         NOT NULL DEFAULT 'ai_proposed'
                        CHECK (provenance IN ('ai_proposed','human_authored')),
  topology_fingerprint TEXT,
  created_by          TEXT         NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_validated_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_intent_active
  ON architecture_intent (kind, target, md5(params::text)) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_intent_status ON architecture_intent(status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_arch_intent_touch') THEN
    CREATE TRIGGER trg_arch_intent_touch BEFORE UPDATE ON architecture_intent
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;
