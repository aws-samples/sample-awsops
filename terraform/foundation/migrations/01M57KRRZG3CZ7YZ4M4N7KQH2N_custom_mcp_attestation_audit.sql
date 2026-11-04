-- since: 2.0.0
-- Durable non-secret attestation snapshots independent of mutable integration state.
-- Historical migration checksums remain unchanged; the runner records this new ULID.
ALTER TABLE customization_audit ADD COLUMN IF NOT EXISTS details JSONB;
