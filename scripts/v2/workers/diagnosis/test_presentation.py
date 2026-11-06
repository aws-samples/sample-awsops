"""Offline acceptance for code-owned report observations and hypotheses."""
import html
import json
import pytest
from diagnosis.sections import SECTIONS, INTENDED_VS_ACTUAL_SECTION


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
        "resources": [{"id": "ec2:@self:us-east-1:i-0123456789abcdef0",
                       "account": "self", "region": "us-east-1", "kind": "ec2",
                       "resource_id": "i-0123456789abcdef0", "facts": {}}],
        "evidence": [{"id": "metric-a", "source": "cloudwatch",
                      "resource_ids": ["ec2:@self:us-east-1:i-0123456789abcdef0"],
                      "kind": "metrics", "facts": {"CPUUtilization": {"maximum": 17.25}},
                      "captured_at": "2026-11-04T00:00:00Z", "window": {"days": 14},
                      "coverage": {"complete": True}, "fresh": True}],
        "relationships": [], "coverage": {"resources_returned": 1},
        "gaps": ["memory_unknown"], "degraded": [], "incomplete": [],
    }


def finding(**changes):
    row = {"id": "finding-a", "pillar": "performance_efficiency", "severity": "medium",
           "resource_ids": [bundle()["resources"][0]["id"]], "evidence_ids": ["metric-a"],
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
    assert "memory&#95;unknown" in result["executive_summary"]


def test_cells_rows_and_total_markdown_are_bounded_with_explicit_markers(monkeypatch):
    from diagnosis import presentation
    assert presentation._cell("x " + "1234567890" * 80).endswith("x …&#91;truncated&#93;")
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
    assert "<script>" not in text
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
