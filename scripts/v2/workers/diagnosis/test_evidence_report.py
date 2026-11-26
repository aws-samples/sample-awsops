"""Offline report-path acceptance; no paid model calls or AWS credentials."""
import re
import pytest

from diagnosis import report
from diagnosis.test_evidence import oid
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


def test_analysis_heartbeat_reaches_report_progress_per_pillar(monkeypatch):
    from diagnosis import loop
    from diagnosis.evidence import PILLARS
    prepare(monkeypatch)

    def run(*args, progress, **kwargs):
        for stage in (*PILLARS, "review"):
            progress(stage)
        return analysis()

    monkeypatch.setattr(loop, "run", run)
    beats = []
    report.generate(object(), "self", on_progress=lambda *a: beats.append(a))
    sections = [row[2] for row in beats if row[2].startswith("Six pillars: ")]
    assert sections == [f"Six pillars: {stage}" for stage in (*PILLARS, "review")]


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
    assert summary["sections"] == len(re.findall(r"^## ", md, re.M)) == 11
    assert len(re.findall(r"^### ", md.split("\n## ")[-1], re.M)) == count - 1
    assert summary["evidence_loop"]["enabled"] is True
    assert summary["title_and_tags"]["tags"] == ["Amazon EC2", "CloudWatch", "performance_efficiency"]
    assert summary["budget"]["attempt_count"] == 0
    assert "17.25" in md
    assert progress[-1][0:2] == (11, 11)
    assert len(progress[-1][4]) == 11
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
        md = "# local report\n- [근거 부록](#evidence_appendix)\n\n## 진단 의견\n\nDecision.\n\n## 근거 부록\n\nAudit ledger."
        return md, {"degraded": [], "render_degraded": [], **extra,
                                  "title_and_tags": {"title": "Local title", "tags": ["security"]}}, ["inventory"]

    monkeypatch.setattr(report, "generate", generate)
    monkeypatch.setattr(report, "make_title_and_tags", lambda *a, **kw: pytest.fail("title inferred"))
    monkeypatch.setattr(handlers, "_upload_markdown", lambda *a: "s3://test/report.md")
    monkeypatch.setattr(handlers, "_export_artifacts", lambda md, rid: state.update(customer_export=md))
    monkeypatch.setattr(ddb, "finish_report", lambda *a, **kw: state.update(finished=kw))
    result, _ = handlers._report({"account": "self", "report_id": 1}, dry_run=False)
    assert result["status"] == expected_status and state["closed"]
    assert "Decision." in state["customer_export"] and "Audit ledger." not in state["customer_export"]
    assert state["finished"]["title"] == "Local title"
    assert state["finished"]["summary"]["budget"]["attempt_count"] == 0


@pytest.mark.parametrize("failure", [True, False])
def test_handler_never_writes_through_a_broken_discovery_connection(monkeypatch, failure):
    import db as wdb
    import handlers
    from diagnosis import db as ddb
    conns, writes = [], []

    class Conn:
        closed = False

        def close(self):
            self.closed = True

    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "false")
    monkeypatch.setattr(wdb, "connect", lambda: conns.append(Conn()) or conns[-1])

    def generate(*args, **kwargs):
        if failure:  # discovery broke (and closed) the connection before analysis
            raise RuntimeError("database_connection_broken")
        # A follow-up graph refresh broke it mid-analysis; the report still renders.
        return "# r", {"degraded": ["database_connection_broken"], "title_and_tags": None}, []

    monkeypatch.setattr(report, "generate", generate)
    monkeypatch.setattr(report, "make_title_and_tags", lambda *a: {"title": "T", "tags": []})
    monkeypatch.setattr(handlers, "_upload_markdown", lambda *a: "s3://test/report.md")
    monkeypatch.setattr(handlers, "_export_artifacts", lambda *a: None)
    monkeypatch.setattr(ddb, "finish_report", lambda conn, *a, **kw: writes.append((conn, kw["status"])))
    if failure:
        with pytest.raises(RuntimeError, match="database_connection_broken"):
            handlers._report({"account": "self", "report_id": 1}, dry_run=False)
    else:
        assert handlers._report({"account": "self", "report_id": 1}, dry_run=False)[0]["status"] == "partial"
    assert len(conns) == 2 and len(writes) == 1
    assert writes[0] == (conns[1], "failed" if failure else "partial")
    assert all(conn.closed for conn in conns)


