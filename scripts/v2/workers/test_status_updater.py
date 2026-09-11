"""SFN Catch terminal writes against real PostgreSQL, with no AWS invocation."""
import pytest

from test_db import legacy_worker_pg, worker_pg
import db
import status_updater


def test_catch_completes_before_timing_migration(legacy_worker_pg, monkeypatch):
    database = legacy_worker_pg
    job_id = database.insert()
    monkeypatch.setattr(db, "connect", database.connect)
    assert status_updater.lambda_handler({"job_id": job_id, "error": "fixture"}, None)["updated"] == 1
    assert database.job(job_id)["status"] == "failed"


@pytest.mark.parametrize("claimed", [False, True])
def test_catch_records_failure_once_with_only_observed_timestamps(worker_pg, monkeypatch, claimed):
    job_id = worker_pg.insert()
    if claimed:
        db.claim_running(worker_pg.conn, job_id, "lambda")
    start = worker_pg.job(job_id)["started_at"]
    monkeypatch.setattr(db, "connect", worker_pg.connect)
    event = {"job_id": job_id, "error": {"Cause": "fixture timeout"}}
    assert status_updater.lambda_handler(event, None)["updated"] == 1
    failed = worker_pg.job(job_id)
    assert failed["status"] == "failed" and failed["finished_at"] is not None
    assert failed["started_at"] == start and failed["attempt"] == int(claimed)
    assert status_updater.lambda_handler(event, None)["updated"] == 0
    assert worker_pg.job(job_id) == failed


@pytest.mark.parametrize("manual", [False, True])
def test_late_catch_cannot_replace_success_or_finish_time(worker_pg, monkeypatch, manual):
    job_id = worker_pg.insert()
    db.claim_running(worker_pg.conn, job_id, "lambda")
    db.finish_job(worker_pg.conn, job_id, "succeeded", result={"ok": True})
    before = worker_pg.job(job_id)
    monkeypatch.setattr(db, "connect", worker_pg.connect)
    out = status_updater.lambda_handler({
        "job_id": job_id, "error": "late Catch", "manual_intervention": manual,
    }, None)
    assert out["updated"] == 0 and worker_pg.job(job_id) == before


def test_manual_intervention_catch_is_terminal_and_timestamped(worker_pg, monkeypatch):
    job_id = worker_pg.insert()
    db.claim_running(worker_pg.conn, job_id, "lambda")
    start = worker_pg.job(job_id)["started_at"]
    monkeypatch.setattr(db, "connect", worker_pg.connect)
    event = {"job_id": job_id, "manual_intervention": True}
    assert status_updater.lambda_handler(event, None)["updated"] == 1
    before = worker_pg.job(job_id)
    assert before["status"] == "manual_intervention"
    assert before["started_at"] == start and before["finished_at"] is not None
    assert status_updater.lambda_handler(event, None)["updated"] == 0
    assert worker_pg.job(job_id) == before
