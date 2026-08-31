"""Tests for finops_dispatcher — daily EventBridge -> enqueue ONE finops_baseline job, guarded
against double-fire within the same UTC day."""
import json

from pg8000.exceptions import DatabaseError

import finops_dispatcher as fd


class FakeConn:
    def __init__(self, already_enqueued=False):
        self.already_enqueued = already_enqueued
        self.deleted = []
        self.closed = False

    def run(self, sql, **kw):
        if sql.strip().startswith("SELECT 1 FROM worker_jobs"):
            return [(1,)] if self.already_enqueued else []
        if sql.strip().startswith("DELETE FROM worker_jobs"):
            self.deleted.append(kw.get("id"))
        return []

    def close(self):
        self.closed = True


class FakeSqs:
    def __init__(self, fail=False):
        self.sent = []
        self.fail = fail

    def send_message(self, QueueUrl, MessageBody):  # noqa: N803
        if self.fail:
            raise RuntimeError("sqs down")
        self.sent.append(json.loads(MessageBody))


def _wire(monkeypatch, already_enqueued=False, sqs_fail=False):
    conn = FakeConn(already_enqueued)
    inserted = []
    monkeypatch.setattr(fd, "QUEUE_URL", "https://sqs.example/jobs")
    monkeypatch.setattr(fd.db, "connect", lambda: conn)
    monkeypatch.setattr(fd.db, "insert_job", lambda c, jid, t, p, **k: inserted.append((jid, t, p, k)))
    monkeypatch.setattr(fd, "_sqs", FakeSqs(sqs_fail))
    return conn, inserted


def test_enqueues_one_job_when_not_already_run_today(monkeypatch):
    conn, inserted = _wire(monkeypatch)
    out = fd.lambda_handler({}, None)
    assert out["enqueued"] is True
    assert len(inserted) == 1
    jid, t, payload, kw = inserted[0]
    assert t == "finops_baseline"
    assert payload == {}
    assert kw["idempotency_key"].startswith("finops_baseline:")
    assert fd._sqs.sent and fd._sqs.sent[0]["type"] == "finops_baseline"
    assert conn.closed


def test_skips_when_already_enqueued_today(monkeypatch):
    conn, inserted = _wire(monkeypatch, already_enqueued=True)
    out = fd.lambda_handler({}, None)
    assert out == {"enqueued": False, "reason": "already_enqueued_today"}
    assert inserted == []
    assert fd._sqs.sent == []


def test_sqs_failure_deletes_the_orphan_ledger_row_and_raises(monkeypatch):
    conn, inserted = _wire(monkeypatch, sqs_fail=True)
    try:
        fd.lambda_handler({}, None)
        assert False, "expected RuntimeError"
    except RuntimeError:
        pass
    assert len(inserted) == 1
    assert conn.deleted == [inserted[0][0]]


def test_requires_queue_url(monkeypatch):
    monkeypatch.setattr(fd, "QUEUE_URL", "")
    try:
        fd.lambda_handler({}, None)
        assert False, "expected RuntimeError"
    except RuntimeError:
        pass


def test_loses_the_enqueue_race_to_a_concurrent_invocation(monkeypatch):
    # Both dispatchers pass the pre-check (SELECT sees 0 rows for both), then the second INSERT
    # hits uq_worker_jobs_idem_internal — pg8000 raises DatabaseError with SQLSTATE 23505. Must be
    # treated the same as "already enqueued today", not propagate as an unhandled error.
    conn, inserted = _wire(monkeypatch)
    monkeypatch.setattr(fd.db, "insert_job",
                         lambda c, jid, t, p, **k: (_ for _ in ()).throw(DatabaseError({"C": "23505"})))
    out = fd.lambda_handler({}, None)
    assert out == {"enqueued": False, "reason": "already_enqueued_today"}
    assert fd._sqs.sent == []
    assert conn.closed


def test_reraises_a_non_unique_violation_database_error(monkeypatch):
    conn, inserted = _wire(monkeypatch)
    monkeypatch.setattr(fd.db, "insert_job",
                         lambda c, jid, t, p, **k: (_ for _ in ()).throw(DatabaseError({"C": "40001"})))
    try:
        fd.lambda_handler({}, None)
        assert False, "expected DatabaseError"
    except DatabaseError:
        pass
    assert fd._sqs.sent == []
