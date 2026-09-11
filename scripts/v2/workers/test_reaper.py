"""B2 — the reaper must also reconcile diagnosis_reports (not just worker_jobs): a report whose
worker job failed, or that has gone stale (no progress heartbeat), is marked 'failed' so the UI
never shows an eternal 'running'. V1 had a 30-min stale guard; this is its V2 edition."""


from types import SimpleNamespace

import boto3
import pytest

from test_db import legacy_worker_pg, worker_pg


@pytest.fixture(autouse=True)
def offline_reaper(monkeypatch):
    def forbid_aws(**kwargs):
        pytest.fail("Reaper tests must not call AWS")

    client = SimpleNamespace(get_event_source_mapping=forbid_aws)
    monkeypatch.setattr(boto3, "client", lambda *args, **kwargs: client)
    import reaper
    monkeypatch.setattr(reaper, "_lam", client)
    monkeypatch.setattr(reaper, "_ESM_UUID", "")


@pytest.fixture
def reaper_pg(legacy_worker_pg, monkeypatch, request):
    import reaper
    database = legacy_worker_pg
    if getattr(request, "param", True):
        database.migrate()
    # Empty domain ledgers let the entire real reaper execute without stubbing SQL.
    database.conn.run("""
        CREATE TABLE diagnosis_reports (
            id integer, worker_job_id uuid, status text, updated_at timestamptz, error text);
        CREATE TABLE finops_runs (
            id integer, status text, started_at timestamptz, finished_at timestamptz, error text);
        CREATE TABLE sg_rule_scan_runs (
            id integer, status text, started_at timestamptz, error_code text);
        CREATE TABLE network_path_runs (
            id integer, status text, created_at timestamptz, finished_at timestamptz, overall_status text);
    """)
    monkeypatch.setattr(reaper.db, "connect", database.connect)
    return database


@pytest.mark.parametrize("reaper_pg", [False], indirect=True)
def test_reaper_completes_before_timing_migration(reaper_pg):
    import reaper
    running = reaper_pg.insert(status="running", attempt=1, updated_at="2020-01-02T00:00:00Z")
    queued = reaper_pg.insert(updated_at="2020-01-02T00:00:00Z")
    result = reaper.lambda_handler(None, None)
    assert result["reaped_running"] == 1 and result["reaped_queued"] == 1
    assert reaper_pg.job(running)["status"] == "failed"
    assert reaper_pg.job(queued)["status"] == "failed"


@pytest.mark.parametrize("dispatch_enabled", [False, True])
def test_reaper_finishes_only_stale_jobs_and_preserves_first_start(reaper_pg, monkeypatch, dispatch_enabled):
    import reaper
    database = reaper_pg
    running = database.insert(
        status="running", attempt=2, started_at="2020-01-01T00:00:00Z",
        updated_at="2020-01-02T00:00:00Z",
    )
    queued = database.insert(updated_at="2020-01-02T00:00:00Z")
    fresh = database.insert(status="running", attempt=1)
    terminal = database.insert(status="succeeded", attempt=1, updated_at="2020-01-02T00:00:00Z")
    manual = database.insert(status="manual_intervention", attempt=1, updated_at="2020-01-02T00:00:00Z")
    before = {job_id: database.job(job_id) for job_id in (running, queued, fresh, terminal, manual)}
    monkeypatch.setattr(reaper, "_dispatch_enabled", lambda: dispatch_enabled)

    out = reaper.lambda_handler(None, None)
    assert out["reaped_running"] == 1
    failed = database.job(running)
    assert failed["status"] == "failed" and failed["finished_at"] is not None
    assert failed["started_at"] == before[running]["started_at"] and failed["attempt"] == 2
    queued_row = database.job(queued)
    if dispatch_enabled:
        assert out["reaped_queued"] == 1
        assert queued_row["status"] == "failed" and queued_row["finished_at"] is not None
        assert queued_row["started_at"] is None and queued_row["attempt"] == 0
    else:
        assert out["reaped_queued"] == "skipped (dispatch ESM disabled)"
        assert queued_row == before[queued]
    for job_id in (fresh, terminal, manual):
        assert database.job(job_id) == before[job_id]
    again = reaper.lambda_handler(None, None)
    assert again["reaped_running"] == 0
    assert database.job(running) == failed and database.job(queued) == queued_row


