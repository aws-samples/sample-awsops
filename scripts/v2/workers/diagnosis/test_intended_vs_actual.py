"""Task 7 — report integrates active-invariant evaluation + drift + report diff."""
import json
from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess

import markdown
import pytest

from diagnosis import db
from diagnosis import report
from diagnosis import sections


# --- db readers ----------------------------------------------------------

class FakeConn:
    def __init__(self, ret_by_sql=None):
        self.ret_by_sql = ret_by_sql or {}
        self.calls = []
        self.closed = False

    def run(self, sql, **kw):
        self.calls.append((sql, kw))
        for needle, ret in self.ret_by_sql.items():
            if needle in sql:
                return ret
        return []

    def close(self):
        self.closed = True


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

def test_generate_weaves_drift_without_sending_verdicts_to_llm(monkeypatch):
    # collectors return an internet→rds edge; one active private_only invariant must drift.
    def fake_collect_all(conn, scope="self"):
        return [
            {"key": "inventory", "ok": True, "degraded": False, "notes": "", "data": {"by_type": {"rds": 1}}},
            {"key": "service_map", "ok": True, "degraded": False, "notes": "",
             "data": {"edges": [{"from": "internet", "to": "rds-prod", "error_rate": 0.0}]}},
        ]
    monkeypatch.setattr(report.src, "collect_all", fake_collect_all)

    captured = []

    def fake_bedrock(prompt, ctx, *a, **k):  # variadic: tolerates model_id/max_tokens args
        captured.append(json.loads(ctx))
        return "LLM says no drift"
    monkeypatch.setattr(report, "_bedrock_render", fake_bedrock)

    active = [{"id": 1, "kind": "private_only", "target": "rds-prod", "params": {}, "severity": "critical"}]
    monkeypatch.setattr(db, "list_active_invariants", lambda conn: active)

    md, summary, sources_used = report.generate(FakeConn(), account="1", tier="mid")

    # drift surfaces the failed verdict
    assert "drift" in summary and len(summary["drift"]) == 1
    assert summary["drift"][0]["id"] == 1 and summary["drift"][0]["passed"] is False
    # the intended-vs-actual section is in the markdown
    assert "Intended vs Actual" in md or "intended" in md.lower()
    # No LLM may overwrite the deterministic verdict with an all-clear.
    body = _intent_body(md)
    assert "LLM says no drift" not in body
    assert "rds" in body and "internet" in body
    assert len(captured) == 8
    assert all("intended_vs_actual" not in ctx for ctx in captured)


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
                     on_progress=lambda cur, total, section, phase, completed=None: events.append((cur, total, section, phase, completed)))

    total_sections = len(sections.SECTIONS) + 1  # + INTENDED_VS_ACTUAL_SECTION
    renders = [e for e in events if e[3] == "render"]
    assert len(renders) == total_sections
    # monotonic 1..N, all carrying the fixed total + a section title
    assert [e[0] for e in renders] == list(range(1, total_sections + 1))
    # L177: the completed list grows by one per render event and ends covering every section
    assert [len(e[4]) for e in renders] == list(range(1, total_sections + 1))
    assert renders[-1][4] and set(renders[-1][4]) == {e[2] for e in renders}
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


# The report contract, not a mocked evaluator: these fixtures exercise evaluate_all and generate.
_LANG_LABELS = {
    "ko": ("전체", "평가됨", "통과", "실패", "미평가"),
    "en": ("Total", "Assessed", "Passed", "Failed", "Unassessed"),
    "zh": ("总数", "已评估", "通过", "失败", "未评估"),
    "ja": ("合計", "評価済み", "合格", "不合格", "未評価"),
}
_NOT_CONFIGURED = {
    "ko": "활성 불변식이 설정되지 않았습니다",
    "en": "No active invariants are configured",
    "zh": "未配置活动不变量",
    "ja": "有効な不変条件が設定されていません",
}


def _intent_body(md):
    return md.split("## Intended vs Actual\n", 1)[1].split("\n## ", 1)[0]


