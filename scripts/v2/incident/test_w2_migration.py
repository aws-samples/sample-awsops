"""W2a migration assertions: incidents.trigger_event/validation JSONB + alert_validation stage +
status superset + GIN. Globs by suffix so it is ULID-agnostic."""
import glob
import os

HERE = os.path.dirname(os.path.abspath(__file__))
_MIG = glob.glob(os.path.join(HERE, "..", "..", "..", "terraform", "v2", "foundation",
                              "migrations", "*_incident_validation_stage.sql"))


def _sql():
    assert _MIG, "incident_validation_stage migration file not found"
    with open(_MIG[0]) as f:
        return f.read()


def test_adds_nullable_jsonb_columns():
    s = _sql()
    assert "ADD COLUMN IF NOT EXISTS trigger_event JSONB" in s
    assert "ADD COLUMN IF NOT EXISTS validation JSONB" in s


def test_stage_check_superset_includes_alert_validation():
    s = _sql().lower()
    assert "drop constraint if exists incident_stages_stage_check" in s
    for v in ("'triage'", "'alert_validation'", "'investigation'", "'root_cause'",
              "'mitigation_plan'", "'prevention'"):
        assert v in s, v


def test_status_check_superset_preserves_existing():
    s = _sql().lower()
    assert "drop constraint if exists incidents_status_check" in s
    for v in ("'triaged'", "'validating'", "'false_positive'", "'investigating'", "'root_cause'",
              "'mitigation_planned'", "'prevention'", "'resolved'", "'stalled'", "'skipped'"):
        assert v in s, v


def test_gin_index_on_validation_jsonb_path_ops():
    assert "using gin (validation jsonb_path_ops)" in _sql().lower()


def test_no_schema_migrations_insert_and_no_on_conflict():
    s = _sql().lower()
    assert "schema_migrations" not in s
    assert "on conflict" not in s
