"""diagnosis_digest.py — batches diagnosis_reports rows with notified_at IS NULL into ONE SNS
notification per run (replaces the prior one-email-per-completion path), then stamps notified_at.
A batch of exactly one report reuses the full single-report format (publish_report); several
reports use the compact digest format (publish_digest) with a short per-report teaser."""


class FakeConn:
    def __init__(self):
        self.closed = False

    def run(self, sql, **_kw):
        # absent flag (zero rows) — the legacy tests must exercise the REAL absent-flag path,
        # not the fail-open except branch via AttributeError.
        return []

    def close(self):
        self.closed = True


def test_digest_single_report_uses_publish_report_with_fetched_markdown(monkeypatch):
    import diagnosis_digest

    conn = FakeConn()
    monkeypatch.setattr(diagnosis_digest.db, "connect", lambda: conn)
    monkeypatch.setattr(
        diagnosis_digest.ddb, "list_pending_notifications",
        lambda c: [{"id": 1, "title": "리포트 A", "artifact_uri": "s3://b/diagnosis/1.md"}],
    )
    monkeypatch.setattr(diagnosis_digest, "_fetch_markdown", lambda uri: "# md for " + uri)
    captured = {}
    monkeypatch.setattr(
        diagnosis_digest.notify, "publish_report",
        lambda topic, title, md, url, region=None: captured.update(
            topic=topic, title=title, md=md, url=url) or "mid-1",
    )
    digest_called = {"called": False}
    monkeypatch.setattr(
        diagnosis_digest.notify, "publish_digest",
        lambda *a, **kw: digest_called.update(called=True),
    )
    marked = {}
    monkeypatch.setattr(diagnosis_digest.ddb, "mark_notified", lambda c, ids, outcome="emailed": marked.update(ids=ids, outcome=outcome))
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    monkeypatch.setenv("APP_DOMAIN", "x.example")

    out = diagnosis_digest.lambda_handler(None, None)

    assert out == {"digested": 1, "paused": False}
    assert marked["outcome"] == "emailed"  # MessageId confirmed → durable 'emailed'
    assert digest_called["called"] is False  # single report → NOT the batch path
    assert captured["topic"] == "arn:aws:sns:x:1:t"
    assert captured["title"] == "리포트 A"
    assert captured["md"] == "# md for s3://b/diagnosis/1.md"
    assert captured["url"] == "https://x.example/ai-diagnosis?report=1"
    assert marked["ids"] == [1]
    assert conn.closed


def test_digest_multiple_reports_uses_publish_digest_with_teasers(monkeypatch):
    import diagnosis_digest

    conn = FakeConn()
    monkeypatch.setattr(diagnosis_digest.db, "connect", lambda: conn)
    monkeypatch.setattr(
        diagnosis_digest.ddb, "list_pending_notifications",
        lambda c: [
            {"id": 1, "title": "리포트 A", "artifact_uri": "s3://b/diagnosis/1.md"},
            {"id": 2, "title": "리포트 B", "artifact_uri": None},  # no artifact → no teaser, no crash
        ],
    )

    def fake_fetch(uri):
        return "## 핵심 요약\n\n좋은 요약입니다." if uri else ""
    monkeypatch.setattr(diagnosis_digest, "_fetch_markdown", fake_fetch)

    report_called = {"called": False}
    monkeypatch.setattr(
        diagnosis_digest.notify, "publish_report",
        lambda *a, **kw: report_called.update(called=True),
    )
    captured = {}
    monkeypatch.setattr(
        diagnosis_digest.notify, "publish_digest",
        lambda topic, reports, region=None: captured.update(topic=topic, reports=reports) or "mid-2",
    )
    marked = {}
    monkeypatch.setattr(diagnosis_digest.ddb, "mark_notified", lambda c, ids, outcome="emailed": marked.update(ids=ids, outcome=outcome))
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    monkeypatch.setenv("APP_DOMAIN", "x.example")

    out = diagnosis_digest.lambda_handler(None, None)

    assert out == {"digested": 2, "paused": False}
    assert marked["outcome"] == "emailed"
    assert report_called["called"] is False  # multiple reports → NOT the single-report path
    assert captured["topic"] == "arn:aws:sns:x:1:t"
    assert [r["title"] for r in captured["reports"]] == ["리포트 A", "리포트 B"]
    assert "핵심 요약" in captured["reports"][0]["teaser"]
    assert captured["reports"][1]["teaser"] == ""  # no artifact_uri → empty, not a crash
    assert marked["ids"] == [1, 2]