class _RenderedContent(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.tags = []
        self.text = []
        self.code = []
        self.current_code = None
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        if tag == "code":
            self.current_code = ""

    def handle_data(self, data):
        self.text.append(data)
        if self.current_code is not None:
            self.current_code += data

    def handle_endtag(self, tag):
        if tag == "code":
            self.code.append(self.current_code)
            self.current_code = None


@pytest.fixture
def offline_generate(monkeypatch):
    """Replace only external collection/storage/model calls; keep evaluation and rendering real."""
    calls = []

    def fake_llm(prompt, context, *args):
        calls.append(json.loads(context))
        return "LLM says no drift"

    def no_aws(*args, **kwargs):
        raise AssertionError("AWS clients are forbidden in these generation tests")

    monkeypatch.setattr(report, "_bedrock_render", fake_llm)
    monkeypatch.setattr(report.boto3, "client", no_aws)

    def run(active, *, inventory=None, service_map=None, lang="en", tier="mid", parent=None,
            degraded_sources=()):
        collected = [
            {"key": "inventory", "ok": True, "degraded": False, "notes": "",
             "data": inventory if inventory is not None else {"by_type": {"rds": 1}}},
            {"key": "service_map", "ok": True, "degraded": False, "notes": "",
             "data": service_map if service_map is not None else {
                 "edges": [{"from": "api", "to_ref": 1, "calls": 0, "error_rate": 0}]}},
        ]
        for source in collected:
            if source["key"] in degraded_sources:
                source.update(ok=False, degraded=True, notes="collector unavailable",
                              data={"_failed": True})
        monkeypatch.setattr(report.src, "collect_all", lambda *args: collected)
        monkeypatch.setattr(db, "list_active_invariants", lambda conn: active)
        if parent is not None:
            monkeypatch.setattr(db, "get_report_summary",
                                lambda conn, rid: (3, {}) if rid == 7 else (None, parent))
        events = []
        calls.clear()
        md, summary, used = report.generate(
            FakeConn(), account="self", tier=tier, lang=lang,
            report_id=7 if parent is not None else None,
            on_progress=lambda *event: events.append(event),
        )
        return md, summary, used, events, list(calls)

    return run


@pytest.mark.parametrize("lang", ["ko", "en", "zh", "ja"])
@pytest.mark.parametrize("tier,total_sections,llm_sections", [
    ("light", 9, 8), ("mid", 9, 8), ("deep", 16, 15),
])
def test_generate_all_unknown_preserves_reasons_and_cannot_render_all_clear(
        offline_generate, lang, tier, total_sections, llm_sections):
    active = [
        {"id": i, "kind": kind, "target": "rds", "params": {"from": "api", "to": "rds"},
         "severity": "warning"}
        for i, kind in enumerate([
            "private_only", "encryption_required", "expected_edge",
            "forbidden_edge", "max_error_rate", "no_public_ingress",
        ], 1)
    ]
    md, summary, used, events, calls = offline_generate(active, lang=lang, tier=tier)

    assert summary["invariant_coverage"] == {
        "total": 6, "assessed": 0, "passed": 0, "failed": 0, "unassessed": 6,
    }
    assert summary["drift"] == []
    assert len(summary["unassessed"]) == 6
    assert all(v["passed"] is None and v["observed"].startswith("unknown:")
               for v in summary["unassessed"])
    assert summary["degraded"] == []  # incomplete evaluation is not a collector failure
    assert used == ["inventory", "service_map"]
    assert summary["sections"] == total_sections
    assert len(calls) == llm_sections
    assert all("intended_vs_actual" not in ctx for ctx in calls)

    body = _intent_body(md)
    assert "LLM says no drift" not in body
    assert _LANG_LABELS[lang][4] in body and "degraded" in body
    assert "| 6 | 0 | 0 | 0 | 6 |" in body
    assert "- `intended_vs_actual`:" not in md
    rendered = _RenderedContent(markdown.markdown(body, extensions=["tables"]))
    for verdict in summary["unassessed"]:
        assert verdict["observed"] in "".join(rendered.text)

    renders = [event for event in events if event[3] == "render"]
    assert [event[0] for event in renders] == list(range(1, total_sections + 1))
    assert all(event[1] == total_sections for event in renders)
    assert [len(event[4]) for event in renders] == list(range(1, total_sections + 1))
    assert events[0][3] == "collect" and events[-1][3] == "assemble"

    # Persisting the existing summary JSON must preserve every original unknown reason.
    conn = FakeConn()
    db.finish_report(conn, 7, status="succeeded", summary=summary, sources_used=used)
    stored = json.loads(conn.calls[-1][1]["sm"])
    assert stored["unassessed"] == summary["unassessed"]
    assert stored["invariant_coverage"] == summary["invariant_coverage"]


@pytest.mark.parametrize("lang", ["ko", "en", "zh", "ja"])
@pytest.mark.parametrize("case,active,inventory,expected", [
    ("none", [], {}, {"total": 0, "assessed": 0, "passed": 0, "failed": 0, "unassessed": 0}),
    ("pass", [{"id": 1, "kind": "encryption_required", "target": "rds", "params": {}}],
     {"unencrypted": {"rds": 0}},
     {"total": 1, "assessed": 1, "passed": 1, "failed": 0, "unassessed": 0}),
    ("fail", [{"id": 1, "kind": "encryption_required", "target": "rds", "params": {}}],
     {"unencrypted": {"rds": 2}},
     {"total": 1, "assessed": 1, "passed": 0, "failed": 1, "unassessed": 0}),
    ("mixed", [
        {"id": 1, "kind": "encryption_required", "target": "rds", "params": {}},
        {"id": 2, "kind": "encryption_required", "target": "s3", "params": {}},
        {"id": 3, "kind": "expected_edge", "params": {"from": "api", "to": "rds"}},
    ], {"unencrypted": {"rds": 0, "s3": 2}},
     {"total": 3, "assessed": 2, "passed": 1, "failed": 1, "unassessed": 1}),
])
def test_generate_coverage_distinguishes_unconfigured_pass_failure_and_mixed(
        offline_generate, lang, case, active, inventory, expected):
    md, summary, _, _, _ = offline_generate(active, inventory=inventory, lang=lang)
    assert summary["invariant_coverage"] == expected
    assert len(summary["drift"]) == expected["failed"]
    assert len(summary["unassessed"]) == expected["unassessed"]
    assert summary["degraded"] == []
    assert "- `intended_vs_actual`:" not in md
    body = _intent_body(md)
    assert all(label in body for label in _LANG_LABELS[lang])
    assert "LLM says no drift" not in body
    if case == "none":
        assert _NOT_CONFIGURED[lang] in body
    if case == "mixed":
        assert "| 3 | 2 | 1 | 1 | 1 |" in body
        rendered = _RenderedContent(markdown.markdown(body, extensions=["tables"]))
        for verdict in summary["drift"] + summary["unassessed"]:
            assert verdict["observed"] in "".join(rendered.text)


@pytest.mark.parametrize("lang", ["ko", "en", "zh", "ja"])
def test_generate_preserves_real_collector_degradation_with_unassessed_intent(offline_generate, lang):
    active = [{"id": 1, "kind": "encryption_required", "target": "rds", "params": {}}]
    md, summary, used, _, _ = offline_generate(
        active, lang=lang, degraded_sources=("inventory",))
    assert summary["degraded"] == ["inventory"]
    assert used == ["service_map"]
    assert summary["invariant_coverage"]["unassessed"] == 1
    assert len(summary["unassessed"]) == 1
    assert "- `inventory`: degraded — collector unavailable" in md
    assert "- `intended_vs_actual`:" not in md
    assert _LANG_LABELS[lang][4] in _intent_body(md)
    assert "degraded" in _intent_body(md)


@pytest.mark.parametrize("configured,degraded_sources,expected_status", [
    (True, (), "succeeded"),
    (True, ("inventory",), "partial"),
    (False, (), "succeeded"),
])
def test_actual_report_handler_status_uses_real_collector_health(
        monkeypatch, offline_generate, configured, degraded_sources, expected_status):
    import db as worker_db
    import handlers

    active = [
        {"id": i, "kind": kind, "target": "rds", "params": {"from": "api", "to": "rds"}}
        for i, kind in enumerate([
            "private_only", "encryption_required", "expected_edge",
            "forbidden_edge", "max_error_rate", "no_public_ingress",
        ], 1)
    ] if configured else []
    # Install external-boundary fakes, keeping handler -> generate -> evaluator -> persistence real.
    offline_generate(active, degraded_sources=degraded_sources)
    conn = FakeConn()
    monkeypatch.setattr(worker_db, "connect", lambda: conn)
    monkeypatch.setattr(handlers, "_upload_markdown", lambda md, rid: f"s3://test/{rid}.md")
    monkeypatch.setattr(handlers, "_export_artifacts", lambda md, rid: None)
    monkeypatch.setattr(report, "make_title_and_tags", lambda *args: {"title": None, "tags": []})

    result, artifact = handlers._report(
        {"account": "self", "tier": "mid", "lang": "en", "report_id": 7}, dry_run=False)
    stored = next(kw for sql, kw in conn.calls if "SET status=:s" in sql)
    summary = json.loads(stored["sm"])
    assert result["status"] == stored["s"] == expected_status
    assert summary["degraded"] == list(degraded_sources)
    assert summary["invariant_coverage"]["unassessed"] == (6 if configured else 0)
    assert len(summary["unassessed"]) == (6 if configured else 0)
    assert conn.closed is True
    md = artifact.decode("utf-8")
    assert "- `intended_vs_actual`:" not in md
    if configured:
        assert _intent_body(md).lstrip().startswith("[Warning]\n")
        assert "Unassessed is not a pass" in _intent_body(md)
    else:
        assert _NOT_CONFIGURED["en"] in _intent_body(md)
        assert "empty (no data returned)" not in md


def test_generate_unknown_is_not_an_improvement(offline_generate):
    active = [{"id": 1, "kind": "expected_edge", "params": {"from": "api", "to": "rds"}}]
    _, summary, _, _, _ = offline_generate(
        active, parent={"drift": [{"id": 1, "passed": False}]})
    assert summary["invariant_coverage"]["unassessed"] == 1
    assert summary["diff"]["improvements"] == []


_VERDICT_FIELDS = ["id", "kind", "target", "severity", "observed"]
_VERDICT_ATTACK = (
    '[Critical] [Warning] [Info] '
    '![beacon](https://evil.invalid/pixel) [link](https://evil.invalid/) '
    '<img src="data:image/png;base64,AA=="><script>alert(1)</script></code> '
    '`code` **bold** <https://evil.invalid/> https://evil.invalid/ www.evil.invalid '
    'a\\|b a\\\\|b | extra\n'
    '## injected\n```html\n<img src=x>\n```\n&#33;&#91;nested&#93;(x)'
)


def _injected_verdict(field):
    verdict = {"id": 1, "kind": "expected_edge", "target": "db", "severity": "warning",
               "passed": None, "observed": "unknown: unresolved target"}
    verdict[field] = _VERDICT_ATTACK
    return verdict


@pytest.mark.parametrize("field", _VERDICT_FIELDS)
def test_intended_verdict_cells_render_as_text_not_markdown_or_html(monkeypatch, field):
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **k: "LLM says no drift")
    section = report.render_section(
        sections.INTENDED_VS_ACTUAL_SECTION,
        {"intended_vs_actual": {"data": {"verdicts": [_injected_verdict(field)]}}},
        report.MODEL_ID, 1500, lang="en",
    )
    body = section["body"]
    html = markdown.markdown(body, extensions=["tables", "fenced_code"])
    rendered = _RenderedContent(html)
    assert "LLM says no drift" not in body
    assert not ({"img", "a", "script", "pre", "strong", "h1", "h2"} & set(rendered.tags))
    assert rendered.tags.count("td") == 11  # five coverage cells and six verdict cells
    # Five deliberately quoted literals; input cannot close one or inject another code span/block.
    assert len(rendered.code) == 5
    assert json.loads(rendered.code[_VERDICT_FIELDS.index(field)]) == " ".join(_VERDICT_ATTACK.split())

    # The actual PDF HTML path must preserve this text-only contract too.
    from diagnosis import exporters
    pdf = _RenderedContent(exporters._html(body))
    assert not ({"img", "a", "script", "pre"} & set(pdf.tags))
    assert len(pdf.code) == 5
    assert json.loads(pdf.code[_VERDICT_FIELDS.index(field)]) == " ".join(_VERDICT_ATTACK.split())
    assert "unresolved target" in "".join(pdf.text) or field == "observed"


