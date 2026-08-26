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
    # Task 3: tier picks the catalog (mid=9, deep=16) + model (deep may select Opus) + max_tokens.
    monkeypatch.setattr(report.src, "collect_all",
                        lambda conn, scope="self": [{"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {}}])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])
    calls = []
    monkeypatch.setattr(report, "_bedrock_render",
                        lambda prompt, ctx, model_id, max_tokens: (calls.append((model_id, max_tokens)) or "본문"))

    calls.clear(); report.generate(object(), account="1", tier="mid")
    assert len(calls) == 9 and all(m == report._MODEL_SONNET and t == 1500 for m, t in calls)

    calls.clear(); report.generate(object(), account="1", tier="deep", model="opus")
    assert len(calls) == 16 and all(m == report._MODEL_OPUS and t == 2200 for m, t in calls)

    calls.clear(); report.generate(object(), account="1", tier="deep")  # default model = sonnet
    assert len(calls) == 16 and all(m == report._MODEL_SONNET for m, t in calls)

    calls.clear(); report.generate(object(), account="1", tier="mid", model="opus")  # pinned
    assert len(calls) == 9 and all(m == report._MODEL_SONNET for m, t in calls)


def test_generate_parallel_preserves_order_and_isolates_section_failure(monkeypatch):
    # ADR-045: sections render concurrently. Order MUST be preserved (reassembled by index) and a single
    # failing section MUST degrade in place (loud) WITHOUT sinking the whole report.
    from diagnosis import sections as S
    monkeypatch.setattr(report.src, "collect_all",
                        lambda conn, scope="self": [{"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {}}])
    monkeypatch.setattr(report.ddb, "list_active_invariants", lambda conn: [])

    def fake_render(section, collected, model_id, max_tokens):
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
        kw["on_progress"](2, 9, "네트워크", "render")  # generate would call this per section
        return ("# md", {"degraded": []}, ["inventory"])
    _patch_report(monkeypatch, generate=gen)
    calls = []
    monkeypatch.setattr(_ddb, "update_progress",
                        lambda conn, rid, **kw: calls.append((rid, kw)))
    result, _ = handlers._report(
        {"account": "1", "tier": "mid", "requested_by": "u", "report_id": 7}, dry_run=False)
    assert result["status"] == "succeeded"
    assert calls and calls[0][0] == 7
    assert calls[0][1] == {"current": 2, "total": 9, "section": "네트워크", "phase": "render"}


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
