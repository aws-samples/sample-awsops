# OpenSearch Log Query Connector (AWS-native, sigv4)

**Date:** 2026-06-16
**Branch:** `fix/v2-upgrade-snapshot-id` (worktree `gap-impl-wave1`)
**Status:** Design — approved by user direction (`/co-agent:consensus`), entering plan→build.
**Context:** first **log-source** connector for the incident-triage scenario ("at 3:30 something
spiked — search the weird logs"). CloudWatch Logs/Insights already works (`aws_cloudwatch_mcp`);
this adds **OpenSearch**. The cross-source fan-out orchestration (time-window → query all connected
sources → correlate) is explicitly NEXT, not this increment.

## Problem / Goal
The agent should be able to search an account's OpenSearch logs by time range + query when asked
about an incident. Deliver a read-only **OpenSearch MCP Lambda** (AWS-native: the Lambda's IAM role
+ **sigv4 `es` signing** — NO token, so it does NOT use the credential UX) exposing domain listing
+ time-bounded log search, registered as a gateway target on the **monitoring** gateway (alongside
the CloudWatch log tools, so one agent can correlate both).

## Reachability (user: "support both")
- **Default (now):** non-VPC Lambda (like all agent MCP Lambdas) → reaches OpenSearch domains with a
  **public endpoint + IAM/fine-grained access policy** via sigv4. Works out of the box.
- **VPC-only domains:** behind a new flag `opensearch_vpc_enabled` (default false), attach the
  OpenSearch Lambda to the private subnets + service SG (reuse the agentcore runtime's subnets/SG)
  so it can reach an in-VPC domain. Off by default → non-VPC; the AWS-resource/read-only stance is
  unaffected.

## Non-goals
- Cross-source triage/correlation orchestration (next increment).
- S3 / Datadog / Dynatrace connectors (later, same pattern; Datadog/Dynatrace use the credential UX).
- Write/ingest to OpenSearch (read-only: `_search`, `_cat/indices`, list/describe only).

## Architecture (data flow)
```
chat ("weird logs around 3:30?") → monitoring gateway → opensearch-mcp Lambda
  (awsops-v2-agent-opensearch-mcp; py3.11/arm64; non-VPC by default; sigv4 'es' via the Lambda role)
  → list_domain_names/describe (endpoint)  +  POST https://<endpoint>/<index>/_search (time-range DSL)
  → hits → agent summarizes
```

## Components
### (a) `agent/lambda/opensearch_mcp.py` — read-only OpenSearch MCP Lambda
- **Tools:**
  - `list_opensearch_domains()` → boto3 `opensearch.list_domain_names` + `describe_domain` (endpoint, engine).
  - `search_opensearch_logs(domain, query?, start?, end?, index?, size?)` → sigv4 POST
    `https://<endpoint>/<index|_all>/_search` with a bounded `query_string` + `range` on `@timestamp`
    (start/end accept ISO or relative like `1h`; default last 1h; `size` clamped, e.g. ≤ 50).
  - `opensearch_indices(domain)` → sigv4 GET `/_cat/indices?format=json`.
- **sigv4 signing:** `botocore.auth.SigV4Auth` + `botocore.awsrequest.AWSRequest` with frozen creds
  from a boto3 session (service `es`, region) → send the signed request via stdlib `urllib`. **No
  third-party deps** (botocore ships with boto3 — matches the zip-packaging constraint).
- Handler contract mirrors `aws_cloudwatch_mcp.py` / `network_mcp.py` (`tool_name` + `arguments`,
  pops `target_account_id`, `ok()`/`err()`). Cross-account: if `target_account_id` is set, assume
  the read-only role (reuse `cross_account.get_client`/`get_role_arn`) — same as the other MCP tools.
- Bounds: `size` cap + response truncation to stay well under the 6 MB Lambda limit.

### (b) `scripts/v2/agentcore/catalog.py`
- Add `TARGETS["opensearch-mcp-target"]` = `{gateway:"monitoring", lambda_key:"opensearch-mcp",
  tools:[3 specs]}`. (monitoring = the log/observability gateway; co-located with CloudWatch logs.)

### (c) `terraform/foundation/ai.tf`
- Add `"opensearch-mcp"` to `local.agent_lambdas` **base map (agentcore_enabled-gated)** — it is
  AWS-native, NOT integrations-gated.
- New `aws_iam_role_policy` (or extend the agent_lambda read policy) granting least-privilege:
  `es:ESHttpGet` + `es:ESHttpPost` on `arn:aws:es:${region}:${acct}:domain/*/*`, and
  `opensearch:ListDomainNames` + `opensearch:DescribeDomain*` on `*` (list needs `*`). No
  `Principal:"*"`, no `0.0.0.0/0`.
- Optional VPC: a `dynamic "vpc_config"` on `aws_lambda_function.agent` that activates ONLY for
  `each.key == "opensearch-mcp" && var.opensearch_vpc_enabled`, using `local.private_subnet_ids` +
  `aws_security_group.service` (the agentcore runtime's networking). Requires `ec2:CreateNetworkInterface`
  etc. on the lambda role when VPC is on (AWSLambdaVPCAccessExecutionRole-equivalent statements).
- New variable `opensearch_vpc_enabled` (default false).

## Error handling
- No domains / domain not found → structured "no OpenSearch domain" message (not a crash).
- sigv4 / HTTP 4xx-5xx (403 access policy, index_not_found) → structured tool error carrying the status.
- Cross-account assume failure → the existing cross_account handling (host short-circuit).

## Testing
- `agent/lambda/test_opensearch_mcp.py` (unittest, mocked): tool dispatch; `search_opensearch_logs`
  builds the right URL + `_search` body (time `range` on `@timestamp`, `query_string`, clamped `size`);
  default time window; `opensearch_indices` GET `/_cat/indices`; missing-domain error; sigv4 signer
  invoked (mock botocore auth + the HTTP seam — no network); `target_account_id` popped.
- TF `fmt` + `validate`. (Worktree can't full-plan — `.build` layers; controller verifies 0-destroy at apply.)
- Live: `make agentcore` provisions the monitoring target; chat "search OpenSearch logs around <time>"
  → CloudWatch logs confirm a real `_search` call (unique runtimeSessionId).

## Scope / YAGNI
- One source (OpenSearch), 3 read tools, sigv4. Public+IAM path default; VPC behind a flag (off).
- No orchestration; no other sources. Same pattern extends to S3/Datadog/Dynatrace later.

## ADR note
AWS-native read-only log query → read-only ops stance preserved (no mutation/autonomy). No new ADR
needed; `external-obs`/observability connectors trace to ADR-011. (ADR numbering per `docs/decisions/CLAUDE.md`.)
