"""Pure helpers for the awsops-only Bedrock cost aggregator (no boto3, unit-testable).

The scheduled Lambda (ai_cost_aggregator.py) uses build_query() against the Bedrock
model-invocation log group and parse_rows() to turn GetQueryResults into daily token rows
for an idempotent UPSERT into ai_usage_daily. Pricing happens later in the web BFF
(web/lib/bedrock.ts), so this module only deals in raw token counts.
"""

# awsops callers are IAM roles named like "awsops-v2-*"; the Bedrock account is shared with
# other workloads, so filtering identity.arn by this substring isolates awsops usage.
AWSOPS_IDENTITY_MATCH = "awsops-v2"


def build_query(match: str = AWSOPS_IDENTITY_MATCH) -> str:
    """CloudWatch Logs Insights query: awsops-only token sums per UTC day × model.

    Notes:
    - Logs Insights has NO coalesce(); use if(ispresent(x), x, 0) so models/events that omit
      the prompt-cache fields don't null out the sum.
    - bin(1d) buckets strictly by UTC day; the aggregator passes a full-UTC-day time window.
    """
    return (
        f"filter identity.arn like /{match}/\n"
        "| stats\n"
        "    sum(if(ispresent(input.inputTokenCount), input.inputTokenCount, 0)) as input_tokens,\n"
        "    sum(if(ispresent(output.outputTokenCount), output.outputTokenCount, 0)) as output_tokens,\n"
        "    sum(if(ispresent(input.cacheReadInputTokenCount), input.cacheReadInputTokenCount, 0)) as cache_read_tokens,\n"
        "    sum(if(ispresent(input.cacheWriteInputTokenCount), input.cacheWriteInputTokenCount, 0)) as cache_write_tokens\n"
        # Do NOT alias the grouping expression (`by bin(1d) as day` is not portable in Logs Insights /
        # can ParseException) — group by the bare bin; the result column is literally "bin(1d)".
        "    by bin(1d), modelId"
    )


def _to_int(v) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def normalize_model(model):
    """Collapse a Bedrock modelId to its canonical inference-profile / model id.

    Callers log modelId inconsistently in the invocation log: the SDK worker logs the FULL ARN
    (arn:...:inference-profile/global.anthropic.claude-sonnet-4-6) while AgentCore logs the BARE id
    (global.anthropic.claude-sonnet-4-6). Without this, `by modelId` produces two rows for the same
    model/day. Strip to the part after the last '/' so both collapse to one key; the web BFF
    (bedrock.ts) strips the cross-region prefix (us./eu./ap./global.) on read for pricing/labels."""
    if not model:
        return model
    # rsplit keeps the original if there's no '/'; `or model` guards a pathological trailing-slash
    # ("foo/" → "") from producing an empty key.
    return model.rsplit("/", 1)[-1] or model


def parse_rows(results) -> list:
    """Map GetQueryResults `results` (list of rows; each row a list of {field,value}) →
    [{day(UTC 'YYYY-MM-DD'), model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}].
    modelId is normalized (normalize_model) and rows are summed per (day, model), so the full-ARN and
    bare-id variants of the same model merge into one row (no duplicate key / no UPSERT overwrite-loss).
    Rows missing day or modelId are skipped; missing token columns default to 0."""
    if not results:
        return []
    agg = {}    # (day, model) -> summed row
    order = []  # first-seen order → deterministic output
    for row in results:
        cells = {c.get("field"): c.get("value") for c in row if isinstance(c, dict)}
        # `stats ... by bin(1d), modelId` returns the time bucket under the literal field "bin(1d)"
        # (no alias). Accept "day" too for forward-compat / mocks.
        day = cells.get("bin(1d)") or cells.get("day")
        model = cells.get("modelId")
        if not day or not model:
            continue
        day = str(day)[:10]  # "2026-06-17 00:00:00.000" / "...T..Z" → "2026-06-17" (UTC)
        model = normalize_model(model)
        key = (day, model)
        if key not in agg:
            agg[key] = {"day": day, "model": model, "input_tokens": 0,
                        "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0}
            order.append(key)
        r = agg[key]
        r["input_tokens"] += _to_int(cells.get("input_tokens"))
        r["output_tokens"] += _to_int(cells.get("output_tokens"))
        r["cache_read_tokens"] += _to_int(cells.get("cache_read_tokens"))
        r["cache_write_tokens"] += _to_int(cells.get("cache_write_tokens"))
    return [agg[k] for k in order]
