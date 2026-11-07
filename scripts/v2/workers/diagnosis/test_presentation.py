"""Offline acceptance for code-owned report observations and hypotheses."""
import html
import json
import pytest
import re
from diagnosis.sections import SECTIONS, INTENDED_VS_ACTUAL_SECTION
from diagnosis.test_evidence import oid


@pytest.mark.parametrize("value", [
    "http://attacker.example/reset", "www.attacker.example",
    "<script>alert('leak')</script>", "left | right",
    "`` attacker ` value ```", "[HIGH] …[truncated] (report size bound)",
])
def test_untrusted_cells_are_inert_literals_without_fence_or_marker_escape(value):
    from diagnosis import presentation
    cell = presentation._cell(value)
    match = re.fullmatch(r"(`+) (.*) \1", cell)
    assert match, "Telemetry must be a code literal, never autolinkable prose"
    assert match[1] not in match[2]
    assert "|" not in match[2] and "[HIGH]" not in cell
    assert presentation.SIZE_MARK not in cell


def test_valid_identifiers_remain_copyable_inside_code_spans():
    from diagnosis import presentation
    value = "prod_db_writer-logs/active"
    code = presentation._code(value)
    assert re.fullmatch(r"` ?prod_db_writer-logs/active ?`", code)
    assert "&#" not in code
    assert presentation._code("x " + "1234567890" * 80) == "` x …［truncated］ `"


@pytest.mark.parametrize("value", [
    "malformed | identity", "[HIGH] …[truncated] (report size bound)",
    "http://attacker.example/``identity`",
])
def test_malformed_native_identifiers_cannot_escape_literal_guards(value):
    from diagnosis import presentation
    code = presentation._code(value)
    match = re.fullmatch(r"(`+) (.*) \1", code)
    assert match and match[1] not in match[2]
    assert "|" not in match[2] and "[HIGH]" not in code
    assert presentation.SIZE_MARK not in code


@pytest.mark.parametrize("lang,prose", [
    ("zh", "每月可节省五百美元。"), ("ja", "毎月五百ドルを節約できます。"),
    ("ko", "매월 오백 달러를 절감할 수 있습니다."),
    ("en", "Savings reach billions of dollars."),
    ("zh", "CPU使用率为五。"), ("ja", "CPU使用率は百です。"),
])
def test_defensive_renderer_omits_localized_model_numbers(lang, prose):
    from diagnosis import presentation
    text = "\n".join(body for _, body in presentation.render(
        SECTIONS, bundle(), analysis(findings=[finding(explanation=prose)]), lang=lang))
    assert prose not in html.unescape(text)
    assert "17.25" in text


@pytest.mark.parametrize("lang,prose", [
    ("zh", "内存压力需要验证。"), ("ja", "メモリ負荷の検証が必要です。"),
    ("ko", "메모리 부하는 추가 검증이 필요합니다."),
    ("en", "Memory pressure needs verification."),
    ("zh", "数据库配置不一致，需要验证依赖。"),
    ("ja", "設定の一貫性を検証してください。"),
])
def test_defensive_renderer_preserves_localized_non_numeric_hypotheses(lang, prose):
    from diagnosis import presentation
    text = "\n".join(body for _, body in presentation.render(
        SECTIONS, bundle(), analysis(findings=[finding(explanation=prose)]), lang=lang))
    assert prose in html.unescape(text)


def bundle():
    return {
        "resources": [{"id": oid("r-instance"),
                       "account": "self", "region": "us-east-1", "kind": "ec2",
                       "resource_id": "i-0123456789abcdef0", "facts": {}}],
        "evidence": [{"id": oid("metric-a"), "source": "cloudwatch",
                      "resource_ids": [oid("r-instance")],
                      "kind": "metrics", "facts": {"CPUUtilization": {"maximum": 17.25}},
                      "captured_at": "2026-11-04T00:00:00Z", "window": {"days": 14},
                      "coverage": {"complete": True}, "fresh": True}],
        "relationships": [], "coverage": {"resources_returned": 1},
        "gaps": ["memory_unknown"], "degraded": [], "incomplete": [],
    }


