"""Tests for the pure ai-cost aggregation helpers (no boto3)."""
import aggregate as A


def test_build_query_filters_awsops_identity():
    q = A.build_query(A.AWSOPS_IDENTITY_MATCH)
    assert "identity.arn" in q
    assert "awsops-v2" in q
    # CloudWatch Logs Insights has NO coalesce() — must use ispresent()/if().
    assert "coalesce" not in q
    assert "ispresent(input.inputTokenCount)" in q
    assert "ispresent(output.outputTokenCount)" in q
    assert "ispresent(input.cacheReadInputTokenCount)" in q
    assert "ispresent(input.cacheWriteInputTokenCount)" in q
    # daily buckets per model
    assert "bin(1d)" in q
    assert "modelId" in q
    # the four aggregate aliases the parser expects
    for alias in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"):
        assert alias in q


def _row(day, model, **toks):
    """Build one Logs-Insights GetQueryResults row (list of {field,value}).
    The time bucket comes back under the literal field "bin(1d)" (grouping expr, no alias)."""
    cells = [{"field": "bin(1d)", "value": day}, {"field": "modelId", "value": model}]
    for k, v in toks.items():
        cells.append({"field": k, "value": str(v)})
    return cells


def test_parse_rows_maps_tokens_and_normalizes_day():
    results = [
        _row("2026-06-17 00:00:00.000", "global.anthropic.claude-sonnet-4-6",
             input_tokens=1500, output_tokens=800, cache_read_tokens=200, cache_write_tokens=50),
    ]
    rows = A.parse_rows(results)
    assert len(rows) == 1
    r = rows[0]
    assert r["day"] == "2026-06-17"  # bin(1d) timestamp → UTC date
    assert r["model"] == "global.anthropic.claude-sonnet-4-6"
    assert r["input_tokens"] == 1500
    assert r["output_tokens"] == 800
    assert r["cache_read_tokens"] == 200
    assert r["cache_write_tokens"] == 50


def test_parse_rows_missing_token_fields_default_zero():
    results = [_row("2026-06-16T00:00:00.000Z", "global.anthropic.claude-haiku-4-5", input_tokens=10)]
    rows = A.parse_rows(results)
    r = rows[0]
    assert r["day"] == "2026-06-16"
    assert r["input_tokens"] == 10
    assert r["output_tokens"] == 0
    assert r["cache_read_tokens"] == 0
    assert r["cache_write_tokens"] == 0


def test_parse_rows_empty():
    assert A.parse_rows([]) == []
    assert A.parse_rows(None) == []


def test_parse_rows_skips_rows_without_day_or_model():
    results = [[{"field": "modelId", "value": "x"}], [{"field": "day", "value": "2026-06-17 00:00:00.000"}]]
    assert A.parse_rows(results) == []


def test_normalize_model_strips_arn_to_canonical_id():
    # SDK worker logs the full inference-profile ARN; AgentCore logs the bare id — both collapse.
    assert A.normalize_model(
        "arn:aws:bedrock:ap-northeast-2:123456789012:inference-profile/global.anthropic.claude-opus-4-8"
    ) == "global.anthropic.claude-opus-4-8"
    assert A.normalize_model("global.anthropic.claude-sonnet-4-6") == "global.anthropic.claude-sonnet-4-6"
    # foundation-model ARNs reduce the same way (after the last '/')
    assert A.normalize_model(
        "arn:aws:bedrock:us-east-1:1:foundation-model/anthropic.claude-3-haiku-20240307-v1:0"
    ) == "anthropic.claude-3-haiku-20240307-v1:0"
    assert A.normalize_model(None) is None
    # bare ids (no '/') pass through unchanged; a pathological trailing slash keeps the original (no empty key)
    assert A.normalize_model("anthropic.claude-opus-4-8") == "anthropic.claude-opus-4-8"
    assert A.normalize_model("foo/") == "foo/"


def test_parse_rows_merges_arn_and_bare_modelid_same_day():
    # The SAME model logged as full-ARN (worker) and bare-id (AgentCore) on the same day must sum
    # into ONE row — not two rows, and not an UPSERT overwrite that drops one side.
    results = [
        _row("2026-06-17 00:00:00.000",
             "arn:aws:bedrock:ap-northeast-2:1:inference-profile/global.anthropic.claude-sonnet-4-6",
             input_tokens=100, output_tokens=10, cache_read_tokens=5),
        _row("2026-06-17 00:00:00.000", "global.anthropic.claude-sonnet-4-6",
             input_tokens=4, output_tokens=501),
    ]
    rows = A.parse_rows(results)
    assert len(rows) == 1
    r = rows[0]
    assert r["model"] == "global.anthropic.claude-sonnet-4-6"
    assert r["input_tokens"] == 104
    assert r["output_tokens"] == 511
    assert r["cache_read_tokens"] == 5


def test_parse_rows_keeps_distinct_models_and_days_separate():
    results = [
        _row("2026-06-17 00:00:00.000", "global.anthropic.claude-opus-4-8", input_tokens=10),
        _row("2026-06-17 00:00:00.000", "global.anthropic.claude-sonnet-4-6", input_tokens=20),
        _row("2026-06-16 00:00:00.000", "global.anthropic.claude-opus-4-8", input_tokens=30),
    ]
    rows = A.parse_rows(results)
    assert len(rows) == 3
