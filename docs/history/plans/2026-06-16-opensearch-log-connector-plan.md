# Plan: OpenSearch log query connector (AWS-native sigv4)

> Spec: `docs/superpowers/specs/2026-06-16-opensearch-log-connector-design.md`. Read-only OpenSearch
> MCP Lambda (sigv4 `es`, NO token → no credential UX), on the **monitoring** gateway. Public+IAM
> path by default (non-VPC Lambda); VPC-only domains behind `opensearch_vpc_enabled` (default false).
> Mirrors `aws_cloudwatch_mcp.py` (AWS-native log tools). Branch `fix/v2-upgrade-snapshot-id`.

## Grounding (verified)
- Agent MCP Lambdas: `local.agent_lambdas` (for_each, py3.11, arm64, archive_file zip + cross_account.py),
  shared exec role `aws_iam_role.agent_lambda[0]`, non-VPC, env `AWSOPS_HOST_ACCOUNT_ID`. Handler
  contract: `tool_name`+`arguments`, `args.pop('target_account_id')`, `ok()`/`err()` (see network_mcp.py).
- `aws_cloudwatch_mcp.py` already does CloudWatch Logs/Insights (boto3) — OpenSearch needs sigv4 HTTP
  (`_search`), signed with `botocore.auth.SigV4Auth` (botocore ships with boto3 — no extra dep).
- `aws_iam_role_policy.agent_lambda_read` holds the read grants (ends with CrossAccountAssumeReadOnly).
- VPC networking available: `local.private_subnet_ids` + `aws_security_group.service` (agentcore output).

## Non-goals
- Cross-source triage orchestration; S3/Datadog/Dynatrace; any write/ingest. Read-only only.