def test_verdict_literals_cannot_be_reautolinked_by_the_app_gfm_renderer(monkeypatch):
    web = Path(__file__).resolve().parents[4] / "web"
    if not shutil.which("node") or not (web / "node_modules/react-markdown").is_dir():
        pytest.skip("App GFM dependencies unavailable; Python/PDF escaping checks still run")
    monkeypatch.setattr(report, "_bedrock_render", lambda *a, **k: "LLM says no drift")
    samples = []
    for lang in ("ko", "en", "zh", "ja"):
        for field in _VERDICT_FIELDS:
            result = report.render_section(
                sections.INTENDED_VS_ACTUAL_SECTION,
                {"intended_vs_actual": {"data": {"verdicts": [_injected_verdict(field)]}}},
                report.MODEL_ID, 1500, lang=lang,
            )
            samples.append({"field": field, "body": result["body"]})
    script = """
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify(JSON.parse(input).map(sample => ({
  field: sample.field,
  html: renderToStaticMarkup(React.createElement(Markdown, {remarkPlugins: [remarkGfm]}, sample.body))
}))));
"""
    result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=web,
                            input=json.dumps(samples), text=True, capture_output=True, check=True)
    for sample in json.loads(result.stdout):
        rendered = _RenderedContent(sample["html"])
        assert not ({"a", "img", "script", "pre", "strong", "h1", "h2"} & set(rendered.tags))
        assert rendered.tags.count("td") == 11
        assert len(rendered.code) == 5
        assert json.loads(rendered.code[_VERDICT_FIELDS.index(sample["field"])]) == \
            " ".join(_VERDICT_ATTACK.split())


