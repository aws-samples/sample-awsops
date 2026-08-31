-- Account-region scan targets for the app-wide Scope Selector.
-- Read-only metadata only: adding a region broadens future inventory reads/syncs, but
-- does not mutate AWS resources or enable any remediation/autonomous path.

CREATE TABLE IF NOT EXISTS account_regions (
  account_id  text        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  region      text        NOT NULL CHECK (region ~ '^[a-z]{2}-[a-z]+-[0-9]+$'),
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, region)
);

-- schema.sql's baseline creates account_regions WITHOUT this FK (the `accounts` table is
-- migration-managed and absent from the baseline, so the baseline cannot reference it). On a
-- schema.sql-first install the CREATE above is therefore a no-op and the FK is missing — add it
-- idempotently here. The accounts migration (smaller ULID) has already run, so `accounts` exists,
-- and the constraint name matches the inline FK above so the migration-only path is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_regions_account_id_fkey') THEN
    ALTER TABLE account_regions
      ADD CONSTRAINT account_regions_account_id_fkey
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_account_regions_enabled ON account_regions(account_id, enabled);

INSERT INTO account_regions (account_id, region, enabled)
SELECT account_id, region, true
  FROM accounts
 WHERE region <> ''
ON CONFLICT (account_id, region) DO UPDATE SET enabled = true, updated_at = now();
