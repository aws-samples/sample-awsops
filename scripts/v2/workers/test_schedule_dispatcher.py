import json

import pytest

import schedule_dispatcher as sd


class FakeConn:
    def __init__(self, due_rows):
        self.due_rows = due_rows
        self.closed = False
        self.sql_log = []
        self._rid = 0

    def run(self, sql, **_kw):
        self.sql_log.append(sql)
        if sql.startswith("UPDATE report_schedules"):
            return self.due_rows
        if sql.startswith("INSERT INTO diagnosis_reports"):
            self._rid += 1
            return [[self._rid]]  # RETURNING id
        return []  # link UPDATE / failure UPDATE

    def close(self):
        self.closed = True


class FakeSqs:
    def __init__(self, fail_for=None):
        self.sent = []
        self.fail_for = set(fail_for or [])

    def send_message(self, QueueUrl, MessageBody):  # noqa: N803 — boto3 kwarg names
        body = json.loads(MessageBody)
        if body["payload"]["requested_by"] in self.fail_for:
            raise RuntimeError("sqs unavailable")
        self.sent.append(body)


def _wire(monkeypatch, due_rows, fail_for=None):
    conn = FakeConn(due_rows)
    inserted = []
    monkeypatch.setattr(sd, "QUEUE_URL", "https://sqs.example/jobs")
    monkeypatch.setattr(sd.db, "connect", lambda: conn)
    monkeypatch.setattr(sd.db, "insert_job", lambda c, jid, t, p, **k: inserted.append((jid, t, p)))
    sqs = FakeSqs(fail_for)
    monkeypatch.setattr(sd, "_sqs", sqs)
    return conn, inserted, sqs


def test_enqueues_a_linked_report_per_due_schedule(monkeypatch):
    rows = [("u1", "weekly", {"tier": "deep", "model": "opus"}), ("u2", "monthly", {"tier": "mid"})]
    conn, inserted, sqs = _wire(monkeypatch, rows)
    out = sd.lambda_handler({}, None)
    assert out == {"due": 2, "enqueued": 2, "failed": 0}
    # each run pre-creates a visible diagnosis_reports row, then a worker_jobs row carrying its report_id
    assert sum(s.startswith("INSERT INTO diagnosis_reports") for s in conn.sql_log) == 2
    assert [t for _, t, _ in inserted] == ["report", "report"]
    assert inserted[0][2]["tier"] == "deep" and inserted[0][2]["requested_by"] == "u1"
    assert inserted[0][2]["model"] == "opus" and inserted[1][2]["model"] == "sonnet"  # deep+opus→opus, mid→sonnet
    assert inserted[0][2]["report_id"] == 1 and inserted[0][2]["scheduled"] is True
    # the report is linked to the job (UPDATE ... SET worker_job_id ...)
    assert any("UPDATE diagnosis_reports SET worker_job_id" in s for s in conn.sql_log)
    assert len(sqs.sent) == 2 and sqs.sent[0]["type"] == "report"
    assert conn.closed is True


def test_no_due_rows_enqueues_nothing(monkeypatch):
    _conn, inserted, sqs = _wire(monkeypatch, [])
    assert sd.lambda_handler({}, None) == {"due": 0, "enqueued": 0, "failed": 0}
    assert inserted == [] and sqs.sent == []


def test_claim_sql_is_advance_first_enabled_only_returning():
    sql = sd._CLAIM_SQL
    assert "UPDATE report_schedules" in sql
    assert "enabled = true" in sql
    assert "next_run_at <= now()" in sql
    assert "RETURNING" in sql  # claim+advance in one statement → concurrent run claims 0 (no double-fire)


def test_string_config_is_tolerated(monkeypatch):
    # pg8000 may hand back JSONB as a string — must not throw after the claim advanced next_run_at.
    rows = [("u1", "weekly", '{"tier": "deep", "model": "opus"}')]
    _conn, inserted, sqs = _wire(monkeypatch, rows)
    out = sd.lambda_handler({}, None)
    assert out == {"due": 1, "enqueued": 1, "failed": 0}
    assert inserted[0][2]["tier"] == "deep"


def test_per_row_failure_marks_report_failed_and_continues(monkeypatch):
    rows = [("bad", "weekly", {}), ("good", "weekly", {})]
    conn, _inserted, sqs = _wire(monkeypatch, rows, fail_for={"bad"})
    out = sd.lambda_handler({}, None)
    assert out["due"] == 2 and out["enqueued"] == 1 and out["failed"] == 1
    assert len(sqs.sent) == 1 and sqs.sent[0]["payload"]["requested_by"] == "good"
    # the failed enqueue marks its report failed (never stuck 'running')
    assert any("status = 'failed'" in s for s in conn.sql_log)


def test_missing_queue_url_raises(monkeypatch):
    _wire(monkeypatch, [])
    monkeypatch.setattr(sd, "QUEUE_URL", "")  # simulate the env var unset
    with pytest.raises(RuntimeError):
        sd.lambda_handler({}, None)
