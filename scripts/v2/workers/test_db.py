"""Tests for the datasource_diag_signals helpers in db.py (pg8000 conn.run pattern).

A FakeConn records (sql, params) and returns canned rows so the helpers are exercised without Aurora.
"""
import json
import os
import re
import sys
from pathlib import Path
from uuid import uuid4

import pg8000.native
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db  # noqa: E402


TIMING_MIGRATION = (
    Path(__file__).resolve().parents[3] / "terraform/foundation/migrations/"
    "01M27AQXZKQQ5J611R01BEFHPD_worker_jobs_lifecycle_timestamps.sql"
)


class WorkerDatabase:
    """Real PostgreSQL contract fixture; never connects to Aurora or uses AWS credentials.

    Set AWSOPS_WORKER_TEST_PG_PORT to a disposable localhost PostgreSQL's port.
    Each test gets a separate database, including the real public/sql_reader schemas.
    Other targeted worker tests reuse this fixture.
    """

    def __init__(self, port):
        self.port = port
        self.database = "worker_timing_" + uuid4().hex
        self.schema = "public"
        self.connections = []
        self.admin = pg8000.native.Connection(
            user="postgres", host="127.0.0.1", port=port, database="postgres",
        )
        self.admin.run("""
            DO $$
            DECLARE role_name text;
            BEGIN
              FOREACH role_name IN ARRAY ARRAY['awsops_sql_reader', 'awsops_web', 'awsops_worker']
              LOOP
                IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
                  EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOINHERIT', role_name);
                END IF;
              END LOOP;
            END $$;
        """)
        self.admin.run(f"CREATE DATABASE {self.database}")
        self.conn = self.connect()
        # The deployed ledger shape before the timing migration. Extended states already
        # belong to the dark remediation substrate; tests ensure they stay protected.
        self.conn.run("""
            CREATE TABLE worker_jobs (
                job_id uuid PRIMARY KEY, type text NOT NULL, runtime text,
                status text NOT NULL DEFAULT 'queued' CHECK (status IN (
                    'queued','running','succeeded','failed','canceled',
                    'awaiting_approval','manual_intervention')),
                payload jsonb NOT NULL DEFAULT '{}'::jsonb, result jsonb,
                artifact_uri text, error text, dry_run boolean NOT NULL DEFAULT false,
                idempotency_key text, requested_by text, attempt integer NOT NULL DEFAULT 0,
                automation_execution_id text, sfn_execution_arn text, task_token text,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE FUNCTION touch_job() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END $$;
            CREATE TRIGGER touch_job BEFORE UPDATE ON worker_jobs
                FOR EACH ROW EXECUTE FUNCTION touch_job();
            GRANT USAGE ON SCHEMA public TO awsops_web, awsops_worker;
            GRANT SELECT, INSERT, UPDATE, DELETE ON worker_jobs TO awsops_web, awsops_worker;

            -- Existing view/grants from 01KYVY9J2E8AMF35WR4J7036A3. The new migration
            -- must append only timing metadata without granting base-table access.
            CREATE SCHEMA sql_reader;
            REVOKE ALL ON SCHEMA sql_reader FROM PUBLIC;
            GRANT USAGE ON SCHEMA sql_reader TO awsops_sql_reader;
            CREATE VIEW sql_reader.worker_jobs WITH (security_invoker = false) AS
                SELECT job_id, type, runtime, status, artifact_uri, dry_run, idempotency_key,
                       attempt, sfn_execution_arn, created_at, updated_at
                FROM public.worker_jobs;
            GRANT SELECT ON sql_reader.worker_jobs TO awsops_sql_reader;
        """)

    def connect(self):
        conn = pg8000.native.Connection(
            user="postgres", host="127.0.0.1", port=self.port, database=self.database,
        )
        conn.run(f"SET search_path TO {self.schema}")
        self.connections.append(conn)
        return conn

    def migrate(self):
        # Missing migration is observed through the resulting database contract, not a
        # source-text assertion. Reapplying also exercises ADD COLUMN IF NOT EXISTS.
        if TIMING_MIGRATION.exists():
            self.conn.run(TIMING_MIGRATION.read_text())

    def insert(self, **overrides):
        values = {
            "job_id": str(uuid4()), "type": "noop", "payload": json.dumps({"fixture": True}),
            "requested_by": "fixture-owner", "idempotency_key": str(uuid4()),
            **overrides,
        }
        cols = ",".join(values)
        binds = ",".join(f":{key}" for key in values)
        self.conn.run(f"INSERT INTO worker_jobs ({cols}) VALUES ({binds})", **values)
        return values["job_id"]

    def job(self, job_id):
        rows = self.conn.run("SELECT * FROM worker_jobs WHERE job_id=:id", id=job_id)
        return dict(zip((column["name"] for column in self.conn.columns), rows[0]))

    def close(self):
        for conn in self.connections:
            try:
                conn.close()
            except pg8000.exceptions.InterfaceError as error:
                if str(error) != "connection is closed":
                    raise
        self.admin.run(f"DROP DATABASE {self.database}")
        self.admin.close()


@pytest.fixture
def legacy_worker_pg(monkeypatch):
    port = os.environ.get("AWSOPS_WORKER_TEST_PG_PORT")
    if not port:
        pytest.skip("Set AWSOPS_WORKER_TEST_PG_PORT for localhost PostgreSQL SQL contracts")

    def forbid_aws(*args, **kwargs):
        pytest.fail("Worker SQL contracts must not create live AWS clients")

    monkeypatch.setattr(db.boto3, "client", forbid_aws)
    database = WorkerDatabase(int(port))
    try:
        yield database
    finally:
        database.close()


