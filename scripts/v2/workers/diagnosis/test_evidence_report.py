"""Offline report-path acceptance; no paid model calls or AWS credentials."""
import pytest

from diagnosis import report
from diagnosis.test_presentation import bundle, analysis


def prepare(monkeypatch, *, data=None, findings=None):
    from diagnosis import discovery, loop, observations, supporting
    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "true")
    monkeypatch.setenv("DIAGNOSIS_NETWORK_EVIDENCE_ENABLED", "false")
    monkeypatch.setattr(discovery, "collect", lambda *a, **kw: data or bundle())
    # Offline: later stages are identity and any SDK client creation fails the test.
    monkeypatch.setattr(observations, "collect", lambda value, *a, **kw: value)
    monkeypatch.setattr(supporting, "collect", lambda value, *a, **kw: value)
    monkeypatch.setattr(discovery, "_client", lambda *a: pytest.fail("offline test created an SDK client"))
    monkeypatch.setattr(supporting, "_client", lambda *a: pytest.fail("offline test created an SDK client"))
    monkeypatch.setattr(loop, "run", lambda *a, **kw: findings or analysis())
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    monkeypatch.setattr(report.src, "collect_all",
                        lambda *a, **kw: pytest.fail("enabled path used legacy collectors"))
    monkeypatch.setattr(report, "_bedrock_render",
                        lambda *a, **kw: pytest.fail("enabled path used free Markdown inference"))


def test_network_collector_runs_in_worker_before_six_pillar_analysis(monkeypatch):
    from diagnosis import discovery, loop, observations
    prepare(monkeypatch)
    state = {}

    def collect(data, budget, *, scope, client_factory):
        state.update(scope=scope, budget=budget, factory=client_factory)
        data["gaps"].append("network_candidate_unresolved")
        return data

    def analyze(data, **options):
        assert "network_candidate_unresolved" in data["gaps"]
        assert options["budget"] is state["budget"]
        return analysis()

    monkeypatch.setattr(observations, "collect", collect)
    monkeypatch.setattr(loop, "run", analyze)
    report.generate(object(), "self")
    assert state["scope"] == "self" and state["factory"] is discovery._client


def test_broken_discovery_connection_is_never_reused(monkeypatch):
    data = bundle()
    data["coverage"]["database_connection_broken"] = True
    prepare(monkeypatch, data=data)
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: pytest.fail("reused conn"))
    with pytest.raises(RuntimeError, match="database_connection_broken"):
        report.generate(object(), "self")


def test_summary_persists_only_projected_rejections(monkeypatch):
    prepare(monkeypatch, findings=analysis(rejected=[{"id": "x", "reason": "r", "explanation": "prose"}]))
    assert report.generate(object(), "self")[1]["rejected_findings"] == [{"id": "x", "reason": "r"}]


@pytest.mark.parametrize("tier,count", [("light", 9), ("mid", 9), ("deep", 16)])
@pytest.mark.parametrize("lang", ["ko", "en", "zh", "ja"])
def test_enabled_report_preserves_catalog_locale_progress_and_local_metadata(monkeypatch, tier, count, lang):
    prepare(monkeypatch)
    progress = []
    md, summary, used = report.generate(object(), "self", tier,
                                       lang=lang, on_progress=lambda *a: progress.append(a))
    assert summary["sections"] == count
    assert summary["evidence_loop"]["enabled"] is True
    assert summary["title_and_tags"]["tags"] == ["performance_efficiency"]
    assert summary["budget"]["attempt_count"] == 0
    assert "17.25" in md
    assert progress[-1][0:2] == (count, count)
    assert len(progress[-1][4]) == count
    assert used


@pytest.mark.parametrize("lang", ["ko", "en", "ja", "zh"])
def test_report_forwards_requested_language_to_analysis(monkeypatch, lang):
    from diagnosis import loop
    prepare(monkeypatch)
    dispatched = []
    monkeypatch.setattr(loop, "run", lambda *a, **kw: dispatched.append(kw["lang"]) or analysis())
    report.generate(object(), "self", lang=lang)
    assert dispatched == [lang]