@pytest.fixture(scope="module")
def app_section_severity():
    """Run the real UI consumer, extracted by AST; never copy its severity heuristic."""
    web = Path(__file__).resolve().parents[4] / "web"
    node = shutil.which("node")
    if not node or not (web / "node_modules/typescript").is_dir():
        pytest.skip("Node/TypeScript unavailable for the cross-runtime section severity contract")
    script = """
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = ts.createSourceFile(
  'ReportSections.tsx', fs.readFileSync('components/diagnosis/ReportSections.tsx', 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const matches = source.statements.filter(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'sectionSeverity');
if (matches.length !== 1) throw new Error('Expected exactly one sectionSeverity function');
const code = ts.transpileModule(matches[0].getText(source), {
  compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS}
}).outputText;
let input = '';
for await (const chunk of process.stdin) input += chunk;
const results = JSON.parse(input).map(({body, title}) => {
  const context = vm.createContext({exports: {}, body, title}, {
    codeGeneration: {strings: false, wasm: false}
  });
  return vm.runInContext(code + '\\nsectionSeverity(body, title)', context, {timeout: 1000});
});
console.log(JSON.stringify(results));
"""

    def classify(bodies, *, title):
        result = subprocess.run(
            [node, "--input-type=module", "-e", script], cwd=web,
            input=json.dumps([{"body": body, "title": title} for body in bodies]),
            text=True, capture_output=True, check=True,
            timeout=30, env={},
        )
        return json.loads(result.stdout)

    return classify