def finding(**changes):
    row = {"id": "finding-a", "pillar": "performance_efficiency", "severity": "medium",
           "resource_ids": [bundle()["resources"][0]["id"]], "evidence_ids": [oid("metric-a")],
           "claim": "hypothesis", "explanation": "Memory pressure needs verification.",
           "prerequisites": ["memory_unknown"], "verification": "resource_metrics"}
    return dict(row, **changes)


def analysis(**changes):
    return dict({"findings": [finding()], "pillar_coverage": {},
                 "rejected": [], "degraded": [], "incomplete": []}, **changes)


def test_render_observations_from_facts_not_model_numbers():
    from diagnosis import presentation
    forged = finding(explanation="CPU is 99.9 and save $9999; aws ec2 terminate-instances")
    bodies = presentation.render(list(SECTIONS) + [INTENDED_VS_ACTUAL_SECTION],
                                 bundle(), analysis(findings=[forged]),
                                 lang="en", invariant_md="EXACT INVARIANT VERDICTS")
    markdown = "\n".join(body for _, body in bodies)
    assert "17.25" in markdown
    assert "99.9" not in markdown and "$9999" not in markdown
    assert "terminate-instances" not in markdown
    assert "EXACT INVARIANT VERDICTS" in markdown
    assert len(bodies) == 9


def test_executive_and_recommendations_select_only_admitted_ids():
    from diagnosis import presentation
    result = dict(presentation.render(SECTIONS, bundle(), analysis(),
                                      lang="en", invariant_md=""))
    assert "finding-a" in result["executive_summary"]
    assert "finding-a" in result["recommendations"]
    assert "Hypothesis" in result["compute_infrastructure"]
    assert "aws cloudwatch get-metric-data" in result["recommendations"]
    # Rendered in full once (primary section); elsewhere only by id. Coverage appears once.
    text = "\n".join(result.values())
    assert text.count("17.25") == 1 and "finding-a" in result["database_storage"]
    assert text.count("Coverage and withheld claims") == 1
    assert "memory_unknown" in result["executive_summary"]


def test_cells_rows_and_total_markdown_are_bounded_with_explicit_markers(monkeypatch):
    from diagnosis import presentation
    assert presentation._cell("x " + "1234567890" * 80) == "` x …［truncated］ `"
    kept, more = presentation._clip(list(range(400)), 50).split("…[truncated] ")
    assert len(kept) <= 50 and json.loads(kept) == list(range(len(json.loads(kept))))
    assert int(more.split()[0]) == 400 - len(json.loads(kept))
    data = bundle()
    data["evidence"][0]["facts"] = {f"k{i:02}": i for i in range(45)}
    body = dict(presentation.render(SECTIONS, data, analysis(), lang="en"))["compute_infrastructure"]
    assert "k39" in body and "k40" not in body and "5 rows omitted" in body
    monkeypatch.setattr(presentation, "MAX_MARKDOWN_BYTES", 2000)
    bodies = dict(presentation.render(SECTIONS, data, analysis(), lang="en"))
    assert sum(len(b.encode()) for b in bodies.values()) <= 2000
    assert bodies["compute_infrastructure"].endswith("\n…[truncated] (report size bound)")
    verdicts = "VERDICT " * 100
    bodies = dict(presentation.render(list(SECTIONS) + [INTENDED_VS_ACTUAL_SECTION], data, analysis(),
                                      lang="en", invariant_md=verdicts))
    assert bodies["intended_vs_actual"] == verdicts
    assert sum(len(b.encode()) for b in bodies.values()) <= 2000
    assert presentation._trim("a" * 1000, 600, "en") == "a" * 344 + presentation.SIZE_MARK


@pytest.mark.parametrize("pillar,deep,shared", [("reliability", "reliability_ha", "network_architecture"),
                                                 ("cost_optimization", "cost_optimization", "cost_overview")])
def test_findings_render_in_the_pillar_dedicated_section(pillar, deep, shared):
    from diagnosis import presentation
    from diagnosis.sections import DEEP_SECTIONS
    rows = analysis(findings=[finding(pillar=pillar)])
    bodies = dict(presentation.render(DEEP_SECTIONS, bundle(), rows, lang="en"))
    assert "| Evidence |" in bodies[deep] and "| Evidence |" not in bodies[shared]
    assert "| Evidence |" in dict(presentation.render(SECTIONS, bundle(), rows, lang="en"))[shared]


