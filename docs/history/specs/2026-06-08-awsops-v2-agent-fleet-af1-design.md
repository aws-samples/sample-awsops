# AWSops v2 — Agent Fleet Depth AF1 Design

**Status:** Accepted. 2026-06-08. Source map: full fleet exploration of `agent/lambda/create_targets.py` (v1 authoritative, 20 targets/19 lambdas/125 tools) + `scripts/v2/agentcore/{catalog.py,provision.py}` + `terraform/foundation/ai.tf`.

**Goal:** Extend the deployed-but-hollow v2 chat from **2 wired section gateways** (security iam-mcp 14, network flow-monitor 1) to **8 of 9**, by porting the v1 fleet's clean (read-only, no-VPC, no-Steampipe) MCP tool Lambdas into v2's `catalog.py` + `ai.tf` and re-running the idempotent provisioner. Makes the section agents actually answer with live AWS data.

**Builds on P1f** (deployed: 9 gateways `awsops-v2-<key>-gateway`, Memory, Interpreter, Runtime in VPC mode, + the 2 slices). `agent/agent.py` routes by `payload.gateway` short-key via `GATEWAYS_JSON` — UNCHANGED. The provisioner is idempotent (re-runnable).

---

## Scope — AF1 wires these 13 targets (port verbatim from create_targets.py)

| v2 gateway | new targets (lambda_key) | tools | notes |
|---|---|---|---|
| network | network-mcp | 15 | VPC/TGW/VPN/ENI/Firewall/FlowLogs (joins existing flow-monitor) |
| container | eks-mcp (9), ecs-mcp (3) | 12 | EKS control-plane + ECS (no in-cluster) |
| data | rds-mcp (6), dynamodb-mcp (6), msk-mcp (6), valkey-mcp (6) | 24 | RDS uses Data API (execute_sql SELECT-only; errors gracefully if Data API unset) |
| cost | cost-mcp (9), finops-mcp (5) | 14 | Cost Explorer + Compute Optimizer / TA |
| monitoring | cloudwatch-mcp (11), cloudtrail-mcp (5) | 16 | metrics/logs-insights + CloudTrail Lake (start_query = read) |
| iac | iac-mcp (7), terraform-mcp (5) | 12 | CFN/CDK validation + TF Registry docs (public HTTPS) |
| ops | aws-knowledge (5) | 5 | proxies `knowledge-mcp.global.api.aws` (public HTTPS egress) |
| security | *(iam-mcp — already wired)* | 14 | — |

After AF1: **8/9 gateways functional** (network, container, data, security, cost, monitoring, iac, ops). external-obs stays empty.

### Deferred (NOT AF1) — with reason
- **istio-mcp** (container) + **steampipe-query** (ops) — need a Kubernetes Steampipe connection / in-cluster access (our Steampipe has the aws plugin only). → **P3-D** (EKS in-cluster).
- **datasource-diag** (external-obs) — signs an EKS token + hits the private K8s API + probes private datasource NLBs; needs VPC ENIs. → **P3-D / external-obs**.
- **reachability** (network) — the ONLY true SDK mutation (creates network-insights-path + starts analysis). → **ADR-029 change-control** wave.
- **core-mcp `call_aws`** (ops) — generic boto3 dispatcher (read-only by IAM only, not code); latent write. → **ADR-029** (or include only `prompt_understanding`/`suggest_aws_commands` later).

---

## Architecture / mechanism (unchanged contracts)

