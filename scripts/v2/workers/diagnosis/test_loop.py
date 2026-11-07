from copy import deepcopy
import datetime as dt
import threading

import pytest

from diagnosis import discovery
from diagnosis import loop
from diagnosis.budget import ReportBudget
from diagnosis.evidence import PILLARS
from diagnosis.test_evidence import ACCOUNT, bundle, finding, oid


def install_models(monkeypatch, reviews=None):
    events = []
    lock = threading.Lock()
    review_values = list(reviews or [{}])

    def analyze(pillar, index, *, model_id, budget, lang="en"):
        with lock:
            events.append(pillar)
        return {"findings": [finding(id=f"finding-{pillar}", pillar=pillar,
                                    claim="hypothesis")] if pillar == "reliability" else []}

    def review(findings, index, *, model_id, budget, final=False, lang="en"):
        with lock:
            events.append("final_review" if final else "review")
        output = {"finding_ids": [value["id"] for value in findings], "reject_ids": [],
                  "follow_up": [], "rerun_pillars": [], "issues": []}
        if review_values:
            output.update(review_values.pop(0))
        return output

    monkeypatch.setattr(loop.agents, "analyze", analyze)
    monkeypatch.setattr(loop.agents, "review", review)
    return events


@pytest.mark.parametrize("provider", ["anthropic_api", "bedrock_openai"])
def test_unsupported_provider_is_distinct_and_makes_no_model_attempt(monkeypatch, provider):
    monkeypatch.setenv("MODEL_PROVIDER", provider)
    events = install_models(monkeypatch)
    budget = ReportBudget("mid")
    result = loop.run(bundle(), account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=budget)
    assert not events and budget.snapshot()["attempt_count"] == 0
    assert result["passes"] == 0 and result["findings"] == []
    assert "analysis:model_provider_unsupported" in result["degraded"]
    assert result["model_stages"][0]["reason"] == "model_provider_unsupported"


def test_initial_specialists_finish_before_review_and_light_has_no_follow_up(monkeypatch):
    events = install_models(monkeypatch, [{"follow_up": [
        {"capability": "resource_metrics", "resource_ids": [oid("r-instance")]}],
        "rerun_pillars": ["performance_efficiency"]}])
    result = loop.run(bundle(), account=ACCOUNT, tier="light",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("light"),
                      collect_follow_up=lambda _: (_ for _ in ()).throw(AssertionError("light follow-up")))
    assert set(events[:6]) == set(PILLARS) and events[6:] == ["review"]
    assert result["passes"] == 1
    assert len(result["findings"]) == 1
    assert result["incomplete"]
    assert all(key in result for key in ["pillar_coverage", "rejected", "review", "model_stages"])


def test_follow_up_dedup_two_targeted_reruns_then_final_review(monkeypatch):
    request = {"capability": "resource_metrics", "resource_ids": [oid("r-instance")]}
    events = install_models(monkeypatch, [{"follow_up": [request, request],
        "rerun_pillars": ["performance_efficiency", "cost_optimization"]}])
    collected = []

    def follow_up(requests):
        collected.append(requests)
        data = bundle()
        data["evidence"][2]["facts"]["metrics"]["CPUUtilization"]["p95"]["max"] = 30
        return data

    result = loop.run(bundle(), account=ACCOUNT, tier="deep",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("deep"),
                      collect_follow_up=follow_up)
    assert collected == [[request]]
    assert events[6] == "review" and events[-1] == "final_review"
    assert set(events[7:-1]) == {"performance_efficiency", "cost_optimization"}
    assert result["passes"] == 2
    assert len(events) == 10


def test_no_progress_stops_before_reruns(monkeypatch):
    events = install_models(monkeypatch, [{"follow_up": [
        {"capability": "graph_refresh", "resource_ids": [oid("r-instance")]}],
        "rerun_pillars": ["reliability"]}])
    result = loop.run(bundle(), account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"),
                      collect_follow_up=lambda _: bundle())
    assert len(events) == 7 and result["passes"] == 1
    assert "follow_up:no_progress" in result["incomplete"]


def test_fabricated_reviewer_selection_and_requests_fail_closed(monkeypatch):
    events = install_models(monkeypatch, [{"finding_ids": ["invented"], "follow_up": [
        {"capability": "terminate", "resource_ids": [oid("r-instance")]}]}])
    result = loop.run(bundle(), account=ACCOUNT, tier="deep",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("deep"))
    assert len(events) == 7
    assert result["review"]["status"] == "invalid"
    assert result["degraded"] and result["rejected"]
    assert result["findings"] == []  # an invalid review never returns unselected findings


