import json

from diagnosis import db


class FakeConn:
    def __init__(self):
        self.calls = []
        self.ret = []

    def run(self, sql, **kw):
        self.calls.append((sql, kw))
        return self.ret


# --- Task 2: db.py CRUD --------------------------------------------------

def test_create_report_inserts_running_row():
    c = FakeConn(); c.ret = [[123]]
    rid = db.create_report(c, worker_job_id="job-1", tier="mid", requested_by="u@x.io")
    assert rid == 123
    sql, kw = c.calls[0]
    assert "INSERT INTO diagnosis_reports" in sql
    assert kw["t"] == "mid" and kw["rb"] == "u@x.io" and kw["jid"] == "job-1"


def test_finish_report_sets_terminal_and_summary():
    c = FakeConn(); c.ret = [[123]]
    n = db.finish_report(c, 123, status="succeeded",
                         sources_used=["inventory", "cost"],
                         summary={"sections": 8}, artifact_uri="s3://b/k.md")
    assert n == 1
    sql, kw = c.calls[0]
    assert "UPDATE diagnosis_reports" in sql and "status=:s" in sql
    assert "finished_at=now()" in sql  # L176: terminal-write stamp (drives the elapsed stat)
    assert json.loads(kw["su"]) == ["inventory", "cost"]
    assert kw["s"] == "succeeded"


def test_update_progress_writes_jsonb():
    c = FakeConn(); c.ret = [[123]]
    n = db.update_progress(c, 123, current=3, total=9, section="네트워크", phase="render")
    assert n == 1
    sql, kw = c.calls[0]
    assert "UPDATE diagnosis_reports" in sql and "progress" in sql
    assert "status='running'" in sql  # never resurrect a terminal/reaped row
    assert kw["id"] == 123
    assert json.loads(kw["p"]) == {"current": 3, "total": 9, "section": "네트워크", "phase": "render"}


def test_update_progress_persists_completed_list_when_given():
    # L177: `completed` is an additive JSONB key — present only when passed (old readers tolerate absence).
    c = FakeConn(); c.ret = [[123]]
    db.update_progress(c, 123, current=2, total=9, section="B", phase="render", completed=["A", "B"])
    assert json.loads(c.calls[0][1]["p"])["completed"] == ["A", "B"]


def test_update_progress_noop_when_no_report_id():
    c = FakeConn()
    n = db.update_progress(c, None, current=1, total=9, section="x", phase="render")
    assert n == 0 and c.calls == []


# --- Task 3: sources.py collectors --------------------------------------

from diagnosis import sources


