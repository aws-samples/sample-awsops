# Agent Fleet Depth AF1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Spec: `docs/superpowers/specs/2026-06-08-awsops-v2-agent-fleet-af1-design.md`. The **authoritative tool-schema source is `agent/lambda/create_targets.py`** — port tool lists VERBATIM. Steps `- [ ]`.

**Goal:** Wire 13 read-only MCP targets across 7 gateways (network/container/data/cost/monitoring/iac/ops) so the v2 chat works on 8/9 sections.

**Mechanism:** add `catalog.py` TARGETS (verbatim tools) + `ai.tf` agent_lambdas + broaden agent_lambda_read IAM → `terraform apply` → re-run provisioner → smoke.

**Invariants:** read-only only (no write tools this wave); `lambda_key` ≡ ai.tf `agent_lambdas` key ≡ `agentcore.lambda_arns` output key; tools carry NO `target_account_id` (provision injects); no agent.py/runtime change; no VPC for tool lambdas.

---

### Task 1: `catalog.py` — port 13 TARGETS (verbatim tool schemas)

**Files:** Modify `scripts/v2/agentcore/catalog.py`; Create `scripts/v2/agentcore/catalog_check.py` (consistency check)

Read `agent/lambda/create_targets.py` (the per-gateway `create_target(...)` blocks) + the existing `catalog.py` TARGETS (the entry shape + `_p` helper).

