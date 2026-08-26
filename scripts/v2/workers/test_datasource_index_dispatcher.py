"""Tests for datasource_index_dispatcher — daily EventBridge → enqueue a datasource_index job per
enabled datasource instance, across all 5 connector kinds (mirrors schedule_dispatcher's
claim/enqueue/isolation shape). Widened from prometheus/mimir-only (diag signals) so every kind gets
its pre-built graph-query catalog refreshed — see graph_catalog.py."""
import json

import datasource_index_dispatcher as did


class FakeConn:
    def __init__(self, rows):
        self.rows = rows
        self.sql_log = []
        self.closed = False
    def run(self, sql, **_kw):
        self.sql_log.append(sql)
        if sql.strip().startswith("SELECT") and "FROM integrations" in sql:
            return self.rows
        return []
    def close(self):
        self.closed = True


class FakeSqs:
    def __init__(self, fail_for=None):
        self.sent = []
        self.fail_for = set(fail_for or [])
    def send_message(self, QueueUrl, MessageBody):  # noqa: N803
        body = json.loads(MessageBody)
        if body["payload"]["integration_id"] in self.fail_for:
            raise RuntimeError("sqs down")
        self.sent.append(body)


def _wire(monkeypatch, rows, fail_for=None):
    conn = FakeConn(rows)
    inserted = []
    monkeypatch.setattr(did, "QUEUE_URL", "https://sqs.example/jobs")
    monkeypatch.setattr(did.db, "connect", lambda: conn)
    monkeypatch.setattr(did.db, "insert_job", lambda c, jid, t, p, **k: inserted.append((t, p)))
    monkeypatch.setattr(did, "_sqs", FakeSqs(fail_for))
    return conn, inserted


def test_enqueues_index_job_per_datasource_instance_across_all_five_kinds(monkeypatch):
    conn, inserted = _wire(monkeypatch, [
        (5, "prod-prom", "prometheus"), (8, "mimir-ro", "mimir"), (9, "ch", "clickhouse"),
        (10, "tmp", "tempo"), (11, "lk", "loki"),
    ])
    out = did.lambda_handler({}, None)
    assert out == {"instances": 5, "enqueued": 5, "failed": 0}
    assert all(t == "datasource_index" for t, _ in inserted)
    assert {p["integration_id"] for _, p in inserted} == {5, 8, 9, 10, 11}
    # kind travels in the payload so the job never has to re-look it up
    by_iid = {p["integration_id"]: p["kind"] for _, p in inserted}
    assert by_iid == {5: "prometheus", 8: "mimir", 9: "clickhouse", 10: "tempo", 11: "loki"}
    assert did._sqs.sent and all(m["type"] == "datasource_index" for m in did._sqs.sent)
    assert conn.closed
    # query filters to all 5 datasource kinds, egress-read enabled — not just prom/mimir
    list_sql = next(s for s in conn.sql_log if "FROM integrations" in s)
    for kind in ("prometheus", "mimir", "clickhouse", "tempo", "loki"):
        assert kind in list_sql
    assert "enabled" in list_sql


def test_per_instance_failure_isolated(monkeypatch):
    conn, inserted = _wire(monkeypatch, [(5, "a", "prometheus"), (8, "b", "mimir")], fail_for={5})
    out = did.lambda_handler({}, None)
    assert out["instances"] == 2 and out["enqueued"] == 1 and out["failed"] == 1  # one bad row didn't block the other


def test_no_instances_is_noop(monkeypatch):
    _wire(monkeypatch, [])
    assert did.lambda_handler({}, None) == {"instances": 0, "enqueued": 0, "failed": 0}


def test_missing_queue_url_fails_loud(monkeypatch):
    _wire(monkeypatch, [(5, "a", "prometheus")])
    monkeypatch.setattr(did, "QUEUE_URL", "")
    try:
        did.lambda_handler({}, None)
        assert False, "should raise on missing queue url"
    except RuntimeError:
        pass