@pytest.mark.parametrize("meta", [None, {"title": None}, "x"])
def test_handler_malformed_local_title_falls_back(monkeypatch, meta):
    import db as wdb
    import handlers
    from diagnosis import db as ddb
    state = {}
    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "true")
    monkeypatch.setattr(wdb, "connect", lambda: type("C", (), {"close": lambda self: None})())
    monkeypatch.setattr(report, "generate", lambda *a, **kw: ("# r", {"title_and_tags": meta}, []))
    monkeypatch.setattr(report, "make_title_and_tags", lambda *a: pytest.fail("unbudgeted title call"))
    monkeypatch.setattr(handlers, "_upload_markdown", lambda *a: "s3://test/report.md")
    monkeypatch.setattr(handlers, "_export_artifacts", lambda *a: None)
    monkeypatch.setattr(ddb, "finish_report", lambda *a, **kw: state.update(kw))
    assert handlers._report({"account": "self", "report_id": 1}, dry_run=False)[0]["status"] == "succeeded"
    assert state["title"] is None and state["tags"] == []


def test_handler_upload_failure_after_broken_connection_is_persisted(monkeypatch):
    import db as wdb
    import handlers
    from diagnosis import db as ddb
    connections, writes = [], []

    class Conn:
        closed = False

        def close(self):
            self.closed = True

    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "true")
    monkeypatch.setattr(wdb, "connect", lambda: connections.append(Conn()) or connections[-1])

    def generate(*args, **kwargs):
        connections[0].close()
        return "# r", {"degraded": ["database_connection_broken"]}, []

    def finish(conn, report_id, **fields):
        assert not conn.closed, "report write reused closed connection"
        writes.append(fields)

    def upload(*args):
        raise RuntimeError("artifact upload failed")

    monkeypatch.setattr(report, "generate", generate)
    monkeypatch.setattr(handlers, "_upload_markdown", upload)
    monkeypatch.setattr(ddb, "finish_report", finish)
    with pytest.raises(RuntimeError, match="artifact upload failed"):
        handlers._report({"account": "self", "report_id": 1}, dry_run=False)
    assert writes == [{"status": "failed", "error": "artifact upload failed"}]
    assert len(connections) == 2 and all(c.closed for c in connections)


def test_final_report_write_recovers_without_a_prior_broken_marker(monkeypatch):
    import db as wdb
    import handlers
    from diagnosis import db as ddb
    connections, writes = [], []

    class Conn:
        closed = False

        def close(self):
            self.closed = True

    original, fresh = Conn(), Conn()
    monkeypatch.setattr(wdb, "connect", lambda: connections.append(fresh) or fresh)

    def finish(conn, report_id, **fields):
        writes.append(conn)
        if conn is original:
            raise RuntimeError("transport unavailable")
        return report_id

    monkeypatch.setattr(ddb, "finish_report", finish)
    assert handlers._finish_report(wdb, ddb, original, False, 1, status="failed") == 1
    assert writes == [original, fresh] and connections == [fresh]
    assert original.closed and fresh.closed


def test_unknown_enabled_tier_persists_failure_before_rethrow(monkeypatch):
    import db as wdb
    import handlers
    from diagnosis import db as ddb
    finished = []
    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "true")
    monkeypatch.setattr(wdb, "connect", lambda: type("C", (), {"close": lambda self: None})())
    monkeypatch.setattr(ddb, "finish_report", lambda *a, **kw: finished.append(kw))
    monkeypatch.setattr(report, "generate", lambda *a, **kw: pytest.fail("invalid tier reached generation"))
    with pytest.raises(ValueError):
        handlers._report({"account": "self", "tier": "unknown", "report_id": 1}, dry_run=False)
    assert len(finished) == 1 and finished[0]["status"] == "failed"

