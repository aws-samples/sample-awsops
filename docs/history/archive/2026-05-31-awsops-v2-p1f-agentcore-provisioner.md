# AWSops v2 — P1f: AgentCore 멱등 Provisioner (MID-minus) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`). **Long/shared-infra applies (ECR + Lambdas + image build + AgentCore control-plane create): the CONTROLLER runs them via saved-tfplan / `make agentcore` — NOT subagents (subagent stream idle-timeout). `-auto-approve` on shared infra is gated.**

**Goal:** Build an idempotent Terraform (ECR/IAM/Lambda/SSM) + Python boto3 provisioner that stands up the v2 AgentCore skeleton — 9 Gateways (8 named + External-Observability empty), one Runtime, Memory, Code Interpreter — and registers a **representative read-only Lambda target slice** (`iam-mcp` 14 tools → Security, `flow-monitor` 1 tool → Network) to prove every provisioner code path idempotently. ARNs are delivered via SSM; the web task role gets read access for P3's consumer.

**Architecture:** Terraform owns what it models well (`foundation/ai.tf`: dual-tier ECR `awsops-v2-agentcore`, the AgentCore IAM role, the agent Lambda fleet via `for_each`, SSM placeholder params, the web-task-role SSM grant). A post-`apply` **`make agentcore`** step builds the arm64 agent image and runs a self-idempotent Python module (`scripts/v2/agentcore/provision.py`) that does `list→create/update` on the 5 AgentCore control-plane resources (Terraform has no native resources for them; spec §8 says "small idempotent provisioner, avoid null_resource+raw"). Gateway URLs are injected into the Runtime via `GATEWAYS_JSON` env (agent.py's documented fallback — no awscli-in-image dependency). Config (runtime ARN / interpreter id / memory id) lands in SSM String params; the web BFF will read them at runtime in P3 (this phase only provisions + grants).

**Tech Stack:** Terraform `aws_ecr_repository`/`aws_ecrpublic_repository`/`aws_iam_role`/`aws_lambda_function`/`archive_file`/`aws_ssm_parameter`; Python 3 + boto3 `bedrock-agentcore-control`; Node `execSync` (image build, mirrors deploy.mjs); reuses `agent/` (Dockerfile, agent.py, streamable_http_sigv4.py) + `agent/lambda/{aws_iam_mcp,flowmonitor,cross_account}.py` as-is.

**Builds on:** P1d `aws_iam_role.task`/`.execution` + dual-tier ECR pattern (`ecr.tf`) + `deploy.mjs`/`Makefile`; P1e `eks.tf` `for_each`+count-gated-IAM+map-output pattern; `configure.mjs` tfvars writer.

**Scope decision (3-AI cross review, 2026-05-31 — `docs/reviews/v2-p1f-scope-architecture-review.md`):** **MID-minus** (user-confirmed). **In scope:** provisioner machinery + 9 Gateways (#7 empty) + Runtime/Memory/Interpreter + the 2-Lambda representative slice + SSM + web grant. **Non-goals (deferred):** full Lambda fleet + `≤25`-tool curation + section=routing + right-dock UI (→ **P3**); `#7` plugin datasource registry + OTLP + datasource-diag re-home (→ **P3**); the 2 VPC Lambdas `istio`/`steampipe-query` (need a v2 Steampipe service that doesn't exist — → later); `reachability` (the only write op — no ADR-029 mutating gate in v2 yet); Incident orchestrator/Opus (→ **P4**).

---

## File Structure

```
terraform/foundation/
  ai.tf                       # NEW — agentcore_enabled var; dual-tier ECR; AgentCore IAM role;
                              #       agent Lambda role; slice Lambdas (for_each+archive_file+permission);
                              #       SSM placeholder params (ignore_changes); web-task-role SSM grant; outputs
scripts/v2/agentcore/
  catalog.py                  # NEW — gateway list (9) + target slice tool schemas (ported from create_targets.py)
  provision.py                # NEW — idempotent boto3 provisioner (Runtime/Gateway/Target/Memory/Interpreter), SSM write, diff report, --smoke
scripts/v2/
  agentcore.mjs               # NEW — make-agentcore entry: build+push arm64 agent image → run provision.py
  configure.mjs               # MODIFY — agentcore_enabled confirm → tfvars (mirror onboard_eks_clusters)
Makefile                      # MODIFY — `agentcore` target
agent/                        # REUSE as-is — Dockerfile/agent.py/streamable_http_sigv4.py built to awsops-v2-agentcore ECR
agent/lambda/{aws_iam_mcp,flowmonitor,cross_account}.py   # REUSE as-is — packaged by ai.tf archive_file
```

`var.agentcore_enabled` defaults `false` → every resource is `count`/`for_each`-gated, so merging A1–A6 is a safe no-op until A7 sets it `true` (mirrors P1e's empty-list no-op).

---

## Task A1: `ai.tf` — ECR + IAM + SSM + web grant (no Lambdas yet)

**Files:** Create `terraform/foundation/ai.tf`.

- [ ] **Step 1: write the ECR + IAM + SSM + web-grant section of `ai.tf`**

```hcl
# AWSops v2 — P1f AgentCore provisioner (Terraform-native parts).
# AgentCore control-plane resources (Runtime/Gateway/Target/Memory/Interpreter) are NOT
# Terraform-native — they are created by scripts/v2/agentcore/provision.py after apply.
# Everything here is gated on var.agentcore_enabled (default false → no-op).

variable "agentcore_enabled" {
  type        = bool
  description = "Provision the AgentCore skeleton (ECR/IAM/Lambda/SSM). Written by `make configure`."
  default     = false
}

locals {
  ac_count = var.agentcore_enabled ? 1 : 0
}

# ---- dual-tier ECR for the agent runtime image (mirrors ecr.tf) ----
resource "aws_ecr_repository" "agentcore" {
  count                = local.ac_count
  name                 = "${var.project}-agentcore"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  force_delete = true
}

resource "aws_ecrpublic_repository" "agentcore" {
  count           = local.ac_count
  provider        = aws.use1
  repository_name = "${var.project}-agentcore"
  catalog_data {
    about_text    = "AWSops v2 AgentCore runtime (Strands agent on AgentCore Runtime)."
    architectures = ["ARM 64"]
    description   = "AWSops v2 AgentCore agent image."
  }
}

# ---- AgentCore role: used by BOTH the Runtime (model invoke + gateway calls) and the
#      Gateways (GATEWAY_IAM_ROLE → invoke target Lambdas). Least-privilege per 3-AI Finding 6. ----
data "aws_iam_policy_document" "agentcore_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com", "bedrock-agentcore.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "agentcore" {
  count              = local.ac_count
  name               = "${var.project}-agentcore"
  assume_role_policy = data.aws_iam_policy_document.agentcore_assume.json
}

resource "aws_iam_role_policy" "agentcore" {
  count = local.ac_count
  name  = "${var.project}-agentcore-perms"
  role  = aws_iam_role.agentcore[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "BedrockModelInvoke"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = "*"
      },
      {
        Sid      = "AgentCoreControlAndData"
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:*"]
        Resource = "*"
      },
      {
        Sid      = "InvokeAgentLambdasOnly"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = "arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:${var.project}-agent-*"
      }
    ]
  })
}

# ---- SSM String params (placeholders; provision.py overwrites the value). Not secrets → String. ----
resource "aws_ssm_parameter" "agentcore_runtime_arn" {
  count     = local.ac_count
  name      = "/${var.project}/agentcore/runtime_arn"
  type      = "String"
  value     = "PENDING"
  overwrite = true
  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "agentcore_interpreter_id" {
  count     = local.ac_count
  name      = "/${var.project}/agentcore/interpreter_id"
  type      = "String"
  value     = "PENDING"
  overwrite = true
  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "agentcore_memory_id" {
  count     = local.ac_count
  name      = "/${var.project}/agentcore/memory_id"
  type      = "String"
  value     = "PENDING"
  overwrite = true
  lifecycle {
    ignore_changes = [value]
  }
}

# ---- web task role reads the AgentCore SSM params at runtime (P3 consumer). TASK role, NOT
#      execution role → avoids the valueFrom-at-task-start race (3-AI Q3 / P1d blocker). ----
resource "aws_iam_role_policy" "task_agentcore_ssm" {
  count = local.ac_count
  name  = "${var.project}-task-agentcore-ssm"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParameters"]
      Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project}/agentcore/*"
    }]
  })
}
```

- [ ] **Step 2: confirm `data.aws_caller_identity.current` exists; add it only if missing**

Run:
```bash
cd /home/atomoh/awsops/terraform/foundation
grep -rn 'data "aws_caller_identity"' *.tf
```
If the grep prints a match, do nothing. If it prints NOTHING, append this block to `ai.tf`:
```hcl
data "aws_caller_identity" "current" {}
```
(`ai.tf` references `data.aws_caller_identity.current.account_id` in Step 1; it must be declared exactly once across the module.)

- [ ] **Step 3: validate (disabled = no-op)**
```bash
cd /home/atomoh/awsops/terraform/foundation
terraform fmt && terraform validate
```
Expected: `Success! The configuration is valid.` With `agentcore_enabled=false` (default), `count = 0` everywhere → zero new resources.

- [ ] **Step 4: commit**
```bash
cd /home/atomoh/awsops
git add terraform/foundation/ai.tf
git commit -m "feat(v2-p1f): ai.tf — AgentCore ECR + IAM role + SSM params + web task-role SSM grant (gated)"
```

---

## Task A2: slice agent Lambdas in `ai.tf`

**Files:** Modify `terraform/foundation/ai.tf` (append).

- [ ] **Step 1: append the agent Lambda fleet (representative slice)**

```hcl
# ---- agent Lambda execution role (read-only invariant; reachability/write ops excluded) ----
data "aws_iam_policy_document" "agent_lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "agent_lambda" {
  count              = local.ac_count
  name               = "${var.project}-agent-lambda"
  assume_role_policy = data.aws_iam_policy_document.agent_lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "agent_lambda_logs" {
  count      = local.ac_count
  role       = aws_iam_role.agent_lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "agent_lambda_read" {
  count = local.ac_count
  name  = "${var.project}-agent-lambda-read"
  role  = aws_iam_role.agent_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadOnlySlice"
        Effect   = "Allow"
        Action   = ["iam:Get*", "iam:List*", "iam:SimulatePrincipalPolicy", "ec2:Describe*"]
        Resource = "*"
      },
      {
        Sid      = "CrossAccountAssumeReadOnly"
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = "arn:aws:iam::*:role/AWSopsReadOnlyRole"
      }
    ]
  })
}

# The slice. key → source file (handler is "<module>.lambda_handler"). cross_account.py is bundled.
locals {
  agent_lambdas = var.agentcore_enabled ? {
    "iam-mcp"      = { file = "aws_iam_mcp.py", handler = "aws_iam_mcp.lambda_handler" }
    "flow-monitor" = { file = "flowmonitor.py", handler = "flowmonitor.lambda_handler" }
  } : {}
}

data "archive_file" "agent" {
  for_each    = local.agent_lambdas
  type        = "zip"
  output_path = "${path.module}/.build/agent-${each.key}.zip"
  source {
    content  = file("${path.module}/../../../agent/lambda/${each.value.file}")
    filename = each.value.file
  }
  source {
    content  = file("${path.module}/../../../agent/lambda/cross_account.py")
    filename = "cross_account.py"
  }
}

resource "aws_lambda_function" "agent" {
  for_each         = local.agent_lambdas
  function_name    = "${var.project}-agent-${each.key}"
  role             = aws_iam_role.agent_lambda[0].arn
  runtime          = "python3.11"
  handler          = each.value.handler
  filename         = data.archive_file.agent[each.key].output_path
  source_code_hash = data.archive_file.agent[each.key].output_base64sha256
  timeout          = 60
  memory_size      = 256
  architectures    = ["arm64"]
}

# Allow the AgentCore Gateway (via its IAM role) to invoke each agent Lambda.
resource "aws_lambda_permission" "agent_agentcore" {
  for_each      = local.agent_lambdas
  statement_id  = "AllowAgentCoreInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent[each.key].function_name
  principal     = "bedrock-agentcore.amazonaws.com"
}

# ---- outputs consumed by scripts/v2/agentcore/provision.py ----
output "agentcore" {
  description = "AgentCore provisioning inputs for scripts/v2/agentcore/provision.py (null when disabled)."
  value = var.agentcore_enabled ? {
    region       = var.region
    project      = var.project
    role_arn     = aws_iam_role.agentcore[0].arn
    ecr_uri      = aws_ecr_repository.agentcore[0].repository_url
    lambda_arns  = { for k, fn in aws_lambda_function.agent : k => fn.arn }
    ssm_runtime_arn    = aws_ssm_parameter.agentcore_runtime_arn[0].name
    ssm_interpreter_id = aws_ssm_parameter.agentcore_interpreter_id[0].name
    ssm_memory_id      = aws_ssm_parameter.agentcore_memory_id[0].name
  } : null
}
```

- [ ] **Step 2: validate**
```bash
cd /home/atomoh/awsops/terraform/foundation
terraform fmt && terraform validate
```
Expected: `Success! The configuration is valid.` (`local.agent_lambdas = {}` when disabled → no archive/function/permission resources, and `output "agentcore"` is `null`.)

- [ ] **Step 3: confirm `.build/` is git-ignored** (archive_file writes the zip there)
```bash
cd /home/atomoh/awsops
grep -qE '(^|/)\.build/?($|\*)' terraform/foundation/.gitignore .gitignore 2>/dev/null && echo "ignored OK" || echo 'terraform/foundation/.build/' >> terraform/foundation/.gitignore
```
Expected: `ignored OK`, or the path is appended. (P1d already writes `.build/` for the edge-lambda zip, so it is likely ignored.)

- [ ] **Step 4: commit**
```bash
cd /home/atomoh/awsops
git add terraform/foundation/ai.tf terraform/foundation/.gitignore
git commit -m "feat(v2-p1f): ai.tf — agent Lambda slice (iam-mcp, flow-monitor) for_each + role + permission + agentcore output"
```

---

## Task A3: provisioner catalog (`catalog.py`)

**Files:** Create `scripts/v2/agentcore/catalog.py`.

The 9 gateway names (8 v1-stable + `external-obs` NEW empty) and the target slice tool schemas, ported verbatim from `agent/lambda/create_targets.py` (the authoritative registry). `provision.py` joins `TARGETS[*].lambda_key` to the real Lambda ARNs from `terraform output`.

- [ ] **Step 1: write `scripts/v2/agentcore/catalog.py`**

```python
"""AWSops v2 P1f — AgentCore skeleton catalog (MID-minus).

GATEWAYS: 9 domain gateways. 8 reuse v1-stable names (agent.py auto-discovers by
stripping 'awsops-'/'-gateway'); 'external-obs' is the NEW §4 #7 split, left EMPTY in
P1f (its plugin datasource registry + OTLP + datasource-diag re-home are P3).

TARGETS: the representative read-only slice proving every provisioner code path:
  - iam-mcp (14 tools, cross-account, largest schema) -> security gateway
  - flow-monitor (1 tool, single-tool, proves for_each>=2) -> network gateway
Schemas are copied verbatim from agent/lambda/create_targets.py. provision.py injects
target_account_id into every tool inputSchema (cross-account), exactly like v1.
"""

# short-key -> gateway display name. provision.py builds 'awsops-<key>-gateway'.
GATEWAYS = [
    "network", "container", "data", "security", "cost",
    "monitoring", "iac", "ops", "external-obs",
]

GATEWAY_DESCRIPTIONS = {
    "network": "VPC, ENI, reachability, flow logs, TGW, VPN, firewall",
    "container": "EKS, ECS, Istio, Kubernetes",
    "data": "DynamoDB, RDS/Aurora, ElastiCache, MSK, OpenSearch",
    "security": "IAM, policy simulation, CIS/benchmark (P3)",
    "cost": "Cost Explorer, forecast, budgets, container cost",
    "monitoring": "CloudWatch, CloudTrail (AWS native only)",
    "iac": "CloudFormation, CDK, Terraform",
    "ops": "Steampipe SQL listing/status/docs/inventory",
    "external-obs": "External Observability (Prometheus/Loki/Tempo/...) — registry built in P3",
}


def _p(t, d=""):
    r = {"type": t}
    if d:
        r["description"] = d
    return r


# target_name -> {gateway, lambda_key (matches terraform output agentcore.lambda_arns), description, tools[]}
TARGETS = {
    "iam-mcp-target": {
        "gateway": "security",
        "lambda_key": "iam-mcp",
        "description": "IAM users, roles, groups, policies, simulation (14 tools)",
        "tools": [
            {"name": "list_users", "description": "List IAM users", "inputSchema": {"type": "object", "properties": {}}},
            {"name": "get_user", "description": "User details", "inputSchema": {"type": "object", "properties": {"user_name": _p("string", "User")}, "required": ["user_name"]}},
            {"name": "list_roles", "description": "List roles", "inputSchema": {"type": "object", "properties": {}}},
            {"name": "get_role_details", "description": "Role details", "inputSchema": {"type": "object", "properties": {"role_name": _p("string", "Role")}, "required": ["role_name"]}},
            {"name": "list_groups", "description": "List groups", "inputSchema": {"type": "object", "properties": {}}},
            {"name": "get_group", "description": "Group details", "inputSchema": {"type": "object", "properties": {"group_name": _p("string", "Group")}, "required": ["group_name"]}},
            {"name": "list_policies", "description": "List policies", "inputSchema": {"type": "object", "properties": {"scope": _p("string", "Local/AWS/All")}}},
            {"name": "list_user_policies", "description": "User policies", "inputSchema": {"type": "object", "properties": {"user_name": _p("string", "User")}, "required": ["user_name"]}},
            {"name": "list_role_policies", "description": "Role policies", "inputSchema": {"type": "object", "properties": {"role_name": _p("string", "Role")}, "required": ["role_name"]}},
            {"name": "get_user_policy", "description": "User inline policy", "inputSchema": {"type": "object", "properties": {"user_name": _p("string", "User"), "policy_name": _p("string", "Policy")}, "required": ["user_name", "policy_name"]}},
            {"name": "get_role_policy", "description": "Role inline policy", "inputSchema": {"type": "object", "properties": {"role_name": _p("string", "Role"), "policy_name": _p("string", "Policy")}, "required": ["role_name", "policy_name"]}},
            {"name": "list_access_keys", "description": "Access keys", "inputSchema": {"type": "object", "properties": {"user_name": _p("string", "User")}, "required": ["user_name"]}},
            {"name": "simulate_principal_policy", "description": "Policy simulation", "inputSchema": {"type": "object", "properties": {"policy_source_arn": _p("string", "ARN"), "action_names": _p("string", "Actions")}, "required": ["policy_source_arn", "action_names"]}},
            {"name": "get_account_security_summary", "description": "Account security summary", "inputSchema": {"type": "object", "properties": {}}},
        ],
    },
    "flow-monitor-target": {
        "gateway": "network",
        "lambda_key": "flow-monitor",
        "description": "VPC Flow Log analyzer (1 tool)",
        "tools": [
            {"name": "query_flow_logs", "description": "Query flow logs", "inputSchema": {"type": "object", "properties": {"vpc_id": _p("string", "VPC ID")}, "required": ["vpc_id"]}},
        ],
    },
}
```

- [ ] **Step 2: import-check**
```bash
cd /home/atomoh/awsops/scripts/v2/agentcore
python3 -c "import catalog; assert len(catalog.GATEWAYS)==9; assert sum(len(t['tools']) for t in catalog.TARGETS.values())==15; print('catalog OK: 9 gateways, 15 slice tools')"
```
Expected: `catalog OK: 9 gateways, 15 slice tools` (iam 14 + flow-monitor 1).

- [ ] **Step 3: commit**
```bash
cd /home/atomoh/awsops
git add scripts/v2/agentcore/catalog.py
git commit -m "feat(v2-p1f): agentcore catalog — 9 gateways (#7 external-obs empty) + iam/flow-monitor target slice"
```

---

## Task A4: idempotent provisioner (`provision.py`)

**Files:** Create `scripts/v2/agentcore/provision.py`.

`list→create/update` for all 5 AgentCore resource types. Runtime update re-passes `roleArn` + `networkConfiguration` (v1 quirk). Gateway-Target does `update_gateway_target` on schema drift (v1 had no drift path). Underscore-only names for Runtime/Memory/Interpreter; Memory `eventExpiryDuration=365`. Writes SSM. Prints a per-resource diff/no-op report (CREATED/EXISTS/UPDATED/ERR). `--smoke` invokes the Runtime through one gateway.

- [ ] **Step 1: write `scripts/v2/agentcore/provision.py`**

```python
#!/usr/bin/env python3
"""AWSops v2 P1f — idempotent AgentCore provisioner.

Reads `terraform -chdir=terraform/foundation output -json` -> ensures Runtime,
9 Gateways, the slice Targets, Memory, Code Interpreter exist (list->create/update),
writes ARNs to SSM, prints a diff/no-op report.

  python3 scripts/v2/agentcore/provision.py          # provision (idempotent)
  python3 scripts/v2/agentcore/provision.py --smoke   # provision + invoke runtime via 1 gateway

Run from the repo root (so `terraform -chdir=...` resolves) AFTER `terraform apply`.
"""
import argparse
import json
import subprocess
import sys
import time

import boto3
from botocore.exceptions import ClientError

import catalog  # same directory

TFDIR = "terraform/foundation"
RUNTIME_NAME = "awsops_v2_agent"            # underscores only
MEMORY_NAME = "awsops_v2_memory"            # underscores only
INTERPRETER_NAME = "awsops_v2_code_interpreter"  # underscores only

report = []  # (resource, status, detail)


def log(resource, status, detail=""):
    report.append((resource, status, detail))
    print(f"  [{status:8}] {resource}  {detail}")


def tf_outputs():
    raw = subprocess.check_output(["terraform", f"-chdir={TFDIR}", "output", "-json"], text=True)
    data = json.loads(raw)
    if "agentcore" not in data or data["agentcore"]["value"] is None:
        sys.exit("agentcore output is null — set agentcore_enabled=true and `terraform apply` first.")
    return data["agentcore"]["value"]


def _items(resp):
    """AgentCore list APIs are inconsistent on the wrapper key."""
    for k in ("items", "memories", "gateways", "agentRuntimes", "codeInterpreters", "codeInterpreterSummaries"):
        if k in resp:
            return resp[k]
    return []


def gateway_url(gw_id, region):
    return f"https://{gw_id}.gateway.bedrock-agentcore.{region}.amazonaws.com/mcp"


def ensure_gateways(ctrl, ac):
    """9 gateways, idempotent by exact name. Returns {short_key: gateway_id}."""
    existing = {g.get("name"): g.get("gatewayId") for g in _items(ctrl.list_gateways())}
    ids = {}
    for key in catalog.GATEWAYS:
        name = f"awsops-{key}-gateway"
        if name in existing:
            ids[key] = existing[name]
            log(f"gateway:{key}", "EXISTS", name)
            continue
        try:
            resp = ctrl.create_gateway(
                name=name,
                roleArn=ac["role_arn"],
                protocolType="MCP",
                authorizerType="NONE",
                description=catalog.GATEWAY_DESCRIPTIONS.get(key, key),
            )
            ids[key] = resp["gatewayId"]
            log(f"gateway:{key}", "CREATED", name)
        except ClientError as e:
            log(f"gateway:{key}", "ERR", str(e)[:140])
    return ids


def _inject_account(tools):
    for t in tools:
        props = t.setdefault("inputSchema", {}).setdefault("properties", {})
        props.setdefault("target_account_id", {
            "type": "string",
            "description": "Target AWS account ID for cross-account access (12 digits). Only provide when instructed.",
        })
    return tools


def ensure_targets(ctrl, ac, gw_ids):
    """Slice targets, idempotent by name. update_gateway_target on tool-schema drift."""
    for tname, spec in catalog.TARGETS.items():
        gw_id = gw_ids.get(spec["gateway"])
        if not gw_id:
            log(f"target:{tname}", "ERR", f"gateway {spec['gateway']} missing")
            continue
        lambda_arn = ac["lambda_arns"].get(spec["lambda_key"])
        if not lambda_arn:
            log(f"target:{tname}", "ERR", f"lambda {spec['lambda_key']} not in tf output")
            continue
        tools = _inject_account([dict(t, inputSchema=dict(t["inputSchema"])) for t in spec["tools"]])
        cfg = {"mcp": {"lambda": {"lambdaArn": lambda_arn, "toolSchema": {"inlinePayload": tools}}}}
        creds = [{"credentialProviderType": "GATEWAY_IAM_ROLE"}]
        existing = {t.get("name"): t for t in _items(ctrl.list_gateway_targets(gatewayIdentifier=gw_id))}
        try:
            if tname in existing:
                tid = existing[tname]["targetId"]
                cur = ctrl.get_gateway_target(gatewayIdentifier=gw_id, targetId=tid)
                cur_tools = cur.get("targetConfiguration", {}).get("mcp", {}).get("lambda", {}).get("toolSchema", {}).get("inlinePayload", [])
                if {t["name"] for t in cur_tools} == {t["name"] for t in tools}:
                    log(f"target:{tname}", "EXISTS", f"{len(tools)} tools")
                else:
                    ctrl.update_gateway_target(gatewayIdentifier=gw_id, targetId=tid, name=tname,
                                                description=spec["description"], targetConfiguration=cfg,
                                                credentialProviderConfigurations=creds)
                    log(f"target:{tname}", "UPDATED", f"{len(tools)} tools (schema drift)")
            else:
                ctrl.create_gateway_target(gatewayIdentifier=gw_id, name=tname, description=spec["description"],
                                            targetConfiguration=cfg, credentialProviderConfigurations=creds)
                log(f"target:{tname}", "CREATED", f"{len(tools)} tools")
        except ClientError as e:
            log(f"target:{tname}", "ERR", str(e)[:140])


def ensure_memory(ctrl):
    for m in _items(ctrl.list_memories()):
        if m.get("name") == MEMORY_NAME:
            mid = m.get("memoryId") or m.get("id")
            log("memory", "EXISTS", mid)
            return mid
    try:
        resp = ctrl.create_memory(name=MEMORY_NAME, description="AWSops v2 conversation history",
                                  eventExpiryDuration=365)
        mid = resp.get("memoryId") or resp.get("id") or resp.get("memory", {}).get("memoryId")
        log("memory", "CREATED", mid)
        return mid
    except ClientError as e:
        log("memory", "ERR", str(e)[:140])
        return ""


def ensure_interpreter(ctrl):
    for c in _items(ctrl.list_code_interpreters()):
        if c.get("name") == INTERPRETER_NAME:
            cid = c.get("codeInterpreterId") or c.get("id")
            log("interpreter", "EXISTS", cid)
            return cid
    try:
        resp = ctrl.create_code_interpreter(name=INTERPRETER_NAME,
                                            networkConfiguration={"networkMode": "PUBLIC"})
        cid = resp.get("codeInterpreterId") or resp.get("id")
        log("interpreter", "CREATED", cid)
        return cid
    except ClientError as e:
        log("interpreter", "ERR", str(e)[:140])
        return ""


def ensure_runtime(ctrl, ac, gw_ids):
    region = ac["region"]
    gateways_json = json.dumps({k: gateway_url(v, region) for k, v in gw_ids.items()})
    artifact = {"containerConfiguration": {"containerUri": f"{ac['ecr_uri']}:agent-latest"}}
    netcfg = {"networkMode": "PUBLIC"}
    env = {"AWS_REGION": region, "GATEWAYS_JSON": gateways_json}
    existing = {r.get("agentRuntimeName"): r for r in _items(ctrl.list_agent_runtimes())}
    try:
        if RUNTIME_NAME in existing:
            rid = existing[RUNTIME_NAME].get("agentRuntimeId")
            # v1 quirk: update MUST re-pass roleArn + networkConfiguration.
            resp = ctrl.update_agent_runtime(agentRuntimeId=rid, roleArn=ac["role_arn"],
                                             agentRuntimeArtifact=artifact, networkConfiguration=netcfg,
                                             environmentVariables=env)
            arn = resp.get("agentRuntimeArn") or existing[RUNTIME_NAME].get("agentRuntimeArn")
            log("runtime", "UPDATED", arn)
            return arn
        resp = ctrl.create_agent_runtime(agentRuntimeName=RUNTIME_NAME, roleArn=ac["role_arn"],
                                         agentRuntimeArtifact=artifact, networkConfiguration=netcfg,
                                         environmentVariables=env)
        arn = resp.get("agentRuntimeArn")
        log("runtime", "CREATED", arn)
        return arn
    except ClientError as e:
        log("runtime", "ERR", str(e)[:160])
        return ""


def write_ssm(ac, runtime_arn, interpreter_id, memory_id):
    ssm = boto3.client("ssm", region_name=ac["region"])
    for pname, val in [(ac["ssm_runtime_arn"], runtime_arn),
                       (ac["ssm_interpreter_id"], interpreter_id),
                       (ac["ssm_memory_id"], memory_id)]:
        if not val:
            log(f"ssm:{pname}", "SKIP", "empty value")
            continue
        ssm.put_parameter(Name=pname, Value=val, Type="String", Overwrite=True)
        log(f"ssm:{pname}", "WROTE", val[:60])


def smoke(ac, runtime_arn):
    if not runtime_arn:
        log("smoke", "ERR", "no runtime arn")
        return
    data = boto3.client("bedrock-agentcore", region_name=ac["region"])
    payload = json.dumps({"gateway": "security", "prompt": "List the IAM roles in this account. Use the list_roles tool."}).encode()
    try:
        resp = data.invoke_agent_runtime(agentRuntimeArn=runtime_arn, qualifier="DEFAULT",
                                         runtimeSessionId="p1f-smoke-session-000000000000000000000000000000000",
                                         payload=payload)
        body = resp["response"].read().decode() if hasattr(resp.get("response"), "read") else str(resp.get("response"))
        ok = "role" in body.lower()
        log("smoke", "OK" if ok else "WARN", body[:160])
    except ClientError as e:
        log("smoke", "ERR", str(e)[:160])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="invoke the runtime through one gateway after provisioning")
    args = ap.parse_args()

    ac = tf_outputs()
    region = ac["region"]
    ctrl = boto3.client("bedrock-agentcore-control", region_name=region)

    print(f"\n=== AWSops v2 AgentCore provisioner (region={region}) ===")
    gw_ids = ensure_gateways(ctrl, ac)
    ensure_targets(ctrl, ac, gw_ids)
    memory_id = ensure_memory(ctrl)
    interpreter_id = ensure_interpreter(ctrl)
    runtime_arn = ensure_runtime(ctrl, ac, gw_ids)
    write_ssm(ac, runtime_arn, interpreter_id, memory_id)

    if args.smoke:
        print("\n=== smoke (runtime -> gateway -> tool) ===")
        # the runtime may need a few seconds after create/update to become invokable
        time.sleep(10)
        smoke(ac, runtime_arn)

    errs = [r for r in report if r[1] == "ERR"]
    print(f"\n=== report: {len(report)} actions, {len(errs)} errors ===")
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: compile-check (no AWS calls)**
```bash
cd /home/atomoh/awsops/scripts/v2/agentcore
python3 -m py_compile provision.py && python3 -c "import ast,sys; ast.parse(open('provision.py').read()); print('provision.py parses OK')"
```
Expected: `provision.py parses OK`.

- [ ] **Step 3: commit**
```bash
cd /home/atomoh/awsops
git add scripts/v2/agentcore/provision.py
git commit -m "feat(v2-p1f): provision.py — idempotent boto3 AgentCore wrapper (list/create/update, drift, SSM, --smoke, diff report)"
```

> **Note for the executor (verified design facts, not placeholders):** `environmentVariables` on `create/update_agent_runtime` is how agent.py receives `GATEWAYS_JSON` (its documented discovery fallback — see `agent/agent.py` `_discover_gateways`). If the live `bedrock-agentcore-control` API in this account rejects `environmentVariables`, that is the single field to confirm against `aws bedrock-agentcore-control create-agent-runtime help` in A7 Step 2 — the rest of the call shape matches v1's working `06a`/`create_targets.py`.

---

## Task A5: `make agentcore` entry (`agentcore.mjs` + Makefile)

**Files:** Create `scripts/v2/agentcore.mjs`; modify `Makefile`.

- [ ] **Step 1: write `scripts/v2/agentcore.mjs`** (mirrors `deploy.mjs`'s build idiom)

```javascript
#!/usr/bin/env node
// AWSops v2 P1f: build arm64 agent image -> push ECR -> run idempotent boto3 provisioner.
// Run AFTER `terraform apply` (with agentcore_enabled=true). Pass --smoke to invoke after provisioning.
import { execSync } from 'node:child_process';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const CHDIR = 'terraform/foundation';
const TAG = process.env.AGENT_IMAGE_TAG || 'agent-latest';
const DOCKER = process.env.DOCKER || 'sudo docker';
const SMOKE = process.argv.includes('--smoke') ? '--smoke' : '';

const tfJson = () => JSON.parse(execSync(`terraform -chdir=${CHDIR} output -json`, { encoding: 'utf8' }));
const sh = (cmd) => execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });

const ac = tfJson().agentcore?.value;
if (!ac) {
  console.error('agentcore output is null — set agentcore_enabled=true in terraform.tfvars and `terraform apply` first.');
  process.exit(1);
}
const repo = ac.ecr_uri;
const registry = repo.split('/')[0];

console.log(`\n[1/3] ECR login -> ${registry}`);
sh(`aws ecr get-login-password --region ${REGION} | ${DOCKER} login --username AWS --password-stdin ${registry}`);

console.log(`\n[2/3] build + push arm64 agent image -> ${repo}:${TAG}`);
sh(`${DOCKER} buildx build --platform linux/arm64 -t ${repo}:${TAG} --push agent/`);

console.log(`\n[3/3] idempotent AgentCore provision (Runtime/Gateways/Targets/Memory/Interpreter -> SSM)`);
sh(`python3 scripts/v2/agentcore/provision.py ${SMOKE}`.trim());

console.log('\n✅ make agentcore complete');
```

- [ ] **Step 2: add the `agentcore` target to `Makefile`** — change the `.PHONY` line and append the target.

Replace:
```make
.PHONY: help configure deps deploy
```
with:
```make
.PHONY: help configure deps deploy agentcore
```
Then append at end of file:
```make

agentcore: ## Build arm64 agent image, push ECR, run idempotent AgentCore provisioner (--smoke to invoke). Run after `terraform apply`.
	@node scripts/v2/agentcore.mjs $(if $(SMOKE),--smoke,)
```

- [ ] **Step 3: syntax-check + commit**
```bash
cd /home/atomoh/awsops
node --check scripts/v2/agentcore.mjs && echo "agentcore.mjs syntax OK"
make help | grep -q agentcore && echo "make target OK"
git add scripts/v2/agentcore.mjs Makefile
git commit -m "feat(v2-p1f): make agentcore — build+push arm64 agent image then run provisioner"
```
Expected: `agentcore.mjs syntax OK` and `make target OK`.

---

## Task A6: `agentcore_enabled` toggle in `configure.mjs`

**Files:** Modify `scripts/v2/configure.mjs`.

- [ ] **Step 1: confirm the `confirm` import** — `configure.mjs` already imports from `@inquirer/prompts` (it uses `checkbox` for EKS). Ensure `confirm` is in that import list:
```bash
cd /home/atomoh/awsops
grep -n "@inquirer/prompts" scripts/v2/configure.mjs
```
If the imported names do not include `confirm`, add it to the existing destructured import (e.g. `import { input, select, checkbox, confirm } from '@inquirer/prompts';`).

- [ ] **Step 2: add the AgentCore prompt** — in `main()`, immediately AFTER the EKS selection block added in P1e (right before `const cfg = {`), add:
```js
  // AgentCore skeleton (optional). Provisions ECR/IAM/Lambda/SSM; `make agentcore` does the rest.
  console.log('');
  const agentcoreEnabled = await confirm({
    message: 'Provision the AgentCore skeleton (9 gateways + runtime + slice tools)? You run `make agentcore` after apply.',
    default: false,
  });
```

- [ ] **Step 3: thread into `cfg`** — in the `const cfg = { ... }` object, add the field (after `onboardEksClusters,`):
```js
    agentcoreEnabled,
```

- [ ] **Step 4: write it to tfvars** — in `buildTfvars(cfg)`, before the final `return`, add:
```js
  if (cfg.agentcoreEnabled) {
    lines.push('agentcore_enabled = true');
  }
```

- [ ] **Step 5: show it in the summary** — in the Summary block (after the EKS line), add:
```js
  console.log(`  AgentCore        : ${cfg.agentcoreEnabled ? 'enabled' : '(disabled)'}`);
```

- [ ] **Step 6: syntax-check + commit**
```bash
cd /home/atomoh/awsops
node --check scripts/v2/configure.mjs && echo "configure.mjs syntax OK"
git add scripts/v2/configure.mjs
git commit -m "feat(v2-p1f): configure.mjs — agentcore_enabled confirm -> tfvars"
```
Expected: `configure.mjs syntax OK`.

---

## Task A7: enable + apply + provision + verify (GREEN bar)

**Files:** Modify `terraform/foundation/terraform.tfvars` (gitignored — operator input). **Controller runs the apply + `make agentcore` (long: ECR + 2 Lambdas + arm64 image build + AgentCore create); subagents hit idle-timeout.**

- [ ] **Step 1: enable in tfvars** (simulates the `make configure` choice)
```bash
cd /home/atomoh/awsops/terraform/foundation
grep -q '^agentcore_enabled' terraform.tfvars || echo 'agentcore_enabled = true' >> terraform.tfvars
tail -3 terraform.tfvars
```

- [ ] **Step 2: confirm the one uncertain API field, then plan + apply** (controller; saved plan)
```bash
# Confirm environmentVariables is accepted by create-agent-runtime in this account/region:
aws bedrock-agentcore-control create-agent-runtime help 2>/dev/null | grep -i -A1 environmentVariables | head -4 || echo "field-name check: inspect `aws bedrock-agentcore-control create-agent-runtime help`"
cd terraform/foundation
terraform plan -out tfplan -no-color 2>&1 | grep -E "^  # |^Plan:|must be replaced" | head -40
```
Expected plan: ADD `aws_ecr_repository.agentcore[0]`, `aws_ecrpublic_repository.agentcore[0]`, `aws_iam_role.agentcore[0]` + its policy, `aws_iam_role.agent_lambda[0]` + 2 policies, `data.archive_file.agent["iam-mcp"|"flow-monitor"]`, `aws_lambda_function.agent[...]` (×2), `aws_lambda_permission.agent_agentcore[...]` (×2), 3× `aws_ssm_parameter.agentcore_*`, `aws_iam_role_policy.task_agentcore_ssm[0]`, + the `agentcore` output. **NO replace** of web/ECS/ALB/edge/Aurora/EKS. Then:
```bash
terraform apply tfplan
cd /home/atomoh/awsops
```

- [ ] **Step 3: provision (1st run = CREATE) with smoke** (controller; image build + AgentCore create)
```bash
cd /home/atomoh/awsops
make agentcore SMOKE=1
```
Expected report: 9× `gateway:* CREATED` (incl. `gateway:external-obs`), `target:iam-mcp-target CREATED 14 tools`, `target:flow-monitor-target CREATED 1 tools`, `memory CREATED`, `interpreter CREATED`, `runtime CREATED`, 3× `ssm:* WROTE`, and `smoke OK` (runtime → security gateway → `list_roles` → real IAM role names in the body). `0 errors`.

- [ ] **Step 4: idempotency — 2nd run is a clean no-op**
```bash
cd /home/atomoh/awsops
python3 scripts/v2/agentcore/provision.py
```
Expected: every line `EXISTS` (9 gateways, 2 targets, memory, interpreter) and `runtime UPDATED` (update path re-passes roleArn+networkConfiguration — proves the v1 quirk is handled, NOT a ConflictException). SSM `WROTE` (overwrite is idempotent). `0 errors`.

- [ ] **Step 5: drift reconciliation — the path v1 never had** (mutate one target's schema → expect UPDATED, then revert)
```bash
cd /home/atomoh/awsops/scripts/v2/agentcore
# temporarily drop one tool from the iam-mcp slice to force schema drift
python3 - <<'PY'
import re,io
s=open('catalog.py').read()
s2=s.replace('            {"name": "get_account_security_summary", "description": "Account security summary", "inputSchema": {"type": "object", "properties": {}}},\n','',1)
open('catalog.py','w').write(s2)
print('dropped 1 tool (14 -> 13) to simulate drift')
PY
cd /home/atomoh/awsops && python3 scripts/v2/agentcore/provision.py 2>&1 | grep -E "target:iam"
git checkout scripts/v2/agentcore/catalog.py   # revert the mutation
python3 scripts/v2/agentcore/provision.py 2>&1 | grep -E "target:iam"   # re-sync back to 14
```
Expected: first run prints `target:iam-mcp-target UPDATED 13 tools (schema drift)` (in-place update, NOT EXISTS, NOT ConflictException, NOT ERR); after revert prints `UPDATED 14 tools (schema drift)`. This proves the Gateway-Target drift path that v1 silently skipped.

- [ ] **Step 6: independent verification of the skeleton**
```bash
REGION=ap-northeast-2
aws bedrock-agentcore-control list-gateways --region $REGION --query "items[?contains(name,'awsops-')].name" --output text
aws ssm get-parameter --name /awsops-v2/agentcore/runtime_arn --region $REGION --query Parameter.Value --output text
aws ssm get-parameter --name /awsops-v2/agentcore/memory_id --region $REGION --query Parameter.Value --output text
terraform -chdir=terraform/foundation output -json agentcore | python3 -c "import json,sys; d=json.load(sys.stdin); print('lambda_arns:', list(d['lambda_arns'].keys()))"
```
Expected: 9 gateway names incl. `awsops-external-obs-gateway`; runtime ARN (not `PENDING`); memory id (not `PENDING`); `lambda_arns: ['iam-mcp', 'flow-monitor']`.

- [ ] **Step 7: commit + update memory**
```bash
cd /home/atomoh/awsops
git add -A && git commit -m "feat(v2-p1f): provision AgentCore skeleton — 9 gateways(#7 empty)+runtime+memory+interpreter+slice, idempotent+drift+smoke GREEN" --allow-empty
```
Then update `/home/atomoh/.claude/projects/-home-atomoh-awsops/memory/awsops-v2-effort.md`: mark **P1f DONE** (MID-minus: provisioner + 9 gateways[#7 empty] + runtime/memory/interpreter + iam-mcp/flow-monitor slice + SSM config + web task-role grant; idempotency + drift-reconcile + Runtime-re-pass + SSM→runtime→gateway smoke all GREEN). Record the **P3 carry-over**: full Lambda fleet + ≤25 curation + section=routing + UI + #7 plugin registry/OTLP/datasource-diag re-home; VPC Lambdas (istio/steampipe-query) blocked on v2 Steampipe; reachability blocked on ADR-029 v2 gate; Incident orchestrator → P4. Note any API-shape deltas found in Step 2 (e.g. `environmentVariables` name).

---

## Self-Review

**Spec coverage:**
- §8 "AgentCore CLI/boto3 수동 → 선언적 catalog + 멱등 provisioner" → `catalog.py` + `provision.py` list→create/update (A3/A4) ✓
- §8 "06e config.json ARN 손주입 → Terraform output → SSM/Secrets → 런타임 read" → SSM String params + `provision.py write_ssm` + web task-role grant (A1/A4) ✓
- §8 "작은 멱등 provisioner, null_resource+raw 지양" → post-apply Python module, TF owns only ECR/IAM/Lambda/SSM (A1/A2/A5) ✓
- §8 "3-명령: configure → apply → make ..." → `make configure` toggle (A6) + `terraform apply` (A7) + `make agentcore` (A5) ✓
- §4 "9 Gateway (Monitoring→AWS Monitoring + External Observability 분리)" → 9 gateways incl. `external-obs` empty (A3); Monitoring=AWS-native (datasource-diag deferred) ✓
- §4 "≤~25 도구/agent, 정확한 수는 재설계(P3) 시 확정" → slice only; full curation = P3 non-goal ✓
- AgentCore quirks (root CLAUDE.md): boto3 for targets (not CLI) ✓; arm64 image ✓; underscore-only Runtime/Memory/Interpreter names ✓; Runtime update re-passes role-arn+network-config ✓; Memory eventExpiryDuration=365 ✓; `credentialProviderConfigurations=[GATEWAY_IAM_ROLE]` ✓; target_account_id injection ✓
- 3-AI review action items: MID-minus ✓; (A)/Python ✓; SSM String + BFF/task-role read (not execution valueFrom → no race) ✓; reuse agent.py + arm64 + orchestrator→P4 ✓; GREEN = 2×no-op + drift re-run + Runtime re-pass + SSM→runtime→gateway smoke ✓; least-priv Gateway role (scoped lambda:InvokeFunction) + read-only Lambda role ✓; non-goals documented ✓

**Placeholder scan:** none. All HCL/Python/JS is concrete; tool schemas are copied verbatim from `create_targets.py`; the one API-shape uncertainty (`environmentVariables`) is called out with a confirm step (A7 Step 2) and a fallback, not left as TODO.

**Type/name consistency:** `var.agentcore_enabled` (bool) ← `configure.mjs` `agentcore_enabled = true`; `local.ac_count`/`local.agent_lambdas` gate every resource; output `agentcore.lambda_arns` keys (`iam-mcp`,`flow-monitor`) == `catalog.TARGETS[*].lambda_key` == `local.agent_lambdas` keys; `aws_iam_role.task` (P1d) is the SSM-grant principal; `aws_iam_role.agentcore` is `roleArn` for gateways+runtime; SSM names `/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}` consistent across `ai.tf` output, `provision.py write_ssm`, and A7 verify; gateway names `awsops-<key>-gateway` consistent (`ensure_gateways` ↔ A7 verify ↔ agent.py discovery); image tag `agent-latest` consistent (`agentcore.mjs` ↔ `provision.py` artifact). Fixed inline during review: `ensure_gateways` builds the name as a plain `f"awsops-{key}-gateway"` (an earlier draft had a dead ternary).

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-31-awsops-v2-p1f-agentcore-provisioner.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task A1–A6 (code + validate + commit), two-stage review between tasks. **A7 (apply + `make agentcore` + AgentCore create + smoke) is long/shared-infra → the CONTROLLER runs it**, not a subagent.

**2. Inline Execution** — execute A1–A7 in this session with checkpoints.

**Which approach?**
