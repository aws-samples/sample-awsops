"""Static contract for the additive durable inventory-freshness migration."""
from pathlib import Path
import re


MIGRATIONS = Path(__file__).parents[3] / "terraform" / "foundation" / "migrations"


def _migration():
    matches = list(MIGRATIONS.glob("*_inventory_sync_freshness.sql"))
    assert len(matches) == 1, "expected one collision-free inventory_sync_freshness migration"
    return matches[0].read_text(encoding="utf-8")


def _unknown_attrs_migration():
    matches = list(MIGRATIONS.glob("*_inventory_sync_unknown_attrs.sql"))
    assert len(matches) == 1, "expected one collision-free inventory_sync_unknown_attrs migration"
    return matches[0].read_text(encoding="utf-8")


def test_migration_adds_durable_success_fields_and_partial_status():
    sql = _migration()
    assert re.search(
        r"ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+run_token\s+text",
        sql,
        re.I,
    )
    assert re.search(
        r"ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+last_success_at\s+timestamptz",
        sql,
        re.I,
    )
    assert re.search(
        r"ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+last_success_row_count\s+integer",
        sql,
        re.I,
    )
    assert "'partial'" in sql
    assert re.search(r"CHECK\s*\(\s*status\s+IN\s*\(", sql, re.I)


def test_migration_backfills_only_existing_successes():
    sql = _migration()
    assert re.search(
        r"UPDATE\s+inventory_sync_runs.*last_success_at.*finished_at",
        sql,
        re.I | re.S,
    )
    assert re.search(
        r"last_success_row_count\s*=\s*COALESCE\s*\(\s*last_success_row_count\s*,\s*row_count\s*\)",
        sql,
        re.I,
    )
    assert re.search(r"WHERE\s+status\s*=\s*'succeeded'", sql, re.I)


def test_migration_recreates_safe_reader_view_without_error_text():
    sql = _migration()
    match = re.search(
        r"CREATE\s+VIEW\s+sql_reader\.inventory_sync_runs.*?AS\s+SELECT\s+(.*?)"
        r"\s+FROM\s+public\.inventory_sync_runs",
        sql,
        re.I | re.S,
    )
    assert match, "migration must recreate sql_reader.inventory_sync_runs"
    columns = match.group(1).lower()
    for column in (
        "resource_type",
        "account_id",
        "started_at",
        "finished_at",
        "status",
        "row_count",
        "last_success_at",
        "last_success_row_count",
    ):
        assert re.search(rf"\b{column}\b", columns), column
    assert not re.search(r"\berror\b", columns)
    assert not re.search(r"\brun_token\b", columns)
    assert re.search(
        r"GRANT\s+SELECT\s+ON\s+sql_reader\.inventory_sync_runs\s+TO\s+awsops_sql_reader",
        sql,
        re.I,
    )


def test_unknown_attrs_migration_adds_the_column_and_recreates_the_reader_view():
    """Attribute blind spots must be disclosed to the reader without widening it to error text."""
    sql = _unknown_attrs_migration()
    assert re.search(
        r"ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+unknown_attribute_count\s+integer",
        sql,
        re.I,
    )
    match = re.search(
        r"CREATE\s+VIEW\s+sql_reader\.inventory_sync_runs.*?AS\s+SELECT\s+(.*?)"
        r"\s+FROM\s+public\.inventory_sync_runs",
        sql,
        re.I | re.S,
    )
    assert match, "migration must recreate sql_reader.inventory_sync_runs"
    columns = match.group(1).lower()
    for column in (
        "resource_type",
        "account_id",
        "started_at",
        "finished_at",
        "status",
        "row_count",
        "last_success_at",
        "last_success_row_count",
        "unknown_attribute_count",
    ):
        assert re.search(rf"\b{column}\b", columns), column
    assert not re.search(r"\berror\b", columns)
    assert not re.search(r"\brun_token\b", columns)
    assert re.search(
        r"GRANT\s+SELECT\s+ON\s+sql_reader\.inventory_sync_runs\s+TO\s+awsops_sql_reader",
        sql,
        re.I,
    )