def test_missing_supporting_host_identity_produces_a_partial_report(monkeypatch):
    import db as wdb
    import handlers
    from diagnosis import db as ddb, supporting
    collect = supporting.collect
    data = bundle()
    data["coverage"].update(account="111122223333", storage_scope="self")
    prepare(monkeypatch, data=data)
    monkeypatch.setattr(supporting, "collect", collect)
    monkeypatch.delenv("DIAGNOSIS_HOST_ACCOUNT_ID", raising=False)
    monkeypatch.setattr(wdb, "connect", lambda: type("C", (), {"close": lambda self: None})())
    monkeypatch.setattr(handlers, "_upload_markdown", lambda *a: "s3://test/report.md")
    monkeypatch.setattr(handlers, "_export_artifacts", lambda *a: None)
    finished = []
    monkeypatch.setattr(ddb, "finish_report", lambda *a, **kw: finished.append(kw))
    monkeypatch.setattr(ddb, "get_report_summary", lambda *a: (None, None))
    monkeypatch.setattr(ddb, "update_progress", lambda *a, **kw: None)
    result, _ = handlers._report({"account": "self", "report_id": 1}, dry_run=False)
    assert result["status"] == finished[0]["status"] == "partial"
    assert "supporting_host_unknown" in finished[0]["summary"]["degraded"]


def test_size_bound_truncation_degrades_render(monkeypatch):
    from diagnosis import presentation
    prepare(monkeypatch)
    monkeypatch.setattr(presentation, "MAX_MARKDOWN_BYTES", 600)
    summary = report.generate(object(), "self", lang="en")[1]
    assert summary["render_degraded"] and summary["budget_incomplete"] == []