@pytest.fixture
def worker_pg(legacy_worker_pg):
    legacy_worker_pg.migrate()
    return legacy_worker_pg


def test_lifecycle_migration_is_nullable_and_leaves_history_unknown(legacy_worker_pg):
    database = legacy_worker_pg
    old_ids = [
        database.insert(status=status, attempt=attempt)
        for status, attempt in [("queued", 0), ("running", 2), ("succeeded", 1), ("failed", 0)]
    ]
    database.migrate()
    database.migrate()
    columns = database.conn.run("""
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema=:schema AND table_name='worker_jobs'
          AND column_name IN ('started_at','finished_at')
        ORDER BY column_name
    """, schema=database.schema)
    assert columns == [
        ["finished_at", "timestamp with time zone", "YES", None],
        ["started_at", "timestamp with time zone", "YES", None],
    ]
    for job_id in old_ids + [database.insert()]:
        row = database.job(job_id)
        assert row["started_at"] is None and row["finished_at"] is None


def test_sql_reader_view_appends_only_lifecycle_columns(worker_pg):
    job_id = worker_pg.insert(
        payload=json.dumps({"private": "input"}), result=json.dumps({"private": "output"}),
        error="private error", task_token="fixture-capability", requested_by="private-owner",
    )
    db.claim_running(worker_pg.conn, job_id, "lambda")
    db.finish_job(worker_pg.conn, job_id, "succeeded", result={"private": "output"})
    authoritative = worker_pg.job(job_id)
    reader = worker_pg.connect()
    reader.run("SET ROLE awsops_sql_reader")
    reader.run("SET search_path TO sql_reader, pg_catalog")
    rows = reader.run("SELECT * FROM worker_jobs WHERE job_id=:id", id=job_id)
    columns = [column["name"] for column in reader.columns]
    assert columns == [
        "job_id", "type", "runtime", "status", "artifact_uri", "dry_run", "idempotency_key",
        "attempt", "sfn_execution_arn", "created_at", "updated_at", "started_at", "finished_at",
    ]
    row = dict(zip(columns, rows[0]))
    assert row["status"] == "succeeded"
    assert row["started_at"] == authoritative["started_at"]
    assert row["finished_at"] == authoritative["finished_at"]


@pytest.mark.parametrize("statement", [
    "SELECT * FROM public.worker_jobs",
    "SELECT started_at FROM public.worker_jobs",
    "UPDATE sql_reader.worker_jobs SET status='failed'",
    "DELETE FROM sql_reader.worker_jobs",
    "SELECT public.stamp_worker_job_lifecycle()",
])
def test_sql_reader_cannot_access_base_table_mutate_view_or_execute_trigger(worker_pg, statement):
    worker_pg.insert()
    reader = worker_pg.connect()
    reader.run("SET ROLE awsops_sql_reader")
    with pytest.raises(pg8000.exceptions.DatabaseError) as error:
        reader.run(statement)
    assert error.value.args[0]["C"] == "42501"  # insufficient_privilege, not a read-only transaction


def test_trigger_function_is_not_publicly_executable(worker_pg):
    assert worker_pg.conn.run("""
        SELECT EXISTS (
            SELECT FROM pg_proc p,
              LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
            WHERE p.oid='public.stamp_worker_job_lifecycle()'::regprocedure
              AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
        )
    """) == [[False]]


@pytest.mark.parametrize("role", ["awsops_web", "awsops_worker"])
def test_app_role_status_writes_still_fire_trigger_without_execute_grant(worker_pg, role):
    writer = worker_pg.connect()
    writer.run(f"SET ROLE {role}")
    assert writer.run(
        "SELECT has_function_privilege(current_user, 'public.stamp_worker_job_lifecycle()', 'EXECUTE')"
    ) == [[False]]
    job_id = str(uuid4())
    db.insert_job(writer, job_id, "noop", {"fixture": True}, requested_by="fixture-owner")
    assert db.claim_running(writer, job_id, "lambda") == 1
    assert db.finish_job(writer, job_id, "succeeded", result={"ok": True}) == 1
    row = worker_pg.job(job_id)
    assert row["status"] == "succeeded" and row["attempt"] == 1
    assert row["started_at"] is not None and row["finished_at"] >= row["started_at"]
    assert db.finish_job(writer, job_id, "failed", error="late") == 0
    assert worker_pg.job(job_id) == row


def test_first_claim_records_database_time_without_changing_owner(worker_pg):
    job_id = worker_pg.insert(created_at="2020-01-01T00:00:00Z")
    before = worker_pg.job(job_id)
    earliest = worker_pg.conn.run("SELECT clock_timestamp()")[0][0]
    assert db.claim_running(worker_pg.conn, job_id, "lambda") == 1
    row = worker_pg.job(job_id)
    latest = worker_pg.conn.run("SELECT clock_timestamp()")[0][0]
    assert row["status"] == "running" and row["attempt"] == 1
    assert row["started_at"] is not None
    assert earliest <= row["started_at"] <= latest
    assert row["finished_at"] is None
    for field in ("requested_by", "idempotency_key", "payload", "created_at"):
        assert row[field] == before[field]


def test_retry_keeps_first_start_and_increments_existing_attempt(worker_pg):
    job_id = worker_pg.insert(
        status="running", attempt=1, runtime="lambda", started_at="2020-01-01T00:00:00Z",
    )
    before = worker_pg.job(job_id)
    assert db.claim_running(worker_pg.conn, job_id, "lambda") == 1
    row = worker_pg.job(job_id)
    assert row["attempt"] == 2 and row["started_at"] == before["started_at"]
    assert row["finished_at"] is None
    assert row["updated_at"] != before["updated_at"]