- [ ] **Step 1:** For each of the 13 targets below, add a `TARGETS["<name>"]` entry with `{gateway, lambda_key, description, tools}`. Copy the tool list (name, description, inputSchema/properties) **verbatim** from the matching `create_target` call in `create_targets.py`, using the `_p(type, desc)` helper for properties exactly like the existing iam-mcp/flow-monitor entries. **Omit `target_account_id`** (provision.py injects it). Entries (target-name → gateway / lambda_key / #tools):
  - `network-mcp-target` → network / `network-mcp` / 15
  - `eks-mcp-target` → container / `eks-mcp` / 9
  - `ecs-mcp-target` → container / `ecs-mcp` / 3
  - `rds-mcp-target` → data / `rds-mcp` / 6
  - `dynamodb-mcp-target` → data / `dynamodb-mcp` / 6
  - `msk-mcp-target` → data / `msk-mcp` / 6
  - `valkey-mcp-target` → data / `valkey-mcp` / 6
  - `cost-mcp-target` → cost / `cost-mcp` / 9
  - `finops-mcp-target` → cost / `finops-mcp` / 5
  - `cloudwatch-mcp-target` → monitoring / `cloudwatch-mcp` / 11
  - `cloudtrail-mcp-target` → monitoring / `cloudtrail-mcp` / 5
  - `iac-mcp-target` → iac / `iac-mcp` / 7
  - `terraform-mcp-target` → iac / `terraform-mcp` / 5
  - `aws-knowledge-target` → ops / `aws-knowledge` / 5
  (15 entries total in this wave's port list? No — 14 listed; the spec scope is 13 NEW targets + iam/flow done. Count: network-mcp, eks, ecs, rds, dynamodb, msk, valkey, cost, finops, cloudwatch, cloudtrail, iac, terraform, aws-knowledge = **14 new**. Port all 14.)
- [ ] **Step 2:** `scripts/v2/agentcore/catalog_check.py` — imports catalog, asserts: every TARGETS `gateway` ∈ GATEWAYS; every tool has non-empty `name`/`description` and an `inputSchema` dict with `type:'object'`; no tool carries `target_account_id`; collect the set of `lambda_key`s and print it (for cross-checking ai.tf). Exit non-zero on any failure.
- [ ] **Step 3:** Run `cd /home/atomoh/awsops && python3 scripts/v2/agentcore/catalog_check.py` → prints `OK` + the lambda_key set `{iam-mcp, flow-monitor, network-mcp, eks-mcp, ecs-mcp, rds-mcp, dynamodb-mcp, msk-mcp, valkey-mcp, cost-mcp, finops-mcp, cloudwatch-mcp, cloudtrail-mcp, iac-mcp, terraform-mcp, aws-knowledge}`. Also `python3 -c "import ast; ast.parse(open('scripts/v2/agentcore/catalog.py').read()); print('parse ok')"`.
- [ ] **Step 4: Commit** — `git add scripts/v2/agentcore/catalog.py scripts/v2/agentcore/catalog_check.py && git commit -m "feat(v2-af1): catalog +14 read-only targets (network/eks/ecs/rds/dynamodb/msk/valkey/cost/finops/cloudwatch/cloudtrail/iac/terraform/aws-knowledge) verbatim from create_targets.py + consistency check"`

---

### Task 2: `ai.tf` — agent_lambdas map + curated read-only IAM

**Files:** Modify `terraform/foundation/ai.tf`

Read the `ai.tf` agent Lambda slice (locals.agent_lambdas, archive_file.agent, aws_lambda_function.agent, aws_iam_role_policy.agent_lambda_read) per the spec §Architecture.

- [ ] **Step 1:** Add the 14 keys to `locals.agent_lambdas` (each `"<key>" = { file = "<src>.py", handler = "<module>.lambda_handler" }`). File/handler per `agent/lambda/`:
```hcl
    "network-mcp"    = { file = "network_mcp.py",      handler = "network_mcp.lambda_handler" }
    "eks-mcp"        = { file = "aws_eks_mcp.py",       handler = "aws_eks_mcp.lambda_handler" }
    "ecs-mcp"        = { file = "aws_ecs_mcp.py",       handler = "aws_ecs_mcp.lambda_handler" }
    "rds-mcp"        = { file = "aws_rds_mcp.py",       handler = "aws_rds_mcp.lambda_handler" }
    "dynamodb-mcp"   = { file = "aws_dynamodb_mcp.py",  handler = "aws_dynamodb_mcp.lambda_handler" }
    "msk-mcp"        = { file = "aws_msk_mcp.py",       handler = "aws_msk_mcp.lambda_handler" }
    "valkey-mcp"     = { file = "aws_valkey_mcp.py",    handler = "aws_valkey_mcp.lambda_handler" }
    "cost-mcp"       = { file = "aws_cost_mcp.py",      handler = "aws_cost_mcp.lambda_handler" }
    "finops-mcp"     = { file = "aws_finops_mcp.py",    handler = "aws_finops_mcp.lambda_handler" }
    "cloudwatch-mcp" = { file = "aws_cloudwatch_mcp.py",handler = "aws_cloudwatch_mcp.lambda_handler" }
    "cloudtrail-mcp" = { file = "aws_cloudtrail_mcp.py",handler = "aws_cloudtrail_mcp.lambda_handler" }
    "iac-mcp"        = { file = "aws_iac_mcp.py",       handler = "aws_iac_mcp.lambda_handler" }
    "terraform-mcp"  = { file = "aws_terraform_mcp.py", handler = "aws_terraform_mcp.lambda_handler" }
    "aws-knowledge"  = { file = "aws_knowledge.py",     handler = "aws_knowledge.lambda_handler" }
```
(Verify each handler module name matches the file's actual `def lambda_handler` — read each file's handler line if unsure.)
- [ ] **Step 2:** Broaden `aws_iam_role_policy.agent_lambda_read` with the curated read-only statement(s) from the spec §IAM (ec2/elb/network-firewall, eks, ecs/ecr, rds, dynamodb read, elasticache, kafka, ce/pricing/budgets/compute-optimizer/savingsplans/support, cloudwatch/logs, cloudtrail, cloudformation; keep existing iam + sts:AssumeRole). All Resource `*`, read verbs only.
- [ ] **Step 3: validate + plan** — `cd /home/atomoh/awsops/terraform/foundation && export PATH="$HOME/.local/bin:$PATH"; terraform fmt ai.tf; terraform validate; terraform plan -no-color -input=false -lock=false 2>&1 | grep -E "will be created|will be updated|Plan:|Error" | head -40`. Expected: **14 new `aws_lambda_function.agent["<key>"]` + 14 archive_file + 14 lambda_permission created**, `agent_lambda_read` updated in-place; NO destroys of existing agent lambdas/gateways/runtime/aurora. (agentcore_enabled=true on live.)
- [ ] **Step 4: Commit** — `git add terraform/foundation/ai.tf && git commit -m "feat(v2-af1): ai.tf +14 agent tool Lambdas (for_each agent_lambdas) + curated read-only IAM per service domain"`

---

### Task 3: Apply + provision + smoke (CONTROLLER — real infra/AgentCore)
- [ ] **Step 1:** `terraform apply` the plan (controller; saved-tfplan). Confirm 14 new agent lambdas created + IAM updated, no existing disturbed. `terraform output agentcore` shows `lambda_arns` now has all 16 keys.
- [ ] **Step 2:** Re-run the idempotent provisioner: `make agentcore` (builds agent image [unchanged] + provision.py creates the 14 new gateway targets; existing 2 = EXISTS no-op). Watch for the eventual-consistency ValidationException on a not-yet-READY gateway → re-run resolves (provisioner is idempotent). Confirm: 0 errors, 14 targets CREATED across network/container/data/cost/monitoring/iac/ops.
- [ ] **Step 3: smoke each new gateway** via the runtime (per spec §verify): data(rds/dynamodb), cost, monitoring(cloudwatch), iac(terraform), container(eks), network(network-mcp list_vpcs), ops(aws-knowledge). Each: invoke runtime with the gateway short-key + a representative read tool → assert live data (or a sane empty result). Use the P1f A7 smoke pattern (`make agentcore SMOKE=1` if it supports per-gateway, else a direct InvokeAgentRuntime per gateway).
- [ ] **Step 4: report GREEN** + per-gateway smoke results. No commit (deploy only).

---

## Self-Review
- Coverage: all 14 clean read-only targets (T1 catalog + T2 lambdas/IAM) + apply/provision/smoke (T3). Deferred set (istio/steampipe/datasource-diag/reachability/call_aws) explicitly out, with reasons in the spec.
- Key consistency: the 14 lambda_keys are identical across catalog TARGETS (T1), ai.tf agent_lambdas (T2 Step1), and the IAM domains (T2 Step2) — reviewer cross-checks.
- Tools verbatim from create_targets.py (no `target_account_id`); read-only IAM (no write surface added this wave).
- No agent.py/runtime/aurora change; agentcore_enabled already true.
