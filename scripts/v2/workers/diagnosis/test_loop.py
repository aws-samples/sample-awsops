from copy import deepcopy
import datetime as dt
import threading

import pytest

from diagnosis import discovery
from diagnosis import loop
from diagnosis.budget import ReportBudget
from diagnosis.evidence import PILLARS
from diagnosis.test_evidence import ACCOUNT, bundle, finding


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


def test_initial_specialists_finish_before_review_and_light_has_no_follow_up(monkeypatch):
    events = install_models(monkeypatch, [{"follow_up": [
        {"capability": "resource_metrics", "resource_ids": ["r-instance"]}],
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
    request = {"capability": "resource_metrics", "resource_ids": ["r-instance"]}
    events = install_models(monkeypatch, [{"follow_up": [request, request],
        "rerun_pillars": ["performance_efficiency", "cost_optimization", "reliability"]}])
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
        {"capability": "graph_refresh", "resource_ids": ["r-instance"]}],
        "rerun_pillars": ["reliability"]}])
    result = loop.run(bundle(), account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"),
                      collect_follow_up=lambda _: bundle())
    assert len(events) == 7 and result["passes"] == 1
    assert "follow_up:no_progress" in result["incomplete"]


def test_fabricated_reviewer_selection_and_requests_fail_closed(monkeypatch):
    events = install_models(monkeypatch, [{"finding_ids": ["invented"], "follow_up": [
        {"capability": "terminate", "resource_ids": ["r-instance"]}]}])
    result = loop.run(bundle(), account=ACCOUNT, tier="deep",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("deep"))
    assert len(events) == 7
    assert result["review"]["status"] == "invalid"
    assert result["degraded"] and result["rejected"]


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
        {"capability": "graph_refresh", "resource_ids": ["r-instance"]}],
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
    data["evidence"] = [row for row in data["evidence"] if row["id"] != "e-config"]
    item = discovery._evidence(
        data, "stored_graph", "configured_dependency", ["r-instance", "r-db"],
        {"relation": "queries", "graph_class": "infra"}, captured,
        region=data["resources"][0]["region"], fresh=True,
        window={"start": "2026-11-04T00:00:00Z", "end": "2026-11-04T00:30:00Z"},
        coverage={"complete": True, "status": "ok"})
    discovery._relationship(data, "r-instance", "r-db", "configured_dependency", item)
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
        {"capability": "graph_refresh", "resource_ids": ["r-instance"]}],
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
        {"capability": "graph_refresh", "resource_ids": ["r-instance"]}],
        "rerun_pillars": ["performance_efficiency", "cost_optimization"]}])
    result = loop.run(first, account=ACCOUNT, tier="mid",
                      model_id="global.anthropic.claude-sonnet-5-5", budget=ReportBudget("mid"),
                      collect_follow_up=lambda _: refreshed)
    assert len(events) == 10 and result["passes"] == 2
    assert events[-1] == "final_review"


@pytest.mark.parametrize("lang", ["ko", "en", "ja", "zh"])
def test_language_reaches_initial_and_followup_model_stages(monkeypatch, lang):
    request = {"capability": "resource_metrics", "resource_ids": ["r-instance"]}
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