@pytest.mark.parametrize("attempt", [0, 2])
def test_legacy_retry_does_not_fabricate_a_first_start(legacy_worker_pg, attempt):
    database = legacy_worker_pg
    job_id = database.insert(status="running", attempt=attempt)
    database.migrate()
    assert db.claim_running(database.conn, job_id, "lambda") == 1
    assert db.finish_job(database.conn, job_id, "succeeded", result={"ok": True}) == 1
    row = database.job(job_id)
    assert row["attempt"] == attempt + 1 and row["started_at"] is None
    assert row["finished_at"] is not None


@pytest.mark.parametrize("status", ["succeeded", "failed", "canceled", "manual_intervention"])
def test_terminal_write_stamps_finish_once_and_keeps_first_start(worker_pg, status):
    job_id = worker_pg.insert(status="running", attempt=1, started_at="2020-01-01T00:00:00Z")
    before = worker_pg.job(job_id)
    earliest = worker_pg.conn.run("SELECT clock_timestamp()")[0][0]
    assert db.finish_job(worker_pg.conn, job_id, status, result={"fixture": True}) == 1
    finished = worker_pg.job(job_id)
    assert finished["status"] == status and finished["started_at"] == before["started_at"]
    assert finished["finished_at"] is not None
    assert finished["finished_at"] >= earliest
    assert db.finish_job(worker_pg.conn, job_id, "failed", error="late callback") == 0
    assert db.claim_running(worker_pg.conn, job_id, "fargate") == 0
    assert db.set_manual_intervention(worker_pg.conn, job_id, "late callback") == 0
    assert worker_pg.job(job_id) == finished


@pytest.mark.parametrize("status", ["succeeded", "failed", "canceled", "manual_intervention"])
def test_legacy_terminal_jobs_stay_unknown_and_immutable(legacy_worker_pg, status):
    database = legacy_worker_pg
    job_id = database.insert(status=status, attempt=1)
    database.migrate()
    before = database.job(job_id)
    assert before["started_at"] is None and before["finished_at"] is None
    assert db.claim_running(database.conn, job_id, "lambda") == 0
    assert db.finish_job(database.conn, job_id, "succeeded", result={"new": True}) == 0
    assert db.set_manual_intervention(database.conn, job_id, "new") == 0
    assert database.job(job_id) == before


def test_failure_before_claim_has_finish_but_no_start(worker_pg):
    job_id = worker_pg.insert()
    assert db.finish_job(worker_pg.conn, job_id, "failed", error="dispatch failed") == 1
    row = worker_pg.job(job_id)
    assert row["attempt"] == 0 and row["started_at"] is None
    assert row["finished_at"] is not None


def test_success_requires_an_actual_worker_claim(worker_pg):
    job_id = worker_pg.insert()
    before = worker_pg.job(job_id)
    assert db.finish_job(worker_pg.conn, job_id, "succeeded") == 0
    assert worker_pg.job(job_id) == before


def test_manual_intervention_is_a_terminal_completion(worker_pg):
    job_id = worker_pg.insert(status="running", attempt=1, started_at="2020-01-01T00:00:00Z")
    assert db.set_manual_intervention(worker_pg.conn, job_id, "fixture failure") == 1
    row = worker_pg.job(job_id)
    assert row["status"] == "manual_intervention" and row["finished_at"] is not None
    assert db.set_manual_intervention(worker_pg.conn, job_id, "duplicate") == 0
    assert worker_pg.job(job_id) == row


def test_claim_does_not_promote_awaiting_approval(worker_pg):
    job_id = worker_pg.insert(status="awaiting_approval")
    before = worker_pg.job(job_id)
    assert db.claim_running(worker_pg.conn, job_id, "lambda") == 0
    assert worker_pg.job(job_id) == before


def test_nonexistent_job_never_updates_a_different_owner(worker_pg):
    job_id = worker_pg.insert(requested_by="another-owner")
    before = worker_pg.job(job_id)
    missing_id = str(uuid4())
    assert db.claim_running(worker_pg.conn, missing_id, "lambda") == 0
    assert db.finish_job(worker_pg.conn, missing_id, "failed") == 0
    assert worker_pg.job(job_id) == before


def test_get_job_exposes_existing_attempt_without_depending_on_timing(worker_pg):
    job_id = worker_pg.insert()
    row = db.get_job(worker_pg.conn, job_id)
    assert row["attempt"] == 0 and row["status"] == "queued"
    db.claim_running(worker_pg.conn, job_id, "lambda")
    db.finish_job(worker_pg.conn, job_id, "succeeded")
    row = db.get_job(worker_pg.conn, job_id)
    assert row["attempt"] == 1
    timed = worker_pg.job(job_id)
    assert timed["started_at"].tzinfo is not None and timed["finished_at"] >= timed["started_at"]


@pytest.mark.parametrize("operation", ["read", "claim", "finish", "manual"])
def test_workers_operate_before_timing_migration(legacy_worker_pg, operation):
    database = legacy_worker_pg
    job_id = database.insert()
    if operation == "read":
        assert db.get_job(database.conn, job_id)["status"] == "queued"
    elif operation == "claim":
        assert db.claim_running(database.conn, job_id, "lambda") == 1
    elif operation == "finish":
        assert db.finish_job(database.conn, job_id, "failed", error="fixture") == 1
    else:
        assert db.set_manual_intervention(database.conn, job_id, "fixture") == 1
    # The parent's optional-column read contract must work before the migration.
    assert database.conn.run(
        "SELECT to_jsonb(j)->>'started_at', to_jsonb(j)->>'finished_at' "
        "FROM worker_jobs j WHERE job_id=:id", id=job_id,
    ) == [[None, None]]