def test_evidence_summary_separates_budget_cutoffs_from_caps(monkeypatch):
    data = bundle()
    data["incomplete"] = ["inventory_cap", "discovery_deadline", "supporting_deadline_exhausted",
                          "follow_up:budget_exhausted", "proxy_cap"]
    prepare(monkeypatch, data=data)
    summary = report.generate(object(), "self")[1]
    assert summary["budget_incomplete"] == ["discovery_deadline", "supporting_deadline_exhausted",
                                            "follow_up:budget_exhausted"]


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
        "id": oid("summary-cost"), "source": "cost", "kind": "scope_summary",
        "resource_ids": [], "account": ACCOUNT, "region": "global",
        "fresh": True, "captured_at": "2026-11-04T00:00:00Z",
        "facts": {"cost_groups": [{"service": "Amazon EC2", "amount": 123.75,
                                   "currency": "USD", "estimated": True}],
                  "resource_cost": False, "partial_month": True},
        "coverage": {"complete": True}, "window": {"start": "2026-11-01", "end": "2026-11-04"},
    })
    data["evidence"].append({
        "id": oid("summary-posture"), "source": "posture", "kind": "scope_summary",
        "resource_ids": [], "account": ACCOUNT, "region": "ap-northeast-2",
        "fresh": True, "captured_at": "2026-11-04T00:00:00Z",
        "facts": {"posture_counts": {"HIGH": 7}, "sampled": True},
        "coverage": {"complete": False},
    })

    class Bedrock:
        def invoke_model(self, *, modelId, body):
            request = json.loads(body)
            # report._thinking_fields parity: Sonnet 5.5 thinking off; no output_config.
            assert "output_config" not in request
            assert request["thinking"] == {"type": "between_tools"}
            assert "temperature" not in request
            context = json.loads(request["messages"][0]["content"][0]["text"])
            if "candidates" in context:
                row = context["candidates"][0]
                output = {"lead": [row["id"]], "context": [], "next": [row["id"]],
                          "paragraphs": [] if row["claim"] == "observation" else [{"id": row["id"], "text": row["explanation"]}]}
            elif "pairs" in context:
                output = {"accepted": [row["source"]["id"] for row in context["pairs"]]}
            elif "findings" not in context:
                pillar = request["system"].split("Required pillar key: ")[1].split(".", 1)[0]
                rows = []
                if pillar == "reliability":
                    rows = [finding(), finding(id="fabricated", evidence_ids=["invented"])]
                elif pillar == "cost_optimization":
                    rows = [finding(id="account-cost", pillar=pillar, resource_ids=[],
                                    evidence_ids=[oid("summary-cost")], claim="hypothesis",
                                    explanation="Service spend needs resource attribution.",
                                    verification="none")]
                elif pillar == "security":
                    rows = [finding(id="account-posture", pillar=pillar, resource_ids=[],
                                    evidence_ids=[oid("summary-posture")], claim="hypothesis",
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
    assert summary["budget"]["attempt_count"] == 9
    assert [s["stage"] for s in summary["model_stages"][-2:]] == ["report_editor", "report_editor_check"]
    assert summary["pillar_coverage"]["reliability"]["status"] == "partial"
    assert any(row["id"] == "rel:fabricated" for row in summary["rejected_findings"])
    assert "123.75" in md and "USD" in md and "posture" in used
    assert "` posture_counts.HIGH ` = ` 7 `" in md
    assert "i-0123456789abcdef0" in md and "database" in md
    assert "scope_summary" in md and "global" in md


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
            if "candidates" in context:
                row = context["candidates"][0]
                output = {"lead": [row["id"]], "context": [], "next": [row["id"]],
                          "paragraphs": [] if row["claim"] == "observation" else [{"id": row["id"], "text": row["explanation"]}]}
            elif "pairs" in context:
                output = {"accepted": [row["source"]["id"] for row in context["pairs"]]}
            elif "Required pillar key: " in request["system"]:
                pillar = request["system"].split("Required pillar key: ")[1].split(".", 1)[0]
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
    assert summary["budget"]["attempt_count"] == 8
    assert summary["model_stages"][-1]["stage"] == "report_editor"
    md = html.unescape(md)
    assert f"` {I1} `, ` db1 `" in md and f"` {I2} `, ` db2 `" in md
    assert f"` {I1} `, ` db2 `" not in md and f"` {I2} `, ` db1 `" not in md


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


@pytest.mark.parametrize("model_id", ["global.openai.gpt-6.1-terra", "claude-sonnet-5-5"])
def test_non_bedrock_claude_provider_model_degrades_without_model_calls(monkeypatch, model_id):
    """bedrock_openai / anthropic_api diagnosis models cannot run the evidence loop."""
    from diagnosis import discovery, pillar_agents, supporting
    from diagnosis.budget import ReportBudget
    from diagnosis.test_evidence import ACCOUNT, bundle as actual_bundle
    monkeypatch.setenv("DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "true")
    monkeypatch.setattr(report, "_MODEL_SONNET", model_id)
    monkeypatch.setattr(discovery, "collect", lambda *a, **kw: actual_bundle())
    monkeypatch.setattr(supporting, "collect", lambda value, *a, **kw: value)
    monkeypatch.setattr(pillar_agents, "_client", lambda *a: pytest.fail("model call"))
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    monkeypatch.setattr(report, "_bedrock_render", lambda *a: pytest.fail("free Markdown inference"))
    md, summary, _ = report.generate(object(), ACCOUNT, "mid", lang="en", budget=ReportBudget("mid"))
    assert "analysis:unsupported_model" in summary["degraded"] and md
    assert summary["budget"]["attempt_count"] == 0
    assert {row["status"] for row in summary["pillar_coverage"].values()} == {"failed"}


def test_connection_broken_during_follow_up_keeps_the_rendered_report(monkeypatch):
    from diagnosis import discovery, loop
    prepare(monkeypatch)

    def broken_follow_up(conn, account, data, requests, budget):
        data["coverage"]["database_connection_broken"] = True
        return data

    def run(data, **options):
        options["collect_follow_up"]([{"resource_id": "r"}])
        return analysis()

    monkeypatch.setattr(discovery, "follow_up", broken_follow_up)
    monkeypatch.setattr(loop, "run", run)
    monkeypatch.setattr(report.ddb, "get_report_summary", lambda *a: pytest.fail("reused a closed conn"))
    md, summary, _ = report.generate(object(), "self", report_id=4)
    assert md and "database_connection_broken" in summary["degraded"] and "diff" not in summary


@pytest.mark.parametrize("failure", ["number", "scope", "unsupported"])
def test_editor_rejects_new_facts_wrong_citations_and_unverified_paragraphs(monkeypatch, failure):
    from diagnosis import pillar_agents
    from diagnosis.pillar_agents import ModelStageError
    from diagnosis.test_presentation import finding

    def reply(stage, *args, **kwargs):
        if stage == "report_editor":
            draft = {"lead": ["F1"], "context": [], "next": [],
                    "paragraphs": [{"id": "F2" if failure == "scope" else "F1",
                                    "text": "Memory is 99% full." if failure == "number" else
                                            "Memory pressure needs verification."}], "_stage": {}}
            kwargs["validate"](draft)
            return draft
        assert failure == "unsupported"
        return {"accepted": [], "_stage": {}}
    monkeypatch.setattr(pillar_agents, "_structured", reply)
    with pytest.raises(ModelStageError):
        pillar_agents.edit_report([finding()], model_id="test", budget=None, lang="en")


def test_reader_body_qualifies_hypothesis_without_unrelated_measurement(monkeypatch):
    data = bundle()
    data["evidence"][0]["facts"]["metrics"] = {
        "CPUUtilization": {"Maximum": {"max": 25.25, "unit": "Percent", "status": "Complete"}}}
    prepare(monkeypatch, data=data)
    md, _, _ = report.generate(object(), "self", lang="en")
    body, appendix = md.split("\n## Evidence appendix\n", 1)
    assert "2026-11-04" in body
    assert "25.25" not in body and "25.25" in appendix
    assert "Memory pressure needs verification." in body
    assert "| Evidence | Scope / window |" not in body
    assert data["evidence"][0]["id"] not in body and data["evidence"][0]["id"] in appendix


def test_editor_selection_cannot_hide_critical_or_unassessed_pillars(monkeypatch):
    from diagnosis.test_presentation import finding
    rows = [finding(id="minor", severity="low"), finding(id="urgent", pillar="security",
            severity="critical", explanation="Access controls need verification.")]
    prepare(monkeypatch, findings=analysis(findings=rows, editor_plan={
        "lead": ["minor"], "context": [], "next": [], "paragraphs": {}}))
    md, _, _ = report.generate(object(), "self", lang="en")
    body = md.split("\n## Evidence appendix")[0]
    assert "[Critical]" in body.split("\n## Operational Excellence")[0]
    assert "Access controls need verification." in body.split("\n## Security")[1].split("\n## ")[0]
    assert "Unassessed" in body.split("\n## Sustainability")[1].split("\n## ")[0]

def test_bounded_report_preserves_pillars_and_evidence_with_large_resource_names(monkeypatch):
    from diagnosis.test_presentation import finding
    from diagnosis.evidence import PILLARS
    from diagnosis import presentation
    data = bundle()
    refs = []
    for i in range(16):
        data["resources"].append({**data["resources"][0], "id": str(i),
                                  "resource_id": "가" * 240})
        refs.append(str(i))
    rows = [finding(id=f"{pillar}-{i}", pillar=pillar, resource_ids=refs)
            for pillar in PILLARS for i in range(8)]
    prepare(monkeypatch, data=data, findings=analysis(findings=rows))
    md, summary, _ = report.generate(object(), "self", lang="en")
    assert len(md.encode()) <= presentation.MAX_MARKDOWN_BYTES
    assert len(md.split("\n## Evidence appendix")[1].encode()) > 1024
    assert any(key in PILLARS for key in summary["render_degraded"])


def test_customer_guide_distinguishes_calls_flows_and_configuration():
    from diagnosis.architecture import section
    resources = [{"id": k, "resource_id": k, "kind": "test"} for k in ("service-A", "database-B")]
    evidence, edges = [], []
    for kind in ("configured_dependency", "observed_network_flow", "observed_call"):
        evidence.append({"id": kind, "kind": kind, "source": "fixture", "resource_ids": ["service-A", "database-B"],
                         "facts": {}, "fresh": False, "coverage": {"complete": False, "sampled": True}})
        edges.append({"id": kind, "kind": kind, "source": "service-A", "target": "database-B", "evidence_ids": [kind]})
    body = section({"resources": resources, "evidence": evidence, "relationships": edges}, "en")["body"]
    for row in body.splitlines():
        if row.startswith("| Observed call"):
            assert "→" in row and "stale" in row
        if row.startswith(("| Configuration", "| Network flow")):
            assert "→" not in row and " / " in row
    assert all(name in body for name in ["Observed call", "Network flow", "Configuration", "3 / 3"])
    assert "No relationship with verified endpoints" in section({"resources": resources}, "en")["body"]


def test_customer_guide_prioritizes_admitted_checks_and_keeps_local_detail(monkeypatch):
    from diagnosis.test_presentation import finding
    findings = [finding(id="other", severity="medium", prerequisites=["Compare wait times."]),
                finding(id="first", pillar="security", severity="high", prerequisites=["Confirm data classification."])]
    prepare(monkeypatch, findings=analysis(findings=findings, editor_plan={
        "lead": ["other"], "next": ["other"], "context": [], "paragraphs": {}}))
    md, _, _ = report.generate(object(), "self", lang="en")
    front, pillars = md.split("\n## Current architecture\n", 1)
    assert "Confirm data classification." in front.split("### Immediate checks")[1]
    sec = pillars.split("\n## Security\n")[1].split("\n## ")[0]
    assert "Confirm data classification." in sec and "Decision criteria" in sec

def test_executive_brief_ranks_admitted_findings_before_editor_preference(monkeypatch):
    from diagnosis.test_presentation import finding
    rows = [finding(id=str(i), severity="low", explanation=text) for i, text in enumerate(
        ["Review demand.", "Review trend.", "Review capacity."])]
    rows.append(finding(id="important", pillar="security", severity="high", explanation="Review exposure."))
    prepare(monkeypatch, findings=analysis(findings=rows, editor_plan={
        "lead": ["0"], "next": [], "context": [], "paragraphs": {}}))
    md, _, _ = report.generate(object(), "self", lang="en")
    top = md.split("### Top risks")[1].split("### Immediate checks")[0]
    assert "| 1 | Security · High |" in top and "Review exposure." in top
    assert "| 3 |" in top and "| 4 |" not in top and "cloudwatch" in top


def test_report_architecture_masks_fact_values_before_formatting_verified_edges(monkeypatch):
    data = bundle()
    endpoint = data["resources"][0]
    peer = {**endpoint, "id": oid("r-peer"), "resource_id": "peer"}
    data["resources"].append(peer)
    refs = [endpoint["id"], peer["id"]]
    relationship = {"id": oid("binding"), "source": refs[0], "target": refs[1],
                    "kind": "configured_dependency", "evidence_ids": [oid("edge-evidence")]}
    data["relationships"] = [relationship]
    data["evidence"].append({"id": oid("edge-evidence"), "kind": relationship["kind"],
                             "source": "stored_graph", "resource_ids": refs, "fresh": True,
                             "regions": ["us-east-1"], "coverage": {"complete": True},
                             "facts": {"relation": "relation.example.internal",
                                       "resource_binding": "binding.example.internal"}})
    prepare(monkeypatch, data=data, findings=analysis(findings=[], evidence_bundle=data))
    md, _, _ = report.generate(object(), "self", lang="en")
    architecture = md.split("\n## Current architecture\n", 1)[1].split("\n## ", 1)[0]
    assert "Configuration" in architecture and "stored_graph" in architecture and "us-east-1" in architecture
    assert "relation.example.internal" not in architecture and "binding.example.internal" not in architecture
    assert "<host> · <host>" in architecture


def test_architecture_distinguishes_telemetry_services_from_inventory():
    from diagnosis.architecture import section
    nodes = [{"id": "left", "kind": "service", "resource_id": "xray:3", "region": "us-east-1",
              "facts": {"name": "checkout"}},
             {"id": "right", "kind": "service", "resource_id": "xray:7", "region": "us-east-1",
              "facts": {"name": "orders"}},
             {"id": "db", "kind": "rds", "resource_id": "backend", "facts": {}}]
    e = {"id": "call", "kind": "observed_call", "source": "xray", "resource_ids": ["left", "right"],
         "facts": {"resource_binding": "unresolved"}, "coverage": {"sampled": True}, "fresh": True}
    data = {"resources": nodes, "evidence": [e], "relationships": [
        {"id": "pair", "kind": "observed_call", "source": "left", "target": "right", "evidence_ids": ["call"]}]}
    body = section(data, "en")["body"]
    inventory, telem = body.split("### Services in telemetry")
    assert "backend" in inventory and "checkout" not in inventory
    table, relationships = telem.split("| Relationship |")
    assert "2" in table and ("checkout" in table or "orders" in table)
    assert "checkout" in relationships and "orders" in relationships and "→" in relationships
    assert "workload binding unverified" in relationships and "xray:3" not in body
    nodes[0]["facts"]["name"] = "orders"
    same_name_pair = section(data, "en")["body"].split("| Relationship |")[1]
    assert "xray:3" in same_name_pair and "xray:7" in same_name_pair
    nodes[0]["facts"] = {}
    assert "xray:3" in section(data, "en")["body"]
    nodes[0]["facts"]["name"] = "private.service.internal"
    assert "private.service.internal" not in section(data, "en")["body"]


def test_architecture_groups_correlated_flows_but_preserves_directed_call_pairs():
    from diagnosis.architecture import section
    nodes = [{"id": k, "resource_id": k, "kind": "ec2"} for k in ("left", "right")]
    edges, evidence = [], []
    for n, (kind, left, right) in enumerate([
            ("observed_network_flow", "left", "right"),
            ("observed_network_flow", "left", "right"),
            ("observed_network_flow", "right", "left"),
            ("observed_call", "left", "right"), ("observed_call", "right", "left")]):
        key = f"record-{n}"
        facts = {"binding": "dns_window_correlation"} if n == 1 else {}
        evidence.append({"id": key, "source": "flow" if n < 3 else "trace", "kind": kind,
                         "fresh": True, "facts": facts, "coverage": {"truncated": True, "complete": False}})
        edges.append({"id": f"edge-{n}", "source": left, "target": right, "kind": kind,
                      "evidence_ids": [key]})
    body = section({"resources": nodes, "evidence": evidence, "relationships": edges}, "en")["body"]
    assert body.count("| Network flow") == 1 and body.count("| Observed call") == 2
    assert "3 / 3" in body and "DNS-window correlation" in body and "truncated" in body
    assert "` left ` → ` right `" in body and "` right ` → ` left `" in body


@pytest.mark.parametrize("accepted,valid", [(["F1"], True), (["F1", "F1"], False), (["F1", "F3"], False)])
def test_editor_preserves_only_verified_rewrites(monkeypatch, accepted, valid):
    from diagnosis import pillar_agents
    from diagnosis.test_presentation import finding

    rows = [finding(id="first"), finding(id="second")]
    def reply(stage, *args, **kwargs):
        meta = {"stage": stage, "status": "succeeded"}
        if stage == "report_editor_check":
            return {"accepted": accepted, "_stage": meta}
        draft = {"lead": ["F1"], "context": ["F2"], "next": [], "_stage": meta,
                 "paragraphs": [{"id": "F1", "text": "Review available memory."},
                                {"id": "F2", "text": "Unconfirmed explanation."}]}
        kwargs["validate"](draft)
        return draft
    monkeypatch.setattr(pillar_agents, "_structured", reply)
    if not valid:
        with pytest.raises(pillar_agents.ModelStageError, match="editor_verification_failed"):
            pillar_agents.edit_report(rows, model_id="test", budget=None, lang="en")
        return
    plan, stages = pillar_agents.edit_report(rows, model_id="test", budget=None, lang="en")
    assert plan["paragraphs"] == {"first": "Review available memory."}
    assert stages[-1] == {"stage": "report_editor_check", "status": "partial",
                          "checked_count": 2, "accepted_count": 1}


def test_partially_verified_editor_keeps_report_partial_and_renders_both_sources(monkeypatch):
    from diagnosis import pillar_agents
    from diagnosis.test_presentation import finding

    rows = [finding(id="first"), finding(id="second", explanation="Check the scope of the sample.")]
    prepare(monkeypatch, findings=analysis(findings=rows, evidence_bundle=bundle(), model_stages=[]))

    def mixed(_findings, *, stages, **_kwargs):
        stages.extend([{"stage": "report_editor", "status": "succeeded"},
                       {"stage": "report_editor_check", "status": "partial", "checked_count": 2, "accepted_count": 1}])
        return {"lead": ["first"], "context": ["second"], "next": [],
                "paragraphs": {"first": "Review available memory."}}, stages
    monkeypatch.setattr(pillar_agents, "edit_report", mixed)
    md, summary, _ = report.generate(object(), "self", lang="en")
    body = md.split("\n## Evidence appendix")[0]
    assert "Review available memory." in body and "Check the scope of the sample." in body
    assert "report_editor_check:partial_verification" in summary["render_degraded"]
    assert summary["model_stages"][-1]["accepted_count"] == 1


def test_scope_gaps_and_withheld_claims_cannot_displace_customer_risks(monkeypatch):
    from diagnosis.test_presentation import finding
    rows = [finding(id="gap", severity="critical", pillar="reliability", claim="coverage_gap",
                    explanation="The trace source was not collected.", prerequisites=["Verify the recovery objective."]),
            finding(id="withheld", severity="high", explanation="Value is 99%."),
            finding(id="decision", severity="medium", explanation="The application may be waiting on memory.",
                    prerequisites=["Compare memory and application latency."])]
    prepare(monkeypatch, findings=analysis(findings=rows, editor_plan={
        "lead": ["gap", "withheld"], "context": [], "next": ["gap"], "paragraphs": {}}))
    md, _, _ = report.generate(object(), "self", lang="en")
    main, appendix = md.split("\n## Evidence appendix", 1)
    brief = main.split("## Assessment", 1)[1].split("\n## ", 1)[0]
    assert "application may be waiting on memory" in brief
    assert "[Critical]" in brief
    for title in ("Reliability", "Performance Efficiency"):
        pillar = main.split("\n## " + title + "\n", 1)[1].split("\n## ", 1)[0]
        assert "[Critical]" in pillar
    assert "trace source was not collected" not in main and "model text withheld" not in main
    assert "Verify the recovery objective." in main
    assert "trace source was not collected" in appendix and "model text withheld" in appendix


def test_only_coverage_gaps_still_get_six_honest_sections_without_a_risk_ranking(monkeypatch):
    from diagnosis.test_presentation import finding
    prepare(monkeypatch, findings=analysis(findings=[finding(id="gap", severity="critical", claim="coverage_gap",
        explanation="Source detail is unavailable.", prerequisites=["Compare the utilization window."])]))
    md, _, _ = report.generate(object(), "self", lang="en")
    front = md.split("\n## Evidence appendix")[0]
    assert "### Top risks" not in front
    assert "[Critical]" in front.split("\n## Assessment\n", 1)[1].split("\n## ", 1)[0]
    assert "Compare the utilization window." in front and "## Sustainability" in front
    assert "Source detail is unavailable." not in front and "Source detail is unavailable." in md


@pytest.mark.parametrize("statement_lang", ["ko", "en", "ja", "zh"])
def test_metric_collection_statements_stay_out_of_rankings_and_pillar_prose(monkeypatch, statement_lang):
    from diagnosis.evidence import METRIC_OBSERVATION_TEXT
    from diagnosis.test_presentation import finding

    measured = bundle()
    measured["evidence"][0]["facts"]["metrics"] = {
        "CPUUtilization": {"Maximum": {"max": 17.25, "unit": "Percent", "status": "Complete"}}}
    statement = METRIC_OBSERVATION_TEXT[statement_lang]
    row = finding(claim="observation", explanation=f"  {statement}\n", prerequisites=["Check the baseline."])
    prepare(monkeypatch, data=measured, findings=analysis(findings=[row]))
    md, _, _ = report.generate(object(), "self", lang="en")
    front = md.split("\n## Evidence appendix", 1)[0]
    assert "### Top risks" not in front and "### Immediate checks" not in front
    assert statement not in front
    assert "17.25" in front


@pytest.mark.parametrize("locale,title", [("ko","근거 부록"), ("en","Evidence appendix"),
                                          ("zh","证据附录"), ("ja","根拠資料")])
def test_customer_download_omits_only_managed_evidence_appendix(locale, title):
    from diagnosis.editor import customer_download
    md = f"# Report\n\n- [A](#a)\n- [{title}](#evidence_appendix)\n\n## A\n\nCheck the owner.\n\n## {title}\n\nCollection diagnostics.\n"
    result = customer_download(md, locale)
    assert "Check the owner." in result and "Collection diagnostics." not in result and title not in result
    legacy = f"# Old report\n## {title}\nLegacy content."
    assert customer_download(legacy, locale) == legacy
