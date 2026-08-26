-- awsops-only Bedrock token usage, pre-aggregated per UTC day × model.
-- Written ONLY by the scheduled ai-cost aggregator (scripts/v2/workers/ai_cost_aggregator.py),
-- which parses Bedrock model-invocation logs (/aws/bedrock/invocation-logs, ap-northeast-2)
-- filtered to awsops caller identities (identity.arn like /awsops-v2/) and UPSERT-overwrites the
-- last few full UTC days each run (idempotent — no overlap double-count, no data loss).
-- The web BFF (/api/ai-usage) only does a fast SELECT/SUM here and prices via web/lib/bedrock.ts.
-- Raw tokens are stored (not dollars) so pricing stays single-sourced in bedrock.ts.
-- Read-only posture: derived from CloudWatch logs; never mutates AWS resources.

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day                 date        NOT NULL,
  model               text        NOT NULL,
  input_tokens        bigint      NOT NULL DEFAULT 0,
  output_tokens       bigint      NOT NULL DEFAULT 0,
  cache_read_tokens   bigint      NOT NULL DEFAULT 0,
  cache_write_tokens  bigint      NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, model)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_day ON ai_usage_daily (day DESC);
