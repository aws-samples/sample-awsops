"""B1 — fargate_worker fail-loud: a crash before/at the handler must never orphan diagnosis_reports
in 'running'. Reproduces the stale-image bug (REGISTRY has no 'report' → KeyError) and asserts the
job AND the report are marked failed, and the connection is always released."""
import sys

import pytest

import db
import handlers
import fargate_worker as fw
from diagnosis import db as ddb
from test_db import legacy_worker_pg, worker_pg


class FakeConn:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


def _setup(monkeypatch, job, *, claim=1):
    conn = FakeConn()
    finishes, reports = [], []
    monkeypatch.setattr(db, "connect", lambda: conn)
    monkeypatch.setattr(db, "claim_running", lambda c, j, runtime: claim)
    monkeypatch.setattr(db, "get_job", lambda c, j: job)
    monkeypatch.setattr(db, "finish_job", lambda c, j, s, **kw: finishes.append((s, kw)) or 1)
    monkeypatch.setattr(ddb, "finish_report",
                        lambda c, rid, status, **kw: reports.append((rid, status)) or 1)
    monkeypatch.setattr(sys, "argv", ["fargate_worker.py", "--job-id", "J1"])
    return conn, finishes, reports


def test_unknown_job_type_marks_job_and_report_failed(monkeypatch):
    # Stale image: REGISTRY lacks 'report' (the live KeyError: 'report' bug).
    monkeypatch.setattr(handlers, "REGISTRY", {"noop": (lambda p, d: ({}, None), "lambda")})
    conn, finishes, reports = _setup(
        monkeypatch, {"type": "report", "payload": {"report_id": 7}, "dry_run": False})
    with pytest.raises(SystemExit):
        fw.main()
    assert any(s == "failed" for s, _ in finishes)         # worker_jobs failed
    assert reports == [(7, "failed")]                       # diagnosis_reports failed (not orphaned)
    assert conn.closed


def test_handler_exception_marks_job_and_report_failed(monkeypatch):
    def boom(payload, dry_run):
        raise RuntimeError("kaboom")
    monkeypatch.setattr(handlers, "REGISTRY", {"report": (boom, "fargate")})
    conn, finishes, reports = _setup(
        monkeypatch, {"type": "report", "payload": {"report_id": 9}, "dry_run": False})
    with pytest.raises(RuntimeError):
        fw.main()
    assert any(s == "failed" for s, _ in finishes)
    assert reports == [(9, "failed")]
    assert conn.closed


def test_success_path_unchanged(monkeypatch):
    monkeypatch.setattr(handlers, "REGISTRY", {"report": (lambda p, d: ({"ok": True}, None), "fargate")})
    conn, finishes, reports = _setup(
        monkeypatch, {"type": "report", "payload": {"report_id": 3}, "dry_run": False})
    fw.main()
    assert finishes[-1][0] == "succeeded"
    assert reports == []          # success path does not touch finish_report from the worker shell
    assert conn.closed


def test_already_claimed_is_noop(monkeypatch):
    conn, finishes, reports = _setup(
        monkeypatch, {"type": "report", "payload": {"report_id": 1}, "dry_run": False}, claim=0)
    fw.main()
    assert finishes == [] and reports == [] and conn.closed


@pytest.mark.parametrize("outcome", ["success", "exception", "unknown_type"])
def test_fargate_terminal_paths_record_real_lifecycle(worker_pg, monkeypatch, outcome):
    job_id = worker_pg.insert(type="noop" if outcome != "unknown_type" else "unknown")
    monkeypatch.setattr(db, "connect", worker_pg.connect)
    monkeypatch.setattr(sys, "argv", ["fargate_worker.py", "--job-id", job_id])

    def handler(payload, dry_run):
        running = worker_pg.job(job_id)
        assert running["status"] == "running" and running["started_at"] is not None
        assert running["finished_at"] is None and running["attempt"] == 1
        if outcome == "exception":
            raise RuntimeError("fixture crash")
        return {"ok": True}, None

    monkeypatch.setattr(handlers, "REGISTRY", {"noop": (handler, "fargate")})
    if outcome == "unknown_type":
        with pytest.raises(SystemExit, match="unknown job type"):
            fw.main()
    elif outcome == "exception":
        with pytest.raises(RuntimeError, match="fixture crash"):
            fw.main()
    else:
        fw.main()
    finished = worker_pg.job(job_id)
    assert finished["status"] == ("succeeded" if outcome == "success" else "failed")
    assert finished["runtime"] == "fargate" and finished["attempt"] == 1
    assert finished["started_at"] is not None
    assert finished["finished_at"] >= finished["started_at"]
    fw.main()
    assert worker_pg.job(job_id) == finished


def test_fargate_completes_before_timing_migration(legacy_worker_pg, monkeypatch):
    database = legacy_worker_pg
    job_id = database.insert()
    monkeypatch.setattr(db, "connect", database.connect)
    monkeypatch.setattr(sys, "argv", ["fargate_worker.py", "--job-id", job_id])
    monkeypatch.setattr(handlers, "REGISTRY", {"noop": (lambda p, d: ({"ok": True}, None), "fargate")})
    fw.main()
    row = database.job(job_id)
    assert row["status"] == "succeeded" and row["attempt"] == 1 and row["result"] == {"ok": True}


def test_fargate_late_result_cannot_replace_a_terminal_failure(worker_pg, monkeypatch):
    job_id = worker_pg.insert()
    monkeypatch.setattr(db, "connect", worker_pg.connect)
    monkeypatch.setattr(sys, "argv", ["fargate_worker.py", "--job-id", job_id])
    authoritative = []

    def handler(payload, dry_run):
        db.finish_job(worker_pg.conn, job_id, "failed", error="fixture reaper")
        authoritative.append(worker_pg.job(job_id))
        return {"late": "success"}, None

    monkeypatch.setattr(handlers, "REGISTRY", {"noop": (handler, "fargate")})
    fw.main()
    assert worker_pg.job(job_id) == authoritative[0]