@pytest.mark.parametrize("status", ["queued", "running", "succeeded", "failed", "canceled", "manual_intervention"])
def test_trigger_records_only_timing_observed_at_insert(worker_pg, status):
    before = worker_pg.conn.run("SELECT clock_timestamp()")[0][0]
    job_id = worker_pg.insert(status=status)
    row = worker_pg.job(job_id)
    assert row["status"] == status and row["attempt"] == 0
    if status == "running":
        assert row["started_at"] is not None and row["started_at"] >= before
    else:
        assert row["started_at"] is None
    if status in ("succeeded", "failed", "canceled", "manual_intervention"):
        assert row["finished_at"] is not None and row["finished_at"] >= before
    else:
        assert row["finished_at"] is None


@pytest.mark.parametrize("status", ["succeeded", "failed", "canceled", "manual_intervention"])
def test_trigger_stamps_existing_status_only_writers(worker_pg, status):
    job_id = worker_pg.insert()
    worker_pg.conn.run(
        "UPDATE worker_jobs SET status='running', attempt=attempt+1 WHERE job_id=:id",
        id=job_id,
    )
    started = worker_pg.job(job_id)
    assert started["started_at"] is not None and started["finished_at"] is None
    worker_pg.conn.run("UPDATE worker_jobs SET status=:s WHERE job_id=:id", s=status, id=job_id)
    finished = worker_pg.job(job_id)
    assert finished["started_at"] == started["started_at"]
    assert finished["finished_at"] >= finished["started_at"]
    # An old or duplicate writer cannot replace the authoritative timestamps.
    worker_pg.conn.run(
        "UPDATE worker_jobs SET status=:s, started_at=clock_timestamp(), "
        "finished_at=clock_timestamp(), error='duplicate' WHERE job_id=:id",
        s=status, id=job_id,
    )
    duplicate = worker_pg.job(job_id)
    assert duplicate["started_at"] == finished["started_at"]
    assert duplicate["finished_at"] == finished["finished_at"]


def test_trigger_retry_clears_old_finish_and_preserves_first_start(worker_pg):
    job_id = worker_pg.insert()
    worker_pg.conn.run(
        "UPDATE worker_jobs SET status='running', attempt=1 WHERE job_id=:id", id=job_id,
    )
    worker_pg.conn.run("UPDATE worker_jobs SET status='failed' WHERE job_id=:id", id=job_id)
    failed = worker_pg.job(job_id)
    assert failed["started_at"] is not None and failed["finished_at"] is not None
    # Metadata only: the trigger does not initiate/authorize this explicit retry.
    worker_pg.conn.run("UPDATE worker_jobs SET status='queued' WHERE job_id=:id", id=job_id)
    retried = worker_pg.job(job_id)
    assert retried["started_at"] == failed["started_at"] and retried["finished_at"] is None
    worker_pg.conn.run(
        "UPDATE worker_jobs SET status='running', attempt=attempt+1 WHERE job_id=:id", id=job_id,
    )
    worker_pg.conn.run("UPDATE worker_jobs SET status='succeeded' WHERE job_id=:id", id=job_id)
    finished = worker_pg.job(job_id)
    assert finished["started_at"] == failed["started_at"] and finished["attempt"] == 2
    assert finished["finished_at"] > failed["finished_at"]


@pytest.mark.parametrize("status", ["queued", "running", "succeeded", "failed", "canceled", "manual_intervention"])
def test_trigger_never_backfills_legacy_metadata_or_duplicate_status_updates(legacy_worker_pg, status):
    database = legacy_worker_pg
    job_id = database.insert(status=status, attempt=2)
    database.migrate()
    for sql in (
        "UPDATE worker_jobs SET error='metadata' WHERE job_id=:id",
        "UPDATE worker_jobs SET status=status WHERE job_id=:id",
    ):
        database.conn.run(sql, id=job_id)
        row = database.job(job_id)
        assert row["started_at"] is None and row["finished_at"] is None


def test_status_and_timestamps_roll_back_together(worker_pg):
    job_id = worker_pg.insert()
    writer = worker_pg.connect()
    writer.run("BEGIN")
    db.claim_running(writer, job_id, "lambda")
    assert worker_pg.job(job_id)["status"] == "queued"
    writer.run("ROLLBACK")
    row = worker_pg.job(job_id)
    assert row["attempt"] == 0 and row["started_at"] is None
    db.claim_running(writer, job_id, "lambda")
    writer.run("BEGIN")
    db.finish_job(writer, job_id, "succeeded")
    assert worker_pg.job(job_id)["status"] == "running"
    writer.run("ROLLBACK")
    assert worker_pg.job(job_id)["finished_at"] is None


def test_timestamp_is_transition_time_not_long_transaction_start(worker_pg):
    job_id = worker_pg.insert()
    writer = worker_pg.connect()
    writer.run("BEGIN")
    writer.run("SELECT pg_sleep(0.02)")
    before_claim = worker_pg.conn.run("SELECT clock_timestamp()")[0][0]
    db.claim_running(writer, job_id, "lambda")
    writer.run("COMMIT")
    started = worker_pg.job(job_id)["started_at"]
    assert started is not None
    assert started >= before_claim
    writer.run("BEGIN")
    writer.run("SELECT pg_sleep(0.02)")
    before_finish = worker_pg.conn.run("SELECT clock_timestamp()")[0][0]
    db.finish_job(writer, job_id, "succeeded")
    writer.run("COMMIT")
    assert worker_pg.job(job_id)["finished_at"] >= before_finish


class FakeConn:
    def __init__(self, returns=None):
        self.calls = []
        self._returns = returns or []
    def run(self, sql, **params):
        self.calls.append((sql, params))
        return self._returns.pop(0) if self._returns else []


