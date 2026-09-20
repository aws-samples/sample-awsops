"""compliance.py — Powerpipe JSON parsing (pure), password scrub, and the _compliance handler
registration/dry_run. No subprocess/boto3/Aurora in these tests."""
import compliance
import handlers

# Top-level group rollup summary (v1 parity: run totals come from groups[].summary.control),
# plus leaf control results (for compliance_results detail rows).
SAMPLE = {
    "groups": [
        {
            "title": "1 IAM",
            "summary": {"control": {"total": 2, "ok": 1, "alarm": 1, "info": 0, "skip": 0, "error": 0}},
            "controls": [
                {"control_id": "1.1", "title": "MFA", "description": "Enable MFA for all IAM users with a console password.", "tags": {"severity": "high"}, "results": [
                    {"status": "ok", "reason": "ok", "resource": "arn:user/a",
                     "dimensions": [{"key": "region", "value": "us-east-1"}]},
                    {"status": "alarm", "reason": "no mfa", "resource": "arn:user/b",
                     "dimensions": [{"key": "region", "value": "us-east-1"}]},
                ]},
            ],
        },
    ],
}


def test_parse_totals_from_group_summaries():
    totals, controls = compliance.parse_powerpipe_json(SAMPLE)
    assert totals["total_controls"] == 2 and totals["ok"] == 1 and totals["alarm"] == 1
    assert round(totals["pass_rate"], 1) == 50.0  # ok / (ok+alarm+info+skip+error) * 100
    assert sorted(c["status"] for c in controls) == ["alarm", "ok"]
    assert all(c["region"] == "us-east-1" for c in controls)
    assert controls[0]["severity"] == "high"
    # Gap L70: the control description (recommendation rationale) rides every leaf result row.
    assert all(c["description"] == "Enable MFA for all IAM users with a console password." for c in controls)


def test_parse_missing_description_defaults_to_empty():
    doc = {"groups": [{"title": "g", "controls": [
        {"control_id": "x", "title": "t", "results": [{"status": "ok", "reason": "", "resource": "r"}]},
    ]}]}
    _, controls = compliance.parse_powerpipe_json(doc)
    assert controls[0]["description"] == ""


def test_parse_empty_is_zero_not_crash():
    totals, controls = compliance.parse_powerpipe_json({"groups": []})
    assert totals["total_controls"] == 0 and totals["pass_rate"] == 0
    assert controls == []


def test_parse_falls_back_to_leaf_counts_when_no_summary():
    doc = {"groups": [{"title": "g", "controls": [
        {"control_id": "x", "results": [{"status": "ok"}, {"status": "alarm"}, {"status": "ok"}]}]}]}
    totals, controls = compliance.parse_powerpipe_json(doc)
    assert totals["total_controls"] == 3 and totals["ok"] == 2 and totals["alarm"] == 1
    assert len(controls) == 3


def test_scrub_redacts_steampipe_password():
    msg = "FATAL: connect postgres://steampipe:s3cr3tPW@host:9193/steampipe failed"
    scrubbed = compliance._scrub(msg)
    assert "s3cr3tPW" not in scrubbed
    assert "postgres://steampipe:***@host" in scrubbed


def test_compliance_handler_dry_run():
    out, art = handlers._compliance({"benchmark": "cis_v300", "run_id": 1}, True)
    assert out["dry_run"] is True and out["would_run"] == "cis_v300"
    assert art is None


def test_compliance_registered_as_fargate():
    assert handlers.REGISTRY["compliance"][1] == "fargate"
    assert handlers.is_allowed("compliance")
    assert handlers.runtime_for("compliance") == "fargate"


def test_run_powerpipe_scope_search_path(monkeypatch):
    """A 12-digit scope adds --search-path public,aws_<id>; 'all' keeps the aggregator default;
    a malformed scope raises before any subprocess call (defense vs forged payloads)."""
    import subprocess as sp
    import compliance
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd

        class P:
            returncode = 0
            stdout = "{}"
            stderr = ""
        return P()

    monkeypatch.setattr(sp, "run", fake_run)
    compliance.run_powerpipe("cis_v400", "postgres://x", "123456789012")
    assert "--search-path" in seen["cmd"]
    assert "public,aws_123456789012" in seen["cmd"]

    compliance.run_powerpipe("cis_v400", "postgres://x", "all")
    assert "--search-path" not in seen["cmd"]

    import pytest
    with pytest.raises(ValueError):
        compliance.run_powerpipe("cis_v400", "postgres://x", "123; DROP TABLE x")


