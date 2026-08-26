"""Task 7 — report integrates active-invariant evaluation + drift + report diff."""
import json

from diagnosis import db
from diagnosis import report
from diagnosis import sections


# --- db readers ----------------------------------------------------------

class FakeConn:
    def __init__(self, ret_by_sql=None):
        self.ret_by_sql = ret_by_sql or {}
        self.calls = []

    def run(self, sql, **kw):
        self.calls.append((sql, kw))
        for needle, ret in self.ret_by_sql.items():
            if needle in sql:
                return ret
        return []


def test_list_active_invariants_normalizes_params():
    c = FakeConn({"FROM architecture_intent": [
        [1, "private_only", "rds-prod", '{"x": 1}', "critical"],
        [2, "expected_edge", None, {"from": "api", "to": "rds"}, "warning"],
    ]})
    out = db.list_active_invariants(c)
    assert out[0]["params"] == {"x": 1} and out[0]["kind"] == "private_only"
    assert out[1]["params"] == {"from": "api", "to": "rds"}
    # only active rows are queried
    assert "status='active'" in c.calls[0][0]


def test_get_report_summary_returns_parent_and_dict():
    c = FakeConn({"FROM diagnosis_reports": [[42, '{"drift": []}']]})
    parent, summary = db.get_report_summary(c, 7)
    assert parent == 42 and summary == {"drift": []}


def test_get_report_summary_missing_row():
    c = FakeConn({})
    parent, summary = db.get_report_summary(c, 99)
    assert parent is None and summary == {}


# --- section catalog -----------------------------------------------------

def test_intended_vs_actual_section_registered():
    sec = sections.INTENDED_VS_ACTUAL_SECTION
    assert sec["key"] == "intended_vs_actual"
    assert sec["sources"] == ["intended_vs_actual"]
    # base SECTIONS stays at 8 (Plan-1 native sections) — drift section is appended in generate
    assert len(sections.SECTIONS) == 8


# --- actual assembly + drift ---------------------------------------------

def test_build_actual_from_collected():
    collected = {
        "service_map": {"key": "service_map", "ok": True,
                        "data": {"edges": [{"from": "internet", "to": "rds-prod"}]}},
        "inventory": {"key": "inventory", "ok": True, "data": {"by_type": {"rds": 2}}},
    }
    actual = report._build_actual(collected)
    assert actual["service_map"]["edges"][0]["from"] == "internet"
    assert actual["inventory"]["by_type"] == {"rds": 2}


def test_drift_returns_only_failed_verdicts():
    actual = {"service_map": {"edges": [{"from": "internet", "to": "rds-prod"}]}}
    active = [
        {"id": 1, "kind": "private_only", "target": "rds-prod", "params": {}, "severity": "critical"},
        {"id": 2, "kind": "forbidden_edge", "params": {"from": "x", "to": "y"}, "severity": "warning"},
    ]
    verdicts = report._evaluate_intent(active, actual)
    drift = report._drift(verdicts)
    assert len(verdicts) == 2
    assert len(drift) == 1 and drift[0]["id"] == 1 and drift[0]["passed"] is False


# --- report diff vs parent ----------------------------------------------

def test_diff_flags_regression_when_parent_passed_now_fails():
    parent_summary = {"drift": []}  # invariant id=1 passed in parent (not in drift)
    current_drift = [{"id": 1, "kind": "private_only", "severity": "critical", "passed": False,
                      "observed": "internet→rds-prod edges: 1"}]
    diff = report._diff_summary(current_drift, parent_summary)
    assert any(r["id"] == 1 for r in diff["regressions"])


def test_diff_empty_when_same_drift():
    parent_summary = {"drift": [{"id": 1, "passed": False}]}
    current_drift = [{"id": 1, "kind": "private_only", "severity": "critical", "passed": False, "observed": "x"}]
    diff = report._diff_summary(current_drift, parent_summary)
    assert diff["regressions"] == []


# --- generate end-to-end (fakes, no AWS) --------------------------------