def test_unsupported_report_language_fails_before_collection(monkeypatch):
    from diagnosis import discovery
    prepare(monkeypatch)
    monkeypatch.setattr(discovery, "collect", lambda *a, **kw: pytest.fail("invalid locale collected"))
    with pytest.raises(ValueError, match="language"):
        report.generate(object(), "self", lang="fr")


def test_disabled_path_does_not_import_discovery_or_change_legacy_calls(monkeypatch):
    monkeypatch.delenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", raising=False)
    monkeypatch.setattr(report.src, "collect_all", lambda *a, **kw: [
        {"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {}}])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **kw: "legacy text")
    md, summary, used = report.generate(object(), "self")
    assert "legacy text" in md and "evidence_loop" not in summary
    assert used == ["inventory"]


def test_enabled_invariant_unknown_and_parent_diff_remain_deterministic(monkeypatch):
    prepare(monkeypatch)
    invariant = {"id": "must-edge", "kind": "expected_edge", "target": "app",
                 "params": {"from": "app", "to": "db"}, "severity": "warning"}
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [invariant])
    monkeypatch.setattr(report.ddb, "get_report_summary",
                        lambda conn, rid: (3, {}) if rid == 4 else (None, {"drift": [invariant]}))
    _, summary, _ = report.generate(object(), "self", report_id=4)
    assert summary["drift"] == []
    assert summary["unassessed"][0]["passed"] is None
    assert summary["diff"]["improvements"] == []


def test_model_stage_failure_is_partial_and_visible_in_report(monkeypatch):
    failed = analysis(findings=[], degraded=["security"], incomplete=["performance_efficiency"])
    prepare(monkeypatch, findings=failed)
    md, summary, _ = report.generate(object(), "self", lang="en")
    assert summary["render_degraded"] == ["security"]
    assert "security" in md
    assert "performance_efficiency" in summary["incomplete"]


def test_discovery_exception_still_produces_visible_partial_report(monkeypatch):
    prepare(monkeypatch)
    from diagnosis import discovery
    monkeypatch.setattr(discovery, "collect",
                        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("private secret detail")))
    md, summary, _ = report.generate(object(), "self", lang="en")
    assert "discovery_failed" in summary["degraded"]
    assert "private secret detail" not in md


@pytest.mark.parametrize("extra,expected_status", [
    ({}, "succeeded"), ({"incomplete": ["inventory_cap", "nfm_categories_omitted"]}, "succeeded"),
    ({"budget_incomplete": ["discovery_deadline"]}, "partial")])
def test_handler_uses_entry_budget_and_skips_enabled_title_model(monkeypatch, extra, expected_status):
    import db as wdb
    import handlers
    from diagnosis import db as ddb
    state = {}

    class Conn:
        def close(self):
            state["closed"] = True

    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "true")
    monkeypatch.setattr(wdb, "connect", lambda: Conn())

    def generate(*args, **kwargs):
        state["budget"] = kwargs["budget"]
        assert state["budget"].remaining(analysis=False) <= 3300
        return "# local report", {"degraded": [], "render_degraded": [], **extra,
                                  "title_and_tags": {"title": "Local title", "tags": ["security"]}}, ["inventory"]

    monkeypatch.setattr(report, "generate", generate)
    monkeypatch.setattr(report, "make_title_and_tags", lambda *a, **kw: pytest.fail("title inferred"))
    monkeypatch.setattr(handlers, "_upload_markdown", lambda *a: "s3://test/report.md")
    monkeypatch.setattr(handlers, "_export_artifacts", lambda *a: None)
    monkeypatch.setattr(ddb, "finish_report", lambda *a, **kw: state.update(finished=kw))
    result, _ = handlers._report({"account": "self", "report_id": 1}, dry_run=False)
    assert result["status"] == expected_status and state["closed"]
    assert state["finished"]["title"] == "Local title"
    assert state["finished"]["summary"]["budget"]["attempt_count"] == 0