class _FakeConn:
    """conn.run stub for the notify reads/writes (gap L192): pause flag, the ATOMIC dedup
    window claim (advisory-lock + UPDATE … NOT EXISTS … RETURNING), durable notify_outcome."""

    def __init__(self, paused=None, raise_on_read=False, recent_mail=False):
        self._paused = paused
        self._raise = raise_on_read
        self._recent = recent_mail
        self.outcomes = []  # (outcome, notified) writes
        self.claims = 0
        self.locks = 0
        self.unlocks = 0

    def run(self, sql, **kw):
        if "pg_advisory_lock" in sql:
            self.locks += 1
            return []
        if "pg_advisory_unlock" in sql:
            self.unlocks += 1
            return []
        if "SET notified_at = now()" in sql and "NOT EXISTS" in sql:
            # the atomic window claim — BEFORE any publish
            if self._raise:
                raise RuntimeError("db down")
            if self._recent:
                return []  # window already claimed by another run → no rows
            self.claims += 1
            return [[kw.get("id")]]
        if "UPDATE compliance_runs" in sql:
            self.outcomes.append((kw.get("o"), "notified_at=now()" in sql))
            return []
        if self._raise:
            raise RuntimeError("db down")
        return [] if self._paused is None else [[str(self._paused).lower()]]


class _FakeSns:
    def __init__(self, captured):
        self._c = captured

    def publish(self, **kw):
        self._c.update(kw)
        return {"MessageId": "m-1"}


TOTALS = {"pass_rate": 66.66666666666666, "total_controls": 4, "ok": 3, "alarm": 1, "info": 0, "skip": 0, "error": 0}


def _patch_sns(monkeypatch, captured):
    from diagnosis import notify

    monkeypatch.setattr(notify, "_client", lambda *_a, **_k: _FakeSns(captured))


def test_notify_completed_noop_without_topic(monkeypatch):
    monkeypatch.delenv("DIAGNOSIS_SNS_TOPIC_ARN", raising=False)
    conn = _FakeConn()
    assert compliance.notify_completed(conn, 9, "cis_v300", TOTALS) is None
    assert conn.outcomes == [("skipped_no_topic", False)]


def test_all_skip_class_outcomes_never_overwrite_a_durable_record(monkeypatch):
    """Round-2 gate: EVERY skip-class outcome (skipped_no_topic / dropped_paused /
    skipped_dedup) must carry the notify_outcome='' guard — a manual SFN re-drive of an
    already-emailed run passes through these branches and must not clobber the record."""
    seen = []

    class _SqlConn(_FakeConn):
        def run(self, sql, **kw):
            if "notify_outcome=:o" in sql:
                seen.append((kw.get("o"), "notify_outcome=''" in sql))
            return super().run(sql, **kw)

    # no topic
    monkeypatch.delenv("DIAGNOSIS_SNS_TOPIC_ARN", raising=False)
    compliance.notify_completed(_SqlConn(), 9, "cis_v300", TOTALS)
    # paused
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    compliance.notify_completed(_SqlConn(paused=True), 9, "cis_v300", TOTALS)
    # dedup'd
    captured = {}
    _patch_sns(monkeypatch, captured)
    compliance.notify_completed(_SqlConn(paused=False, recent_mail=True), 9, "cis_v300", TOTALS)
    assert [o for o, _ in seen] == ["skipped_no_topic", "dropped_paused", "skipped_dedup"]
    assert all(guarded for _, guarded in seen), seen