## P2 consensus gate — round 1 findings & resolutions (panel: kiro opus-4.8 delivered; kimi tool-approval err, glm timeout → 1 substantive reviewer + self-verification against AWS facts)
- **MAJOR (verified) — IAM uses the `es:` prefix, NOT `opensearch:`.** Amazon OpenSearch *managed* domains have no `opensearch:` IAM namespace; every action is `es:*` (`es:ListDomainNames`, `es:DescribeDomain`, `es:DescribeDomains`, `es:ESHttpGet`, `es:ESHttpPost`). The boto3 client name `opensearch` ≠ the IAM prefix. `terraform validate` won't catch it → runtime AccessDenied on `list_opensearch_domains`. (`opensearch:`/`aoss:` is Serverless only.) **Resolution: Task 3 grants `es:*` for everything.**
- **MAJOR (verified) — cross-account sigv4 needs Credentials, but `cross_account.py` returns only clients.** SigV4Auth needs a botocore Credentials object; `cross_account` exposes `get_client`/`get_role_arn` only (`_assume_role` is private). **Resolution: add `get_credentials(target_account_id)` to `cross_account.py` (host → `boto3.Session().get_credentials()`; other → Credentials from the assume-role response) + test; `_signed_request` signs with those.** (cross_account.py + its test join Task 1's file scope.)
- **MAJOR (verified) — ENI policy index error.** `count = var.opensearch_vpc_enabled ? 1 : 0` references `aws_iam_role.agent_lambda[0]` (exists only when `agentcore_enabled`). **Resolution: `count = var.agentcore_enabled && var.opensearch_vpc_enabled ? 1 : 0`.**
- **MAJOR (verified) — sigv4 signed-bytes must equal sent-bytes; the mocked-seam test is vacuous.** **Resolution: serialize the body to bytes ONCE, sign that exact buffer (`SigV4Auth.add_auth` on an `AWSRequest` with that body + `Content-Type: application/json`), send the SAME buffer with `signed.headers` copied verbatim. Test does NOT mock `_signed_request` — it mocks `urlopen` and asserts the request carries `Authorization` + `X-Amz-Date` and the exact signed body.**
- **MINOR (verified) — VPC domain endpoint.** `describe_domain` returns the public host under `DomainStatus.Endpoint` but a VPC domain under `DomainStatus.Endpoints["vpc"]`. **Resolution: resolve `Endpoint` else `Endpoints.vpc`; test both.**
- **MINOR — hardcoded `@timestamp`.** **Resolution: optional `time_field` arg (default `@timestamp`) in the range clause.**

## Tasks (TDD; per-task commit; `python3 -m unittest` + catalog_check + `terraform validate` green)

### Task 1: OpenSearch read MCP Lambda + cross_account creds accessor (TDD)
**Files:**
- Create: `agent/lambda/opensearch_mcp.py`
- Test: `agent/lambda/test_opensearch_mcp.py`
- Modify: `agent/lambda/cross_account.py`
- Test: `agent/lambda/test_cross_account.py`
- [ ] cross_account: add `get_credentials(target_account_id)` → host (target==host or None) returns
  `boto3.Session().get_credentials()`; a real other account returns a botocore `Credentials` built from
  the assume-role response (reuse the existing `_assume_role`). Failing test asserts host vs other paths
  (mock STS; no network). Keep existing get_role_arn behavior.
- [ ] Failing tests for `opensearch_mcp` (unittest; mock boto3 `opensearch` client + `urlopen`; NO network):
  - `list_opensearch_domains`: `list_domain_names` + `describe_domain`; returns name+endpoint+engine;
    endpoint resolves `DomainStatus.Endpoint` ELSE `DomainStatus.Endpoints["vpc"]` (assert both cases).
  - `search_opensearch_logs(domain, query='ERROR', start='1h')`: POST `https://<endpoint>/<index|_all>/_search`;
    body = `bool` with `range` on the time field (default `@timestamp`, gte from start) + `query_string`=query;
    `size` clamped (>50→50; default 20); returns hits.
  - default window: no start → last 1h (a `range.<time_field>.gte` present); optional `time_field` overrides `@timestamp`.
  - `opensearch_indices(domain)`: GET `/_cat/indices?format=json`.
  - missing domain → structured "no OpenSearch domain" error; HTTP non-2xx (403) → structured error w/ status.
  - `target_account_id` popped.
  - **sigv4 (NOT mocking _signed_request):** mock `urlopen`; assert the sent request has `Authorization`
    + `X-Amz-Date` headers AND the body bytes equal the exact buffer that was signed (signed==sent).
- [ ] Implement `opensearch_mcp.py`: `lambda_handler` (mirror network_mcp dispatch, pop `target_account_id`);
  `_endpoint(domain, role_arn)` (Endpoint else Endpoints.vpc); `_search_body(query, start, end, size, time_field)`;
  `_signed_request(method, url, body_bytes, region, target_account_id)` — `creds =
  cross_account.get_credentials(target_account_id)`; `req = AWSRequest(method, url, data=body_bytes,
  headers={'Content-Type':'application/json','Host':<host>})`; `SigV4Auth(creds, 'es', region).add_auth(req)`;
  send the SAME `body_bytes` with `dict(req.headers)` via stdlib `urllib` (timeout). 3 tools; `ok()`/`err()`;
  `size` cap + truncate. Stdlib + boto3/botocore only.
- [ ] `cd agent/lambda && python3 -m unittest test_opensearch_mcp test_cross_account` → green.
- [ ] Commit: `feat(agent-platform): OpenSearch read MCP Lambda (sigv4, read-only) + cross_account.get_credentials`.

### Task 2: register the OpenSearch target on the monitoring gateway
**Files:**
- Modify: `scripts/v2/agentcore/catalog.py`
- [ ] Add `TARGETS["opensearch-mcp-target"]` = `{gateway:"monitoring", lambda_key:"opensearch-mcp",
  description, tools:[3 specs]}` (`_p` helper; no `target_account_id` prop). Tools:
  `list_opensearch_domains` (no req), `search_opensearch_logs` (req `domain`; opt `query`/`start`/`end`/`index`/`size`),
  `opensearch_indices` (req `domain`).
- [ ] `cd scripts/v2/agentcore && python3 catalog_check.py` → `OK` + `opensearch-mcp` in lambda_keys.
- [ ] Commit: `feat(agent-platform): register opensearch-mcp-target on monitoring gateway`.

### Task 3: provision the OpenSearch Lambda + scoped IAM (TF)
**Files:**
- Modify: `terraform/foundation/ai.tf`
- [ ] Add `"opensearch-mcp" = { file = "opensearch_mcp.py", handler = "opensearch_mcp.lambda_handler" }`
  to the `local.agent_lambdas` **base map** (the `var.agentcore_enabled ? {...}` branch — AWS-native,
  NOT integ-gated). `lambda_arns` output auto-includes it.
- [ ] Grant least-privilege on the agent_lambda role (new `aws_iam_role_policy.agent_lambda_opensearch`,
  `count = local.ac_count`): **all `es:` prefix** — `es:ESHttpGet` + `es:ESHttpPost` on
  `arn:aws:es:${var.region}:${acct}:domain/*/*`; `es:ListDomainNames` + `es:DescribeDomain` +
  `es:DescribeDomains` on `*`. NO `opensearch:` actions (managed domains use `es:`). No `Principal:"*"`.
- [ ] `terraform -chdir=terraform/foundation fmt` (revert out-of-scope fmt drift) + `validate` → green.
- [ ] Commit: `feat(agent-platform): provision opensearch-mcp Lambda + scoped es/opensearch IAM (read-only)`.

### Task 4: optional VPC attachment for VPC-only domains (flag, default off)
**Files:**
- Modify: `terraform/foundation/ai.tf`
- Modify: `terraform/foundation/variables.tf`
- [ ] Add variable `opensearch_vpc_enabled` (bool, default false) with a clear description (off → no-op,
  $0; on → attach the opensearch Lambda to private subnets so it reaches a VPC-only domain).
- [ ] Add a `dynamic "vpc_config"` block on `aws_lambda_function.agent` that yields a config ONLY when
  `each.key == "opensearch-mcp" && var.opensearch_vpc_enabled` — `subnet_ids = local.private_subnet_ids`,
  `security_group_ids = [aws_security_group.service.id]`. Other Lambdas: no vpc_config (unchanged).
- [ ] When VPC is on, the lambda role needs ENI perms: add `ec2:CreateNetworkInterface`,
  `ec2:DescribeNetworkInterfaces`, `ec2:DeleteNetworkInterface` (Resource `*`, the AWS-required shape)
  gated `count = var.agentcore_enabled && var.opensearch_vpc_enabled ? 1 : 0` (compound — the policy
  references `agent_lambda[0]`, which only exists when agentcore_enabled; separate policy → off = absent).
- [ ] `terraform -chdir=terraform/foundation fmt` + `validate` → green (validate with the flag both
  default-off and, if feasible, a `-var opensearch_vpc_enabled=true` validate to catch the dynamic block).
- [ ] Commit: `feat(agent-platform): opensearch_vpc_enabled flag — optional VPC attach for VPC-only domains (off)`.

## Manual / live steps (NOT autonomous)
1. `terraform -target` apply: the opensearch Lambda + IAM (+ VPC if `opensearch_vpc_enabled=true`).
2. `make agentcore` — provision the monitoring `opensearch-mcp-target`.
3. Live: chat (monitoring) "search OpenSearch logs around <time> for errors" → CloudWatch logs confirm
   a real `_search` (unique runtimeSessionId). For a VPC-only domain, set `opensearch_vpc_enabled=true`
   first (+ persist in the live tfvars / configure.mjs).
