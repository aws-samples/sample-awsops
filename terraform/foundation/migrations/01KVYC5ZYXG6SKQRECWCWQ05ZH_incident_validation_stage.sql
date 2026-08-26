-- since: 2.4.0
-- W2a: AlertValidation data foundation. Adds the trigger_event snapshot + validation verdict
-- JSONB seams to incidents, widens the incident_stages.stage and incidents.status CHECKs to
-- include the new alert_validation stage / validating / false_positive states, and a GIN index
-- for verdict queries. All additive + idempotent; nullable JSONB (inert when the lifecycle flag
-- is off). The runner stamps the version ledger itself — do NOT insert into it here, and never
-- edit this file after authoring (sha256 drift aborts the runner).

-- 1) Nullable JSONB seams (match incidents.rca / mitigation_plan / embedding_seam — no DEFAULT).
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS trigger_event JSONB;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS validation JSONB;

-- 2) Widen the incident_stages.stage CHECK to include 'alert_validation' (superset = safe; the
-- baseline inline CHECK auto-names as incident_stages_stage_check).
ALTER TABLE incident_stages DROP CONSTRAINT IF EXISTS incident_stages_stage_check;
ALTER TABLE incident_stages ADD CONSTRAINT incident_stages_stage_check
  CHECK (stage IN ('triage','alert_validation','investigation','root_cause','mitigation_plan','prevention'));

-- 3) Widen the incidents.status CHECK to include 'validating' + 'false_positive' (superset; all
-- existing values preserved; auto-name incidents_status_check).
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_status_check;
ALTER TABLE incidents ADD CONSTRAINT incidents_status_check
  CHECK (status IN ('triaged','validating','false_positive','investigating','root_cause',
                    'mitigation_planned','prevention','resolved','stalled','skipped'));

-- 4) GIN index for verdict queries (jsonb_path_ops: smaller/faster, supports @> containment).
CREATE INDEX IF NOT EXISTS idx_incidents_validation ON incidents USING GIN (validation jsonb_path_ops);