def test_notify_completed_publishes_ascii_subject_and_counts(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    monkeypatch.setenv("APP_DOMAIN", "awsops.example.com")
    captured = {}
    _patch_sns(monkeypatch, captured)
    conn = _FakeConn(paused=False)
    assert compliance.notify_completed(conn, 9, "cis_v300", TOTALS, scope="all") == "m-1"
    assert captured["TopicArn"] == "arn:aws:sns:x:1:t"
    # SNS REJECTS a non-ASCII Subject (diagnosis notify._SUBJECT precedent) — a Korean subject
    # makes the whole feature a silent no-op.
    assert captured["Subject"].isascii() and len(captured["Subject"]) <= 100
    assert "cis_v300" in captured["Message"]
    assert "통과: 3" in captured["Message"] and "실패(Alarm): 1" in captured["Message"]
    assert "통과율: 66.7%" in captured["Message"]  # rounded, not 66.66666666666666%
    assert "https://awsops.example.com/compliance" in captured["Message"]
    assert captured["MessageAttributes"]["awsops_class"]["StringValue"] == "compliance_completed"
    assert conn.outcomes == [("emailed", True)]


def test_notify_completed_respects_admin_pause(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    captured = {}
    _patch_sns(monkeypatch, captured)
    conn = _FakeConn(paused=True)
    assert compliance.notify_completed(conn, 9, "cis_v300", TOTALS) is None
    assert captured == {}  # paused → no publish
    assert conn.outcomes == [("dropped_paused", False)]


def test_notify_completed_dedup_window_blocks_reblast(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    captured = {}
    _patch_sns(monkeypatch, captured)
    conn = _FakeConn(paused=False, recent_mail=True)
    assert compliance.notify_completed(conn, 9, "cis_v300", TOTALS) is None
    assert captured == {}  # a same-benchmark mail went out within the window → skip
    assert conn.outcomes == [("skipped_dedup", False)]
    assert conn.claims == 0
    assert conn.locks == 1 and conn.unlocks == 1  # advisory lock always released


def test_notify_completed_claims_window_before_publish(monkeypatch):
    """Round-2 race fix: the window claim is an atomic UPDATE taken BEFORE the publish —
    concurrent same-benchmark runs cannot each pass a read-only check and all publish."""
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    order = []

    class _OrderedSns:
        def publish(self, **kw):
            order.append("publish")
            return {"MessageId": "m-1"}

    from diagnosis import notify

    monkeypatch.setattr(notify, "_client", lambda *_a, **_k: _OrderedSns())

    class _OrderedConn(_FakeConn):
        def run(self, sql, **kw):
            if "SET notified_at = now()" in sql and "NOT EXISTS" in sql:
                order.append("claim")
            return super().run(sql, **kw)

    conn = _OrderedConn(paused=False)
    assert compliance.notify_completed(conn, 9, "cis_v300", TOTALS) == "m-1"
    assert order == ["claim", "publish"]
    assert conn.locks == 1 and conn.unlocks == 1


def test_notify_claim_requires_own_row_unnotified(monkeypatch):
    """Round-3 hardening: the claim's target row must require notified_at IS NULL — a manual
    SFN re-drive of an already-notified run must not re-claim its own window and re-publish."""
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    captured = {}
    _patch_sns(monkeypatch, captured)
    seen_sql = []

    class _SqlConn(_FakeConn):
        def run(self, sql, **kw):
            seen_sql.append(sql)
            return super().run(sql, **kw)

    conn = _SqlConn(paused=False)
    compliance.notify_completed(conn, 9, "cis_v300", TOTALS)
    claim = next(q for q in seen_sql if "NOT EXISTS" in q)
    assert "notified_at IS NULL" in claim


def test_notify_completed_pause_read_failure_fails_open(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    captured = {}
    _patch_sns(monkeypatch, captured)
    conn = _FakeConn(raise_on_read=True)
    assert compliance.notify_completed(conn, 9, "cis_v300", TOTALS) == "m-1"
    assert conn.outcomes == [("emailed_failopen", True)]


def test_notify_completed_never_raises_on_publish_failure(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    from diagnosis import notify

    def boom(*_a, **_k):
        raise RuntimeError("sns down")

    monkeypatch.setattr(notify, "_client", boom)
    conn = _FakeConn(paused=False)
    assert compliance.notify_completed(conn, 9, "cis_v300", TOTALS) is None
    assert conn.outcomes == [("publish_failed", False)]
    assert conn.claims == 1  # the claimed window is KEPT on publish failure (no retry-blast)
