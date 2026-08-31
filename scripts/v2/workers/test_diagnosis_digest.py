"""diagnosis_digest.py — batches diagnosis_reports rows with notified_at IS NULL into ONE SNS
notification per run (replaces the prior one-email-per-completion path), then stamps notified_at.
A batch of exactly one report reuses the full single-report format (publish_report); several
reports use the compact digest format (publish_digest) with a short per-report teaser."""


class FakeConn:
    def __init__(self):
        self.closed = False

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
    monkeypatch.setattr(diagnosis_digest.ddb, "mark_notified", lambda c, ids: marked.update(ids=ids))
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    monkeypatch.setenv("APP_DOMAIN", "x.example")

    out = diagnosis_digest.lambda_handler(None, None)

    assert out == {"digested": 1}
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
    monkeypatch.setattr(diagnosis_digest.ddb, "mark_notified", lambda c, ids: marked.update(ids=ids))
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    monkeypatch.setenv("APP_DOMAIN", "x.example")

    out = diagnosis_digest.lambda_handler(None, None)

    assert out == {"digested": 2}
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

    assert out == {"digested": 0}
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
    monkeypatch.setattr(diagnosis_digest.ddb, "mark_notified", lambda c, ids: marked.update(ids=ids))
    monkeypatch.delenv("DIAGNOSIS_SNS_TOPIC_ARN", raising=False)

    out = diagnosis_digest.lambda_handler(None, None)

    assert out == {"digested": 1}
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