def test_collector_degrades_on_exception(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("AccessDenied")
    # cost collector calls a boto3 client; force it to raise
    monkeypatch.setattr(sources, "_ce_client", boom)
    res = sources.collect_cost()
    assert res["key"] == "cost"
    assert res["ok"] is False and res["degraded"] is True
    assert "AccessDenied" in res["notes"]
    assert res["data"] == {"_failed": True}


def test_result_shape_keys():
    res = sources._result("inventory", ok=True, data={"x": 1})
    assert set(res) == {"key", "ok", "degraded", "notes", "data"}
    assert res["degraded"] is False


def test_what_changed_strips_pii(monkeypatch):
    import datetime as dt

    class _FakeCt:
        def lookup_events(self, **kw):
            return {"Events": [{
                "EventName": "RunInstances",
                "EventSource": "ec2.amazonaws.com",
                "EventTime": dt.datetime(2026, 6, 11, 0, 0, 0),
                "Username": "alice",                       # PII — must be dropped
                "Resources": [{"ResourceName": "i-abc"}],  # must be dropped
            }]}

    monkeypatch.setattr(sources, "_ct_client", lambda: _FakeCt())
    res = sources.collect_what_changed()
    assert res["ok"] is True
    ev = res["data"]["recent_changes"][0]
    assert set(ev) == {"name", "source", "time"}
    assert "username" not in {k.lower() for k in ev}
    assert "Resources" not in ev


def test_throttle_is_loud(monkeypatch):
    from botocore.exceptions import ClientError

    def throttled(*a, **k):
        raise ClientError({"Error": {"Code": "ThrottlingException"}}, "GetFindings")

    monkeypatch.setattr(sources, "_sh_client", throttled)
    res = sources.collect_posture()
    assert res["ok"] is False and res["degraded"] is True
    assert "THROTTLED" in res["notes"]
    assert res["data"] == {"_failed": True}


def test_security_hub_not_subscribed_is_quiet(monkeypatch):
    # Security Hub is opt-in. "Not subscribed" is a known steady state, NOT a failure:
    # it must NOT degrade the report to 'partial' or leak a scary `_failed` to the LLM.
    from botocore.exceptions import ClientError

    def not_subscribed(*a, **k):
        raise ClientError(
            {"Error": {"Code": "InvalidAccessException",
                       "Message": "Account 1 is not subscribed to AWS Security Hub"}},
            "GetFindings")

    monkeypatch.setattr(sources, "_sh_client", not_subscribed)
    res = sources.collect_posture()
    assert res["ok"] is True and res["degraded"] is False
    assert res["data"].get("enabled") is False
    assert "_failed" not in res["data"]
    assert res["data"]["findings_by_severity"] == {}


def test_security_hub_subscribed_reports_findings(monkeypatch):
    class _FakeSh:
        def get_findings(self, **kw):
            return {"Findings": [
                {"Severity": {"Label": "HIGH"}}, {"Severity": {"Label": "HIGH"}},
                {"Severity": {"Label": "LOW"}}, {}]}  # last → UNKNOWN

    monkeypatch.setattr(sources, "_sh_client", lambda: _FakeSh())
    res = sources.collect_posture()
    assert res["ok"] is True and res["degraded"] is False
    assert res["data"]["enabled"] is True
    assert res["data"]["findings_by_severity"] == {"HIGH": 2, "LOW": 1, "UNKNOWN": 1}


def test_cw_metrics_collector_present():
    assert hasattr(sources, "collect_cw_metrics")


# --- Task 4: sections.py -------------------------------------------------

from diagnosis import sections


def test_eight_sections_ordered_and_unique():
    s = sections.SECTIONS
    assert len(s) == 8
    keys = [x["key"] for x in s]
    assert keys[0] == "executive_summary"
    assert len(set(keys)) == 8
    for sec in s:
        assert sec["title"] and sec["prompt"] and isinstance(sec["sources"], list)


def test_cw_metrics_wired_into_compute_and_db_sections():
    by_key = {s["key"]: s for s in sections.SECTIONS}
    assert "cw_metrics" in by_key["compute_infrastructure"]["sources"]
    assert "cw_metrics" in by_key["database_storage"]["sources"]


def test_deep_sections_catalog():
    # deep = the 8 base + 7 deep-only = 15 (report.generate appends intended_vs_actual → 16).
    base = sections.SECTIONS
    deep = sections.DEEP_SECTIONS
    assert len(base) == 8  # base unchanged
    assert len(deep) == 15
    assert deep[:8] == base  # deep is a superset that preserves the base order
    keys = [x["key"] for x in deep]
    assert len(set(keys)) == 15  # unique
    # AWS-native collectors + datasources_obs (external observability) + idle/commitment (WS-A2 FinOps:
    # idle = DB-derived waste from inventory_resources [no new IAM]; commitment = RI/SP coverage
    # [ce:GetReservationCoverage / ce:GetSavingsPlansCoverage]). All read-only.
    known = {"inventory", "cw_metrics", "cost", "service_map", "posture", "what_changed",
             "datasources_obs", "idle", "commitment"}
    for sec in deep:
        assert sec["key"] and sec["title"] and sec["prompt"]
        assert isinstance(sec["sources"], list) and sec["sources"]
        assert set(sec["sources"]) <= known  # only known collectors (guards against ACCIDENTAL new sources)
    # the 6 deep-only keys are present
    assert {"identity_access", "data_protection", "network_exposure",
            "reliability_ha", "observability_coverage", "cost_optimization"} <= set(keys)


def test_generate_resolves_tier_catalog_and_model(monkeypatch):
    # The 9/16-section catalogs include one deterministic section; only 8/15 use the LLM.
    monkeypatch.setattr(report.src, "collect_all",
                        lambda conn, scope="self": [{"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {}}])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    calls = []
    monkeypatch.setattr(report, "_bedrock_render",
                        lambda prompt, ctx, model_id, max_tokens: (calls.append((model_id, max_tokens)) or "본문"))

    calls.clear(); report.generate(object(), account="1", tier="mid")
    assert len(calls) == 8 and all(m == report._MODEL_SONNET for m, t in calls)
    assert sorted(set(t for _, t in calls)) == [report.TIER_MAX_TOKENS["mid"], 8000]

    calls.clear(); report.generate(object(), account="1", tier="deep", model="opus")
    assert len(calls) == 15 and all(m == report._MODEL_OPUS and t >= report.TIER_MAX_TOKENS["deep"] for m, t in calls)

    calls.clear(); report.generate(object(), account="1", tier="deep")  # default model = sonnet
    assert len(calls) == 15 and all(m == report._MODEL_SONNET for m, t in calls)

    calls.clear(); report.generate(object(), account="1", tier="mid", model="opus")  # pinned
    assert len(calls) == 8 and all(m == report._MODEL_SONNET for m, t in calls)


def test_generate_parallel_preserves_order_and_isolates_section_failure(monkeypatch):
    # ADR-045: sections render concurrently. Order MUST be preserved (reassembled by index) and a single
    # failing section MUST degrade in place (loud) WITHOUT sinking the whole report.
    from diagnosis import sections as S
    monkeypatch.setattr(report.src, "collect_all",
                        lambda conn, scope="self": [{"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {}}])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])

    def fake_render(section, collected, model_id, max_tokens, lang="ko"):
        if section["key"] == "cost_overview":
            raise RuntimeError("boom")  # one section blows up
        return {"key": section["key"], "title": section["title"], "body": f"BODY::{section['key']}"}
    monkeypatch.setattr(report, "render_section", fake_render)

    md = report.generate(object(), account="1", tier="deep")[0]  # (markdown, summary, sources); must NOT raise
    keys = [s["key"] for s in S.DEEP_SECTIONS] + ["intended_vs_actual"]
    assert "degraded" in md  # cost_overview degraded note is present (loud)
    succ = [k for k in keys if k != "cost_overview"]
    for k in succ:
        assert f"BODY::{k}" in md, f"missing section {k}"
    positions = [md.find(f"BODY::{k}") for k in succ]
    assert positions == sorted(positions), "section order not preserved under parallel render"


# --- Task 5: report.py ---------------------------------------------------

from diagnosis import report


def test_build_markdown_has_toc_and_all_sections():
    rendered = [
        {"key": "executive_summary", "title": "Executive Summary", "body": "요약 본문"},
        {"key": "security_posture", "title": "Security Posture", "body": "보안 본문"},
    ]
    md = report.build_markdown(rendered, account="123456789012", tier="mid")
    assert md.startswith("# AWS 진단 리포트") or md.startswith("# AWSops")
    assert "## Executive Summary" in md and "## Security Posture" in md
    assert "요약 본문" in md and "보안 본문" in md
    # TOC lists both sections
    assert "Executive Summary" in md.split("##", 1)[0]


def test_build_markdown_has_generation_date():
    md = report.build_markdown([], account="123456789012", tier="mid")
    assert "생성 일시:" in md and "(KST)" in md


def test_render_section_uses_only_its_sources(monkeypatch):
    captured = {}

    def fake_invoke(prompt, context_json, *a, **k):  # variadic: tolerates model_id/max_tokens args
        captured["context"] = context_json
        return "섹션 본문"

    monkeypatch.setattr(report, "_bedrock_render", fake_invoke)
    collected = {
        "inventory": {"key": "inventory", "ok": True, "data": {"by_type": {"ec2": 3}}},
        "cost": {"key": "cost", "ok": True, "data": {"mtd_by_service": {"EC2": 12.5}}},
        "posture": {"key": "posture", "ok": True, "data": {}},
    }
    sec = {"key": "cost_overview", "title": "Cost Overview", "sources": ["cost"], "prompt": "p"}
    out = report.render_section(sec, collected, report.MODEL_ID, 1500)
    assert out["body"] == "섹션 본문"
    # context must include cost but not inventory (section only declares 'cost')
    assert "mtd_by_service" in captured["context"]
    assert "by_type" not in captured["context"]


def test_render_section_appends_lang_rule(monkeypatch):
    # Report output language (gap L50): the prompt gets the per-lang instruction appended; an
    # unknown lang falls back to Korean (fail-closed).
    captured = {}

    def fake_invoke(prompt, context_json, *a, **k):
        captured["prompt"] = prompt
        return "본문"

    monkeypatch.setattr(report, "_bedrock_render", fake_invoke)
    sec = {"key": "x", "title": "X", "sources": [], "prompt": "p."}
    report.render_section(sec, {}, report.MODEL_ID, 100)  # default ko
    assert "한국어로 작성" in captured["prompt"]
    report.render_section(sec, {}, report.MODEL_ID, 100, lang="en")
    assert "in English" in captured["prompt"]
    report.render_section(sec, {}, report.MODEL_ID, 100, lang="xx")  # unknown → ko
    assert "한국어로 작성" in captured["prompt"]


def test_render_section_localizes_deep_titles(monkeypatch):
    # Non-ko reports must not ship Korean deep-section headings (round-2 review MAJOR).
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **k: "body")
    from diagnosis import sections as S
    sec = next(x for x in S.DEEP_SECTIONS if x["key"] == "identity_access")
    assert report.render_section(sec, {}, report.MODEL_ID, 100, lang="en")["title"] == "IAM & Identity Deep-Dive"
    assert report.render_section(sec, {}, report.MODEL_ID, 100)["title"] == "IAM & 자격 증명 심층"  # ko unchanged
    # English base titles pass through for every lang.
    base = next(x for x in S.SECTIONS if x["key"] == "executive_summary")
    assert report.render_section(base, {}, report.MODEL_ID, 100, lang="ja")["title"] == "Executive Summary"
    # every deep Korean title has all 3 translations (lockstep completeness)
    for key, m in S.TITLES_I18N.items():
        assert set(m) == {"en", "zh", "ja"}, key


def test_build_markdown_localizes_document_chrome():
    rendered = [{"key": "a", "title": "A", "body": "b"}]
    md_en = report.build_markdown(rendered, account="123456789012", tier="mid", lang="en")
    assert "AWS Diagnosis Report" in md_en
    assert "**Table of Contents**" in md_en
    assert "Generated:" in md_en
    md_ko = report.build_markdown(rendered, account="123456789012", tier="mid")
    assert "AWS 진단 리포트" in md_ko and "**목차**" in md_ko


def test_render_section_closes_unclosed_code_fence(monkeypatch):
    # A section truncated by max_tokens can leave an open ``` fence. Unbalanced, it bleeds into every
    # following section when bodies are concatenated → the whole rest renders as one code block.
    monkeypatch.setattr(report, "_bedrock_render",
                        lambda *a, **k: "위험 매트릭스:\n```\nCRITICAL  보안\nMEDIUM  Cloud")  # cut mid-fence
    out = report.render_section({"key": "x", "title": "X", "sources": [], "prompt": "p"}, {}, report.MODEL_ID, 100)
    assert out["body"].count("```") % 2 == 0          # balanced
    assert out["body"].rstrip().endswith("```")        # closed at section end


def test_render_section_leaves_balanced_fences_untouched(monkeypatch):
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **k: "```\ncode\n```\n본문")
    out = report.render_section({"key": "x", "title": "X", "sources": [], "prompt": "p"}, {}, report.MODEL_ID, 100)
    assert out["body"] == "```\ncode\n```\n본문"        # unchanged


def test_render_section_threads_model_id_and_max_tokens(monkeypatch):
    # Task 1: render_section/_bedrock_render carry model_id + max_tokens through to invoke_model.
    captured = {}

    class _FakeClient:
        def invoke_model(self, modelId, body):
            captured["modelId"] = modelId
            captured["body"] = json.loads(body)
            class _R:
                def read(self):
                    return json.dumps({"content": [{"text": "본문"}]}).encode()
            return {"body": _R()}

    monkeypatch.setattr(report.boto3, "client", lambda *a, **k: _FakeClient())
    sec = {"key": "x", "title": "X", "sources": [], "prompt": "p"}
    out = report.render_section(sec, {}, report.MODEL_ID, 1500)
    assert out["body"] == "본문"
    assert captured["modelId"] == report.MODEL_ID
    assert captured["body"]["max_tokens"] == 1500


def test_redact_strips_pii():
    from diagnosis import report as rpt
    s = rpt._redact('arn:aws:iam::123456789012:role/x user a@b.io ip 10.0.0.1 AKIAABCDEFGHIJKLMNOP')
    assert 'arn:aws' not in s and '123456789012' not in s and 'a@b.io' not in s
    assert '10.0.0.1' not in s and 'AKIA' not in s


# --- Task 6: handlers registration --------------------------------------

import handlers


def test_report_registered_as_fargate():
    assert handlers.is_allowed("report")
    assert handlers.runtime_for("report") == "fargate"


# --- Task 6: _report handler orchestration (PR#37 review MAJOR) ----------
import pytest  # noqa: E402
import db as _wdb  # noqa: E402
from diagnosis import db as _ddb  # noqa: E402
from diagnosis import report as _rpt  # noqa: E402


def _patch_report(monkeypatch, *, generate):
    """Wire fakes for the _report dependencies; return a dict capturing finish_report + close."""
    state = {"closed": False, "finish": None}

    class FakeConn:
        def close(self):
            state["closed"] = True

    monkeypatch.setattr(_wdb, "connect", lambda: FakeConn())
    monkeypatch.setattr(_rpt, "generate", generate)
    monkeypatch.setattr(handlers, "_upload_markdown", lambda md, rid: f"s3://b/diagnosis/{rid}.md")
    monkeypatch.setattr(_rpt, "make_title_and_tags", lambda md: {"title": None, "tags": []})  # no real LLM call

    def _finish(conn, rid, **kw):
        state["finish"] = {"rid": rid, **kw}
    monkeypatch.setattr(_ddb, "finish_report", _finish)
    return state


def test_report_handler_success_uploads_sets_uri_and_closes(monkeypatch):
    state = _patch_report(monkeypatch, generate=lambda c, a, t, **_: ("# md", {"degraded": []}, ["inventory", "cost"]))
    monkeypatch.setattr(handlers, "_export_artifacts", lambda md, rid: None)  # exports tested separately
    result, artifact = handlers._report(
        {"account": "1", "tier": "mid", "requested_by": "u", "report_id": 7}, dry_run=False)
    assert result["status"] == "succeeded" and result["report_id"] == 7
    assert artifact == b"# md"
    assert state["finish"]["status"] == "succeeded"
    assert state["finish"]["artifact_uri"].startswith("s3://b/diagnosis/7")
    assert state["closed"] is True  # CRITICAL: connection always released


def test_report_export_failure_is_isolated(monkeypatch):
    # A docx/pdf failure (e.g. chromium crash) must NOT fail the report — md is the source of truth.
    _patch_report(monkeypatch, generate=lambda c, a, t, **_: ("# md", {"degraded": []}, ["inventory"]))
    from diagnosis import exporters
    uploaded = []
    monkeypatch.setattr(handlers, "_upload_bytes", lambda body, key, ct: uploaded.append(key))
    monkeypatch.setattr(exporters, "to_docx", lambda md: b"PKdocx")
    def boom(md):
        raise RuntimeError("chromium crashed")
    monkeypatch.setattr(exporters, "to_pdf", boom)
    result, _ = handlers._report(
        {"account": "1", "tier": "mid", "requested_by": "u", "report_id": 7}, dry_run=False)
    assert result["status"] == "succeeded"                       # pdf failure isolated
    assert any(k.endswith("diagnosis/7.docx") for k in uploaded)  # docx still uploaded
    assert not any(k.endswith("diagnosis/7.pdf") for k in uploaded)  # pdf raised before upload


def test_make_title_and_tags_parses_fenced_json(monkeypatch):
    monkeypatch.setattr(report, "_bedrock_render",
                        lambda *a, **k: '```json\n{"title": "보안 형상 진단 불가가 최대 리스크", "tags": ["보안", "비용"]}\n```')
    out = report.make_title_and_tags("# md")
    assert out["title"] == "보안 형상 진단 불가가 최대 리스크"
    assert out["tags"] == ["보안", "비용"]


def test_make_title_and_tags_bad_output_is_none(monkeypatch):
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **k: "sorry, no json here")
    out = report.make_title_and_tags("# md")
    assert out == {"title": None, "tags": []}


def test_make_title_and_tags_swallows_llm_error(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("bedrock down")
    monkeypatch.setattr(report, "_bedrock_render", boom)
    assert report.make_title_and_tags("# md") == {"title": None, "tags": []}


def test_finish_report_conditionally_sets_title_tags():
    c = FakeConn(); c.ret = [[7]]
    db.finish_report(c, 7, status="succeeded", title="제목", tags=["a", "b"])
    sql, kw = c.calls[0]
    assert "title=" in sql and "tags=" in sql
    assert kw["t2"] == "제목" and kw["tg"] == ["a", "b"]
    # failure path passes neither → must NOT clobber title/tags
    c2 = FakeConn(); c2.ret = [[7]]
    db.finish_report(c2, 7, status="failed", error="boom")
    sql2, _ = c2.calls[0]
    assert "title=" not in sql2 and "tags=" not in sql2


def test_report_title_failure_is_isolated(monkeypatch):
    # A title/tag LLM failure must NOT fail the report.
    state = _patch_report(monkeypatch, generate=lambda c, a, t, **_: ("# md", {"degraded": []}, ["inventory"]))
    monkeypatch.setattr(handlers, "_export_artifacts", lambda md, rid: None)
    def boom(md):
        raise RuntimeError("title model down")
    monkeypatch.setattr(_rpt, "make_title_and_tags", boom)
    result, _ = handlers._report(
        {"account": "1", "tier": "mid", "requested_by": "u", "report_id": 7}, dry_run=False)
    assert result["status"] == "succeeded"
    assert state["finish"]["status"] == "succeeded"


def test_report_handler_streams_progress_via_callback(monkeypatch):
    # A4: _report must hand generate() an on_progress that persists via ddb.update_progress(report_id).
    def gen(conn, account, tier, **kw):
        kw["on_progress"](2, 9, "네트워크", "render", ["Executive Summary", "네트워크"])  # per-section call (with the L177 completed list)
        return ("# md", {"degraded": []}, ["inventory"])
    _patch_report(monkeypatch, generate=gen)
    calls = []
    monkeypatch.setattr(_ddb, "update_progress",
                        lambda conn, rid, **kw: calls.append((rid, kw)))
    result, _ = handlers._report(
        {"account": "1", "tier": "mid", "requested_by": "u", "report_id": 7}, dry_run=False)
    assert result["status"] == "succeeded"
    assert calls and calls[0][0] == 7
    assert calls[0][1] == {"current": 2, "total": 9, "section": "네트워크", "phase": "render",
                           "completed": ["Executive Summary", "네트워크"]}


def test_report_handler_partial_when_a_source_degraded(monkeypatch):
    state = _patch_report(monkeypatch, generate=lambda c, a, t, **_: ("# md", {"degraded": ["cost"]}, ["inventory"]))
    result, _ = handlers._report(
        {"account": "1", "tier": "mid", "requested_by": "u", "report_id": 9}, dry_run=False)
    assert result["status"] == "partial"
    assert state["finish"]["status"] == "partial" and state["closed"] is True


def test_report_handler_failure_marks_failed_str_error_and_closes(monkeypatch):
    def boom(c, a, t, **_):
        raise RuntimeError("kaboom")
    state = _patch_report(monkeypatch, generate=boom)
    with pytest.raises(RuntimeError):
        handlers._report({"account": "1", "tier": "mid", "requested_by": "u", "report_id": 5}, dry_run=False)
    assert state["finish"]["status"] == "failed"
    assert state["finish"]["error"] == "kaboom"  # str(e), not a full traceback
    assert state["closed"] is True  # CRITICAL: closed even on the error path


def test_report_handler_dry_run_does_no_work(monkeypatch):
    # dry_run must not touch the DB/S3 at all (no connect).
    monkeypatch.setattr(_wdb, "connect", lambda: (_ for _ in ()).throw(AssertionError("connect on dry_run")))
    result, artifact = handlers._report({"account": "1", "tier": "mid"}, dry_run=True)
    assert result["dry_run"] is True and artifact is None


# ── data-coverage note (so a thin report is self-explaining) ──────────────────
def _coll(key, ok=True, degraded=False, notes="", data=None):
    return {"key": key, "ok": ok, "degraded": degraded, "notes": notes, "data": data or {}}


def test_coverage_note_lists_collector_status():
    collected = {
        "inventory": _coll("inventory", data={"by_type": {"ec2": 1}}),          # ok (has data)
        "cost": _coll("cost", ok=False, degraded=True, notes="AccessDenied", data={"_failed": True}),
        "service_map": _coll("service_map", data={"edges": [], "service_count": 0}),  # ok but empty
    }
    note = report._coverage_note(collected)
    assert "데이터 커버리지" in note
    assert "inventory" in note
    assert "cost" in note and "AccessDenied" in note          # degraded reason surfaced
    assert "service_map" in note and "empty" in note.lower()  # ran ok but no signal


def test_build_actual_preserves_collector_status_and_provenance():
    collected = {"service_map": _coll("service_map", degraded=True, notes="partial graph",
                                    data={"edges": [{"from": "api", "to": "rds", "calls": 4,
                                                     "error_rate": 0}]}),
                 "inventory": _coll("inventory", data={"by_type": {"rds": 1}})}
    collected["inventory"].update({"freshness": "stale", "captured_at": "2020-01-01T00:00:00Z"})
    actual = report._build_actual(collected)
    assert actual["service_map"] == collected["service_map"]["data"]
    assert actual["_sources"]["service_map"]["degraded"] is True
    assert actual["_sources"]["service_map"]["notes"] == "partial graph"
    assert actual["_sources"]["inventory"]["captured_at"] == "2020-01-01T00:00:00Z"
    assert actual["_sources"]["inventory"]["freshness"] == "stale"


@pytest.mark.parametrize("collected", [{}, {"service_map": None}, {"service_map": []},
                                      {"service_map": {"data": None}},
                                      {"service_map": {"ok": True, "data": ["bad"]}}])
def test_build_actual_missing_or_malformed_collector_stays_unknown(collected):
    active = [{"id": 1, "kind": "max_error_rate", "params": {"from": "api", "to": "rds"}}]
    assert report._evaluate_intent(active, report._build_actual(collected))[0]["passed"] is None


@pytest.mark.parametrize("degraded", [False, True])
def test_generate_current_source_shapes_do_not_claim_active_invariants_healthy(monkeypatch, degraded):
    # Matches sources.collect_service_map's unresolved references and inventory's bounded sample.
    collected = [
        _coll("service_map", degraded=degraded, data={"edges": [
            {"from": "api", "to_ref": 1, "calls": 0, "error_rate": 0}], "service_count": 2}),
        _coll("inventory", data={"by_type": {"rds": 20}, "resources": {
            "rds": [{"resource_id": "db", "region": "test", "data": {"storage_encrypted": True}}]},
            "truncated": False}),
    ]
    active = [{"id": i, "kind": kind, "target": "rds", "params": {"from": "api", "to": "rds"}}
              for i, kind in enumerate(["private_only", "encryption_required", "max_error_rate"])]
    monkeypatch.setattr(report.src, "collect_all", lambda *a: collected)
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda *a: active)
    captured = []

    def render(prompt, ctx, *a):
        data = json.loads(ctx)
        captured.append(data)
        return "body"

    monkeypatch.setattr(report, "_bedrock_render", render)
    _, summary, _ = report.generate(object(), account="1")
    assert len(summary["unassessed"]) == 3
    assert all(v["passed"] is None for v in summary["unassessed"])
    assert all("intended_vs_actual" not in ctx for ctx in captured)


@pytest.mark.parametrize("degraded,expected_improvements", [(True, []), (False, [1])])
def test_report_diff_requires_observed_pass_for_improvement(monkeypatch, degraded, expected_improvements):
    # A previous failure turning unknown must not appear as "improved" in the report UI.
    collected = [_coll("inventory", degraded=degraded, data={"unencrypted": {"rds": 0}})]
    active = [{"id": 1, "kind": "encryption_required", "target": "rds", "params": {}}]
    monkeypatch.setattr(report.src, "collect_all", lambda *a: collected)
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda *a: active)
    monkeypatch.setattr(report.ddb, "get_report_summary",
                        lambda conn, rid: (3, {}) if rid == 7 else (None, {"drift": [{"id": 1}]}))
    monkeypatch.setattr(report, "_bedrock_render", lambda *a: "body")
    _, summary, _ = report.generate(object(), account="1", report_id=7)
    assert summary["diff"]["improvements"] == expected_improvements


def test_build_markdown_appends_coverage_note_optional():
    rendered = [{"key": "executive_summary", "title": "Executive Summary", "body": "x"}]
    collected = {"inventory": _coll("inventory", data={"by_type": {}})}  # ok but empty
    md = report.build_markdown(rendered, "123", "mid", collected)
    assert "데이터 커버리지" in md and "Executive Summary" in md
    # backward-compatible: collected is optional
    md2 = report.build_markdown(rendered, "123", "mid")
    assert "Executive Summary" in md2 and "데이터 커버리지" not in md2


def test_normalize_headings_collapses_doubled_prefix():
    # LLM emits `## ### X`; must collapse to `### X` (else CommonMark shows literal "###").
    assert report._normalize_headings("## ### 보안 점수 (0~100)\n본문") == "### 보안 점수 (0~100)\n본문"
    assert report._normalize_headings("#### ## 비용\nx") == "## 비용\nx"
    # single, well-formed headings are untouched
    assert report._normalize_headings("## Security Posture") == "## Security Posture"
    assert report._normalize_headings("### 공개 노출") == "### 공개 노출"


# ── Task 6: datasource utilization surfaced in the coverage note (not opaque "empty") ────────────
from diagnosis import report as _rpt


def _cov(ds_result):
    return _rpt._coverage_note({"datasources_obs": ds_result})


def test_coverage_note_datasource_disabled():
    note = _cov({"data": {"instances": [], "queried": 0}, "degraded": False,
                 "notes": "datasource diagnosis disabled (datasource_diagnosis_enabled flag off)"})
    assert "비활성" in note


def test_coverage_note_datasource_none_connected():
    note = _cov({"data": {"instances": [], "queried": 0}, "degraded": False,
                 "notes": "no connected observability datasources"})
    assert "없음" in note


def test_coverage_note_datasource_used():
    note = _cov({"data": {"instances": [{"name": "prod-prom", "kind": "prometheus"}], "queried": 1,
                          "findings": [{"name": "prod-prom", "results": [{"label": "oom_kills:l", "summary": {"count": 2}}]}]},
                 "degraded": False, "notes": ""})
    assert "사용" in note and "prod-prom" in note


def test_coverage_note_datasource_unavailable_only_not_marked_used():
    # M4: an instance with ONLY unavailable signals (empty results) must NOT read as "사용"
    note = _cov({"data": {"instances": [{"name": "p", "kind": "prometheus"}], "queried": 1,
                          "findings": [{"name": "p", "results": []}]},
                 "degraded": False, "notes": ""})
    assert "사용" not in note and "unavailable" in note


def test_coverage_note_datasource_unavailable_reason():
    note = _cov({"data": {"instances": [{"name": "p", "kind": "prometheus"}], "queried": 1,
                          "notes": ["p (prometheus): signal 'oom_kills' unavailable — metric(s) X 없음"]},
                 "degraded": False, "notes": ""})
    assert "사용" not in note
    assert "실행 가능한 신호 없음" in note
    assert "oom_kills" in note


# ── RCA grounding: run context, collection status, truncation (AI diagnosis quality) ──────────────

def test_render_section_hands_the_model_collection_status_and_run_context(monkeypatch):
    captured = {}

    def fake_invoke(prompt, context_json, *a, **k):
        captured.update(prompt=prompt, ctx=json.loads(context_json))
        return "본문"
    monkeypatch.setattr(report, "_bedrock_render", fake_invoke)
    collected = {
        "cost": {"key": "cost", "ok": False, "degraded": True, "notes": "AccessDenied", "data": {"_failed": True}},
        "inventory": {"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {"by_type": {"ec2": 2}}},
    }
    sec = {"key": "s", "title": "S", "sources": ["cost", "inventory", "posture"], "prompt": "p.",
           "_run": {"generated_at_utc": "2026-10-11 09:00", "scope": "host account", "region": "ap-northeast-2"}}
    report.render_section(sec, collected, report.MODEL_ID, 100)
    status = captured["ctx"]["_collection"]
    assert status["cost"]["status"] == "failed" and status["cost"]["notes"] == "AccessDenied"
    assert status["inventory"]["status"] == "ok" and "inventory" in status["inventory"]["window"]
    assert status["posture"]["status"] == "not_collected" and "Security Hub" in status["posture"]["window"]
    assert captured["ctx"]["_run"]["region"] == "ap-northeast-2"
    assert "정상·문제 없음으로 판단하지 마라" in captured["prompt"]


def test_render_section_empty_source_is_reported_as_empty():
    assert report._collection_status("posture", {"key": "posture", "degraded": False, "data": {}})["status"] == "empty"


@pytest.mark.parametrize("key,data,reason", [
    ("inventory", {"by_type": {"ec2": 2}, "truncated": True}, "payload size cap"),
    ("inventory", {"by_type": {"ec2": 2}, "unsampled_types": ["ec2"]}, "inventory sample size cap"),
    ("posture", {"findings_by_severity": {"HIGH": 1}, "top_findings_unavailable": "unavailable"},
     "finding detail unavailable (unavailable)"),
    ("posture", {"findings_by_severity": {"HIGH": 1}, "more_findings": True}, "first 100 findings only"),
    ("posture", {"findings_by_severity": {"HIGH": 1}, "more_top_groups": True}, "top finding groups capped"),
])
def test_incomplete_collection_is_partial_without_discarding_available_evidence(key, data, reason):
    source = {"key": key, "ok": True, "degraded": False, "notes": "", "data": data}
    assert report._collection_status(key, source)["status"] == "partial"
    # the coverage line says WHICH gap made the source partial
    assert f"partial — {reason}; missing evidence remains unknown" in report._coverage_note({key: source})


def test_explicit_failed_collection_cannot_be_certified_ok():
    assert report._collection_status("cost", {
        "ok": False, "degraded": False, "data": {"_failed": True}})["status"] == "failed"


def test_generate_discloses_partial_sources_in_model_context_and_summary(monkeypatch):
    monkeypatch.setattr(report.src, "collect_all", lambda conn, scope="self": [{
        "key": "inventory", "ok": True, "degraded": False, "notes": "",
        "data": {"by_type": {"ec2": 2}, "unsampled_types": ["ec2"]}}])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    seen = []

    def render(prompt, context, *args):
        seen.append(json.loads(context))
        return "Available evidence only."
    monkeypatch.setattr(report, "_bedrock_render", render)
    _, summary, _ = report.generate(object(), account="self")
    # a by-design sample cap is disclosed (model + summary.incomplete) but is not a failure of the run
    assert summary["degraded"] == [] and summary["incomplete"] == ["inventory"]
    contexts = [ctx for ctx in seen if "inventory" in ctx]
    assert contexts and all(ctx["_collection"]["inventory"]["status"] == "partial" for ctx in contexts)
    assert all(ctx["inventory"]["by_type"] == {"ec2": 2} for ctx in contexts)


@pytest.mark.parametrize("text", ["", " \n\t"])
def test_empty_model_sections_degrade_report(monkeypatch, text):
    monkeypatch.setattr(report.src, "collect_all", lambda conn, scope="self": [])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    monkeypatch.setattr(report, "_bedrock_render", lambda *args: report._RenderedText(text))
    md, summary, _ = report.generate(object(), account="self", lang="en")
    assert set(summary["render_degraded"]) == {sec["key"] for sec in report.SECTIONS}
    assert "This section failed to render (degraded)" in md
    assert "Model returned no section text" not in md


def test_section_failure_does_not_publish_provider_error_text(monkeypatch):
    monkeypatch.setattr(report.src, "collect_all", lambda conn, scope="self": [])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])

    def fail(*args):
        raise RuntimeError("private provider context and credentials")
    monkeypatch.setattr(report, "_bedrock_render", fail)
    md, summary, _ = report.generate(object(), account="self", lang="en")
    assert summary["render_degraded"]
    assert "private provider context" not in md
    assert "This section failed to render (degraded)" in md


def test_render_section_marks_max_tokens_truncation(monkeypatch):
    text = report._RenderedText("잘린 본문")
    text.stop_reason = "max_tokens"
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **k: text)
    out = report.render_section({"key": "x", "title": "X", "sources": [], "prompt": "p"}, {}, report.MODEL_ID, 100, lang="en")
    assert out["truncated"] is True
    assert out["body"].endswith("cut off at the output length limit (degraded)]_")


def test_bedrock_render_keeps_stop_reason(monkeypatch):
    class _FakeClient:
        def invoke_model(self, modelId, body):
            class _R:
                def read(self):
                    return json.dumps({"content": [{"text": "t"}], "stop_reason": "max_tokens"}).encode()
            return {"body": _R()}
    monkeypatch.setattr(report, "_bedrock_clients", {})
    monkeypatch.setattr(report.boto3, "client", lambda *a, **k: _FakeClient())
    out = report._bedrock_render("p", "{}", report.MODEL_ID, 10)
    assert out == "t" and out.stop_reason == "max_tokens"


def test_generate_counts_failed_and_truncated_sections_as_render_degraded(monkeypatch):
    monkeypatch.setattr(report.src, "collect_all",
                        lambda conn, scope="self": [{"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {"x": 1}}])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    seen_run = []

    def fake_render(section, collected, model_id, max_tokens, lang="ko"):
        seen_run.append(section.get("_run"))
        if section["key"] == "cost_overview":
            raise RuntimeError("boom")
        out = {"key": section["key"], "title": section["title"], "body": "b"}
        if section["key"] == "security_posture":
            out["truncated"] = True
        return out
    monkeypatch.setattr(report, "render_section", fake_render)
    _, summary, _ = report.generate(object(), account="1", tier="mid")
    assert set(summary["render_degraded"]) == {"cost_overview", "security_posture"}
    assert summary["degraded"] == []  # collectors were fine — render problems are tracked separately
    assert all(r and r["scope"] == "host account" and r["generated_at_kst"] for r in seen_run)


def test_report_handler_partial_when_a_section_render_degraded(monkeypatch):
    state = _patch_report(monkeypatch, generate=lambda c, a, t, **_: (
        "# md", {"degraded": [], "render_degraded": ["cost_overview"]}, ["inventory"]))
    monkeypatch.setattr(handlers, "_export_artifacts", lambda md, rid: None)  # exports tested separately
    result, _ = handlers._report(
        {"account": "1", "tier": "mid", "requested_by": "u", "report_id": 9}, dry_run=False)
    assert result["status"] == "partial" and state["finish"]["status"] == "partial"


def test_section_rules_require_rca_and_operator_remediation():
    from diagnosis import sections as S
    for needle in ("원인 미확정", "확인 방법", "해결 절차", "신뢰도", "근거(소스.필드=값)", "### 원인 분석 및 조치"):
        assert needle in S._RULES
    # ADR-005: remediation is a reviewed proposal — never executed, never a mutating command.
    assert "어떤 변경도 실행·자동화하지 말고" in S._RULES and "변경을 수행하는 CLI 명령" in S._RULES
    assert "AWS 리소스 변경·자동 실행을 제안하지 마라" not in S._RULES  # the old self-contradiction


def test_posture_top_findings_come_from_a_severity_filtered_query(monkeypatch):
    control = {"Severity": {"Label": "CRITICAL"}, "Title": "S3 general purpose buckets should block public access",
               "Compliance": {"SecurityControlId": "S3.8"},
               "Resources": [{"Type": "AwsS3Bucket", "Id": "arn:aws:s3:::secret-bucket"}]}
    product = {"Severity": {"Label": "HIGH"}, "Title": "EC2 instance i-0secret is communicating with a C2 server",
               "ProductName": "GuardDuty", "Types": ["TTPs/Command and Control"],
               "Resources": [{"Type": "AwsEc2Instance", "Id": "i-0secret"}]}
    calls = []

    class _FakeSh:
        def get_findings(self, **kw):
            calls.append(kw["Filters"])
            if "SeverityLabel" in kw["Filters"]:
                return {"Findings": [control, control, product], "NextToken": "n"}
            return {"Findings": [control, {"Severity": {"Label": "LOW"}, "Title": "low"}]}
    monkeypatch.setattr(sources, "_sh_client", lambda: _FakeSh())
    data = sources.collect_posture()["data"]
    assert [v["Value"] for v in calls[1]["SeverityLabel"]] == ["CRITICAL", "HIGH"]
    assert data["top_findings"] == [
        {"title": "S3 general purpose buckets should block public access", "severity": "CRITICAL",
         "control_id": "S3.8", "resource_types": ["AwsS3Bucket"], "count": 2},
        {"title": "GuardDuty: TTPs/Command and Control", "severity": "HIGH", "control_id": None,
         "resource_types": ["AwsEc2Instance"], "count": 1}]
    assert data["more_top_findings"] is True and data["more_findings"] is False
    assert "secret" not in json.dumps(data)  # no resource ids, no product titles that embed them


def test_posture_top_findings_failure_keeps_the_severity_rollup(monkeypatch):
    from botocore.exceptions import ClientError

    class _FakeSh:
        def get_findings(self, **kw):
            if "SeverityLabel" in kw["Filters"]:
                raise ClientError({"Error": {"Code": "ThrottlingException",
                                             "Message": "Rate exceeded for arn:aws:securityhub:secret"}},
                                  "GetFindings")
            return {"Findings": [{"Severity": {"Label": "HIGH"}}]}
    monkeypatch.setattr(sources, "_sh_client", lambda: _FakeSh())
    res = sources.collect_posture()
    assert res["ok"] is True and res["data"]["findings_by_severity"] == {"HIGH": 1}
    # a bounded error code reaches model context, never the provider message text
    assert res["data"]["top_findings_unavailable"] == "ThrottlingException"
    assert "secret" not in json.dumps(res["data"])


def test_service_map_resolves_target_names(monkeypatch):
    class _FakeXr:
        def get_service_graph(self, **kw):
            return {"Services": [
                {"ReferenceId": 1, "Name": "api", "Edges": [{"ReferenceId": 2, "SummaryStatistics": {"TotalCount": 4}}]},
                {"ReferenceId": 2, "Name": "orders-db", "Edges": []}]}
    monkeypatch.setattr(sources, "_xray_client", lambda: _FakeXr())
    edge = sources.collect_service_map()["data"]["edges"][0]
    assert (edge["from"], edge["to_name"], edge["to_ref"]) == ("api", "orders-db", 2)
    # `to` stays unresolved: invariant verdicts must keep treating the 3h sample as insufficient.
    assert "to" not in edge


def test_resolved_xray_names_do_not_activate_invariant_verdicts(monkeypatch):
    class _FakeXr:
        def get_service_graph(self, **kw):
            return {"Services": [
                {"ReferenceId": 1, "Name": "internet", "Edges": [{"ReferenceId": 2, "SummaryStatistics": {"TotalCount": 4}}]},
                {"ReferenceId": 2, "Name": "rds", "Edges": []},
                {"Name": "no-ref", "Edges": [{"ReferenceId": None, "SummaryStatistics": {}}]}]}
    monkeypatch.setattr(sources, "_xray_client", lambda: _FakeXr())
    collected = {"service_map": sources.collect_service_map(),
                 "inventory": sources._result("inventory", data={"by_type": {"rds": 1}})}
    actual = report._build_actual(collected)
    verdicts = report._evaluate_intent([
        {"id": 1, "kind": "expected_edge", "params": {"from": "internet", "to": "rds"}, "severity": "warning"},
        {"id": 2, "kind": "private_only", "target": "rds", "params": {}, "severity": "critical"}], actual)
    assert all(v["passed"] is None for v in verdicts)
    assert collected["service_map"]["data"]["edges"][1]["to_name"] is None  # None ReferenceId borrows no name


def test_inventory_names_types_cut_by_the_byte_cap(monkeypatch):
    class _Conn:
        def run(self, sql, **kw):
            if "GROUP BY" in sql:
                return [("ec2", 3), ("rds", 2), ("s3", 1)]
            return [("id-" + kw["rtype"], "ap-northeast-2", {"blob": "x" * 400})]
    monkeypatch.setattr(sources, "DIAG_INV_MAX_BYTES", 500)
    data = sources.collect_inventory(_Conn())["data"]
    assert data["truncated"] is True
    assert list(data["resources"]) == ["ec2"]
    assert data["unsampled_types"] == ["rds", "s3"]


def test_inventory_names_a_type_whose_sample_read_failed():
    class _Conn:
        def run(self, sql, **kw):
            if "GROUP BY" in sql:
                return [("ec2", 1), ("rds", 1)]
            if kw["rtype"] == "rds":
                raise RuntimeError("timeout")
            return [("i-1", "ap-northeast-2", {"a": 1})]
    data = sources.collect_inventory(_Conn())["data"]
    assert list(data["resources"]) == ["ec2"] and data["unsampled_types"] == ["rds"]



def test_posture_discloses_the_group_cap(monkeypatch):
    findings = [{"Severity": {"Label": "HIGH"}, "Title": f"control {i}", "Compliance": {"SecurityControlId": f"X.{i}"}}
                for i in range(sources.POSTURE_TOP_FINDINGS + 5)]

    class _FakeSh:
        def get_findings(self, **kw):
            return {"Findings": findings}
    monkeypatch.setattr(sources, "_sh_client", lambda: _FakeSh())
    data = sources.collect_posture()["data"]
    assert len(data["top_findings"]) == sources.POSTURE_TOP_FINDINGS
    assert data["top_groups_total"] == sources.POSTURE_TOP_FINDINGS + 5 and data["more_top_groups"] is True
    assert data["more_top_findings"] is False  # API had no more pages; the cut is ours and is disclosed
    assert f"at most {sources.POSTURE_TOP_FINDINGS} groups" in sources.COLLECTION_WINDOWS["posture"]


def test_inventory_names_partial_and_zero_row_types(monkeypatch):
    class _Conn:
        def run(self, sql, **kw):
            if "GROUP BY" in sql:
                return [("ec2", 3), ("ebs", 1)]
            if kw["rtype"] == "ebs":
                return []  # counted but the detail read returned nothing
            return [(f"i-{n}", "ap-northeast-2", {"blob": "x" * 150}) for n in range(3)]
    monkeypatch.setattr(sources, "DIAG_INV_MAX_BYTES", 400)
    data = sources.collect_inventory(_Conn())["data"]
    assert data["partial_types"] == ["ec2"] and len(data["resources"]["ec2"]) < 3
    assert data["unsampled_types"] == ["ebs"]


def test_collection_windows_cover_every_section_source():
    from diagnosis import sections as S
    used = {k for sec in S.DEEP_SECTIONS for k in sec["sources"]}
    assert used <= set(sources.COLLECTION_WINDOWS), used - set(sources.COLLECTION_WINDOWS)


def test_mutating_cli_in_a_section_is_marked_and_degrades_the_report(monkeypatch):
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **k: (
        "| 해결 절차 | `aws ec2 revoke-security-group-ingress --group-id sg-1` |\n확인: `aws logs start-query`"))
    out = report.render_section({"key": "x", "title": "X", "sources": [], "prompt": "p"}, {}, report.MODEL_ID, 100)
    assert out["mutating_command"] is True and "실행하지 말고" in out["body"]
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **k: "확인: `aws logs start-query --log-group-name g`")
    assert "mutating_command" not in report.render_section(
        {"key": "x", "title": "X", "sources": [], "prompt": "p"}, {}, report.MODEL_ID, 100)


def test_report_header_and_sections_share_one_clock(monkeypatch):
    from datetime import datetime, timezone
    monkeypatch.setattr(report.src, "collect_all",
                        lambda conn, scope="self": [{"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {"x": 1}}])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    seen = []

    def fake_render(section, collected, model_id, max_tokens, lang="ko"):
        seen.append(section.get("_run", {}).get("generated_at_kst"))
        return {"key": section["key"], "title": section["title"], "body": "b"}
    monkeypatch.setattr(report, "render_section", fake_render)
    md = report.generate(object(), account="1", tier="mid")[0]
    assert seen[0] and f"{seen[0]} (KST)" in md
    assert report.build_markdown([], "1", "mid", generated_at=datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)).count("2026-01-01 09:00") == 1



def test_long_sections_get_a_token_floor():
    assert report._section_budget({"key": "recommendations"}, 5000) == report.SECTION_MIN_TOKENS["recommendations"]
    assert report._section_budget({"key": "security_posture"}, 6000) == 6000
    assert report._section_budget({"key": "cost_overview"}, 9000) == 9000  # a larger tier budget wins



def test_mutating_cli_guard_flags_anything_not_provably_read_only():
    mutating = (
        "aws ec2 copy-snapshot --source-snapshot-id s", "aws sqs send-message --queue-url q",
        "aws iam tag-role --role-name r", "aws ssm set-default-patch-baseline",
        "aws lambda invoke --function-name f out.json", "aws sns publish --topic-arn t",
        "aws cloudformation deploy --template-file t", "aws s3 rm s3://b/k", "aws s3 sync . s3://b",
        "aws logs put-query-definition --name n", "aws logs delete-query-definition --query-definition-id i",
        "aws dynamodb batch-write-item --request-items x",
        "aws --region ap-northeast-2 ec2 terminate-instances --instance-ids i-1",
        "aws --profile=prod --debug ec2 delete-volume --volume-id v", "`aws s3 rm s3://b/k`",
        # reviewer examples: verbs a denylist missed, and Athena DDL/CTAS
        "aws route53 change-resource-record-sets --hosted-zone-id Z --change-batch file://c.json",
        "aws sns subscribe --topic-arn t --protocol email", "aws rds suspend-db-activity-stream x",
        "aws acm request-certificate --domain-name d", "aws ec2 move-address-to-vpc --public-ip 1.2.3.4",
        "aws ec2 grant-something --x", "aws ssm start-session --target i-1", "aws sts assume-role --role-arn r",
        "aws athena start-query-execution --query-string 'DROP TABLE t'",
        "aws ecs execute-command --cluster c", "aws iam activate-foo --x",
        # `verify-*` is not read-only: SES creates an identity and sends a verification mail
        "aws ses verify-email-identity --email-address a@b.io", "aws ses verify-domain-identity --domain d",
        "aws kms verify --key-id k --message m --signature s")
    for cmd in mutating:
        assert report._has_mutating_cli(cmd), cmd
    read_only = (
        "aws ec2 describe-snapshots", "aws ec2 get-ebs-encryption-by-default", "aws ce get-cost-and-usage",
        "aws logs start-query --log-group-name g", "aws logs start-live-tail --log-group-identifiers g",
        "aws logs filter-log-events --log-group-name g", "aws logs tail /aws/lambda/x",
        "aws eks update-kubeconfig --name c", "aws s3 ls s3://b", "aws s3 presign s3://b/k",
        "aws dynamodb batch-get-item --request-items x", "aws dynamodb scan --table-name t",
        "aws iam simulate-principal-policy --policy-source-arn a", "aws cloudtrail lookup-events",
        "aws ec2 search-transit-gateway-routes --x", "aws s3api head-bucket --bucket b",
        "aws cloudformation validate-template --template-body t", "aws ec2 wait instance-running",
        "aws iam generate-credential-report", "aws --region ap-northeast-2 ec2 describe-instances",
        # prose and non-commands must not be read as commands
        "AWS Lambda update windows are announced", "Use AWS Config enable recording guidance",
        "use aws cloudwatch dashboards to compare", "run aws ec2 against the account", "aws --version")
    for cmd in read_only:
        assert not report._has_mutating_cli(cmd), cmd



def test_inventory_reports_sync_window():
    class _Conn:
        def run(self, sql, **kw):
            if "GROUP BY" in sql:
                return [("ec2", 1)]
            if "min(captured_at)" in sql:
                return [("2026-10-11 08:00:00+00", "2026-10-11 08:15:00+00")]
            return [("i-1", "ap-northeast-2", {"a": 1})]
    data = sources.collect_inventory(_Conn())["data"]
    assert data["synced_at"] == {"oldest": "2026-10-11 08:00:00+00", "newest": "2026-10-11 08:15:00+00"}
    assert "synced_at" in sources.COLLECTION_WINDOWS["inventory"]



def test_empty_inventory_stays_empty_with_sync_window():
    class _Conn:
        def run(self, sql, **kw):
            if "min(captured_at)" in sql:
                return [(None, None)]
            return []
    res = sources.collect_inventory(_Conn())
    assert res["data"]["synced_at"] is None
    assert report._collection_status("inventory", res)["status"] == "empty"


def test_read_timeout_scales_with_the_token_budget(monkeypatch):
    assert report._BEDROCK_READ_TIMEOUT_S == 90  # base value stays the floor for small calls
    assert report._read_timeout_for(300) == report._BEDROCK_READ_TIMEOUT_S
    assert report._read_timeout_for(8000) == 8000 // report._SLOWEST_TOKENS_PER_S + 60
    seen = []
    monkeypatch.setattr(report, "_bedrock_clients", {})
    monkeypatch.setattr(report.boto3, "client", lambda *a, **k: seen.append(k["config"].read_timeout) or object())
    report._get_bedrock_client("r", 300)
    report._get_bedrock_client("r", 460)
    report._get_bedrock_client("r", 460)
    assert seen == [300, 460]  # one client per (region, timeout), reused



# ── render budget: the Step Functions task (3600 s) must never be killed by Bedrock waits ─────────

def test_bedrock_client_has_no_botocore_retries():
    # a legacy retry would multiply a read timeout x3 per section per render wave
    assert report._bedrock_config(100).retries == {"max_attempts": 0}


def test_call_timeout_is_capped_by_the_remaining_render_budget(monkeypatch):
    monkeypatch.setattr(report, "_render_deadline", None)
    assert report._call_timeout(8000) == report._read_timeout_for(8000)
    monkeypatch.setattr(report.time, "monotonic", lambda: 1000.0)
    monkeypatch.setattr(report, "_render_deadline", 1000.0 + 200)
    assert report._call_timeout(8000) == 180            # min(460, 200) quantized down to 30 s
    monkeypatch.setattr(report, "_render_deadline", 1000.0 + 10)
    with pytest.raises(TimeoutError):
        report._call_timeout(8000)                      # less than _MIN_CALL_S left: fail fast


def test_throttling_is_retried_inside_the_budget_but_other_errors_are_not(monkeypatch):
    from botocore.exceptions import ClientError
    monkeypatch.setattr(report, "_bedrock_clients", {})
    monkeypatch.setattr(report.time, "sleep", lambda s: None)
    calls = []

    class _Client:
        def __init__(self, errors):
            self.errors = list(errors)

        def invoke_model(self, modelId, body):
            calls.append(1)
            if self.errors:
                raise ClientError({"Error": {"Code": self.errors.pop(0)}}, "InvokeModel")

            class _R:
                def read(self):
                    return json.dumps({"content": [{"text": "ok"}], "stop_reason": "end_turn"}).encode()
            return {"body": _R()}

    client = _Client(["ThrottlingException", "ServiceUnavailableException"])
    monkeypatch.setattr(report.boto3, "client", lambda *a, **k: client)
    assert report._bedrock_render("p", "{}", report.MODEL_ID, 100) == "ok"
    assert len(calls) == 3                               # 2 retries then success
    calls.clear()
    client = _Client(["AccessDeniedException"])
    monkeypatch.setattr(report, "_bedrock_clients", {})
    with pytest.raises(ClientError):
        report._bedrock_render("p", "{}", report.MODEL_ID, 100)
    assert len(calls) == 1                               # not retryable: fail at once
    calls.clear()
    client = _Client(["ThrottlingException"] * 5)
    monkeypatch.setattr(report, "_bedrock_clients", {})
    with pytest.raises(ClientError):
        report._bedrock_render("p", "{}", report.MODEL_ID, 100)
    assert len(calls) == report._CALL_ATTEMPTS           # bounded, never unbounded retry


def test_generate_degrades_remaining_sections_when_the_render_budget_is_spent(monkeypatch):
    monkeypatch.setattr(report.src, "collect_all",
                        lambda conn, scope="self": [{"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {"x": 1}}])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    monkeypatch.setattr(report, "_RENDER_BUDGET_S", 0)   # budget already spent when rendering starts
    monkeypatch.setattr(report, "_get_bedrock_client", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no call expected")))
    md, summary, _ = report.generate(object(), account="1", tier="mid")
    assert len(summary["render_degraded"]) == 8           # every LLM section failed fast, none hung
    assert "(degraded)" in md and report._render_deadline is None  # report still assembled; deadline cleared



# ── by-design caps vs unexpected gaps: only failures make a real report `partial` ──────────────────

def _gen(monkeypatch, data, **extra):
    monkeypatch.setattr(report.src, "collect_all", lambda conn, scope="self": [
        {"key": "posture", "ok": True, "degraded": False, "notes": "", "data": data, **extra}])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    monkeypatch.setattr(report, "_bedrock_render", lambda *a: "body")
    return report.generate(object(), account="self")[1]


def test_security_hub_page_cap_alone_does_not_make_the_report_partial(monkeypatch):
    # >100 ACTIVE+NEW findings is the normal state of an account with standards enabled
    summary = _gen(monkeypatch, {"enabled": True, "findings_by_severity": {"HIGH": 100}, "more_findings": True,
                                 "more_top_findings": True, "more_top_groups": True})
    assert summary["degraded"] == [] and summary["incomplete"] == ["posture"]


def test_unexpected_gaps_still_make_the_report_partial(monkeypatch):
    s1 = _gen(monkeypatch, {"enabled": True, "findings_by_severity": {"HIGH": 1}, "top_findings_unavailable": "throttled"})
    assert s1["degraded"] == ["posture"] and s1["incomplete"] == []
    s2 = _gen(monkeypatch, {"by_type": {"ec2": 1}, "read_failed_types": ["ec2"], "unsampled_types": ["ec2"]})
    assert s2["degraded"] == ["posture"]


def test_datasource_payload_cap_is_a_by_design_gap():
    assert report._collection_gaps({"_truncated": True}) == (True, False)
    assert report._collection_status("datasources_obs", {"key": "datasources_obs", "data": {"_truncated": True, "queried": 1}}
                                     )["status"] == "partial"


def test_inventory_marks_failed_reads_separately_from_the_byte_cap():
    class _Conn:
        def run(self, sql, **kw):
            if "GROUP BY" in sql:
                return [("ec2", 1), ("rds", 1)]
            if kw.get("rtype") == "rds":
                raise RuntimeError("timeout")
            return [("i-1", "ap-northeast-2", {"a": 1})]
    data = sources.collect_inventory(_Conn())["data"]
    assert data["read_failed_types"] == ["rds"] and data["unsampled_types"] == ["rds"]
    assert report._collection_gaps(data) == (True, True)


# ── review: line continuations and unknown global options must not hide the operation ──────────────

def test_cli_guard_sees_through_line_continuations_and_unknown_global_options():
    mutating = (
        "aws ec2 \\\n  terminate-instances --instance-ids i-1",
        "aws s3 \\\n rm s3://b/k --recursive",
        "aws --cli-input-yaml f.yaml ec2 delete-volume --volume-id v",     # value-taking option not in the list
        "aws --foo bar ec2 delete-volume --volume-id v",                  # unknown option with a service-shaped value
        "aws ec2 --region ap-northeast-2 terminate-instances --instance-ids i-1",
        "`aws iam \\\n   delete-user --user-name u`",
        "aws logs stop-query --query-id q")                                # cancelling a query is a state change
    for cmd in mutating:
        assert report._has_mutating_cli(cmd), cmd
    read_only = (
        "aws ec2 \\\n  describe-instances --filters Name=instance-state-name,Values=stopped",
        "aws --cli-input-yaml f.yaml ec2 describe-volumes", "aws ec2 --region x describe-instances",
        "aws ec2 describe-instances --instance-ids i-1 --query 'Reservations[].Instances[]'",
        "aws --version", "run aws against the account", "use aws cloudwatch dashboards to compare")
    for cmd in read_only:
        assert not report._has_mutating_cli(cmd), cmd


def test_cli_commands_yield_one_pair_per_invocation():
    text = "first `aws ec2 describe-instances` then\n`aws \\\n s3api put-object --bucket b`"
    assert list(report._cli_commands(text)) == [("ec2", "describe-instances"), ("s3api", "put-object")]



# ── review: the allowlist must not pass operations that create or register things ────────────────────

def test_generate_and_push_style_operations_are_not_read_only():
    for cmd in ("aws apigateway generate-client-certificate", "aws deploy push --application-name a",
                "aws deploy register --instance-name i", "aws deploy install --config-file c",
                "aws codeartifact login --tool npm --repository r", "aws emr put --cluster-id c --src f"):
        assert report._has_mutating_cli(cmd), cmd
    for cmd in ("aws iam generate-credential-report", "aws iam generate-service-last-accessed-details --arn a",
                "aws emr get --cluster-id c --src f"):
        assert not report._has_mutating_cli(cmd), cmd


def test_every_aws_s3_subcommand_is_classified():
    # `aws s3` has exactly these subcommands; the code's lists must cover all of them
    assert report._S3_COMMANDS == {"cp", "ls", "mb", "mv", "presign", "rb", "rm", "sync", "website"}
    assert {c for c in report._S3_COMMANDS if not report._has_mutating_cli(f"aws s3 {c} x")} == report._S3_READ_ONLY



def test_rules_name_enable_and_disable_among_the_forbidden_command_verbs():
    # a live run wrote `aws ec2 enable-ebs-encryption-by-default` into a remediation column
    from diagnosis import sections as S
    for verb in ("enable", "disable", "register", "deploy"):
        assert verb in S._RULES
    assert report._has_mutating_cli("aws ec2 enable-ebs-encryption-by-default")


# ── review: the CLI backstop is tested as a matrix, not one bypass at a time ────────────────────────
# Every (service, operation) is wrapped in every position an option, continuation or quote can take.

_MUTATING_PAIRS = (("ec2", "terminate-instances --instance-ids i-1"), ("s3", "rm s3://b/k --recursive"),
                   ("s3", "sync . s3://b"), ("iam", "delete-user --user-name u"),
                   ("route53", "change-resource-record-sets --hosted-zone-id Z"),
                   ("lambda", "invoke --function-name f out.json"), ("sns", "publish --topic-arn t"),
                   ("deploy", "push --application-name a"), ("ssm", "start-session --target i-1"))
_READ_PAIRS = (("ec2", "describe-instances --instance-ids i-1"), ("s3", "ls s3://b"),
               ("iam", "list-users"), ("logs", "start-query --log-group-name g"),
               ("dynamodb", "scan --table-name t"), ("sts", "get-caller-identity"))
_OPTION_FORMS = ("", "--region ap-northeast-2", "--region=ap-northeast-2", "--profile prod", "--debug",
                 "--output json", "--cli-input-yaml f.yaml", "--unknown-opt value", "--endpoint-url https://e.example",
                 "--region us-east-1 --profile p",
                 # three or more options once exhausted a fixed token window and hid the service
                 "--profile prod --region us-east-1 --output json",
                 "--no-verify-ssl --debug --region ap-northeast-2 --profile p",
                 "--profile=p --region=r --output=json --cli-read-timeout 0 --color off")
_WRAPPERS = ("{c}", "`{c}`", "$ {c}", "run {c} now", "| {c} |", "({c})")


def _variants(service, operation):
    for opts in _OPTION_FORMS:
        for place in ("before", "between", "both"):
            before = opts if place in ("before", "both") else ""
            between = opts if place in ("between", "both") else ""
            command = " ".join(p for p in ("aws", before, service, between, operation) if p)
            yield command
            yield command.replace(" ", " \\\n   ", 2)       # shell line continuations after aws / the options
            yield command.replace(" ", " \\\r\n  ", 1)


def test_cli_guard_matrix_flags_every_mutating_command_in_every_form():
    misses = []
    for service, operation in _MUTATING_PAIRS:
        for command in _variants(service, operation):
            for wrap in _WRAPPERS:
                text = wrap.format(c=command)
                if not report._has_mutating_cli(text):
                    misses.append(text)
    assert not misses, f"{len(misses)} bypasses, e.g. {misses[:3]!r}"


def test_cli_guard_matrix_never_flags_a_read_only_command_in_any_form():
    false_positives = []
    for service, operation in _READ_PAIRS:
        for command in _variants(service, operation):
            for wrap in _WRAPPERS:
                text = wrap.format(c=command)
                if report._has_mutating_cli(text):
                    false_positives.append(text)
    assert not false_positives, f"{len(false_positives)} false positives, e.g. {false_positives[:3]!r}"



def test_title_call_receives_only_the_head_of_the_report(monkeypatch):
    seen = {}

    def fake(prompt, context, model_id, max_tokens):
        seen["len"] = len(context)
        return '{"title": "t", "tags": ["a"]}'
    monkeypatch.setattr(report, "_bedrock_render", fake)
    assert report.make_title_and_tags("x" * 500_000)["title"] == "t"
    assert seen["len"] == report._TITLE_INPUT_CHARS
    assert report.make_title_and_tags("short")["title"] == "t" and seen["len"] == len("short")



def test_many_leading_options_never_hide_the_command():
    cmd = "aws --profile prod --region us-east-1 --output json ec2 terminate-instances --instance-ids i-1"
    assert report._has_mutating_cli(cmd)
    assert list(report._cli_commands(cmd)) == [("ec2", "terminate-instances")]
    many = "aws " + " ".join(f"--opt{n} v{n}" for n in range(12)) + " s3 rm s3://b/k"
    assert report._has_mutating_cli(many)
    assert not report._has_mutating_cli("aws " + " ".join(f"--opt{n} v{n}" for n in range(12)) + " ec2 describe-instances")



# ── review: `test` is not a read verb; the render budget is anchored to the job start ───────────────

def test_test_verb_is_not_read_only_but_pure_evaluations_are_allowlisted():
    for cmd in ("aws apigateway test-invoke-method --rest-api-id a --resource-id r --http-method GET",
                "aws apigateway test-invoke-authorizer --rest-api-id a --authorizer-id z",
                "aws lambda test-something --x"):
        assert report._has_mutating_cli(cmd), cmd
    for cmd in ("aws events test-event-pattern --event-pattern p --event e",
                "aws logs test-metric-filter --filter-pattern p --log-event-messages m",
                "aws route53 test-dns-answer --hosted-zone-id Z --record-name r --record-type A"):
        assert not report._has_mutating_cli(cmd), cmd


def test_slow_collection_shortens_the_render_budget_instead_of_exceeding_the_task_limit(monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr(report.time, "monotonic", lambda: clock["now"])
    monkeypatch.setattr(report, "_RENDER_BUDGET_S", 2400)
    monkeypatch.setattr(report, "_TASK_BUDGET_S", 3300)
    monkeypatch.setattr(report, "_POST_RENDER_RESERVE_S", 600)

    def slow_collect(conn, scope="self"):
        clock["now"] += 2600          # collection alone ate 2600 s of the 3300 s task budget
        return [{"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {"x": 1}}]
    monkeypatch.setattr(report.src, "collect_all", slow_collect)
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    deadlines = []

    def fake_render(section, collected, model_id, max_tokens, lang="ko"):
        deadlines.append(report._render_deadline)
        return {"key": section["key"], "title": section["title"], "body": "b"}
    monkeypatch.setattr(report, "render_section", fake_render)
    report.generate(object(), account="1", tier="mid")
    # job_start + 3300 - 600 = 3700 < now(3600) + 2400: the task cap wins over the render budget
    assert deadlines and all(d == 1000.0 + 3300 - 600 for d in deadlines)
    assert report._render_deadline is None


def test_untouched_collection_keeps_the_full_render_budget(monkeypatch):
    clock = {"now": 5.0}
    monkeypatch.setattr(report.time, "monotonic", lambda: clock["now"])
    monkeypatch.setattr(report.src, "collect_all",
                        lambda conn, scope="self": [{"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {"x": 1}}])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    seen = []

    def fake_render(section, collected, model_id, max_tokens, lang="ko"):
        seen.append(report._render_deadline)
        return {"key": section["key"], "title": section["title"], "body": "b"}
    monkeypatch.setattr(report, "render_section", fake_render)
    report.generate(object(), account="1", tier="mid")
    assert all(d == 5.0 + report._RENDER_BUDGET_S for d in seen)



# ── review: connection resets are retried; stripped secret fields are disclosed ──────────────────────

def test_connection_failures_are_retried_inside_the_budget_but_read_timeouts_are_not(monkeypatch):
    from botocore.exceptions import ConnectionClosedError, EndpointConnectionError, ReadTimeoutError
    monkeypatch.setattr(report.time, "sleep", lambda s: None)
    calls = []

    class _Client:
        def __init__(self, errors):
            self.errors = list(errors)

        def invoke_model(self, modelId, body):
            calls.append(1)
            if self.errors:
                raise self.errors.pop(0)

            class _R:
                def read(self):
                    return json.dumps({"content": [{"text": "ok"}], "stop_reason": "end_turn"}).encode()
            return {"body": _R()}

    def run(errors):
        calls.clear()
        client = _Client(errors)
        monkeypatch.setattr(report, "_bedrock_clients", {})
        monkeypatch.setattr(report.boto3, "client", lambda *a, **k: client)
        return report._bedrock_render("p", "{}", report.MODEL_ID, 100)
    assert run([EndpointConnectionError(endpoint_url="u"), ConnectionClosedError(endpoint_url="u")]) == "ok"
    assert len(calls) == 3
    with pytest.raises(ReadTimeoutError):
        run([ReadTimeoutError(endpoint_url="u")])
    assert len(calls) == 1                                  # a read timeout already used the whole call budget
    with pytest.raises(EndpointConnectionError):
        run([EndpointConnectionError(endpoint_url="u")] * 5)
    assert len(calls) == report._CALL_ATTEMPTS               # bounded
    assert "ModelNotReadyException" in report._RETRYABLE_ERROR_CODES


def test_inventory_names_the_secret_fields_it_removed():
    class _Conn:
        def run(self, sql, **kw):
            if "GROUP BY" in sql:
                return [("iam_role", 1)]
            if "min(captured_at)" in sql:
                return [(None, None)]
            return [("r1", "global", {"name": "r1", "AssumeRolePolicy": {"Statement": "*"},
                                        "inline_policies": ["x"], "user_data": "secret", "arn": "a"})]
    data = sources.collect_inventory(_Conn())["data"]
    row = data["resources"]["iam_role"][0]["data"]
    assert row == {"name": "r1", "arn": "a"}                       # the secret fields are gone from the row
    assert set(data["redacted_keys"]) == {"AssumeRolePolicy", "inline_policies", "user_data"}
    assert "redacted_keys" in sources.COLLECTION_WINDOWS["inventory"]
    assert "NOT evidence" in sources.COLLECTION_WINDOWS["inventory"]


def test_identity_section_is_told_that_policy_bodies_are_not_collected():
    from diagnosis import sections as S
    prompt = next(s for s in S.DEEP_SECTIONS if s["key"] == "identity_access")["prompt"]
    assert "redacted_keys" in prompt and "정책이 없다·안전하다고 결론내리지 마라" in prompt


# ── RCA table contract: findings must end with an evidence-backed cause/remediation table ─────────

_RCA_TABLE_KO = ("### 원인 분석 및 조치\n\n| 발견 | 대상 | 근거 | 원인 | 확인 방법 | 해결 절차 | 신뢰도 |\n"
                 "|---|---|---|---|---|---|---|\n"
                 "| [Critical] 공개 SG | sg-1 | network.sg_open=0.0.0.0/0 | 확인됨: 22 개방 | "
                 "aws ec2 describe-security-groups --group-ids sg-1 | 인바운드를 사내 CIDR로 제한 | High |")


def _render(monkeypatch, body, lang="ko", stop_reason=None):
    def fake(*a, **k):
        t = report._RenderedText(body)
        t.stop_reason = stop_reason
        return t
    monkeypatch.setattr(report, "_bedrock_render", fake)
    return report.render_section({"key": "x", "title": "X", "sources": [], "prompt": "p"}, {},
                                 report.MODEL_ID, 100, lang)


def test_finding_without_rca_table_is_marked_and_degrades_the_report(monkeypatch):
    out = _render(monkeypatch, "### 노출면\n- [Critical] 0.0.0.0/0 SSH 개방 (근거: network.sg)")
    assert out["rca_missing"] is True and "원인 분석 및 조치 표가 없어" in out["body"]


@pytest.mark.parametrize("lang,heading", [
    ("ko", "원인 분석 및 조치"), ("en", "Root Cause and Remediation"),
    ("zh", "原因分析与处置"), ("ja", "原因分析と対処"),
])
def test_finding_with_rca_table_in_any_report_language_passes(monkeypatch, lang, heading):
    body = "- [Warning] x\n\n" + _RCA_TABLE_KO.replace("원인 분석 및 조치", heading)
    out = _render(monkeypatch, body, lang)
    assert "rca_missing" not in out and out["body"] == body


@pytest.mark.parametrize("heading", [
    "## [Critical]/[Warning] 발견 — 원인 분석 및 조치",   # seen live on the Recommendations section
    "### 1. 원인 분석 및 조치 (요약)",
])
def test_decorated_rca_heading_with_a_table_passes(monkeypatch, heading):
    body = "- [Warning] x\n\n" + _RCA_TABLE_KO.replace("### 원인 분석 및 조치", heading)
    assert heading in body
    assert "rca_missing" not in _render(monkeypatch, body)


def test_decorated_rca_heading_without_a_table_is_still_missing(monkeypatch):
    body = "- [Critical] x\n\n## [Critical]/[Warning] 발견 — 원인 분석 및 조치\n원인 미확정"
    assert _render(monkeypatch, body)["rca_missing"] is True


@pytest.mark.parametrize("body", [
    "- [Critical] x\n\n### 원인 분석 및 조치\n원인 미확정",                       # heading, no table
    "- [Critical] x\n\n### 원인 분석 및 조치\n| 발견 | 대상 |\n|---|---|\n",   # header only, no data row
    "- [Critical] x\n\n### 원인 분석 및 조치\n| a | b |\n| c | d |\n| e | f |",  # no separator row
])
def test_rca_heading_without_a_real_table_is_missing(monkeypatch, body):
    assert _render(monkeypatch, body)["rca_missing"] is True


def test_info_only_or_truncated_sections_are_not_marked_rca_missing(monkeypatch):
    assert "rca_missing" not in _render(monkeypatch, "- [Info] 특이사항 없음 (근거: inventory)")
    cut = _render(monkeypatch, "- [Critical] x 그리고 표를 쓰다가", stop_reason="max_tokens")
    assert cut["truncated"] is True and "rca_missing" not in cut  # one note for one cause


def test_rca_missing_section_makes_the_report_render_degraded(monkeypatch):
    monkeypatch.setattr(report.src, "collect_all",
                        lambda conn, scope="self": [{"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {"x": 1}}])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **k: "- [Critical] 근거 없는 결론")
    summary = report.generate(object(), account="1", tier="light")[1]
    assert summary["render_degraded"]  # → handlers.py marks the report `partial`


def test_lang_rules_name_the_localized_rca_heading():
    from diagnosis.sections import LANG_RULES, RCA_HEADINGS
    for lang in ("en", "zh", "ja"):
        assert RCA_HEADINGS[lang] in LANG_RULES[lang]


def test_mutating_cli_guard_review_gaps_are_closed():
    # case-insensitive operations, codedeploy push, EMR put/ssh
    for cmd in ("aws ec2 Delete-Volume --volume-id v", "aws EC2 TERMINATE-INSTANCES --instance-ids i",
                "aws deploy push --application-name a --s3-location s3://b/k",
                "aws emr put --cluster-id j --src f", "aws emr ssh --cluster-id j --key-pair-file k"):
        assert report._has_mutating_cli(cmd), cmd
    # `aws s3 <word>` that is not one of the nine real s3 commands is prose, not a command
    for cmd in ("aws s3 bucket policies should block public access", "aws s3 LS s3://b"):
        assert not report._has_mutating_cli(cmd), cmd


def test_section_budget_is_clamped_to_the_model_output_ceiling(monkeypatch):
    monkeypatch.setattr(report, "_MAX_OUTPUT_TOKENS", 4096)
    assert report._capped_budget({"key": "recommendations"}, 6000) == 4096
    assert report._capped_budget({"key": "security_posture"}, 3000) == 3000


def test_throttling_backoff_never_sleeps_past_the_render_budget(monkeypatch):
    from botocore.exceptions import ClientError
    slept = []
    monkeypatch.setattr(report.time, "sleep", lambda s: slept.append(s))
    monkeypatch.setattr(report.time, "monotonic", lambda: 1000.0)
    monkeypatch.setattr(report, "_render_deadline", 1000.0 + 31)  # one call fits (>=30 s), backoff (>=2 s) + call does not

    class _Throttled:
        def invoke_model(self, **kw):
            raise ClientError({"Error": {"Code": "ThrottlingException"}}, "InvokeModel")
    monkeypatch.setattr(report, "_get_bedrock_client", lambda *a, **k: _Throttled())
    with pytest.raises(TimeoutError):
        report._bedrock_render("p", "{}", report.MODEL_ID, 100)
    assert slept == []


def test_posture_top_findings_are_sorted_by_severity(monkeypatch):
    calls = []

    class _FakeSh:
        def get_findings(self, **kw):
            calls.append(kw)
            return {"Findings": []}
    monkeypatch.setattr(sources, "_sh_client", lambda: _FakeSh())
    sources.collect_posture()
    top = [c for c in calls if "SeverityLabel" in c["Filters"]][0]
    assert top["SortCriteria"] == [{"Field": "SeverityNormalized", "SortOrder": "desc"}]


def test_marker_mentions_without_a_finding_are_not_findings(monkeypatch):
    # live recent_changes output (2026-10-11): only [Info] items, the scale mentioned in prose
    body = ("### 이벤트 분류 표\n\n| 이벤트 | 리스크 |\n|---|---|\n| `CreateLogGroup` | [Info] |\n\n"
            "- 보안·네트워크·IAM 영향 변경(`[Warning]` 이상): **해당 없음**\n\n"
            "### 원인 분석 및 조치\n\n[Critical]/[Warning] 발견 없음 — 해당 표 생략")
    assert "rca_missing" not in _render(monkeypatch, body)
    # a real tagged finding still requires the table, even next to such prose
    assert _render(monkeypatch, body.replace("- 보안", "- [Warning] P2 공개 SG 추가\n- 보안"))["rca_missing"] is True


@pytest.mark.parametrize("body", [
    "### 요약\nNo [Critical] or [Warning] findings were identified in this window.",
    "### 요약\n`[Critical]` 또는 `[Warning]` 발견 없음",
    "- [Critical]/[Warning] 발견 없음 — 해당 표 생략",
    "### 예시\n```\n- [Critical] example only\n```\n- [Info] 정상",
])
def test_scale_mentions_and_code_are_not_findings(monkeypatch, body):
    assert "rca_missing" not in _render(monkeypatch, body)


@pytest.mark.parametrize("body", [
    "- [Critical]/P1 / Low 공개 SG",                 # a real tag followed by a slash and the priority
    "1. **[Warning]** P2 단일 AZ",                   # numbered + bold
    "| 리소스 | 심각도 |\n|---|---|\n| sg-1 | [Critical] |",  # table-cell tag
    "#### [Warning] 백업 부재",                        # heading tag
])
def test_tagged_findings_in_every_prompt_shape_require_the_table(monkeypatch, body):
    assert _render(monkeypatch, body)["rca_missing"] is True


def test_any_rca_heading_with_a_table_satisfies_the_contract(monkeypatch):
    body = ("- [Critical] x\n\n### 원인 분석 및 조치\n원인 미확정\n\n### 원인 분석 및 조치\n"
            "| 발견 | 대상 |\n|:-:|:-|\n| x | y |\n\n### 원인 분석 및 조치\n추가 메모")
    assert "rca_missing" not in _render(monkeypatch, body)


def test_rca_missing_note_carries_no_bracketed_severity_marker(monkeypatch):
    out = _render(monkeypatch, "- [Warning] P2 단일 AZ")
    note = out["body"][len("- [Warning] P2 단일 AZ"):]
    assert "[Critical]" not in note and "[Warning]" not in note
    for mark in report._RCA_MISSING_MARK.values():
        assert "[Critical]" not in mark and "[Warning]" not in mark


def test_coverage_note_never_republishes_provider_text(monkeypatch):
    from botocore.exceptions import ClientError

    class _FakeSh:
        def get_findings(self, **kw):
            if "SeverityLabel" in kw["Filters"]:
                raise ClientError({"Error": {"Code": "AccessDeniedException",
                                             "Message": "User arn:aws:iam::123456789012:role/secret is not authorized"}},
                                  "GetFindings")
            return {"Findings": [{"Severity": {"Label": "HIGH"}}]}
    monkeypatch.setattr(sources, "_sh_client", lambda: _FakeSh())
    note = report._coverage_note({"posture": sources.collect_posture()})
    assert "AccessDeniedException" in note and "secret" not in note and "123456789012" not in note


@pytest.mark.parametrize("rejection_kind", ["InvalidInputException", "ValidationException", "param"])
def test_rejected_sort_falls_back_to_the_unsorted_page_and_says_so(monkeypatch, rejection_kind):
    from botocore.exceptions import ClientError, ParamValidationError
    rejection = (ParamValidationError(report="SortCriteria") if rejection_kind == "param"
                 else ClientError({"Error": {"Code": rejection_kind}}, "GetFindings"))
    calls = []

    class _FakeSh:
        def get_findings(self, **kw):
            calls.append(kw)
            if "SortCriteria" in kw:
                raise rejection
            return {"Findings": [{"Severity": {"Label": "CRITICAL"}, "Title": "t",
                                  "Compliance": {"SecurityControlId": "EC2.1"}}]}
    monkeypatch.setattr(sources, "_sh_client", lambda: _FakeSh())
    data = sources.collect_posture()["data"]
    assert data["top_findings_order"] == "unsorted" and data["top_findings"]
    assert "top_findings_unavailable" not in data


def test_sorted_detail_page_is_tagged(monkeypatch):
    class _FakeSh:
        def get_findings(self, **kw):
            return {"Findings": []}
    monkeypatch.setattr(sources, "_sh_client", lambda: _FakeSh())
    assert sources.collect_posture()["data"]["top_findings_order"] == "severity_desc"


def test_call_timeout_never_drops_below_the_minimum_call_time(monkeypatch):
    monkeypatch.setattr(report.time, "monotonic", lambda: 1000.0)
    monkeypatch.setattr(report, "_render_deadline", 1000.0 + 59)
    assert report._call_timeout(8000) >= report._MIN_CALL_S


def test_other_detail_errors_still_surface_as_unavailable(monkeypatch):
    from botocore.exceptions import ClientError

    class _FakeSh:
        def get_findings(self, **kw):
            if "SortCriteria" in kw:
                raise ClientError({"Error": {"Code": "AccessDeniedException"}}, "GetFindings")
            return {"Findings": []}
    monkeypatch.setattr(sources, "_sh_client", lambda: _FakeSh())
    assert sources.collect_posture()["data"]["top_findings_unavailable"] == "AccessDeniedException"


@pytest.mark.parametrize("body", ["- [Critical] 발견 없음", "**[Warning]** 해당 없음", "- [Warning]: none", "| [Critical] N/A |"])
def test_negation_in_tag_position_is_not_a_finding(monkeypatch, body):
    assert "rca_missing" not in _render(monkeypatch, body)


def test_rca_table_inside_a_code_fence_does_not_satisfy_the_contract(monkeypatch):
    body = "- [Critical] x\n\n```\n### 원인 분석 및 조치\n| a | b |\n|---|---|\n| c | d |\n```"
    assert _render(monkeypatch, body)["rca_missing"] is True


def test_failed_inventory_read_is_not_labelled_a_sample_cap():
    data = {"by_type": {"ec2": 2}, "unsampled_types": ["ec2"], "read_failed_types": ["ec2"]}
    reason = report._gap_reason(data)
    assert "read failed: ec2" in reason and "sample size cap" not in reason


def test_context_rules_disclose_the_severity_ordered_detail_page():
    # a negative-inference ban, not an instruction to trust another (also sampled) count
    assert "posture.top_findings" in report._CONTEXT_RULES
    assert "HIGH 발견이 없다는 근거가 아니다" in report._CONTEXT_RULES



@pytest.mark.parametrize("lang,body", [
    ("zh", "- [Critical] 未发现问题"), ("zh", "- [Warning] 没有发现异常"), ("zh", "| [Critical] 无 |"),
    ("ja", "- [Warning] 該当なし"), ("ja", "- [Critical] 問題なし"), ("ja", "**[Warning]** なし"),
    ("en", "- [Warning] Not found."), ("ko", "| [Critical] 문제 없음 |"),
])
def test_negation_tags_in_every_report_language_are_not_findings(monkeypatch, lang, body):
    assert "rca_missing" not in _render(monkeypatch, body, lang)


def test_negation_table_covers_every_supported_language():
    from diagnosis.sections import LANG_RULES
    assert set(report._NEGATIONS) == set(LANG_RULES)


@pytest.mark.parametrize("lang,body", [
    ("zh", "- [Critical] 安全组对 0.0.0.0/0 开放 22 端口"), ("ja", "- [Warning] 単一 AZ の RDS"),
])
def test_real_zh_ja_findings_still_require_the_table(monkeypatch, lang, body):
    assert _render(monkeypatch, body, lang)["rca_missing"] is True



@pytest.mark.parametrize("lang,body", [
    ("en", "- [Warning] None of the S3 buckets have default encryption enabled"),
    ("en", "- [Critical] Not found: CloudTrail trail in ap-northeast-2"),
    ("zh", "- [Critical] 未发现关键审计日志配置（审计缺失）"),
    ("ko", "- [Warning] 없음에도 불구하고 백업이 구성되지 않음"),
    ("ja", "- [Warning] なしの状態で 30 日経過した EBS スナップショット"),
])
def test_a_finding_that_starts_with_a_negation_word_still_requires_the_table(monkeypatch, lang, body):
    assert _render(monkeypatch, body, lang)["rca_missing"] is True


def test_bold_paired_scale_markers_and_tilde_fences_are_not_findings(monkeypatch):
    assert "rca_missing" not in _render(monkeypatch, "**[Critical]**/**[Warning]** 발견 없음")
    assert "rca_missing" not in _render(monkeypatch, "~~~\n- [Critical] example\n~~~\n- [Info] ok")


def test_negations_are_scoped_to_the_report_language(monkeypatch):
    # a Japanese negation does not silence a Korean report's finding
    assert _render(monkeypatch, "- [Warning] なし", "ko")["rca_missing"] is True
    assert "rca_missing" not in _render(monkeypatch, "- [Warning] なし", "ja")


def test_posture_window_matches_the_severity_sorted_detail_page():
    w = sources.COLLECTION_WINDOWS["posture"]
    assert "sorted by severity" in w and "unsorted page" not in w

def test_rules_give_a_console_path_alternative_to_change_commands():
    from diagnosis import sections as S
    assert "콘솔 경로" in S._RULES and "'확인 방법' 칸에만" in S._RULES
    assert "어디에도(코드·백틱·괄호·본문 문장 포함) 쓰지 마라" in S._RULES  # unconditional, not scoped to formatted text


def test_context_rules_forbid_inferring_iam_cause():
    assert "notes에" in report._CONTEXT_RULES and "IAM 권한 부족" in report._CONTEXT_RULES
    assert "권한 추가로 해결되지 않는다" in report._CONTEXT_RULES
