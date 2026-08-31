# scripts/v2/remediation/test_schema_v4.py
import re, pathlib
SQL = pathlib.Path(__file__).parents[3].joinpath("terraform/foundation/data/schema.sql").read_text()
def test_migration_v4_present():
    assert re.search(r"VALUES \(4,\s*'ADR-029\+036", SQL)
def test_all_seeds_disabled():
    block = SQL[SQL.index("INSERT INTO action_catalog"):SQL.index("INSERT INTO schema_migrations (version, description)\nVALUES (4")]
    # every seeded action tuple must end its VALUES group with the enabled=false literal
    assert block.count("false)") >= 3 and "true)" not in block
def test_status_check_widened():
    assert "'awaiting_approval'" in SQL and "'manual_intervention'" in SQL
def test_tables_idempotent():
    for t in ("action_catalog","action_plans","remediation_audit"):
        assert re.search(rf"CREATE TABLE IF NOT EXISTS {t}", SQL)