@pytest.mark.parametrize("meta", [None, {"title": None}, "x"])
def test_handler_malformed_local_title_falls_back(monkeypatch, meta):
    import db as wdb
    import handlers
    from diagnosis import db as ddb
    state = {}
    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "true")
    monkeypatch.setattr(wdb, "connect", lambda: type("C", (), {"close": lambda self: None})())
    monkeypatch.setattr(report, "generate", lambda *a, **kw: ("# r", {"title_and_tags": meta}, []))
    monkeypatch.setattr(report, "make_title_and_tags", lambda *a: {"title": "Fallback", "tags": []})
    monkeypatch.setattr(handlers, "_upload_markdown", lambda *a: "s3://test/report.md")
    monkeypatch.setattr(handlers, "_export_artifacts", lambda *a: None)
    monkeypatch.setattr(ddb, "finish_report", lambda *a, **kw: state.update(kw))
    assert handlers._report({"account": "self", "report_id": 1}, dry_run=False)[0]["status"] == "succeeded"
    assert state["title"] == "Fallback"


def test_size_bound_truncation_degrades_render(monkeypatch):
    from diagnosis import presentation
    prepare(monkeypatch)
    monkeypatch.setattr(presentation, "MAX_MARKDOWN_BYTES", 600)
    summary = report.generate(object(), "self", lang="en")[1]
    assert summary["render_degraded"] and summary["budget_incomplete"] == []


def test_evidence_summary_separates_budget_cutoffs_from_caps(monkeypatch):
    data = bundle()
    data["incomplete"] = ["inventory_cap", "discovery_deadline"]
    prepare(monkeypatch, data=data)
    summary = report.generate(object(), "self")[1]
    assert summary["budget_incomplete"] == ["discovery_deadline"]


def test_payload_cannot_enable_evidence_path(monkeypatch):
    import db as wdb
    import handlers
    from diagnosis import db as ddb
    monkeypatch.delenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", raising=False)
    state = {}

    class Conn:
        def close(self):
            pass

    def generate(*a, **kw):
        assert "budget" not in kw
        return "# legacy", {"degraded": []}, []

    monkeypatch.setattr(wdb, "connect", lambda: Conn())
    monkeypatch.setattr(report, "generate", generate)
    monkeypatch.setattr(report, "make_title_and_tags",
                        lambda *a: state.update(title_called=True) or {"title": None, "tags": []})
    monkeypatch.setattr(handlers, "_upload_markdown", lambda *a: "s3://test/report.md")
    monkeypatch.setattr(handlers, "_export_artifacts", lambda *a: None)
    monkeypatch.setattr(ddb, "finish_report", lambda *a, **kw: None)
    handlers._report({"account": "self", "report_id": 1, "diagnosis_evidence_loop_enabled": True},
                     dry_run=False)
    assert state["title_called"]


