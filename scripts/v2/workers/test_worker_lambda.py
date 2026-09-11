"""Lambda lifecycle tests: real PostgreSQL transitions; handler work stays local."""
import pytest

from test_db import legacy_worker_pg, worker_pg
import db
import handlers
import worker_lambda


def test_lambda_completes_before_timing_migration(legacy_worker_pg, monkeypatch):
    database = legacy_worker_pg
    job_id = database.insert()
    monkeypatch.setattr(db, "connect", database.connect)
    monkeypatch.setattr(handlers, "REGISTRY", {"noop": (lambda p, d: ({"ok": True}, None), "lambda")})
    assert worker_lambda.lambda_handler({"job_id": job_id, "type": "noop"}, None) == {
        "job_id": job_id, "status": "succeeded",
    }
    row = database.job(job_id)
    assert row["status"] == "succeeded" and row["attempt"] == 1 and row["result"] == {"ok": True}


def test_retry_preserves_first_start_until_final_completion(worker_pg, monkeypatch):
    job_id = worker_pg.insert()
    monkeypatch.setattr(db, "connect", worker_pg.connect)
    attempts = []

    def handler(payload, dry_run):
        attempts.append(worker_pg.job(job_id))
        if len(attempts) == 1:
            raise RuntimeError("fixture retry")
        return {"ok": True}, None

    monkeypatch.setattr(handlers, "REGISTRY", {"noop": (handler, "lambda")})
    event = {"job_id": job_id, "type": "noop", "payload": {}}
    with pytest.raises(RuntimeError, match="fixture retry"):
        worker_lambda.lambda_handler(event, None)
    first = worker_pg.job(job_id)
    assert first["status"] == "running" and first["attempt"] == 1
    assert first["started_at"] is not None and first["finished_at"] is None
    out = worker_lambda.lambda_handler(event, None)
    completed = worker_pg.job(job_id)
    assert out == {"job_id": job_id, "status": "succeeded"}
    assert completed["started_at"] == first["started_at"] and completed["attempt"] == 2
    assert completed["finished_at"] >= completed["started_at"]
    assert completed["result"] == {"ok": True}
    assert worker_lambda.lambda_handler(event, None)["status"] == "skipped"
    assert worker_pg.job(job_id) == completed and len(attempts) == 2


def test_success_response_requires_winning_the_terminal_write(worker_pg, monkeypatch):
    job_id = worker_pg.insert()
    monkeypatch.setattr(db, "connect", worker_pg.connect)
    authoritative = []

    def handler(payload, dry_run):
        # A Catch/reaper terminal transition wins while the worker is still executing.
        assert db.finish_job(worker_pg.conn, job_id, "failed", error="fixture timeout") == 1
        authoritative.append(worker_pg.job(job_id))
        return {"late": "success"}, None

    monkeypatch.setattr(handlers, "REGISTRY", {"noop": (handler, "lambda")})
    result = worker_lambda.lambda_handler({"job_id": job_id, "type": "noop"}, None)
    assert result == {"job_id": job_id, "status": "skipped"}
    assert worker_pg.job(job_id) == authoritative[0]


@pytest.mark.parametrize("status", ["succeeded", "failed", "canceled", "manual_intervention"])
def test_terminal_delivery_never_runs_handler_or_invents_timing(worker_pg, monkeypatch, status):
    job_id = worker_pg.insert(status=status, attempt=1)
    before = worker_pg.job(job_id)
    monkeypatch.setattr(db, "connect", worker_pg.connect)

    def handler(*args):
        pytest.fail("Terminal jobs must not run again")

    monkeypatch.setattr(handlers, "REGISTRY", {"noop": (handler, "lambda")})
    assert worker_lambda.lambda_handler({"job_id": job_id, "type": "noop"}, None)["status"] == "skipped"
    assert worker_pg.job(job_id) == before