def test_digest_noop_when_nothing_pending(monkeypatch):
    import diagnosis_digest

    conn = FakeConn()
    monkeypatch.setattr(diagnosis_digest.db, "connect", lambda: conn)
    monkeypatch.setattr(diagnosis_digest.ddb, "list_pending_notifications", lambda c: [])

    calls = {"report": False, "digest": False}
    monkeypatch.setattr(diagnosis_digest.notify, "publish_report", lambda *a, **kw: calls.update(report=True))
    monkeypatch.setattr(diagnosis_digest.notify, "publish_digest", lambda *a, **kw: calls.update(digest=True))
    marked = {"called": False}
    monkeypatch.setattr(diagnosis_digest.ddb, "mark_notified", lambda *a, **kw: marked.update(called=True))

    out = diagnosis_digest.lambda_handler(None, None)

    assert out == {"digested": 0, "paused": False}
    assert calls == {"report": False, "digest": False}
    assert marked["called"] is False
    assert conn.closed


def test_digest_marks_notified_even_without_topic_configured(monkeypatch):
    """Flag-off / no topic still drains the backlog — a later flag-on shouldn't suddenly
    email a huge historical batch. Also: no topic → no wasted S3 fetch."""
    import diagnosis_digest

    conn = FakeConn()
    monkeypatch.setattr(diagnosis_digest.db, "connect", lambda: conn)
    monkeypatch.setattr(
        diagnosis_digest.ddb, "list_pending_notifications",
        lambda c: [{"id": 5, "title": "리포트 C", "artifact_uri": "s3://b/diagnosis/5.md"}],
    )

    def boom(uri):
        raise AssertionError("should not fetch markdown when there's no topic")
    monkeypatch.setattr(diagnosis_digest, "_fetch_markdown", boom)
    calls = {"report": False, "digest": False}
    monkeypatch.setattr(diagnosis_digest.notify, "publish_report", lambda *a, **kw: calls.update(report=True))
    monkeypatch.setattr(diagnosis_digest.notify, "publish_digest", lambda *a, **kw: calls.update(digest=True))
    marked = {}
    monkeypatch.setattr(diagnosis_digest.ddb, "mark_notified", lambda c, ids, outcome="emailed": marked.update(ids=ids, outcome=outcome))
    monkeypatch.delenv("DIAGNOSIS_SNS_TOPIC_ARN", raising=False)

    out = diagnosis_digest.lambda_handler(None, None)

    assert out == {"digested": 1, "paused": False}
    assert calls == {"report": False, "digest": False}
    assert marked["ids"] == [5]      # backlog still drained


def test_fetch_markdown_parses_uri_and_decodes_body(monkeypatch):
    import diagnosis_digest

    class _Body:
        def read(self):
            return "# hello".encode("utf-8")

    class _S3:
        def get_object(self, Bucket, Key):
            captured_calls.append((Bucket, Key))
            return {"Body": _Body()}

    captured_calls = []
    monkeypatch.setattr(diagnosis_digest, "_s3_client", lambda: _S3())

    out = diagnosis_digest._fetch_markdown("s3://my-bucket/diagnosis/7.md")

    assert out == "# hello"
    assert captured_calls == [("my-bucket", "diagnosis/7.md")]


def test_fetch_markdown_returns_empty_on_missing_uri_or_bad_format():
    import diagnosis_digest

    assert diagnosis_digest._fetch_markdown(None) == ""
    assert diagnosis_digest._fetch_markdown("") == ""
    assert diagnosis_digest._fetch_markdown("not-an-s3-uri") == ""


def test_fetch_markdown_swallows_s3_errors(monkeypatch):
    import diagnosis_digest

    class _S3:
        def get_object(self, Bucket, Key):
            raise RuntimeError("NoSuchKey")

    monkeypatch.setattr(diagnosis_digest, "_s3_client", lambda: _S3())

    assert diagnosis_digest._fetch_markdown("s3://b/missing.md") == ""


class FakeConnWithSettings(FakeConn):
    """FakeConn that answers the gap-L178 pause-flag read."""
    def __init__(self, paused_value=None, raise_on_run=False):
        super().__init__()
        self.paused_value = paused_value
        self.raise_on_run = raise_on_run

    def run(self, sql, **_kw):
        if self.raise_on_run:
            raise RuntimeError("settings table missing")
        # Pin BOTH sides of the cross-component contract: a key typo on either side would
        # read zero rows and silently fail open with green tests.
        assert "app_settings" in sql and "diagnosis_notify_paused" in sql
        return [[self.paused_value]] if self.paused_value is not None else []