class TestInsertJob:
    """requested_by (round-2 pentest fix): defaults to NULL for internal-only enqueues, but a
    caller acting on behalf of a specific user (schedule_dispatcher.py) must be able to pass it
    through so GET /api/jobs[/id]'s ownership filter doesn't hide the row from its own owner."""

    def test_defaults_requested_by_to_none(self):
        c = FakeConn()
        db.insert_job(c, "j1", "noop", {"a": 1})
        sql, p = c.calls[0]
        assert "requested_by" in sql and p["rb"] is None

    def test_forwards_requested_by(self):
        c = FakeConn()
        db.insert_job(c, "j2", "report", {"a": 1}, requested_by="owner@x.io")
        _sql, p = c.calls[0]
        assert p["rb"] == "owner@x.io"


READY = {"signal_key": "oom_kills", "title": "OOM Kill", "status": "ready",
         "query": {"tool": "prometheus_query", "queries": [{"label": "x", "expr": "up"}]},
         "missing_metrics": None, "meta": {"pillar": "reliability", "threshold": 0}}
UNAVAIL = {"signal_key": "node_disk_usage", "title": "노드 디스크", "status": "unavailable",
           "query": None, "missing_metrics": ["node_filesystem_avail_bytes"],
           "meta": {"pillar": "reliability"}}


class TestUpsert:
    def test_upsert_binds_params_and_jsonb_casts(self):
        c = FakeConn()
        db.upsert_diag_signals(c, 42, [READY, UNAVAIL], "abc123")
        assert len(c.calls) == 2
        for sql, p in c.calls:
            assert "INSERT INTO datasource_diag_signals" in sql
            assert "::jsonb" in sql                       # query/missing_metrics/meta cast
            assert p["iid"] == 42 and p["sv"] == "abc123"
            assert p["sk"] in ("oom_kills", "node_disk_usage")
            # user/structured fields are bound, never inlined
            assert "oom_kills" not in sql and "node_disk_usage" not in sql
        # jsonb payloads are json-encoded strings
        ready_call = next(p for _, p in c.calls if p["sk"] == "oom_kills")
        assert json.loads(ready_call["q"])["tool"] == "prometheus_query"

    def test_upsert_empty_rows_records_a_version_sentinel(self):
        # NOT a no-op: with no row at all there is no schema_version, so read_signal_schema_version()
        # returns None forever and datasource_index rebuilds every run — re-invoking Bedrock daily where
        # the fallback flag is on (review MAJOR). The sentinel remembers "this schema yields nothing".
        c = FakeConn()
        written = db.upsert_diag_signals(c, 1, [], "v")
        assert written == [db.SCHEMA_VERSION_SENTINEL_KEY]
        assert len(c.calls) == 1
        params = c.calls[0][1]
        assert params["sk"] == db.SCHEMA_VERSION_SENTINEL_KEY
        assert params["sv"] == "v"          # the whole point: the version IS recorded
        assert params["st"] == "unavailable"
        assert params["q"] is None          # no query: it is bookkeeping, not a signal

    def test_upsert_returns_written_keys_so_the_sweep_keeps_the_sentinel(self):
        # Sweeping the caller's own rows would delete the sentinel in the same transaction.
        c = FakeConn()
        assert db.upsert_diag_signals(c, 1, [READY], "v") == [READY["signal_key"]]


class TestReadSchemaVersion:
    def test_returns_value_when_rows_present(self):
        c = FakeConn(returns=[[[1, "abc123"]]])
        assert db.read_signal_schema_version(c, 7) == "abc123"
        sql, p = c.calls[0]
        assert "COUNT(DISTINCT schema_version)" in sql and p["iid"] == 7

    def test_does_not_exclude_the_generated_row(self):
        # A version-blind exclusion of the generated row was tried and reverted: for a kind whose
        # deterministic catalog is ALWAYS empty (clickhouse), the generated row can be the ONLY row in the
        # table, and excluding it left zero rows to check — reading as no version forever and regenerating
        # on every single call (review, this round). Staleness after a sweep-spared read failure is instead
        # resolved by touch_generated_signal_version(), which brings the row back into agreement without
        # needing to read or preserve its content.
        c = FakeConn(returns=[[[1, "abc123"]]])
        db.read_signal_schema_version(c, 7)
        sql, _ = c.calls[0]
        assert "generated_signal" not in sql

class TestTouchGeneratedSignalVersion:
    def test_updates_only_the_version_column_for_the_fixed_key(self):
        # Exists so a sweep-spared (unverified) generated row's version can be brought back into agreement
        # with the rest of the table WITHOUT touching content we never read — the version-blind EXCLUSION
        # approach tried first broke the opposite way: excluding the generated key left a clickhouse-only
        # (deterministic catalog always empty) build with zero rows to check, reading as no version forever
        # and regenerating on every single call (review, this round).
        c = FakeConn()
        db.touch_generated_signal_version(c, 7, "newversion")
        sql, p = c.calls[0]
        assert sql.strip().startswith("UPDATE datasource_diag_signals")
        assert "signal_key='generated_signal'" in sql
        assert p == {"iid": 7, "sv": "newversion"}


