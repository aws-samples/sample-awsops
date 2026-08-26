"""Tests for insight_dispatcher — daily EventBridge → enqueue a single `insight` job."""
import json

import insight_dispatcher as idi


class FakeConn:
    def __init__(self, recent=False):
        self.sql_log = []
        self.closed = False
        self.recent = recent
    def run(self, sql, **_kw):
        self.sql_log.append(sql)
        if "SELECT 1 FROM worker_jobs" in sql:
            return [[1]] if self.recent else []
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


def _wire(monkeypatch, fail=False, recent=False):
    conn = FakeConn(recent=recent)
    inserted = []
    monkeypatch.setattr(idi, "QUEUE_URL", "https://sqs.example/jobs")
    monkeypatch.setattr(idi.db, "connect", lambda: conn)
    monkeypatch.setattr(idi.db, "insert_job", lambda c, jid, t, p, **k: inserted.append((t, p, jid)))
    monkeypatch.setattr(idi, "_sqs", FakeSqs(fail))
    return conn, inserted


def test_enqueues_single_insight_job(monkeypatch):
    conn, inserted = _wire(monkeypatch)
    out = idi.lambda_handler({}, None)
    assert out == {"enqueued": 1}
    assert len(inserted) == 1 and inserted[0][0] == "insight"
    assert idi._sqs.sent and idi._sqs.sent[0]["type"] == "insight"
    assert conn.closed


def test_dedup_skips_when_recent_insight_job_exists(monkeypatch):
    conn, inserted = _wire(monkeypatch, recent=True)
    out = idi.lambda_handler({}, None)
    assert out == {"enqueued": 0, "deduped": True}
    assert inserted == [] and idi._sqs.sent == []   # no duplicate Bedrock job


def test_missing_queue_url_fails_loud(monkeypatch):
    _wire(monkeypatch)
    monkeypatch.setattr(idi, "QUEUE_URL", "")
    try:
        idi.lambda_handler({}, None)
        assert False, "should raise"
    except RuntimeError:
        pass


def test_sqs_failure_cleans_orphan_row_and_reraises(monkeypatch):
    conn, inserted = _wire(monkeypatch, fail=True)
    # M4: cleanup the orphan 'queued' row, then RE-RAISE so EventBridge retries (no silent loss)
    import pytest
    with pytest.raises(Exception):
        idi.lambda_handler({}, None)
    assert any("DELETE FROM worker_jobs" in s for s in conn.sql_log)  # orphan ledger row cleaned
