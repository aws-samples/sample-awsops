-- since: 0.8.0
-- ADR-020 follow-up (PR review, L4 MAJOR): finops_findings deduped on (rule_id, resource_id)
-- alone, but ebs_unattached reads inventory_resources across ALL synced accounts/regions
-- (base PK is (resource_type, account_id, region, resource_id)) while the Compute Optimizer
-- rules read only the host account/region. Without account_id/region in the finding's own
-- identity, a resource_id collision across accounts/regions is unrecoverable — the wrong
-- account's finding silently overwrites another's, and resolve_stale can wipe a still-true
-- finding for account A because account B stopped reproducing under the same resource_id.
-- Defaulted to 'self'/'' (matching inventory_resources' own account_id default) so existing
-- rows backfill into a single coherent scope rather than colliding on the new key.
ALTER TABLE finops_findings ADD COLUMN account_id TEXT NOT NULL DEFAULT 'self';
ALTER TABLE finops_findings ADD COLUMN region TEXT NOT NULL DEFAULT '';
ALTER TABLE finops_findings DROP CONSTRAINT finops_findings_rule_id_resource_id_key;
ALTER TABLE finops_findings ADD CONSTRAINT finops_findings_scope_key
  UNIQUE (rule_id, account_id, region, resource_id);