@pytest.mark.parametrize("lang", ["ko", "en", "zh", "ja"])
def test_generated_sections_match_exact_app_severity_contract(
        offline_generate, app_section_severity, lang):
    def active(severity="warning", *, target="rds", i=1):
        return {"id": i, "kind": "encryption_required", "target": target,
                "params": {}, "severity": severity}

    default_severity = active()
    default_severity.pop("severity")
    cases = [
        ("warning", [active("warning")], {"unencrypted": {"rds": 2}}, "warning"),
        ("critical", [active("critical")], {"unencrypted": {"rds": 2}}, "critical"),
        ("info", [active("info")], {"unencrypted": {"rds": 2}}, "info"),
        ("default", [default_severity], {"unencrypted": {"rds": 2}}, "warning"),
        ("invalid-severity", [active("[Critical]")], {"unencrypted": {"rds": 2}}, "warning"),
        ("unknown", [active("critical")], {"by_type": {"rds": 1}}, "warning"),
        ("noactive", [], {}, "info"),
        ("allpass", [active("critical")], {"unencrypted": {"rds": 0}}, "ok"),
        ("critical-over-warning", [active("warning"), active("critical", i=2)],
         {"unencrypted": {"rds": 2}}, "critical"),
        ("warning-over-info", [active("info"), active("warning", i=2)],
         {"unencrypted": {"rds": 2}}, "warning"),
        ("unknown-over-info", [active("info"), active("critical", target="s3", i=2)],
         {"unencrypted": {"rds": 2}}, "warning"),
        ("passed-critical-does-not-upgrade-info",
         [active("info"), active("critical", target="s3", i=2)],
         {"unencrypted": {"rds": 2, "s3": 0}}, "info"),
    ]
    bodies = []
    for _, invariants, inventory, _ in cases:
        md, summary, _, _, _ = offline_generate(invariants, inventory=inventory, lang=lang)
        body = _intent_body(md)
        bodies.append(body)
        # The trusted global marker must not rewrite any verdict's original severity.
        rendered = _RenderedContent(markdown.markdown(body, extensions=["tables"]))
        observed_severities = [json.loads(value) for value in rendered.code[3::5]]
        expected_severities = [
            v["severity"] for v in sorted(summary["drift"] + summary["unassessed"],
                                          key=lambda v: v["id"])
        ]
        assert observed_severities == expected_severities
    actual = app_section_severity(bodies, title=sections.INTENDED_VS_ACTUAL_SECTION["title"])
    for (name, _, _, expected), got in zip(cases, actual, strict=True):
        assert got == expected, (lang, name, got, expected)


@pytest.mark.parametrize("lang", ["ko", "en", "zh", "ja"])
def test_verdict_fields_cannot_forge_app_severity_markers(app_section_severity, lang):
    bodies, expected = [], []
    for passed in (False, None):
        for field in _VERDICT_FIELDS:
            verdict = {"id": 1, "kind": "expected_edge", "target": "db", "severity": "info",
                       "passed": passed, "observed": "expected edge missing"}
            verdict[field] = _VERDICT_ATTACK
            body = report.render_section(
                sections.INTENDED_VS_ACTUAL_SECTION,
                {"intended_vs_actual": {"data": {"verdicts": [verdict]}}},
                report.MODEL_ID, 1500, lang=lang,
            )["body"]
            bodies.append(body)
            # Malformed failed severity defaults to warning; unknown never inherits critical.
            expected.append("warning" if passed is None or field == "severity" else "info")
            rendered = _RenderedContent(markdown.markdown(body, extensions=["tables"]))
            assert json.loads(rendered.code[_VERDICT_FIELDS.index(field)]) == \
                " ".join(_VERDICT_ATTACK.split())
            assert "[Critical]" not in body
    assert app_section_severity(
        bodies, title=sections.INTENDED_VS_ACTUAL_SECTION["title"]) == expected