- **catalog.py** — add the 13 `TARGETS["<target-name>"] = {gateway, lambda_key, description, tools[]}` entries. Tool schemas copied **verbatim** from `create_targets.py` via the `_p(type,desc)` helper; **do NOT include `target_account_id`** (provision.py's `_inject_account` deep-copies + injects it at provision time). `lambda_key` MUST match the ai.tf `agent_lambdas` map key AND the `agentcore.lambda_arns` output key.
- **ai.tf** — add each lambda to `locals.agent_lambdas` (`"<key>" = { file = "<src>.py", handler = "<module>.lambda_handler" }`). The `archive_file`/`aws_lambda_function`/`aws_lambda_permission` `for_each` over it (zips `agent/lambda/<file>` + `cross_account.py`; python3.11 arm64 256MB 60s; role `agent_lambda`). All `agentcore_enabled`-gated (already true on live).
- **IAM** — broaden `aws_iam_role_policy.agent_lambda_read` with **curated read-only per service** (consistent with D2's least-privilege; the fleet is LLM-driven so read-only is the key guarantee). Add (Resource `*`, all read verbs):
  - `ec2:Describe*`, `elasticloadbalancing:Describe*`, `network-firewall:Describe*`/`List*` (network)
  - `eks:Describe*`/`List*` (eks)
  - `ecs:Describe*`/`List*`, `ecr:Describe*`/`List*`/`BatchGet*` (ecs)
  - `rds:Describe*`/`ListTagsForResource` (rds — describe tools; execute_sql via Data API is not granted → SELECT tool errors gracefully)
  - `dynamodb:Describe*`/`List*`/`Query`/`GetItem`/`Scan` (dynamodb)
  - `elasticache:Describe*` (valkey)
  - `kafka:Describe*`/`List*`/`Get*` (msk)
  - `ce:Get*`/`List*`/`Describe*`, `pricing:GetProducts`/`DescribeServices`, `budgets:Describe*`/`View*`, `compute-optimizer:Get*`, `savingsplans:Describe*`, `support:Describe*` (cost/finops — TA via support)
  - `cloudwatch:Get*`/`List*`/`Describe*`, `logs:Describe*`/`Get*`/`FilterLogEvents`/`StartQuery`/`StopQuery` (cloudwatch)
  - `cloudtrail:LookupEvents`/`Describe*`/`Get*`/`List*`/`StartQuery` (cloudtrail Lake)
  - `cloudformation:Describe*`/`Detect*`/`Get*`/`List*`/`ValidateTemplate` (iac)
  - keep existing `iam:Get*`/`List*`/`SimulatePrincipalPolicy`, `sts:AssumeRole → AWSopsReadOnlyRole` (cross-account). (terraform-mcp/aws-knowledge need no AWS IAM — public HTTPS.)
  - Pure read-only: NO create/modify/delete/put/start-instance. The generic `call_aws` and `reachability` lambdas are NOT in this wave, so no write surface is added.
- **No VPC** for the tool Lambdas — all AF1 lambdas reach AWS public API endpoints (and 2 reach public HTTPS) from Lambda's default networking. (Runtime is VPC; tool Lambdas are gateway-invoked, separate.)
- **No image rebuild** — agent.py/runtime unchanged. ai.tf packages each tool Lambda from source via `archive_file` (terraform apply deploys them). After apply, re-run the provisioner to create the gateway targets.

---

## Deploy / verify (controller)
1. **apply** — `terraform apply` (creates the 13 new `awsops-v2-agent-<key>` Lambdas + the broadened agent_lambda_read IAM; `agentcore_enabled` already true). In-place/add only; no disturbance to existing gateways/runtime/aurora.
2. **provision** — re-run the idempotent provisioner (`make agentcore`, or `provision.py` directly) → it reads the new `lambda_arns` + catalog TARGETS and `create_gateway_target` for the 13 (existing 2 = no-op EXISTS). Eventual-consistency caveat (P1f): a just-touched gateway not yet READY can ValidationException on first target create → re-run resolves.
3. **smoke** — per new gateway, invoke the runtime with a representative tool and assert live data:
   - data → rds list_db_instances / dynamodb list_tables
   - cost → cost-mcp get_cost_and_usage (or get_today_date)
   - monitoring → cloudwatch get_active_alarms
   - iac → terraform SearchAwsProviderDocs (no creds needed)
   - container → eks list_eks_clusters
   - network → network-mcp list_vpcs
   - ops → aws-knowledge search_documentation
   Each: runtime → gateway → tool → real response (smoke pattern from P1f A7).

## Testing
- A `catalog.py` self-consistency check (Python): every TARGETS entry's `gateway` ∈ GATEWAYS, `lambda_key` is unique-ish, each tool has name+description+inputSchema; the 13 lambda_keys match the planned ai.tf agent_lambdas keys.
- `terraform validate` + `plan` shows only the new agent lambdas + IAM update (no destroys of existing).
- Live smoke (controller) above = the real verification.

## Out of scope (later)
istio/steampipe-query/datasource-diag (P3-D, Steampipe-k8s/VPC) · reachability/call_aws (ADR-029 write-control) · the agent-side response quality / multi-turn memory polish · right-panel section UI depth (chat UI already exists). 
