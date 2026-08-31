-- since: 0.8.0
-- ADR-020 follow-up (PR review): a rule inside a finops_baseline run can raise (e.g. a Compute
-- Optimizer opt-in/permission error propagating, or ebs_unattached's own freshness check firing
-- when steampipe_enabled=false) without failing the WHOLE run — engine.py's per-rule isolation
-- deliberately keeps evaluating the rest of the catalog and never resolves the failed rule's
-- prior findings. Until now that state was indistinguishable from a fully clean 'succeeded' run:
-- nothing in finops_runs recorded that part of the catalog was skipped. 'partial' makes it
-- visible to the API/card instead of silently absorbing it.
ALTER TABLE finops_runs DROP CONSTRAINT finops_runs_status_check;
ALTER TABLE finops_runs ADD CONSTRAINT finops_runs_status_check
  CHECK (status IN ('running', 'succeeded', 'partial', 'failed'));