def test_actual_structured_loop_admits_pair_and_summary_without_model_numbers(monkeypatch):
    """Exercise serialization, six stages, review, admission and presentation together."""
    import io
    import json
    from diagnosis import discovery, pillar_agents, supporting
    from diagnosis.budget import ReportBudget
    from diagnosis.test_evidence import ACCOUNT, bundle as actual_bundle, finding

    data = actual_bundle()
    data["evidence"].append({
        "id": "summary-cost", "source": "cost", "kind": "scope_summary",
        "resource_ids": [], "account": ACCOUNT, "region": "global",
        "fresh": True, "captured_at": "2026-11-04T00:00:00Z",
        "facts": {"cost_groups": [{"service": "Amazon EC2", "amount": 123.75,
                                   "currency": "USD", "estimated": True}],
                  "resource_cost": False, "partial_month": True},
        "coverage": {"complete": True}, "window": {"start": "2026-11-01", "end": "2026-11-04"},
    })
    data["evidence"].append({
        "id": "summary-posture", "source": "posture", "kind": "scope_summary",
        "resource_ids": [], "account": ACCOUNT, "region": "ap-northeast-2",
        "fresh": True, "captured_at": "2026-11-04T00:00:00Z",
        "facts": {"posture_counts": {"HIGH": 7}, "sampled": True},
        "coverage": {"complete": False},
    })

    class Bedrock:
        def invoke_model(self, *, modelId, body):
            request = json.loads(body)
            assert request["output_config"]["format"]["type"] == "json_schema"
            assert request["thinking"] == {"type": "adaptive"}
            assert "temperature" not in request
            context = json.loads(request["messages"][0]["content"][0]["text"])
            schema = request["output_config"]["format"]["schema"]["properties"]
            if "findings" in schema:
                pillar = request["system"].split("Required pillar key: ")[1].rstrip(".")
                rows = []
                if pillar == "reliability":
                    rows = [finding(), finding(id="fabricated", evidence_ids=["invented"])]
                elif pillar == "cost_optimization":
                    rows = [finding(id="account-cost", pillar=pillar, resource_ids=[],
                                    evidence_ids=["summary-cost"], claim="hypothesis",
                                    explanation="Service spend needs resource attribution.",
                                    verification="none")]
                elif pillar == "security":
                    rows = [finding(id="account-posture", pillar=pillar, resource_ids=[],
                                    evidence_ids=["summary-posture"], claim="hypothesis",
                                    explanation="The sampled posture needs investigation.",
                                    verification="none")]
                output = {"findings": rows}
            else:
                output = {"finding_ids": [row["id"] for row in context["findings"]],
                          "reject_ids": [], "follow_up": [], "rerun_pillars": [], "issues": []}
            payload = {"stop_reason": "end_turn", "content": [
                {"type": "text", "text": json.dumps(output)}],
                "usage": {"input_tokens": 250, "output_tokens": 80}}
            return {"body": io.BytesIO(json.dumps(payload).encode())}

    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "true")
    monkeypatch.setattr(discovery, "collect", lambda *a, **kw: data)
    monkeypatch.setattr(supporting, "collect", lambda value, *a, **kw: value)
    monkeypatch.setattr(pillar_agents, "_client", lambda *a: Bedrock())
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    monkeypatch.setattr(report, "_bedrock_render", lambda *a: pytest.fail("free Markdown inference"))
    md, summary, used = report.generate(object(), ACCOUNT, "light", lang="en",
                                       budget=ReportBudget("light"))
    assert summary["budget"]["attempt_count"] == 7
    assert summary["pillar_coverage"]["reliability"]["status"] == "partial"
    assert any(row["id"] == "fabricated" for row in summary["rejected_findings"])
    assert "123.75" in md and "USD" in md and "posture" in used
    assert "posture&#95;counts.HIGH = 7" in md
    assert "i-0123456789abcdef0" in md and "database" in md
    assert "scope&#95;summary" in md and "global" in md


