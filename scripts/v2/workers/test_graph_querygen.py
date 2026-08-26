"""Tests for graph_querygen — the hybrid LLM fallback for ClickHouse schemas that don't match
graph_catalog.py's standard OTel-exporter shape (a renamed/custom span table). Scope v1: clickhouse
`trace_spans` only. Every external call (Bedrock, Code Interpreter, the connector dry-run) is
injectable so these tests make zero real AWS/network calls.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pytest  # noqa: E402
import graph_querygen as qg  # noqa: E402

CANDIDATE_TABLE = {"name": "my_traces", "columns": ["trace_id", "span_id", "parent_span_id", "svc", "ts"]}
CANDIDATE_SCHEMA = {"tables": [{
    "name": "my_traces",
    "columns": [
        {"name": "trace_id", "type": "String"}, {"name": "span_id", "type": "String"},
        {"name": "parent_span_id", "type": "String"}, {"name": "svc", "type": "String"},
        {"name": "ts", "type": "DateTime"},
    ],
}]}


class TestFindCandidateTable:
    def test_finds_a_table_with_trace_span_time_shaped_columns(self):
        c = qg._find_candidate_table(CANDIDATE_SCHEMA)
        assert c is not None and c["name"] == "my_traces"
        assert "trace_id" in c["columns"]

    def test_returns_none_when_no_table_matches(self):
        assert qg._find_candidate_table({"tables": [{"name": "x", "columns": [{"name": "y", "type": "Int64"}]}]}) is None
        assert qg._find_candidate_table({}) is None
        assert qg._find_candidate_table(None) is None


class TestStaticReadonlyCheck:
    OK = "SELECT trace_id AS TraceId FROM my_traces WHERE ts >= now() - INTERVAL {window} MINUTE LIMIT {cap}"

    def test_accepts_a_single_select_with_both_placeholders(self):
        assert qg._static_readonly_check(self.OK) is True

    def test_rejects_missing_placeholders(self):
        assert qg._static_readonly_check("SELECT 1") is False

    def test_rejects_multi_statement(self):
        assert qg._static_readonly_check(self.OK + "; DROP TABLE my_traces") is False

    def test_rejects_non_select(self):
        assert qg._static_readonly_check("INSERT INTO x VALUES (1) {window} {cap}") is False

    def test_rejects_forbidden_keywords_even_inside_a_single_select(self):
        assert qg._static_readonly_check("SELECT * FROM (DROP TABLE x) {window} {cap}") is False

    def test_rejects_non_string_or_blank(self):
        assert qg._static_readonly_check(None) is False
        assert qg._static_readonly_check("") is False
        assert qg._static_readonly_check("   ") is False


class TestGenerateSql:
    def test_uses_the_injected_invoke_and_strips_markdown_fences(self):
        sql = qg._generate_sql(CANDIDATE_TABLE, invoke=lambda p: "```sql\nSELECT 1\n```")
        assert sql == "SELECT 1"

    def test_prompt_includes_the_table_name_and_columns(self):
        seen = {}
        def fake_invoke(prompt):
            seen["prompt"] = prompt
            return "SELECT 1"
        qg._generate_sql(CANDIDATE_TABLE, invoke=fake_invoke)
        assert "my_traces" in seen["prompt"] and "trace_id" in seen["prompt"]


class TestDryRunCheck:
    def test_passes_when_the_dry_run_row_has_every_required_alias(self):
        def invoke_connector(args):
            assert args["max_rows"] == 1
            assert "{window}" not in args["sql"] and "{cap}" not in args["sql"]
            return {"rows": [{"TraceId": "x", "SpanId": "y", "ParentSpanId": "", "ServiceName": "s",
                               "Timestamp": "t", "Duration": 1}]}
        assert qg._dry_run_check("SELECT 1 FROM t WHERE ts>={window} LIMIT {cap}", 7, invoke_connector) is True

    def test_fails_when_a_required_alias_is_missing(self):
        assert qg._dry_run_check("SELECT 1 {window} {cap}", 7, lambda a: {"rows": [{"TraceId": "x"}]}) is False

    def test_fails_on_zero_rows_or_a_connector_error(self):
        assert qg._dry_run_check("SELECT 1 {window} {cap}", 7, lambda a: {"rows": []}) is False
        def boom(a):
            raise RuntimeError("down")
        assert qg._dry_run_check("SELECT 1 {window} {cap}", 7, boom) is False


class TestCodeInterpreterCheckIsAdvisoryOnly:
    """(b) is best-effort: any absence/failure MUST skip (None), never raise, never block."""

    def test_returns_none_when_the_ssm_lookup_fails(self):
        class BrokenSsm:
            def get_parameter(self, **kw):
                raise RuntimeError("parameter not found")
        assert qg._code_interpreter_check("SELECT 1", ["TraceId"], ssm_client=BrokenSsm()) is None

    def test_returns_true_when_the_sandbox_confirms_all_aliases_present(self):
        class FakeSsm:
            def get_parameter(self, **kw):
                return {"Parameter": {"Value": "my_interpreter"}}
        class FakeAgentCore:
            def start_code_interpreter_session(self, **kw):
                return {"sessionId": "s1"}
            def invoke_code_interpreter(self, **kw):
                return {"output": "OK"}
            def stop_code_interpreter_session(self, **kw):
                return {}
        result = qg._code_interpreter_check(
            "SELECT trace_id AS TraceId FROM t", ["TraceId"],
            ssm_client=FakeSsm(), agentcore_client=FakeAgentCore(),
        )
        assert result is True

    def test_returns_false_when_the_sandbox_reports_missing_aliases(self):
        class FakeSsm:
            def get_parameter(self, **kw):
                return {"Parameter": {"Value": "my_interpreter"}}
        class FakeAgentCore:
            def start_code_interpreter_session(self, **kw):
                return {"sessionId": "s1"}
            def invoke_code_interpreter(self, **kw):
                return {"output": "MISSING:SpanId"}
            def stop_code_interpreter_session(self, **kw):
                return {}
        result = qg._code_interpreter_check(
            "SELECT trace_id AS TraceId FROM t", ["TraceId", "SpanId"],
            ssm_client=FakeSsm(), agentcore_client=FakeAgentCore(),
        )
        assert result is False

    def test_returns_none_when_the_agentcore_call_itself_fails(self):
        class FakeSsm:
            def get_parameter(self, **kw):
                return {"Parameter": {"Value": "my_interpreter"}}
        class BrokenAgentCore:
            def start_code_interpreter_session(self, **kw):
                raise RuntimeError("service unavailable")
        result = qg._code_interpreter_check(
            "SELECT 1", ["TraceId"], ssm_client=FakeSsm(), agentcore_client=BrokenAgentCore(),
        )
        assert result is None


class TestTryGenerateClickhouseTraceSpans:
    def _stub(self, monkeypatch, *, static_ok=True, ci_result=None, dry_ok=True, candidate=CANDIDATE_TABLE):
        monkeypatch.setenv("GRAPH_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(qg, "_find_candidate_table", lambda schema: candidate)
        monkeypatch.setattr(qg, "_generate_sql",
                             lambda c, invoke=None: "SELECT trace_id AS TraceId FROM t WHERE ts>={window} LIMIT {cap}")
        monkeypatch.setattr(qg, "_static_readonly_check", lambda sql: static_ok)
        monkeypatch.setattr(qg, "_code_interpreter_check", lambda sql, req, **kw: ci_result)
        monkeypatch.setattr(qg, "_dry_run_check", lambda sql, iid, invoke_connector, required=None: dry_ok)

    def test_returns_none_when_disabled(self, monkeypatch):
        monkeypatch.delenv("GRAPH_QUERYGEN_ENABLED", raising=False)
        assert qg.try_generate_clickhouse_trace_spans(CANDIDATE_SCHEMA, 7, lambda a: {}) is None

    def test_returns_none_when_no_candidate_table(self, monkeypatch):
        self._stub(monkeypatch, candidate=None)
        assert qg.try_generate_clickhouse_trace_spans(CANDIDATE_SCHEMA, 7, lambda a: {}) is None

    def test_returns_a_ready_generated_row_when_every_check_passes(self, monkeypatch):
        self._stub(monkeypatch, ci_result=True)
        row = qg.try_generate_clickhouse_trace_spans(CANDIDATE_SCHEMA, 7, lambda a: {})
        assert row["status"] == "ready" and row["meta"]["provenance"] == "generated"
        assert row["query"]["mapper"] == "otel_v1" and row["query"]["tool"] == "clickhouse_query"
        assert row["query_key"] == "trace_spans"

    def test_returns_a_ready_row_even_when_the_code_interpreter_check_is_skipped(self, monkeypatch):
        self._stub(monkeypatch, ci_result=None)  # skipped — advisory, never blocking
        row = qg.try_generate_clickhouse_trace_spans(CANDIDATE_SCHEMA, 7, lambda a: {})
        assert row is not None and row["status"] == "ready"

    def test_returns_none_when_the_code_interpreter_check_explicitly_fails(self, monkeypatch):
        self._stub(monkeypatch, ci_result=False)
        assert qg.try_generate_clickhouse_trace_spans(CANDIDATE_SCHEMA, 7, lambda a: {}) is None

    def test_returns_none_when_the_static_check_fails(self, monkeypatch):
        self._stub(monkeypatch, static_ok=False)
        assert qg.try_generate_clickhouse_trace_spans(CANDIDATE_SCHEMA, 7, lambda a: {}) is None

    def test_returns_none_when_the_dry_run_fails(self, monkeypatch):
        self._stub(monkeypatch, dry_ok=False)
        assert qg.try_generate_clickhouse_trace_spans(CANDIDATE_SCHEMA, 7, lambda a: {}) is None

    def test_never_raises_when_generation_itself_throws(self, monkeypatch):
        monkeypatch.setenv("GRAPH_QUERYGEN_ENABLED", "true")
        monkeypatch.setattr(qg, "_find_candidate_table", lambda schema: CANDIDATE_TABLE)
        def boom(c, invoke=None):
            raise RuntimeError("bedrock down")
        monkeypatch.setattr(qg, "_generate_sql", boom)
        assert qg.try_generate_clickhouse_trace_spans(CANDIDATE_SCHEMA, 7, lambda a: {}) is None