def test_generate_weaves_drift_and_renders_verdict_only(monkeypatch):
    # collectors return an internet→rds edge; one active private_only invariant must drift.
    def fake_collect_all(conn, scope="self"):
        return [
            {"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {"by_type": {"rds": 1}}},
            {"key": "service_map", "ok": True, "degraded": False, "notes": "",
             "data": {"edges": [{"from": "internet", "to": "rds-prod", "error_rate": 0.0}]}},
        ]
    monkeypatch.setattr(report.src, "collect_all", fake_collect_all)

    captured = {}

    def fake_bedrock(prompt, ctx, *a, **k):  # variadic: tolerates model_id/max_tokens args
        # the intended-vs-actual section's prompt is the only one mentioning 'verdict'
        if "verdict" in prompt:
            captured["intent_ctx"] = ctx
        return "본문"
    monkeypatch.setattr(report, "_bedrock_render", fake_bedrock)

    active = [{"id": 1, "kind": "private_only", "target": "rds-prod", "params": {}, "severity": "critical"}]
    monkeypatch.setattr(db, "list_active_invariants", lambda conn: active)

    md, summary, sources_used = report.generate(FakeConn(), account="1", tier="mid")

    # drift surfaces the failed verdict
    assert "drift" in summary and len(summary["drift"]) == 1
    assert summary["drift"][0]["id"] == 1 and summary["drift"][0]["passed"] is False
    # the intended-vs-actual section is in the markdown
    assert "Intended vs Actual" in md or "intended" in md.lower()
    # verdict-only into the intended-vs-actual prompt: the verdict shape (passed/severity/observed)
    # is allowed, but NO raw service-map edge dict (with 'error_rate') leaks into THIS section.
    ictx = captured["intent_ctx"]
    assert "error_rate" not in ictx
    assert "passed" in ictx and "observed" in ictx


def test_generate_computes_diff_when_parent_set(monkeypatch):
    def fake_collect_all(conn, scope="self"):
        return [
            {"key": "service_map", "ok": True, "degraded": False, "notes": "",
             "data": {"edges": [{"from": "internet", "to": "rds-prod"}]}},
        ]
    monkeypatch.setattr(report.src, "collect_all", fake_collect_all)
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **k: "본문")
    active = [{"id": 1, "kind": "private_only", "target": "rds-prod", "params": {}, "severity": "critical"}]
    monkeypatch.setattr(db, "list_active_invariants", lambda conn: active)
    # current report 7 → parent 3; parent 3 had no drift (id=1 passed) → now fails → regression
    def fake_summary(conn, rid):
        return {7: (3, {}), 3: (None, {"drift": []})}[rid]
    monkeypatch.setattr(db, "get_report_summary", fake_summary)

    md, summary, _ = report.generate(FakeConn(), account="1", tier="mid", report_id=7)
    assert "diff" in summary
    assert any(r["id"] == 1 for r in summary["diff"]["regressions"])


def test_generate_no_diff_without_parent(monkeypatch):
    def fake_collect_all(conn, scope="self"):
        return [{"key": "service_map", "ok": True, "degraded": False, "notes": "", "data": {"edges": []}}]
    monkeypatch.setattr(report.src, "collect_all", fake_collect_all)
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **k: "본문")
    monkeypatch.setattr(db, "list_active_invariants", lambda conn: [])
    md, summary, _ = report.generate(FakeConn(), account="1", tier="mid")
    assert "diff" not in summary  # no report_id → no parent lookup


# --- A3: live per-section progress + bedrock idle timeout ----------------

def test_generate_emits_monotonic_section_progress(monkeypatch):
    def fake_collect_all(conn, scope="self"):
        return [{"key": "service_map", "ok": True, "degraded": False, "notes": "", "data": {"edges": []}}]
    monkeypatch.setattr(report.src, "collect_all", fake_collect_all)
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **k: "본문")
    monkeypatch.setattr(db, "list_active_invariants", lambda conn: [])

    events = []
    report.generate(FakeConn(), account="1", tier="mid",
                     on_progress=lambda cur, total, section, phase: events.append((cur, total, section, phase)))

    total_sections = len(sections.SECTIONS) + 1  # + INTENDED_VS_ACTUAL_SECTION
    renders = [e for e in events if e[3] == "render"]
    assert len(renders) == total_sections
    # monotonic 1..N, all carrying the fixed total + a section title
    assert [e[0] for e in renders] == list(range(1, total_sections + 1))
    assert all(e[1] == total_sections and e[2] for e in renders)
    # collect emitted before the first render; assemble after the last
    assert events[0][3] == "collect"
    assert events[-1][3] == "assemble"


def test_generate_progress_failure_never_aborts_report(monkeypatch):
    def fake_collect_all(conn, scope="self"):
        return [{"key": "service_map", "ok": True, "degraded": False, "notes": "", "data": {"edges": []}}]
    monkeypatch.setattr(report.src, "collect_all", fake_collect_all)
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **k: "본문")
    monkeypatch.setattr(db, "list_active_invariants", lambda conn: [])

    def boom(*a, **k):
        raise RuntimeError("db hiccup")
    md, summary, _ = report.generate(FakeConn(), account="1", tier="mid", on_progress=boom)
    assert md and "sections" in summary  # progress is best-effort; report still produced


def test_bedrock_render_sets_read_timeout(monkeypatch):
    captured = {}

    class _FakeClient:
        def invoke_model(self, **kw):
            import io
            return {"body": io.BytesIO(json.dumps({"content": [{"text": "x"}]}).encode())}

    def fake_client(name, region_name=None, config=None):
        captured["region"] = region_name
        captured["config"] = config
        return _FakeClient()
    monkeypatch.setattr(report.boto3, "client", fake_client)

    out = report._bedrock_render("prompt", "{}", report.MODEL_ID, 1500)
    assert out == "x"
    assert captured["region"] == "ap-northeast-2"  # global.* profile invoked from caller region (matches agent.py)
    assert captured["config"] is not None and captured["config"].read_timeout  # idle/read timeout set