def test_digest_paused_skips_publish_but_still_stamps(monkeypatch):
    """Gap L178: paused behaves exactly like a missing topic — no SNS publish, notified_at
    still stamped (reports completed while paused are dropped, never queued for a stale blast)."""
    import diagnosis_digest

    conn = FakeConnWithSettings(paused_value="true")
    monkeypatch.setattr(diagnosis_digest.db, "connect", lambda: conn)
    monkeypatch.setattr(
        diagnosis_digest.ddb, "list_pending_notifications",
        lambda c: [{"id": 1, "title": "t", "artifact_uri": "s3://b/k"}],
    )
    published = []
    monkeypatch.setattr(diagnosis_digest.notify, "publish_report", lambda *a, **k: published.append(a))
    monkeypatch.setattr(diagnosis_digest.notify, "publish_digest", lambda *a, **k: published.append(a))
    marked = {}
    monkeypatch.setattr(diagnosis_digest.ddb, "mark_notified", lambda c, ids, outcome="emailed": marked.update(ids=ids, outcome=outcome))
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")

    out = diagnosis_digest.lambda_handler({}, None)
    assert published == []
    assert marked["ids"] == [1]
    # the DURABLE record: dropped-while-paused is written to Aurora, not only logs
    assert marked["outcome"] == "dropped_paused"
    assert out["digested"] == 1


def test_digest_pause_flag_read_failure_fails_open(monkeypatch):
    """A broken settings read must not silently kill notifications — publish proceeds."""
    import diagnosis_digest

    conn = FakeConnWithSettings(raise_on_run=True)
    monkeypatch.setattr(diagnosis_digest.db, "connect", lambda: conn)
    monkeypatch.setattr(
        diagnosis_digest.ddb, "list_pending_notifications",
        lambda c: [{"id": 2, "title": "t", "artifact_uri": ""}],
    )
    published = []
    monkeypatch.setattr(diagnosis_digest.notify, "publish_report", lambda *a, **k: published.append(a))
    monkeypatch.setattr(diagnosis_digest.ddb, "mark_notified", lambda c, ids, outcome="emailed": None)
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")

    diagnosis_digest.lambda_handler({}, None)
    assert len(published) == 1


def test_digest_publish_failure_records_publish_failed_not_emailed(monkeypatch):
    """publish_report swallows errors and returns None — a throttled/denied publish must be
    durably recorded as publish_failed (still drained), never as 'emailed'."""
    import diagnosis_digest

    conn = FakeConn()
    monkeypatch.setattr(diagnosis_digest.db, "connect", lambda: conn)
    monkeypatch.setattr(
        diagnosis_digest.ddb, "list_pending_notifications",
        lambda c: [{"id": 5, "title": "t", "artifact_uri": ""}],
    )
    monkeypatch.setattr(diagnosis_digest.notify, "publish_report", lambda *a, **k: None)
    marked = {}
    monkeypatch.setattr(diagnosis_digest.ddb, "mark_notified", lambda c, ids, outcome="emailed": marked.update(ids=ids, outcome=outcome))
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")

    diagnosis_digest.lambda_handler({}, None)
    assert marked["outcome"] == "publish_failed"
    assert marked["ids"] == [5]


def test_digest_no_topic_records_skipped_no_topic(monkeypatch):
    import diagnosis_digest

    conn = FakeConn()
    monkeypatch.setattr(diagnosis_digest.db, "connect", lambda: conn)
    monkeypatch.setattr(
        diagnosis_digest.ddb, "list_pending_notifications",
        lambda c: [{"id": 6, "title": "t", "artifact_uri": ""}],
    )
    marked = {}
    monkeypatch.setattr(diagnosis_digest.ddb, "mark_notified", lambda c, ids, outcome="emailed": marked.update(ids=ids, outcome=outcome))
    monkeypatch.delenv("DIAGNOSIS_SNS_TOPIC_ARN", raising=False)

    diagnosis_digest.lambda_handler({}, None)
    assert marked["outcome"] == "skipped_no_topic"


def test_digest_failopen_publish_records_emailed_failopen(monkeypatch):
    """A publish that happened only because the pause-flag read failed must carry its own
    durable marker — the pause/publish divergence stays answerable."""
    import diagnosis_digest

    conn = FakeConnWithSettings(raise_on_run=True)
    monkeypatch.setattr(diagnosis_digest.db, "connect", lambda: conn)
    monkeypatch.setattr(
        diagnosis_digest.ddb, "list_pending_notifications",
        lambda c: [{"id": 7, "title": "t", "artifact_uri": ""}],
    )
    monkeypatch.setattr(diagnosis_digest.notify, "publish_report", lambda *a, **k: "mid-7")
    marked = {}
    monkeypatch.setattr(diagnosis_digest.ddb, "mark_notified", lambda c, ids, outcome="emailed": marked.update(ids=ids, outcome=outcome))
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")

    diagnosis_digest.lambda_handler({}, None)
    assert marked["outcome"] == "emailed_failopen"
