-- Registered AWS accounts for multi-account (v1-style) cross-account reads.
-- Written ONLY by the admin-gated BFF route /api/accounts; read by web/lib/accounts.ts.
-- The host row (is_host) is seeded at runtime from HOST_ACCOUNT_ID (no AssumeRole for host).
-- Cross-account reads assume AWSopsReadOnlyRole in the target account using external_id.
-- external_id is a CONFUSED-DEPUTY guard, NOT a secret: it is stored plaintext so the web
-- layer can pass it to sts:AssumeRole; no encryption-at-rest is needed for this threat model.
-- Read-only posture: this table never causes a mutation of any AWS resource.

CREATE TABLE IF NOT EXISTS accounts (
  account_id        text        PRIMARY KEY CHECK (account_id ~ '^\d{12}$' OR account_id = 'self'),
  alias             text        NOT NULL,
  region            text        NOT NULL DEFAULT 'ap-northeast-2',
  is_host           boolean     NOT NULL DEFAULT false,
  role_name         text        NOT NULL DEFAULT 'AWSopsReadOnlyRole',
  external_id       text,
  enabled           boolean     NOT NULL DEFAULT true,
  status            text        NOT NULL DEFAULT 'pending',
  last_verified_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- every non-host (target) account MUST carry an ExternalId (confused-deputy guard)
  CONSTRAINT external_id_required_for_target CHECK (is_host OR external_id IS NOT NULL)
);

-- at most one host row
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_single_host ON accounts (is_host) WHERE is_host;
