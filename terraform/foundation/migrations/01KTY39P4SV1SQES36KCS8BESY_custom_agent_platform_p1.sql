-- since: 2.2.0
-- Custom Agent Platform P1 (ADR-031 extension; ADR-039 draft).
-- Frontier-agent fields + migration drift-fix + integrations catalog (created but UNUSED by the runtime in P1).
--
-- Idempotent by construction: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / pg_constraint-guarded
-- CHECK / ON CONFLICT-free additive UPDATE / ON CONFLICT DO NOTHING seeds. Safe to apply twice.
--
-- DRIFT FIX: the ADR-031 catalog tables (skills/agents/agent_skills/customization_audit @ baseline integer
-- ledger v2; agent_spaces @ v8) live ONLY in the frozen baseline schema.sql, not in any ULID migration. A DB
-- provisioned/managed via the ULID runner alone could be missing them. We re-assert them here (verbatim baseline
-- DDL) so the runner-only path is whole. Where the baseline already created them this is a no-op.
--
-- DO NOT write schema_migrations here and DO NOT use ON CONFLICT on the ledger — scripts/v2/migrate.mjs stamps
-- the ledger (id + sha256 checksum + app_version) in the same transaction.

-- (a) Re-assert the 5 ADR-031 catalog tables (drift fix; verbatim baseline DDL).
CREATE TABLE IF NOT EXISTS skills (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  description    TEXT NOT NULL,
  instructions   TEXT NOT NULL DEFAULT '',
  tool_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
  tier           TEXT NOT NULL CHECK (tier IN ('builtin','custom')),
  content_hash   TEXT NOT NULL,
  version        INT  NOT NULL DEFAULT 1,
  enabled        BOOLEAN NOT NULL DEFAULT false,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  description      TEXT NOT NULL,
  persona          TEXT NOT NULL DEFAULT '',
  routing_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  gateway          TEXT NOT NULL,
  model            TEXT,
  tier             TEXT NOT NULL CHECK (tier IN ('builtin','custom')),
  version          INT  NOT NULL DEFAULT 1,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id BIGINT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  ord      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE IF NOT EXISTS customization_audit (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id   TEXT NOT NULL,
  before_hash TEXT,
  after_hash  TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_spaces (
  account_id        TEXT PRIMARY KEY,
  enabled_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled_skill_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_allowlist    JSONB NOT NULL DEFAULT '[]'::jsonb,
  version           INT NOT NULL DEFAULT 1,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- (b) Additive frontier-agent columns (idempotent).
ALTER TABLE agents       ADD COLUMN IF NOT EXISTS agent_type        TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE agents       ADD COLUMN IF NOT EXISTS gateways          JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents       ADD COLUMN IF NOT EXISTS response_language TEXT;
ALTER TABLE skills       ADD COLUMN IF NOT EXISTS agent_types       JSONB NOT NULL DEFAULT '["generic"]'::jsonb;
ALTER TABLE skills       ADD COLUMN IF NOT EXISTS reference_keys    JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_spaces ADD COLUMN IF NOT EXISTS enabled_integration_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_spaces ADD COLUMN IF NOT EXISTS response_language TEXT;

-- (b2) agent_type CHECK — ADD CONSTRAINT is NOT idempotent (no ADD CONSTRAINT IF NOT EXISTS for CHECK);
-- guard via pg_constraint so re-apply is a no-op.
-- SOURCE OF TRUTH for these 6 values is shared with web/lib/skill-validation.ts AGENT_TYPES — keep in sync.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_agent_type_check') THEN
    ALTER TABLE agents ADD CONSTRAINT agents_agent_type_check
      CHECK (agent_type IN ('generic','on_demand','triage','rca','mitigation','evaluation'));
  END IF;
END $$;

-- (c) integrations catalog (Option 4 typed axis over the single MCP substrate). Created but UNUSED by the
-- runtime in P1 — registration UX, auth, read context injection, and READ_WRITE write-actions are P2/P3.
CREATE TABLE IF NOT EXISTS integrations (
  id                     BIGSERIAL PRIMARY KEY,
  name                   TEXT NOT NULL UNIQUE,
  kind                   TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  endpoint               TEXT,
  transport              TEXT CHECK (transport IN ('sigv4','oauth_client_credentials','oauth_3lo','api_key')),
  credentials_ref        TEXT,                                   -- Secrets Manager ARN (never plaintext)
  private_connection_ref TEXT,
  capability             TEXT NOT NULL DEFAULT 'read' CHECK (capability IN ('read','read_write')),
  exposed_tools          JSONB NOT NULL DEFAULT '[]'::jsonb,
  provided_context       JSONB NOT NULL DEFAULT '{}'::jsonb,
  write_action_refs      JSONB NOT NULL DEFAULT '[]'::jsonb,     -- action_catalog entries each write maps to
  tier                   TEXT NOT NULL DEFAULT 'custom' CHECK (tier IN ('builtin','custom')),
  enabled                BOOLEAN NOT NULL DEFAULT false,
  created_by             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- (d) Backfill gateways[] from the legacy single gateway column (additive; runs before the seed).
UPDATE agents SET gateways = jsonb_build_array(gateway)
 WHERE gateways = '[]'::jsonb AND gateway IS NOT NULL;

-- (e) Seed the frontier agents (builtin, enabled). ON CONFLICT (name) DO NOTHING is re-run safe.
-- NOTE: 'security' collides with the existing baseline security-gateway agent → that INSERT no-ops and the
-- existing row serves as the security frontier (its gateways[] was backfilled to ["security"] in step (d),
-- and agent_type defaulted to 'generic' in step (b)). 'devops'/'finops' do not collide and are inserted.
INSERT INTO agents (name, description, persona, routing_keywords, gateway, gateways, agent_type, tier, enabled)
VALUES
  ('devops',
   'DevOps frontier agent — incident response, reliability, deployments.',
   'You are a DevOps operations specialist for AWS and Kubernetes. Describe, analyze, and recommend.',
   '["devops","deploy","deployment","incident","reliability","oncall","rollback"]'::jsonb,
   'ops', '["ops","monitoring","container","iac","network"]'::jsonb, 'generic', 'builtin', true),
  ('security',
   'Security frontier agent — IAM, posture, findings.',
   'You are a cloud security specialist. Describe, analyze, and recommend.',
   '["security","iam","posture","finding","vulnerability","compliance"]'::jsonb,
   'security', '["security"]'::jsonb, 'generic', 'builtin', true),
  ('finops',
   'FinOps frontier agent — cost visibility, optimization, unit economics (FinOps Foundation framework).',
   'You are a FinOps specialist (inform / optimize / operate). Describe, analyze, and recommend.',
   '["finops","cost","spend","savings","budget","optimization","unit economics","rightsizing"]'::jsonb,
   'cost', '["cost"]'::jsonb, 'generic', 'builtin', true)
ON CONFLICT (name) DO NOTHING;
