"""EventBridge-scheduled (rate 6h). Aggregates awsops-only Bedrock token usage from the
model-invocation logs (/aws/bedrock/invocation-logs, ap-northeast-2) into ai_usage_daily.

Idempotent: each run re-queries the last LOOKBACK_DAYS FULL UTC days and UPSERT-overwrites the
(day, model) rows, so today/yesterday progressively complete with no overlap double-count and no
data loss. The web BFF (/api/ai-usage) prices the stored raw tokens via web/lib/bedrock.ts.

Read-only against AWS: logs:StartQuery/GetQueryResults/StopQuery + an Aurora write to the
derived ai_usage_daily table only. Never mutates AWS resources.
"""
import datetime
import os
import time

import boto3

import aggregate
import db

LOG_GROUP = os.environ.get("BEDROCK_LOG_GROUP", "/aws/bedrock/invocation-logs")
MATCH = os.environ.get("AWSOPS_IDENTITY_MATCH", aggregate.AWSOPS_IDENTITY_MATCH)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "3"))
_logs = boto3.client("logs", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))

_UPSERT = (
    "INSERT INTO ai_usage_daily "
    "(day, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, updated_at) "
    "VALUES (:d, :m, :i, :o, :cr, :cw, now()) "
    "ON CONFLICT (day, model) DO UPDATE SET "
    "input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens, "
    "cache_read_tokens = EXCLUDED.cache_read_tokens, cache_write_tokens = EXCLUDED.cache_write_tokens, "
    "updated_at = now()"
)
# NOTE: normalize_model() keys every NEW row by the canonical id (no '/'), so the aggregator never
# creates slash-keyed rows going forward — steady state is exactly one canonical row per (day, model).
# Pre-normalization ARN-keyed rows were a one-off transition artifact, cleaned once at rollout (the live
# table has none). We deliberately do NOT run a recurring cleanup DELETE here: every windowed/blanket
# variant had a deploy-order or data-loss edge. The read path (ai-usage.ts) additionally collapses by
# canonical model for clean labels, but the DURABLE correctness guarantee is this write-side normalization.


def _run_insights(start_epoch: int, end_epoch: int):
    """StartQuery → poll GetQueryResults with backoff → StopQuery on timeout. Returns results (list)."""
    qid = _logs.start_query(
        logGroupName=LOG_GROUP,
        startTime=start_epoch,
        endTime=end_epoch,
        queryString=aggregate.build_query(MATCH),
    )["queryId"]
    delay = 0.5
    for _ in range(10):
        r = _logs.get_query_results(queryId=qid)
        status = r.get("status")
        if status == "Complete":
            return r.get("results", [])
        if status in ("Failed", "Cancelled", "Timeout"):
            print(f"ai_cost_aggregator: insights query {status}")
            return []
        time.sleep(delay)
        delay = min(delay * 1.6, 5.0)
    try:
        _logs.stop_query(queryId=qid)
    except Exception:
        pass
    print("ai_cost_aggregator: insights query did not complete in budget; stopped")
    return []


def lambda_handler(_event, _ctx):
    now = datetime.datetime.now(datetime.timezone.utc)
    start_day = (now - datetime.timedelta(days=LOOKBACK_DAYS)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    rows = aggregate.parse_rows(_run_insights(int(start_day.timestamp()), int(now.timestamp())))
    conn = db.connect()
    upserted = 0
    try:
        for row in rows:
            conn.run(
                _UPSERT,
                d=row["day"], m=row["model"],
                i=row["input_tokens"], o=row["output_tokens"],
                cr=row["cache_read_tokens"], cw=row["cache_write_tokens"],
            )
            upserted += 1
    finally:
        conn.close()  # db.connect() returns a fresh pg8000 connection each call (matches reaper.py)
    print(f"ai_cost_aggregator: upserted {upserted} day×model rows (lookback {LOOKBACK_DAYS}d)")
    return {"upserted": upserted}
