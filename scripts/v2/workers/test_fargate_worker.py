"""B1 — fargate_worker fail-loud: a crash before/at the handler must never orphan diagnosis_reports
in 'running'. Reproduces the stale-image bug (REGISTRY has no 'report' → KeyError) and asserts the
job AND the report are marked failed, and the connection is always released."""
import sys

import pytest

import db
import handlers
import fargate_worker as fw
from diagnosis import db as ddb


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
