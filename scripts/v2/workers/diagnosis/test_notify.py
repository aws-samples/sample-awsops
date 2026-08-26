from diagnosis import notify


MD = """# AWS 보안 포스처 진단 보고서

## 핵심 요약

보안 점수는 **72/100** 입니다. 공개된 S3 버킷 `my-bucket` 2건이 발견되었습니다.

| 항목 | 값 |
| --- | --- |
| 점수 | 72 |

### 보안 점수 (0~100)

세부 내용.

## 네트워크

다음 섹션 본문.
"""


def test_summarize_extracts_first_section_as_plaintext():
    out = notify.summarize(MD)
    assert "핵심 요약" in out
    assert "72/100" in out          # bold markers stripped
    assert "my-bucket" in out       # inline code stripped
    assert "**" not in out and "`" not in out
    assert "| ---" not in out       # table separator row dropped
    # stops before the next section
    assert "다음 섹션 본문" not in out


def test_summarize_truncates_long_input():
    big = "## 요약\n\n" + ("가" * 5000)
    out = notify.summarize(big, limit=1200)
    assert len(out) <= 1202 and out.endswith("…")


def test_build_message_ascii_subject_and_link_in_body():
    subject, body = notify.build_message("주간 진단", MD, "https://x.example/ai-diagnosis?report=14")
    assert subject.isascii()                 # SNS rejects non-ASCII Subject
    assert len(subject) <= 100
    assert "주간 진단" in body                # Korean title goes in the body
    assert "https://x.example/ai-diagnosis?report=14" in body
    assert "핵심 요약" in body


def test_build_message_footer_varies_by_trigger():
    # scheduled run → "자동 진단 스케줄" footer; manual run → "진단 완료 시" footer (and NOT the schedule one)
    _, sched = notify.build_message("주간 진단", MD, "https://x/ai-diagnosis?report=1", scheduled=True)
    _, manual = notify.build_message("수동 진단", MD, "https://x/ai-diagnosis?report=2", scheduled=False)
    assert "자동 진단 스케줄" in sched
    assert "진단 완료 시" in manual and "자동 진단 스케줄" not in manual
    # default (no scheduled kwarg) is the manual wording — manual runs are the parity-widened path
    _, dflt = notify.build_message("기본", MD, "https://x/ai-diagnosis?report=3")
    assert "진단 완료 시" in dflt and "자동 진단 스케줄" not in dflt


def test_publish_report_noop_without_topic():
    assert notify.publish_report("", "t", MD, "url") is None


def test_publish_report_best_effort_swallows_errors(monkeypatch):
    class _Boom:
        def publish(self, **kw):
            raise RuntimeError("Throttling")

    monkeypatch.setattr(notify, "_client", lambda region=None: _Boom())
    # must NOT raise — returns None on failure
    assert notify.publish_report("arn:aws:sns:x:1:t", "t", MD, "url") is None


def test_publish_report_publishes_and_returns_message_id(monkeypatch):
    captured = {}

    class _Sns:
        def publish(self, **kw):
            captured.update(kw)
            return {"MessageId": "mid-1"}

    monkeypatch.setattr(notify, "_client", lambda region=None: _Sns())
    mid = notify.publish_report("arn:aws:sns:x:1:t", "주간 진단", MD,
                                "https://x.example/ai-diagnosis?report=14")
    assert mid == "mid-1"
    assert captured["TopicArn"] == "arn:aws:sns:x:1:t"
    assert captured["Subject"].isascii()
    assert "report=14" in captured["Message"]