class TestDiagSignalBudget:
    """The weekly-retry marker used to share a column with the content rows' schema_version. Every fix
    that protected the budget's own identity (a preserved stale marker, an excluded key) ended up tagging
    fresh CONTENT with a version that didn't describe it — so a schema that later rolled back to whatever
    that stale tag actually named made the agreement check see a false match and skip, serving newer,
    mistagged content as the old schema's real signals (review, this round). Storing the marker in a
    dedicated row's `meta` field, never in any row's `schema_version`, means content is always free to
    carry the truth; read_diag_signal_budget() reads it back independent of schema_version entirely."""

    def test_read_returns_none_when_the_row_is_absent(self):
        c = FakeConn(returns=[[]])
        assert db.read_diag_signal_budget(c, 7) is None

    def test_read_extracts_the_budget_field_from_meta(self):
        c = FakeConn(returns=[[[json.dumps({"budget": "hash:pend1w202601"})]]])
        assert db.read_diag_signal_budget(c, 7) == "hash:pend1w202601"

    def test_read_queries_the_fixed_bookkeeping_key_only(self):
        c = FakeConn(returns=[[]])
        db.read_diag_signal_budget(c, 7)
        sql, p = c.calls[0]
        assert "signal_key" in sql and p == {"iid": 7, "sk": db.BUDGET_KEY}

    def test_the_budget_key_is_not_a_real_schema_hash(self):
        # It must never collide with an actual content row's key, and must be excluded from the BFF read
        # path the same way __schema_version__ is (it is bookkeeping, not a signal).
        assert db.BUDGET_KEY != db.SCHEMA_VERSION_SENTINEL_KEY
        assert db.BUDGET_KEY.startswith("__") and db.BUDGET_KEY.endswith("__")

    def test_returns_none_when_absent(self):
        c = FakeConn(returns=[[[0, None]]])
        assert db.read_signal_schema_version(c, 7) is None

    def test_returns_none_when_versions_are_mixed(self):
        c = FakeConn(returns=[[[2, "newest"]]])
        assert db.read_signal_schema_version(c, 7) is None


class TestDiagSignalAttemptReservation:
    """Charging the weekly budget used to be read → call Bedrock → write, a read-modify-write with a
    multi-second gap in the middle: two workers racing on one integration both read the same attempts
    count, both called Bedrock, and both wrote back the same incremented value, so real usage was
    undercounted against a HARD per-week cap (review MAJOR). The charge is now a RESERVATION — one
    INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement, committed before the model call — and no
    mock-driven test can execute the SQL, so these assert the statement's SHAPE (the semantics were
    verified against a real PostgreSQL 17)."""

    def test_reserve_returns_the_new_attempt_count(self):
        c = FakeConn(returns=[[[2]]])
        assert db.reserve_diag_signal_attempt(c, 7, "202632", 3, "v1") == 2

    def test_reserve_returns_none_when_the_week_is_already_spent(self):
        c = FakeConn(returns=[[]])          # the cap guard in the WHERE clause matched no row
        assert db.reserve_diag_signal_attempt(c, 7, "202632", 3, "v1") is None

    def test_reserve_is_one_atomic_returning_statement(self):
        c = FakeConn(returns=[[[1]]])
        db.reserve_diag_signal_attempt(c, 7, "202632", 3, "v1", known_attempts=2)
        assert len(c.calls) == 1            # not read-then-write: one statement, one row lock
        sql, p = c.calls[0]
        assert "ON CONFLICT" in sql and "RETURNING" in sql
        assert "'{attempts}'" in sql and "+ 1" in sql        # incremented in SQL, never in Python
        assert p == {"iid": 7, "sk": db.BUDGET_KEY, "ti": db.BUDGET_TITLE, "st": "unavailable",
                     "wk": "202632", "sv": "v1", "cap": 3, "known": 2}

    def test_reserve_refuses_at_the_cap_inside_the_statement(self):
        c = FakeConn(returns=[[[1]]])
        db.reserve_diag_signal_attempt(c, 7, "202632", 3, "v1")
        sql, _p = c.calls[0]
        assert "< :cap" in sql              # the DB enforces the cap, not the caller's stale read
        assert "GREATEST" in sql            # …and never below what the caller already knows was spent

    def test_release_is_scoped_to_its_own_week_and_floored(self):
        c = FakeConn()
        db.release_diag_signal_attempt(c, 7, "202632")
        sql, p = c.calls[0]
        assert "GREATEST" in sql and "meta->>'week' = :wk" in sql
        assert p == {"iid": 7, "sk": db.BUDGET_KEY, "wk": "202632"}

    def test_the_marker_write_never_clobbers_the_reservation_counter(self):
        # upsert_diag_signals' `meta = EXCLUDED.meta` would replace the whole object and drop a count a
        # concurrent worker had already charged — which is why the budget row has its own writer.
        c = FakeConn()
        db.write_diag_signal_budget(c, 7, "v1:pend1w202632", "v1")
        sql, p = c.calls[0]
        assert "jsonb_set" in sql and "'{budget}'" in sql
        assert "'{attempts}'" not in sql and "'{week}'" not in sql
        assert p["bg"] == "v1:pend1w202632" and p["sv"] == "v1" and p["st"] == "unavailable"

    def test_live_marker_re_derives_the_whole_marker_at_write_time(self):
        # review MAJOR-1: the caller decides attempts AND state AND streak BEFORE the multi-second
        # Bedrock call, so everything it proposes can be stale by the time it writes. live_marker moves
        # all three into the UPDATE itself, read live from the row, never from the caller's snapshot.
        c = FakeConn()
        db.write_diag_signal_budget(c, 7, "v1:pend1w202632", "v1",
                                     live_marker=("v1", "pend", 0, "202632", 1))
        sql, p = c.calls[0]
        assert "GREATEST" in sql and "meta->>'week' = :wk" in sql
        assert p["ver"] == "v1" and p["wk"] == "202632" and p["floor"] == 1 and p["strk"] == 0
        assert p["rank"] == db._MARKER_STATE_RANK["pend"]
        # Round 3: the STATE and STREAK are re-derived too, not just the attempts digit — the marker is
        # composed in SQL from the more advanced of (proposed, live), so all three pieces are present.
        assert "'conc'" in sql and "'done'" in sql and "'pend'" in sql   # the rank→state mapping
        assert "s([0-9]+)$" in sql                                      # the live streak is parsed back
        # the marker string passed in is NOT what gets stored verbatim on this path — the live
        # expression is what's embedded, so the byte-for-byte `marker` arg is not asserted here.

    def test_the_live_marker_sql_never_looks_like_a_param_inside_a_string_literal(self):
        # pg8000's named paramstyle scans the SQL for `:name`, so a colon FOLLOWED BY AN IDENTIFIER
        # inside a string literal would be eaten as a bogus parameter. That is why the marker-parsing
        # regexes are written colon-free — no `:(pend|done|conc)`, no non-capturing `(?:s[0-9]+)` — even
        # though a bare `':'` separator (colon then a quote) is harmless and is used deliberately.
        c = FakeConn()
        db.write_diag_signal_budget(c, 7, "v1:pend1w202632", "v1",
                                     live_marker=("v1", "conc", 2, "202632", 3))
        sql, _p = c.calls[0]
        for literal in re.findall(r"'([^']*)'", sql):
            assert not re.search(r":[A-Za-z_]", literal), \
                f"{literal!r} looks like a bound parameter to pg8000 — rewrite it colon-free"

    def test_omitting_live_marker_stores_the_marker_byte_for_byte(self):
        # The one caller that must NOT re-derive: a marker preserved for a DIFFERENT schema than the
        # current live counter describes (a capped-schema identity that must not drift — see
        # datasource_index.py's byte-for-byte preservation branch).
        c = FakeConn()
        db.write_diag_signal_budget(c, 7, "otherhash:done3w202601", "v1")
        sql, p = c.calls[0]
        assert "GREATEST" not in sql
        assert p["bg"] == "otherhash:done3w202601"