class FakeConn:
    def __init__(self, report_rows=None, finops_run_rows=None):
        self.calls = []
        self.report_rows = report_rows or []
        self.finops_run_rows = finops_run_rows or []

    def run(self, sql, **kw):
        self.calls.append((sql, kw))
        if "diagnosis_reports" in sql:
            return self.report_rows
        if "finops_runs" in sql:
            return self.finops_run_rows
        return []  # worker_jobs / remediation reaps: nothing stale

    def close(self):
        pass


def _diag_call(conn):
    return next(c for c in conn.calls if "diagnosis_reports" in c[0])


def _finops_run_call(conn):
    return next(c for c in conn.calls if "finops_runs" in c[0])


def test_reaper_reconciles_failed_and_stale_diagnosis_reports(monkeypatch):
    import reaper
    conn = FakeConn(report_rows=[[7], [9]])
    monkeypatch.setattr(reaper.db, "connect", lambda: conn)

    out = reaper.lambda_handler(None, None)

    assert out["reaped_reports"] == 2
    sql, kw = _diag_call(conn)
    assert "UPDATE diagnosis_reports" in sql
    assert "status='failed'" in sql and "status='running'" in sql   # only fail running rows
    assert "worker_job_id IN" in sql                                # linked-job-failed branch
    assert "make_interval" in sql                                   # C12: no string concat
    assert kw["m"] == reaper.R                                      # RUNNING_STALE_MIN threshold


def test_reaper_reports_zero_when_none_stale(monkeypatch):
    import reaper
    conn = FakeConn(report_rows=[])
    monkeypatch.setattr(reaper.db, "connect", lambda: conn)
    out = reaper.lambda_handler(None, None)
    assert out["reaped_reports"] == 0


def test_reaper_reconciles_stale_running_finops_runs(monkeypatch):
    # ADR-020: engine.run() writes finops_runs 'running' BEFORE evaluating anything, and only
    # reaches its own terminal-status write via a Python return/except — a hard kill (Fargate OOM)
    # leaves the row 'running' forever, since nothing else reconciles finops_runs (a review round
    # caught this: the reaper only touched worker_jobs).
    import reaper
    conn = FakeConn(finops_run_rows=[[3]])
    monkeypatch.setattr(reaper.db, "connect", lambda: conn)

    out = reaper.lambda_handler(None, None)

    assert out["reaped_finops_runs"] == 1
    sql, kw = _finops_run_call(conn)
    assert "UPDATE finops_runs" in sql
    assert "status='failed'" in sql and "status='running'" in sql
    assert "finished_at=now()" in sql
    assert "make_interval" in sql
    assert kw["m"] == reaper.R


class FakeConnWithNetworkPathRows:
    """Network Path Check reaper coverage (design spec "Error handling": "Stale run -> a dedicated
    reaper query added to scripts/v2/workers/reaper.py reconciles network_path_runs the same way it
    already does for worker_jobs/diagnosis_reports")."""

    def __init__(self, running_rows, queued_rows):
        self.calls = []
        self.running_rows = running_rows
        self.queued_rows = queued_rows

    def run(self, sql, **kw):
        self.calls.append((sql, kw))
        if "network_path_runs" in sql and "status='running'" in sql:
            return self.running_rows
        if "network_path_runs" in sql and "status='queued'" in sql:
            return self.queued_rows
        return []

    def close(self):
        pass


def test_reaper_reaps_stale_network_path_runs(monkeypatch):
    import reaper
    conn = FakeConnWithNetworkPathRows(running_rows=[["r1"], ["r2"]], queued_rows=[["r3"]])
    monkeypatch.setattr(reaper.db, "connect", lambda: conn)

    out = reaper.lambda_handler(None, None)

    assert out["reaped_network_path_runs_running"] == 2
    assert out["reaped_network_path_runs_queued"] == 1
    run_calls = [c for c in conn.calls if "network_path_runs" in c[0]]
    assert any("overall_status='failed'" in c[0] for c in run_calls)
    assert any("finished_at=now()" in c[0] for c in run_calls)
    assert any("make_interval" in c[0] for c in run_calls)


def test_reaper_skips_network_path_queued_reap_when_dispatch_disabled(monkeypatch):
    import reaper
    conn = FakeConnWithNetworkPathRows(running_rows=[], queued_rows=[["r4"]])
    monkeypatch.setattr(reaper.db, "connect", lambda: conn)
    monkeypatch.setattr(reaper, "_dispatch_enabled", lambda: False)

    out = reaper.lambda_handler(None, None)

    assert out["reaped_network_path_runs_queued"] == "skipped (dispatch ESM disabled)"