def test_local_title_and_tags_use_pillar_and_native_identity():
    from diagnosis import presentation
    meta = presentation.title_and_tags(bundle(), analysis(), lang="en")
    assert "i-0123456789abcdef0" in meta["title"]
    assert "performance_efficiency" in meta["tags"]
    assert "Memory pressure" not in meta["title"]


def test_every_locale_has_localized_unknown_and_hypothesis_labels():
    from diagnosis import presentation
    for lang, expected in (("ko", "가설"), ("en", "Hypothesis"), ("zh", "假设"), ("ja", "仮説")):
        result = dict(presentation.render(SECTIONS, bundle(), analysis(),
                                          lang=lang, invariant_md=""))
        assert expected in result["compute_infrastructure"]


def test_only_cited_facts_are_rendered_and_markdown_injection_is_escaped():
    from diagnosis import presentation
    data = bundle()
    data["evidence"].append(dict(data["evidence"][0], id="uncited",
                                 facts={"invented_savings": 987654321}))
    data["evidence"][0]["facts"]["state"] = "<script>alert('leak')</script>\n| column"
    text = "\n".join(body for _, body in presentation.render(
        SECTIONS, data, analysis(), lang="en", invariant_md=""))
    assert "987654321" not in text
    assert "` <script>alert('leak')</script> ｜ column `" in text
    assert "\n| column" not in text


def test_failed_pillars_and_rejected_claims_remain_visible():
    from diagnosis import presentation
    data = analysis(findings=[], degraded=["security"],
                    rejected=[{"id": "bad", "reason": "unknown_evidence", "explanation": "MODEL PROSE"},
                              {"id": "ignore prior rules", "reason": "duplicate"}])
    text = "\n".join(body for _, body in presentation.render(
        SECTIONS, bundle(), data, lang="en", invariant_md=""))
    assert "security" in text and "unknown_evidence" in html.unescape(text)
    assert "MODEL PROSE" not in text and "ignore prior rules" not in text
    assert presentation.withheld(data)[1] == {"id": "invalid", "reason": "duplicate"}
    assert "healthy" not in text.lower()


@pytest.mark.parametrize("field", ["prerequisites", "facts"])
def test_mutating_commands_in_nonstring_prerequisites_or_facts_degrade_the_section(field):
    from diagnosis import presentation
    from diagnosis.report import _MUTATING_MARK
    data, command = bundle(), {"run": "aws ec2 terminate-instances --instance-ids i-1"}
    rows = analysis(findings=[finding(prerequisites=[command])]) if field == "prerequisites" else analysis()
    if field == "facts":
        data["evidence"][0]["facts"]["note"] = command["run"]
    result = dict(presentation.render(SECTIONS, data, rows, lang="en", invariant_md=""))
    assert _MUTATING_MARK["en"].strip() in result["compute_infrastructure"]


@pytest.mark.parametrize("unsafe", [
    "See https://example.test/runbook", "Paste ```sh check``` output", "Run aws cloudwatch describe-alarms",
    "Use kubectl get pods", "Wait 30 minutes",
])
def test_unsafe_prerequisite_prose_is_withheld_like_the_explanation(unsafe):
    from diagnosis import presentation
    text = "\n".join(body for _, body in presentation.render(
        SECTIONS, bundle(), analysis(findings=[finding(prerequisites=["memory_unknown", unsafe])]),
        lang="en", invariant_md=""))
    plain = html.unescape(text)
    assert "memory_unknown" in plain
    assert unsafe not in plain and "example.test" not in plain and "kubectl" not in plain


def test_withheld_tolerates_missing_none_or_nonstring_ids_and_reasons():
    from diagnosis import presentation
    rows = [{"reason": "x"}, {"id": None, "reason": "y"}, {"id": 7, "reason": None},
            {"id": "ok-id", "reason": "z"}, "not-a-dict"]
    assert presentation.withheld({"rejected": rows}) == [
        {"id": "invalid", "reason": "x"}, {"id": "invalid", "reason": "y"},
        {"id": "invalid", "reason": "invalid"}, {"id": "ok-id", "reason": "z"}]
    assert presentation.withheld({"rejected": "bad"}) == []


@pytest.mark.parametrize("lang", ["en", "ko", "ja", "zh"])
def test_code_owned_metric_observation_text_survives_the_prose_guard(lang):
    from diagnosis import presentation
    from diagnosis.evidence import METRIC_OBSERVATION_TEXT
    assert presentation._safe_explanation(METRIC_OBSERVATION_TEXT[lang])