def test_actual_discovery_to_report_preserves_two_same_service_pairs(monkeypatch):
    import io
    import json
    import html
    from diagnosis import discovery, pillar_agents, supporting
    from diagnosis.test_discovery import ACCOUNT, NOW, I1, I2, Provider, graph_fixture

    fake = Provider()
    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "true")
    monkeypatch.setenv("DIAGNOSIS_HOST_ACCOUNT_ID", ACCOUNT)
    monkeypatch.setattr(discovery, "_now", lambda: NOW)
    monkeypatch.setattr(discovery, "_client", lambda *a: fake)
    monkeypatch.setattr(supporting, "collect", lambda value, *a, **kw: value)
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    observed_pairs = []

    class Bedrock:
        def invoke_model(self, *, modelId, body):
            request = json.loads(body)
            context = json.loads(request["messages"][0]["content"][0]["text"])
            if "Required pillar key: " in request["system"]:
                pillar = request["system"].split("Required pillar key: ")[1].rstrip(".")
                findings = []
                if pillar == "reliability":
                    resources = {row["id"]: row for row in context["resources"]}
                    for edge in context["relationships"]:
                        if (edge["kind"] != "observed_call"
                                or resources[edge["source"]]["kind"] != "ec2"
                                or resources[edge["target"]]["kind"] != "rds"):
                            continue
                        observed_pairs.append((resources[edge["source"]]["resource_id"],
                                               resources[edge["target"]]["resource_id"]))
                        findings.append({
                            "id": f"pair-{len(findings)}", "pillar": pillar, "severity": "medium",
                            "resource_ids": [edge["source"], edge["target"]],
                            "evidence_ids": edge["evidence_ids"], "claim": "observation",
                            "explanation": "This sampled call preserves its instance and database.",
                            "prerequisites": [], "verification": "graph_refresh"})
                output = {"findings": findings}
            else:
                output = {"finding_ids": [row["id"] for row in context["findings"]],
                          "reject_ids": [], "follow_up": [], "rerun_pillars": [], "issues": []}
            return {"body": io.BytesIO(json.dumps({
                "stop_reason": "end_turn",
                "content": [{"type": "text", "text": json.dumps(output)}],
                "usage": {"input_tokens": 250, "output_tokens": 80},
            }).encode())}

    monkeypatch.setattr(pillar_agents, "_client", lambda *a: Bedrock())
    md, summary, _ = report.generate(graph_fixture(), ACCOUNT, "light", lang="en")
    # Source redaction keeps native IDs but removes the actual account from model context.
    assert set(observed_pairs) == {(I1, "db1"), (I2, "db2")}
    assert summary["pillar_coverage"]["reliability"]["findings"] == 2
    assert summary["pillar_coverage"]["reliability"]["status"] == "completed"
    assert summary["budget"]["attempt_count"] == 7
    md = html.unescape(md)
    assert f"`{I1}`, `db1`" in md and f"`{I2}`, `db2`" in md
    assert f"`{I1}`, `db2`" not in md and f"`{I2}`, `db1`" not in md


@pytest.mark.parametrize("stage,error", [("observations", KeyError), ("supporting", TimeoutError)])
def test_late_stage_failure_keeps_discovered_resources(monkeypatch, stage, error):
    from diagnosis import observations, supporting
    prepare(monkeypatch)

    def fail(data, *a, **kw):
        data["resources"].clear()  # a partial in-place mutation must not survive the failure
        raise error("stage")

    monkeypatch.setattr(observations if stage == "observations" else supporting, "collect", fail)
    md, summary, used = report.generate(object(), "self", lang="en")
    assert summary["discovery"]["resources"] == 1
    assert f"{stage}_failed" in summary["degraded"]
    assert f"{stage}_failed" in summary["discovery"]["gaps"]
    assert "discovery_failed" not in summary["degraded"]
    assert "cloudwatch" in used and "i-0123456789abcdef0" in md


def test_model_prerequisite_with_mutating_cli_is_withheld_and_degrades(monkeypatch):
    from diagnosis.test_presentation import finding
    unsafe = finding(prerequisites=["Run aws rds delete-db-instance --db-instance-identifier orders",
                                    "Confirm owner approval."])
    prepare(monkeypatch, findings=analysis(findings=[unsafe]))
    md, summary, _ = report.generate(object(), "self", lang="en")
    assert "delete-db-instance" not in md
    assert "Confirm owner approval." in md
    assert report._MUTATING_MARK["en"].strip() in md
    assert summary["render_degraded"] == ["compute_infrastructure"]


def test_read_only_prerequisites_do_not_degrade_render(monkeypatch):
    prepare(monkeypatch)
    _, summary, _ = report.generate(object(), "self", lang="en")
    assert summary["render_degraded"] == []