class TestList:
    def test_list_returns_parsed_rows(self):
        c = FakeConn(returns=[[
            ["oom_kills", "OOM Kill", "ready",
             json.dumps({"tool": "prometheus_query", "queries": [{"label": "x", "expr": "up"}]}),
             None, json.dumps({"pillar": "reliability", "threshold": 0})],
            ["node_disk_usage", "노드 디스크", "unavailable",
             None, json.dumps(["node_filesystem_avail_bytes"]), json.dumps({"pillar": "reliability"})],
        ]])
        rows = db.list_diag_signals(c, 9)
        by = {r["signal_key"]: r for r in rows}
        assert by["oom_kills"]["status"] == "ready"
        assert by["oom_kills"]["query"]["tool"] == "prometheus_query"
        assert by["node_disk_usage"]["missing_metrics"] == ["node_filesystem_avail_bytes"]
        assert "WHERE account_id" in c.calls[0][0] and c.calls[0][1]["iid"] == 9


class TestSweep:
    def test_sweep_deletes_keys_not_kept_bound(self):
        c = FakeConn()
        db.sweep_diag_signals(c, 5, ["oom_kills", "cpu_saturation"])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_diag_signals" in sql
        assert p["iid"] == 5 and p["keep"] == ["oom_kills", "cpu_saturation"]
        assert "oom_kills" not in sql  # bound, not inlined

    def test_sweep_empty_keep_deletes_all_for_instance(self):
        c = FakeConn()
        db.sweep_diag_signals(c, 5, [])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_diag_signals" in sql and p["iid"] == 5


# ── datasource_graph_queries (pre-built topology-graph queries) ─────────────────────────────────
GQ_READY = {"query_key": "trace_spans", "status": "ready",
            "query": {"tool": "clickhouse_query", "mapper": "otel_v1", "args_template": {"sql": "SELECT 1"}},
            "missing": None, "meta": {"kind": "clickhouse", "provenance": "catalog"}}
GQ_UNAVAIL = {"query_key": "servicegraph_calls", "status": "unavailable", "query": None,
              "missing": ["istio_requests_total"], "meta": {"kind": "prometheus", "provenance": "catalog"}}


class TestUpsertGraphQueries:
    def test_upsert_binds_params_and_jsonb_casts(self):
        c = FakeConn()
        db.upsert_graph_queries(c, 42, [GQ_READY, GQ_UNAVAIL], "abc123")
        assert len(c.calls) == 2
        for sql, p in c.calls:
            assert "INSERT INTO datasource_graph_queries" in sql
            assert "::jsonb" in sql
            assert p["iid"] == 42 and p["sv"] == "abc123"
            assert p["qk"] in ("trace_spans", "servicegraph_calls")
            assert "trace_spans" not in sql and "servicegraph_calls" not in sql  # bound, not inlined
        ready_call = next(p for _, p in c.calls if p["qk"] == "trace_spans")
        assert json.loads(ready_call["q"])["mapper"] == "otel_v1"

    def test_upsert_empty_rows_is_noop(self):
        c = FakeConn()
        db.upsert_graph_queries(c, 1, [], "v")
        assert c.calls == []


class TestReadGraphSchemaVersion:
    def test_returns_value_when_rows_present(self):
        c = FakeConn(returns=[[[1, "abc123"]]])
        assert db.read_graph_schema_version(c, 7) == "abc123"
        sql, p = c.calls[0]
        assert "COUNT(DISTINCT schema_version)" in sql and "datasource_graph_queries" in sql
        assert p["iid"] == 7

    def test_returns_none_when_absent(self):
        c = FakeConn(returns=[[[0, None]]])
        assert db.read_graph_schema_version(c, 7) is None

    def test_returns_none_when_versions_are_mixed(self):
        c = FakeConn(returns=[[[2, "newest"]]])
        assert db.read_graph_schema_version(c, 7) is None