@pytest.mark.parametrize("review,kept,issues", [
    ({"issues": ["Confirm only one subnet route"]}, 1, ["Confirm only one subnet route"]),
    ({"issues": ["CPU at 99", "Verify the m5.large peer in ap-northeast-2"]}, 1,
     ["Verify the m5.large peer in ap-northeast-2"]),
    ({"issues": ["CPU at 99"], "finding_ids": [], "reject_ids": ["finding-reliability"]}, 0, []),
])
def test_numeric_review_issue_is_dropped_per_item(monkeypatch, review, kept, issues):
    install_models(monkeypatch, [review])
    result = loop.run(bundle(), account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"))
    assert len(result["findings"]) == kept
    assert result["review"]["status"] == "completed" and result["review"]["issues"] == issues
    assert "review:invalid_selection" not in result["degraded"]
    assert any(row["reason"] == "invalid_review_issue" for row in result["rejected"]) is ("99" in review["issues"][0])


def test_one_unsupported_follow_up_keeps_review_and_valid_requests(monkeypatch):
    request = {"capability": "resource_metrics", "resource_ids": [oid("r-instance")]}
    events = install_models(monkeypatch, [{"follow_up": [
        {"capability": "resource_metrics", "resource_ids": ["fabricated"]}, request],
        "rerun_pillars": ["performance_efficiency"]}])
    collected = []

    def follow_up(requests):
        collected.append(requests)
        data = bundle()
        data["evidence"][2]["facts"]["window_days"] = 15
        return data

    result = loop.run(bundle(), account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"),
                      collect_follow_up=follow_up)
    assert collected == [[request]] and result["passes"] == 2 and events[-1] == "final_review"
    assert any(row["reason"] == "invalid_follow_up" for row in result["rejected"])
    assert "review:invalid_selection" not in result["degraded"]


def test_provider_failure_and_invalid_findings_are_visible_per_pillar(monkeypatch):
    install_models(monkeypatch)

    def analyze(pillar, index, **kwargs):
        if pillar == "security":
            raise loop.agents.ModelStageError("provider_error")
        if pillar == "cost_optimization":
            return {"findings": [finding(pillar=pillar, evidence_ids=["fabricated"])]}
        return {"findings": []}

    monkeypatch.setattr(loop.agents, "analyze", analyze)
    result = loop.run(bundle(), account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"))
    assert result["pillar_coverage"]["security"]["status"] == "failed"
    assert result["pillar_coverage"]["cost_optimization"]["rejected"] == 1
    assert result["findings"] == [] and result["degraded"]


def test_stale_discovery_and_member_scope_never_become_a_healthy_pass(monkeypatch):
    install_models(monkeypatch)
    data = bundle()
    data["degraded"] = ["stale graph"]
    data["incomplete"] = ["member live sizing unsupported"]
    result = loop.run(data, account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"))
    assert "stale graph" in result["degraded"]
    assert "member live sizing unsupported" in result["incomplete"]


def test_review_can_withhold_existing_finding_but_cannot_promote_hypothesis(monkeypatch):
    install_models(monkeypatch, [{"finding_ids": [], "reject_ids": ["finding-reliability"]}])
    result = loop.run(bundle(), account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"))
    assert result["findings"] == []
    assert any(row["reason"] == "review_withheld" for row in result["rejected"])


def test_capture_time_only_refresh_is_no_progress(monkeypatch):
    events = install_models(monkeypatch, [{"follow_up": [
        {"capability": "graph_refresh", "resource_ids": [oid("r-instance")]}],
        "rerun_pillars": ["reliability"]}])
    data = bundle()
    for evidence in data["evidence"]:
        evidence["captured_at"] = "2026-11-04T01:00:00Z"
    result = loop.run(bundle(), account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"),
                      collect_follow_up=lambda _: data)
    assert len(events) == 7 and result["passes"] == 1
    assert "follow_up:no_progress" in result["incomplete"]


def captured_bundle(captured):
    """Create real discovery IDs, which include the source capture timestamp."""
    data = bundle()
    data["coverage"]["account"] = ACCOUNT
    data["evidence"] = [row for row in data["evidence"] if row["id"] != oid("e-config")]
    item = discovery._evidence(
        data, "stored_graph", "configured_dependency", [oid("r-instance"), oid("r-db")],
        {"relation": "queries", "graph_class": "infra"}, captured,
        region=data["resources"][0]["region"], fresh=True,
        window={"start": "2026-11-04T00:00:00Z", "end": "2026-11-04T00:30:00Z"},
        coverage={"complete": True, "status": "ok"})
    discovery._relationship(data, oid("r-instance"), oid("r-db"), "configured_dependency", item)
    return data, item


@pytest.mark.parametrize("retain_history", [False, True])
def test_real_discovery_capture_ids_do_not_trigger_model_reruns(monkeypatch, retain_history):
    first, original = captured_bundle(dt.datetime(2026, 11, 4, 12, tzinfo=dt.timezone.utc))
    refreshed, replacement = captured_bundle(dt.datetime(2026, 11, 4, 12, 1, tzinfo=dt.timezone.utc))
    assert original["id"] != replacement["id"]
    assert first["relationships"][-1]["id"] != refreshed["relationships"][-1]["id"]
    if retain_history:
        historical = deepcopy(original)
        historical["fresh"] = False
        historical["coverage"].update(complete=False, status="refresh_pending", retained_previous=True)
        refreshed["evidence"].append(historical)
        refreshed["relationships"].append(deepcopy(first["relationships"][-1]))
    events = install_models(monkeypatch, [{"follow_up": [
        {"capability": "graph_refresh", "resource_ids": [oid("r-instance")]}],
        "rerun_pillars": ["performance_efficiency", "cost_optimization"]}])
    result = loop.run(first, account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"),
                      collect_follow_up=lambda _: refreshed)
    assert len(events) == 7 and result["passes"] == 1
    assert "follow_up:no_progress" in result["incomplete"]


@pytest.mark.parametrize("changed", ["facts", "window", "freshness", "coverage"])
def test_real_discovery_semantic_changes_still_trigger_reruns(monkeypatch, changed):
    first, original = captured_bundle(dt.datetime(2026, 11, 4, 12, tzinfo=dt.timezone.utc))
    refreshed, replacement = captured_bundle(dt.datetime(2026, 11, 4, 12, 1, tzinfo=dt.timezone.utc))
    if changed == "facts":
        replacement["facts"]["relation"] = "uses"
    elif changed == "window":
        replacement["window"]["end"] = "2026-11-04T01:00:00Z"
    elif changed == "freshness":
        original["fresh"] = False
    else:
        original["coverage"]["complete"] = False
    events = install_models(monkeypatch, [{"follow_up": [
        {"capability": "graph_refresh", "resource_ids": [oid("r-instance")]}],
        "rerun_pillars": ["performance_efficiency", "cost_optimization"]}])
    result = loop.run(first, account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"),
                      collect_follow_up=lambda _: refreshed)
    assert len(events) == 10 and result["passes"] == 2
    assert events[-1] == "final_review"


@pytest.mark.parametrize("lang", ["ko", "en", "ja", "zh"])
def test_language_reaches_initial_and_followup_model_stages(monkeypatch, lang):
    request = {"capability": "resource_metrics", "resource_ids": [oid("r-instance")]}
    install_models(monkeypatch, [{"follow_up": [request],
                                 "rerun_pillars": ["performance_efficiency", "cost_optimization"]}])
    original_analyze, original_review = loop.agents.analyze, loop.agents.review
    locales = []

    def analyze(*args, **kwargs):
        locales.append(kwargs["lang"])
        return original_analyze(*args, **kwargs)

    def review(*args, **kwargs):
        locales.append(kwargs["lang"])
        return original_review(*args, **kwargs)

    monkeypatch.setattr(loop.agents, "analyze", analyze)
    monkeypatch.setattr(loop.agents, "review", review)
    refreshed = bundle()
    refreshed["evidence"][2]["facts"]["window_days"] = 15
    result = loop.run(bundle(), account=ACCOUNT, tier="mid", lang=lang,
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"),
                      collect_follow_up=lambda _: refreshed)
    assert result["passes"] == 2
    assert locales == [lang] * 10


def test_unsupported_language_fails_before_any_loop_stage(monkeypatch):
    events = install_models(monkeypatch)
    with pytest.raises(ValueError, match="language"):
        loop.run(bundle(), account=ACCOUNT, tier="mid", lang="fr",
                 model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"))
    assert events == []


def test_specialist_concurrency_never_exceeds_four(monkeypatch):
    install_models(monkeypatch)
    active, peak = 0, 0
    lock = threading.Lock()
    barrier = threading.Barrier(4)

    def analyze(pillar, index, **kwargs):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        if pillar in PILLARS[:4]:
            barrier.wait(timeout=5)
        with lock:
            active -= 1
        return {"findings": []}

    monkeypatch.setattr(loop.agents, "analyze", analyze)
    result = loop.run(bundle(), account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"))
    assert peak == 4 and not result["degraded"]


def test_opaque_summary_and_uppercase_identifiers_are_not_numeric_issues(monkeypatch):
    issue = "Confirm summary-0123456789abcdef01234567 against I-0123456789ABCDEF0 in AP-NORTHEAST-2"
    install_models(monkeypatch, [{"issues": [issue]}])
    result = loop.run(bundle(), account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"))
    assert result["review"]["issues"] == [issue]


def test_follow_up_revalidation_updates_coverage_of_pillars_not_rerun(monkeypatch):
    install_models(monkeypatch, [{"follow_up": [
        {"capability": "graph_refresh", "resource_ids": [oid("r-instance")]}],
        "rerun_pillars": ["performance_efficiency"]}])
    refreshed = bundle()
    refreshed["evidence"] = [row for row in refreshed["evidence"] if row["id"] != oid("e-observed")]
    result = loop.run(bundle(), account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"),
                      collect_follow_up=lambda _: refreshed)
    assert result["passes"] == 2 and result["findings"] == []
    assert result["pillar_coverage"]["reliability"] == {
        "status": "partial", "findings": 0, "rejected": 0, "downgraded": 0, "revalidation_dropped": 1}
    assert "pillar:reliability:revalidation_dropped" in result["degraded"]


def test_pass_one_downgrades_are_not_carried_as_rejections(monkeypatch):
    install_models(monkeypatch, [{"follow_up": [
        {"capability": "resource_metrics", "resource_ids": [oid("r-instance")]}],
        "rerun_pillars": ["performance_efficiency"]}])
    monkeypatch.setattr(loop.agents, "analyze", lambda pillar, index, **kw: {"findings": [finding(
        id="finding-reliability", evidence_ids=[oid("e-config")])] if pillar == "reliability" else []})
    refreshed = bundle()
    refreshed["evidence"][2]["facts"]["window_days"] = 15
    result = loop.run(bundle(), account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"),
                      collect_follow_up=lambda _: refreshed)
    assert result["passes"] == 2
    assert result["rejected"] == [{"id": "finding-reliability", "reason": "unconfirmed_observation"}]
    assert "evidence:downgraded" in result["degraded"] and "evidence:rejected" not in result["degraded"]


def test_progress_heartbeat_fires_per_pillar_and_per_pass(monkeypatch):
    install_models(monkeypatch, [{"follow_up": [
        {"capability": "resource_metrics", "resource_ids": [oid("r-instance")]}],
        "rerun_pillars": ["performance_efficiency"]}])
    refreshed = bundle()
    refreshed["evidence"][2]["facts"]["window_days"] = 15
    beats = []
    loop.run(bundle(), account=ACCOUNT, tier="mid", model_id="global.anthropic.claude-sonnet-5-5",
             budget=ReportBudget("mid"), collect_follow_up=lambda _: refreshed,
             progress=lambda stage: beats.append(stage) or 1 / 0)  # a failing heartbeat is ignored
    assert set(beats[:6]) == set(PILLARS)
    assert beats[6:] == ["review", "performance_efficiency", "final_review"]


def test_word_hex_tokens_are_numeric_assertions_not_identifiers():
    from diagnosis import loop
    assert loop._RESOURCE_ID.sub(" ", "Downsize savings approx usd-00000500 monthly") \
        == "Downsize savings approx usd-00000500 monthly"
    assert loop._NUMBER.search(loop._RESOURCE_ID.sub(" ", loop._IDENTIFIER_TOKEN.sub(
        " ", "Downsize savings approx usd-00000500 monthly")))


def test_over_limit_rerun_request_rejects_the_review_instead_of_trimming(monkeypatch):
    request = {"capability": "resource_metrics", "resource_ids": [oid("r-instance")]}
    install_models(monkeypatch, [{"follow_up": [request],
        "rerun_pillars": ["performance_efficiency", "cost_optimization", "reliability"]}])
    result = loop.run(bundle(), account=ACCOUNT, tier="deep",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("deep"),
                      collect_follow_up=lambda requests: pytest.fail("trimmed rerun was executed"))
    assert result["passes"] == 1 and result["review"]["status"] != "completed"
    assert any(r.get("reason") == "review_rerun_limit" for r in result["rejected"])


def test_rerun_without_follow_up_is_disclosed(monkeypatch):
    install_models(monkeypatch, [{"rerun_pillars": ["reliability"]}])
    result = loop.run(bundle(), account=ACCOUNT, tier="deep",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("deep"),
                      collect_follow_up=lambda requests: pytest.fail("no follow-up was requested"))
    assert "rerun:no_follow_up" in result["incomplete"]