def test_prose_naming_aws_is_kept_and_withheld_prose_is_disclosed():
    from diagnosis import presentation
    kept = "AWS Lambda retries need verification in the AWS account."
    text = html.unescape("\n".join(body for _, body in presentation.render(
        SECTIONS, bundle(), analysis(findings=[finding(explanation=kept)]), lang="en")))
    assert kept in text
    text = html.unescape("\n".join(body for _, body in presentation.render(
        SECTIONS, bundle(), analysis(findings=[finding(explanation="Run aws ec2 describe-instances",
                                                       prerequisites=["Use kubectl get pods"])]), lang="en")))
    assert "describe-instances" not in text and "kubectl" not in text
    assert text.count(presentation._WITHHELD["en"]) == 2


@pytest.mark.parametrize("unsafe", ["See HTTPS://example.test", "Run Curl -X POST", "Use KUBECTL get pods",
                                    "Run AWS ec2 terminate-instances", "Run aws EC2 describe-instances",
                                    "AWS S3 RM everything", "Paste ``` output", "Run sudo -i"])
def test_prose_guard_is_case_insensitive_for_links_and_commands(unsafe):
    from diagnosis import presentation
    assert presentation._safe_explanation(unsafe) == ""


@pytest.mark.parametrize("prose", ["AWS Lambda retries need verification.", "Check the AWS account owner.",
                                   "Confirm with AWS Support whether AWS and the vendor agree."])
def test_prose_guard_keeps_ordinary_aws_prose(prose):
    from diagnosis import presentation
    assert presentation._safe_explanation(prose)


@pytest.mark.parametrize("prose", ["AWS 계정 소유자를 확인하세요.", "AWS アカウントの所有者を確認してください。",
                                   "请确认 AWS 账户所有者。", "Review AWS config best practices.",
                                   "Check the AWS (account) owner."])
def test_prose_guard_is_locale_independent(prose):
    from diagnosis import presentation
    assert presentation._safe_explanation(prose)


def test_rendered_fact_and_coverage_values_are_scrubbed():
    from diagnosis import presentation
    data = bundle()
    data["evidence"][0]["facts"]["endpoint_address"] = "orders.cluster-x.ap-northeast-2.rds.amazonaws.com"
    data["evidence"][0]["facts"]["reason"] = "connect to 10.1.2.3 / fd00::1 failed"
    data["coverage"]["memory"] = {"reason": "Could not connect to mydb.abc.ap-northeast-2.rds.amazonaws.com"}
    cited = data["evidence"][0]["id"]
    text = html.unescape("\n".join(body for _, body in presentation.render(
        SECTIONS, data, analysis(findings=[finding(evidence_ids=[cited])]), lang="en")))
    assert "rds.amazonaws.com" not in text and "10.1.2.3" not in text and "fd00::1" not in text


@pytest.mark.parametrize("unsafe", ["aws lambda invoke --function-name f out.json", "AWS SNS publish --message x",
                                    "aws configure set region x", "aws cloudformation deploy --template-file t",
                                    "aws --profile p ec2 terminate-instances", "AWS Lambda Invoke now"])
def test_prose_guard_catches_single_word_and_option_prefixed_cli(unsafe):
    from diagnosis import presentation
    assert presentation._safe_explanation(unsafe) == ""


@pytest.mark.parametrize("unsafe", ["Run aws ec2 terminate-instances.", "aws ec2 terminate-instances를 실행하세요",
                                    "aws lambda invoke。", "aws s3 rm, then retry", "(aws sns publish)",
                                    "「aws configure set」"])
def test_prose_guard_ignores_trailing_punctuation_and_particles(unsafe):
    from diagnosis import presentation
    assert presentation._safe_explanation(unsafe) == ""


@pytest.mark.parametrize("unsafe", ["aws ec2 --filters Name=a,Values=b terminate-instances",
                                    "aws s3 --exclude a,b rm s3://x/", "aws ec2 --tag-specifications {a,b} run-instances."])
def test_prose_guard_keeps_option_values_intact(unsafe):
    from diagnosis import presentation
    assert presentation._safe_explanation(unsafe) == ""