class TestSweepGraphQueries:
    def test_sweep_deletes_keys_not_kept_bound(self):
        c = FakeConn()
        db.sweep_graph_queries(c, 5, ["trace_spans"])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_graph_queries" in sql
        assert p["iid"] == 5 and p["keep"] == ["trace_spans"]

    def test_sweep_empty_keep_deletes_all_for_instance(self):
        c = FakeConn()
        db.sweep_graph_queries(c, 5, [])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_graph_queries" in sql and p["iid"] == 5


class TestUpsertDatasourceSchema:
    """Write-back of a freshly re-introspected schema (drift refresh) — python-worker side mirror
    of the BFF's upsertSchema (web/lib/datasource-schema.ts), used only by datasource_index.py."""
    def test_upsert_binds_params_and_jsonb_casts(self):
        c = FakeConn()
        db.upsert_datasource_schema(c, "self", 42, "clickhouse", {"version": "1.2", "tables": []})
        assert len(c.calls) == 1
        sql, p = c.calls[0]
        assert "INSERT INTO datasource_schemas" in sql and "::jsonb" in sql
        assert p["acct"] == "self" and p["iid"] == 42 and p["k"] == "clickhouse"
        assert json.loads(p["s"]) == {"version": "1.2", "tables": []}

    def test_oversized_metric_schema_is_stored_bounded_and_truncated(self):
        c = FakeConn()
        big = {"metrics": [f"very_long_metric_name_{'x' * 80}_{i}" for i in range(3000)], "truncated": False}
        db.upsert_datasource_schema(c, "self", 42, "prometheus", big)
        assert len(c.calls) == 1
        stored = json.loads(c.calls[0][1]["s"])
        assert len(c.calls[0][1]["s"].encode("utf-8")) <= db._MAX_SCHEMA_BYTES
        assert stored["truncated"] is True and 0 < len(stored["metrics"]) < 3000
        assert stored["metrics"][0] == big["metrics"][0]

    def test_metric_trim_keeps_probed_present_names_and_marks_trimmed(self):
        metrics = [f"very_long_metric_name_{'x' * 80}_{i}" for i in range(3000)]
        out = db._trim_schema_for_cache({"metrics": metrics, "probed": [metrics[1], metrics[1501], "absent"], "truncated": False})
        assert out["trimmed"] is True and out["truncated"] is True
        assert metrics[1] in out["metrics"] and metrics[1501] in out["metrics"]
        assert "absent" not in out["metrics"]
        assert out["probed"] == [metrics[1], metrics[1501], "absent"]
        assert len(json.dumps(out).encode("utf-8")) <= db._MAX_SCHEMA_BYTES

    def test_oversized_untrimmable_schema_still_raises(self):
        c = FakeConn()
        try:
            db.upsert_datasource_schema(c, "self", 42, "clickhouse", {"blob": "x" * 300_000})
            raise AssertionError("expected ValueError")
        except ValueError:
            pass
        assert c.calls == []


# ── datasource_dashboard_cards (pre-built dashboard cards) ───────────────────────────────────────
CARD_READY = {"card_key": "up_targets", "title": "정상 타깃 수", "viz": "stat", "unit": "",
              "status": "ready",
              "query": {"tool": "prometheus_query", "expr": "count(up == 1)", "range": None},
              "missing": []}
CARD_UNAVAIL = {"card_key": "memory_available", "title": "가용 메모리", "viz": "timeseries", "unit": "bytes",
                "status": "unavailable", "query": None, "missing": ["node_memory_MemAvailable_bytes"]}


class TestUpsertDashboardCards:
    def test_upsert_binds_params_and_jsonb_casts(self):
        c = FakeConn()
        written = db.upsert_dashboard_cards(c, 42, [CARD_READY, CARD_UNAVAIL], "abc123")
        assert written == ["up_targets", "memory_available"]
        assert len(c.calls) == 2
        for sql, p in c.calls:
            assert "INSERT INTO datasource_dashboard_cards" in sql
            assert "::jsonb" in sql
            assert p["iid"] == 42 and p["sv"] == "abc123"
            assert "up_targets" not in sql  # bound, not inlined
        ready_call = next(p for _, p in c.calls if p["ck"] == "up_targets")
        assert json.loads(ready_call["q"])["tool"] == "prometheus_query"

    def test_upsert_empty_rows_writes_version_sentinel(self):
        c = FakeConn()
        written = db.upsert_dashboard_cards(c, 1, [], "v9")
        assert written == [db.SCHEMA_VERSION_SENTINEL_KEY]
        sql, p = c.calls[0]
        assert "datasource_dashboard_cards" in sql and p["sv"] == "v9"


class TestReadCardSchemaVersion:
    def test_returns_value_when_rows_agree(self):
        c = FakeConn(returns=[[[1, "abc123"]]])
        assert db.read_card_schema_version(c, 7) == "abc123"
        sql, p = c.calls[0]
        assert "datasource_dashboard_cards" in sql and p["iid"] == 7

    def test_returns_none_when_absent_or_mixed(self):
        assert db.read_card_schema_version(FakeConn(returns=[[[0, None]]]), 7) is None
        assert db.read_card_schema_version(FakeConn(returns=[[[2, "newest"]]]), 7) is None


class TestSweepDashboardCards:
    def test_sweep_deletes_keys_not_kept_bound(self):
        c = FakeConn()
        db.sweep_dashboard_cards(c, 5, ["up_targets"])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_dashboard_cards" in sql
        assert p["iid"] == 5 and p["keep"] == ["up_targets"]
