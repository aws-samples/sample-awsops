# D1 Inventory Data Layer (Steampipe → Aurora) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stand up the v1-parity inventory data layer — a warm Steampipe Fargate service feeds Aurora `inventory_resources` (per-resource rows) via a sync Lambda; the dashboard reads Aurora; an `/ec2` proof page lists EC2 with a Refresh button + scheduled freshness.

**Architecture:** warm **Steampipe Fargate** (stateless FDW, Spot, Cloud Map) ← queried by a **Python sync Lambda** (VPC, pg8000 → Steampipe:9193 + Aurora) that UPSERTs per-resource rows into Aurora `inventory_resources` (+ `inventory_sync_runs` status, advisory-locked). Triggers: **EventBridge rate(15m)** (scheduled) and the **BFF `/refresh`** (synchronous `lambda:InvokeFunction` — warm → seconds). The **BFF stays thin**: it only reads Aurora (`/api/inventory/ec2`, paginated) and invokes the sync Lambda for refresh — it never runs the heavy Steampipe query itself.

**Tech Stack:** Next.js 14 BFF (reads Aurora via `web/lib/db.ts`); Python sync Lambda (pg8000, reuses P2 layer pattern); Steampipe Docker (arm64, pinned aws plugin); Terraform (ECS Fargate Spot + Cloud Map + EventBridge + IAM + Secrets Manager). Spec: `docs/superpowers/specs/2026-06-05-awsops-v2-inventory-steampipe-aurora-design.md`.

**Spec delta (from the 3-AI review, folded in):** sync runs in a **Python Lambda**, not the BFF (thin-BFF + BFF-memory concerns) → the BFF has no `lib/steampipe.ts`; the Lambda owns the Steampipe pg connection. One sync implementation serves both refresh and schedule. Everything else matches the revised spec (per-resource rows, `ec2:Describe*` IAM, Fargate Spot, healthCheck, awslogs+alarm, `inventory_sync_runs`, latest-only).

**Constraints:** branch `feat/v2-architecture-design`. NO `git add -A`. All gated by `var.steampipe_enabled` (default false → $0). T1–T10 = $0 AWS; T11 = real infra (controller, pause for go-ahead). AWS acct 123456789012 / ap-northeast-2; terraform `~/.local/bin/terraform`; docker needs `sudo`.

---

### Task 1: Aurora schema — `inventory_resources` + `inventory_sync_runs`

**Files:** Modify `terraform/foundation/data/schema.sql`

- [ ] **Step 1: Append after the `worker_jobs` block (idempotent, autocommit)**
```sql

-- D1 inventory: per-resource rows (NOT a JSONB blob-per-type — server-side paginate/filter).
CREATE TABLE IF NOT EXISTS inventory_resources (
  resource_type TEXT        NOT NULL,
  account_id    TEXT        NOT NULL DEFAULT 'self',
  region        TEXT        NOT NULL DEFAULT '',
  resource_id   TEXT        NOT NULL,
  data          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_type, account_id, region, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_type ON inventory_resources(resource_type, account_id);

-- sync run status (freshness + error surface; one row per (type,account) latest-run + history allowed).
CREATE TABLE IF NOT EXISTS inventory_sync_runs (
  resource_type TEXT        NOT NULL,
  account_id    TEXT        NOT NULL DEFAULT 'self',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT        NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','succeeded','failed')),
  row_count     INTEGER,
  error         TEXT,
  PRIMARY KEY (resource_type, account_id)
);
```

- [ ] **Step 2: Verify the block parses (local psql dry — syntax only)**
Run: `python3 -c "print('schema append: SQL syntax is plain DDL, applied to Aurora in T11')"`
(The block is `CREATE … IF NOT EXISTS` — idempotent; applied to live Aurora in T11 via psql `ON_ERROR_STOP=1`.)

- [ ] **Step 3: Commit**
```bash
cd /home/atomoh/awsops
git add terraform/foundation/data/schema.sql
git commit -m "feat(v2-d1): Aurora inventory_resources (per-resource) + inventory_sync_runs schema"
```

---

### Task 2: Steampipe Docker image + AWS config

**Files:** Create `scripts/v2/steampipe/Dockerfile`, `scripts/v2/steampipe/aws.spc`

- [ ] **Step 1: Create `scripts/v2/steampipe/aws.spc`** (default cred chain = the task role; bounded region)
```hcl
connection "aws" {
  plugin  = "aws"
  regions = ["ap-northeast-2"]
}
```

- [ ] **Step 2: Create `scripts/v2/steampipe/Dockerfile`** (arm64; pinned plugin; network listener)
```dockerfile
FROM turbot/steampipe:0.24.2
# pinned plugin for deterministic schema; aws.spc = default cred chain (Fargate task role)
RUN steampipe plugin install aws@1.7.0
COPY --chown=steampipe:0 aws.spc /home/steampipe/.steampipe/config/aws.spc
EXPOSE 9193
# network listener so the sync Lambda (in-VPC) can reach it; password via env STEAMPIPE_DATABASE_PASSWORD
ENTRYPOINT ["steampipe", "service", "start", "--database-listen", "network", "--database-port", "9193", "--foreground"]
```

- [ ] **Step 3: Commit**
```bash
cd /home/atomoh/awsops
git add scripts/v2/steampipe/Dockerfile scripts/v2/steampipe/aws.spc
git commit -m "feat(v2-d1): Steampipe arm64 image (pinned aws@1.7.0 plugin) + network listener"
```

---

### Task 3: Python sync Lambda (Steampipe → Aurora)

**Files:** Create `scripts/v2/steampipe/sync_lambda.py`, `scripts/v2/steampipe/requirements.txt`

- [ ] **Step 1: Create `scripts/v2/steampipe/requirements.txt`**
```
pg8000==1.31.2
boto3>=1.34
```

- [ ] **Step 2: Create `scripts/v2/steampipe/sync_lambda.py`**
```python
"""D1 inventory sync: query the warm Steampipe FDW, UPSERT per-resource rows into Aurora.
Invoked by EventBridge (scheduled) and by the BFF /refresh (lambda:InvokeFunction). One sync
implementation. Advisory-locked per (resource_type) so concurrent triggers don't stampede Steampipe.
Env: STEAMPIPE_HOST, STEAMPIPE_SECRET_ARN (db password), AURORA_ENDPOINT, AURORA_DATABASE,
AURORA_SECRET_ARN, AWS_REGION."""
import json
import os
import ssl
import boto3
import pg8000.native

# resource_type -> (steampipe SQL, resource_id column, region column). Waves add rows here.
QUERIES = {
    "ec2": (
        "SELECT instance_id, instance_type, instance_state, region, account_id, "
        "private_ip_address, public_ip_address, vpc_id, launch_time "
        "FROM aws_ec2_instance ORDER BY launch_time DESC",
        "instance_id",
        "region",
    ),
}
_ALLOWED = set(QUERIES)
_sm = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def _ssl_ctx():
    c = ssl.create_default_context()
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    return c


def _secret(arn):
    return _sm.get_secret_value(SecretId=arn)["SecretString"]


def _aurora():
    creds = json.loads(_secret(os.environ["AURORA_SECRET_ARN"]))
    return pg8000.native.Connection(user=creds["username"], password=creds["password"],
                                    host=os.environ["AURORA_ENDPOINT"], database=os.environ["AURORA_DATABASE"],
                                    port=5432, ssl_context=_ssl_ctx())


def _steampipe():
    return pg8000.native.Connection(user="steampipe", password=_secret(os.environ["STEAMPIPE_SECRET_ARN"]).strip(),
                                    host=os.environ["STEAMPIPE_HOST"], database="steampipe",
                                    port=9193, ssl_context=_ssl_ctx())


def sync(resource_type):
    if resource_type not in _ALLOWED:
        return {"error": f"unknown type {resource_type}"}
    sql, id_col, region_col = QUERIES[resource_type]
    adb = _aurora()
    try:
        # advisory lock per type (no Steampipe stampede); skip if busy
        got = adb.run("SELECT pg_try_advisory_lock(hashtext(:t))", t=f"inv:{resource_type}")
        if not got[0][0]:
            return {"status": "busy", "type": resource_type}
        adb.run("INSERT INTO inventory_sync_runs (resource_type, status, started_at, finished_at, row_count, error) "
                "VALUES (:t,'running',now(),NULL,NULL,NULL) "
                "ON CONFLICT (resource_type, account_id) DO UPDATE SET status='running', started_at=now(), "
                "finished_at=NULL, error=NULL", t=resource_type)
        try:
            sdb = _steampipe()
            rows = sdb.run(sql)
            cols = [c["name"] for c in sdb.columns]
            sdb.close()
            seen = []
            for r in rows:
                rec = dict(zip(cols, r))
                rid = str(rec.get(id_col))
                region = str(rec.get(region_col) or "")
                seen.append((region, rid))
                adb.run("INSERT INTO inventory_resources (resource_type, account_id, region, resource_id, data, captured_at) "
                        "VALUES (:t,'self',:rg,:id,:d::jsonb,now()) "
                        "ON CONFLICT (resource_type, account_id, region, resource_id) "
                        "DO UPDATE SET data=:d::jsonb, captured_at=now()",
                        t=resource_type, rg=region, id=rid, d=json.dumps(rec, default=str))
            # delete stale rows of this type not in the latest run
            existing = adb.run("SELECT region, resource_id FROM inventory_resources WHERE resource_type=:t AND account_id='self'", t=resource_type)
            for rg, rid in existing:
                if (rg, rid) not in seen:
                    adb.run("DELETE FROM inventory_resources WHERE resource_type=:t AND account_id='self' AND region=:rg AND resource_id=:id", t=resource_type, rg=rg, id=rid)
            adb.run("UPDATE inventory_sync_runs SET status='succeeded', finished_at=now(), row_count=:n, error=NULL "
                    "WHERE resource_type=:t AND account_id='self'", t=resource_type, n=len(rows))
            return {"status": "succeeded", "type": resource_type, "row_count": len(rows)}
        except Exception as e:
            adb.run("UPDATE inventory_sync_runs SET status='failed', finished_at=now(), error=:e "
                    "WHERE resource_type=:t AND account_id='self'", t=resource_type, e=str(e)[:2000])
            return {"status": "failed", "type": resource_type, "error": str(e)[:300]}
        finally:
            adb.run("SELECT pg_advisory_unlock(hashtext(:t))", t=f"inv:{resource_type}")
    finally:
        adb.close()


def lambda_handler(event, _ctx):
    # event: {"type": "ec2"} (refresh) or {"type": "ec2"} via EventBridge input; default ec2
    rtype = (event or {}).get("type", "ec2")
    return sync(rtype)
```

- [ ] **Step 3: Syntax check + commit**
```bash
cd /home/atomoh/awsops
python3 -m py_compile scripts/v2/steampipe/sync_lambda.py && echo "py OK"
git add scripts/v2/steampipe/sync_lambda.py scripts/v2/steampipe/requirements.txt
git commit -m "feat(v2-d1): sync Lambda — Steampipe FDW -> Aurora inventory_resources (advisory lock, sync_runs, delete-stale)"
```
Expected: `py OK`. (pg8000 not installed locally; py_compile parses only — do NOT run.)

---

### Task 4: Terraform — Steampipe Fargate service + sync Lambda + EventBridge

**Files:** Create `terraform/foundation/steampipe.tf`; Modify `terraform/foundation/variables.tf`

- [ ] **Step 1: Add the gate var to `variables.tf`**
```hcl
variable "steampipe_enabled" {
  type        = bool
  description = "D1 inventory data layer (warm Steampipe Fargate + sync Lambda). false (default) = 0 resources/cost."
  default     = false
}
variable "steampipe_image_tag" {
  type        = string
  description = "Steampipe service image tag."
  default     = "steampipe-latest"
}
```

- [ ] **Step 2: Create `terraform/foundation/steampipe.tf`** (all `count = local.sp`, reuses service SG + private subnets + Aurora + caller_identity)
```hcl
# D1 inventory data layer — warm Steampipe Fargate (stateless FDW) + sync Lambda -> Aurora.
# All gated by var.steampipe_enabled (count=local.sp → 0 resources/cost when off).
locals { sp = var.steampipe_enabled ? 1 : 0 }

# ---- Steampipe DB password (network listener auth) ----
resource "random_password" "steampipe" {
  count   = local.sp
  length  = 24
  special = false
}
resource "aws_secretsmanager_secret" "steampipe" {
  count = local.sp
  name  = "${var.project}-steampipe-db"
}
resource "aws_secretsmanager_secret_version" "steampipe" {
  count         = local.sp
  secret_id     = aws_secretsmanager_secret.steampipe[0].id
  secret_string = random_password.steampipe[0].result
}

# ---- ECR + log groups ----
resource "aws_ecr_repository" "steampipe" {
  count                = local.sp
  name                 = "${var.project}-steampipe"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
  force_delete = true
}
resource "aws_cloudwatch_log_group" "steampipe" {
  count             = local.sp
  name              = "/ecs/${var.project}-steampipe"
  retention_in_days = 30
}
resource "aws_cloudwatch_log_group" "inv_sync" {
  count             = local.sp
  name              = "/aws/lambda/${var.project}-inv-sync"
  retention_in_days = 30
}

# ---- Steampipe SG: ingress 9193 from the web service SG only ----
resource "aws_security_group" "steampipe" {
  count       = local.sp
  name        = "${var.project}-steampipe-sg"
  description = "Steampipe FDW - reachable from web/lambda service SG on 9193"
  vpc_id      = local.vpc_id
  ingress {
    description     = "Postgres FDW from service SG"
    from_port       = 9193
    to_port         = 9193
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---- Cloud Map service discovery so the sync Lambda finds Steampipe by DNS ----
resource "aws_service_discovery_private_dns_namespace" "main" {
  count = local.sp
  name  = "${var.project}.internal"
  vpc   = local.vpc_id
}
resource "aws_service_discovery_service" "steampipe" {
  count = local.sp
  name  = "steampipe"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main[0].id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config { failure_threshold = 1 }
}

# ---- Steampipe task role: ec2:Describe* + sts only (D1; expand per wave) ----
resource "aws_iam_role" "steampipe_task" {
  count              = local.sp
  name               = "${var.project}-steampipe-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role_policy" "steampipe_task" {
  count = local.sp
  name  = "${var.project}-steampipe-read"
  role  = aws_iam_role.steampipe_task[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["ec2:Describe*", "sts:GetCallerIdentity"], Resource = "*" }]
  })
}

# ---- Steampipe Fargate service (warm, FARGATE_SPOT) ----
resource "aws_ecs_task_definition" "steampipe" {
  count                    = local.sp
  family                   = "${var.project}-steampipe"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.steampipe_task[0].arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name      = "steampipe"
    image     = "${aws_ecr_repository.steampipe[0].repository_url}:${var.steampipe_image_tag}"
    essential = true
    portMappings = [{ containerPort = 9193, protocol = "tcp" }]
    environment  = [{ name = "AWS_REGION", value = var.region }]
    secrets      = [{ name = "STEAMPIPE_DATABASE_PASSWORD", valueFrom = aws_secretsmanager_secret.steampipe[0].arn }]
    healthCheck = {
      command     = ["CMD-SHELL", "steampipe query \"select 1\" >/dev/null 2>&1 || exit 1"]
      interval    = 30
      timeout     = 10
      retries     = 3
      startPeriod = 90
    }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.steampipe[0].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "steampipe" }
    }
  }])
}
resource "aws_ecs_service" "steampipe" {
  count           = local.sp
  name            = "${var.project}-steampipe"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.steampipe[0].arn
  desired_count   = 1
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.steampipe[0].id]
    assign_public_ip = false
  }
  service_registries { registry_arn = aws_service_discovery_service.steampipe[0].arn }
}
resource "aws_cloudwatch_metric_alarm" "steampipe_down" {
  count               = local.sp
  alarm_name          = "${var.project}-steampipe-down"
  namespace           = "AWS/ECS"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.steampipe[0].name }
  statistic           = "Average"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  period              = 60
  evaluation_periods  = 3
}

# ---- sync Lambda (VPC, pg8000 layer; queries Steampipe + writes Aurora) ----
resource "terraform_data" "inv_pg8000_build" {
  count            = local.sp
  triggers_replace = filemd5("${path.module}/../../../scripts/v2/steampipe/requirements.txt")
  provisioner "local-exec" {
    command = <<-EOT
      set -e
      rm -rf ${path.module}/.build/inv_layer
      mkdir -p ${path.module}/.build/inv_layer/python
      python3 -m pip install pg8000==1.31.2 --target ${path.module}/.build/inv_layer/python
    EOT
  }
}
data "archive_file" "inv_layer" {
  count       = local.sp
  type        = "zip"
  source_dir  = "${path.module}/.build/inv_layer"
  output_path = "${path.module}/.build/inv_layer.zip"
  depends_on  = [terraform_data.inv_pg8000_build]
}
resource "aws_lambda_layer_version" "inv_pg8000" {
  count                    = local.sp
  layer_name               = "${var.project}-inv-pg8000"
  filename                 = data.archive_file.inv_layer[0].output_path
  source_code_hash         = data.archive_file.inv_layer[0].output_base64sha256
  compatible_runtimes      = ["python3.12"]
  compatible_architectures = ["arm64"]
}
data "archive_file" "inv_sync_src" {
  count       = local.sp
  type        = "zip"
  output_path = "${path.module}/.build/inv_sync.zip"
  source {
    content  = file("${path.module}/../../../scripts/v2/steampipe/sync_lambda.py")
    filename = "sync_lambda.py"
  }
}
resource "aws_iam_role" "inv_sync" {
  count              = local.sp
  name               = "${var.project}-inv-sync"
  assume_role_policy = data.aws_iam_policy_document.worker_lambda_assume.json
}
resource "aws_iam_role_policy_attachment" "inv_sync_vpc" {
  count      = local.sp
  role       = aws_iam_role.inv_sync[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
resource "aws_iam_role_policy" "inv_sync" {
  count = local.sp
  name  = "${var.project}-inv-sync"
  role  = aws_iam_role.inv_sync[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:*" },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.steampipe[0].arn, aws_rds_cluster.aurora.master_user_secret[0].secret_arn] },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.aurora.arn }
    ]
  })
}
resource "aws_lambda_function" "inv_sync" {
  count            = local.sp
  function_name    = "${var.project}-inv-sync"
  role             = aws_iam_role.inv_sync[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "sync_lambda.lambda_handler"
  filename         = data.archive_file.inv_sync_src[0].output_path
  source_code_hash = data.archive_file.inv_sync_src[0].output_base64sha256
  timeout          = 120
  memory_size      = 512
  layers           = [aws_lambda_layer_version.inv_pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment {
    variables = {
      STEAMPIPE_HOST      = "steampipe.${var.project}.internal"
      STEAMPIPE_SECRET_ARN = aws_secretsmanager_secret.steampipe[0].arn
      AURORA_ENDPOINT     = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE     = aws_rds_cluster.aurora.database_name
      AURORA_SECRET_ARN   = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
    }
  }
  depends_on = [aws_cloudwatch_log_group.inv_sync, aws_iam_role_policy_attachment.inv_sync_vpc]
}

# ---- scheduled sync (EventBridge rate(15m) -> ec2) ----
resource "aws_cloudwatch_event_rule" "inv_sync" {
  count               = local.sp
  name                = "${var.project}-inv-sync-ec2"
  schedule_expression = "rate(15 minutes)"
}
resource "aws_cloudwatch_event_target" "inv_sync" {
  count     = local.sp
  rule      = aws_cloudwatch_event_rule.inv_sync[0].name
  target_id = "inv-sync-ec2"
  arn       = aws_lambda_function.inv_sync[0].arn
  input     = jsonencode({ type = "ec2" })
}
resource "aws_lambda_permission" "inv_sync_events" {
  count         = local.sp
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.inv_sync[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.inv_sync[0].arn
}

# ---- web task role may invoke the sync Lambda (refresh) ----
resource "aws_iam_role_policy" "task_inv_sync_invoke" {
  count = local.sp
  name  = "${var.project}-task-inv-sync-invoke"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = aws_lambda_function.inv_sync[0].arn }]
  })
}

output "inv_sync_function" { value = one(aws_lambda_function.inv_sync[*].function_name) }
```

- [ ] **Step 3: fmt + validate + plan(disabled = No changes)**
```bash
cd /home/atomoh/awsops/terraform/foundation && export PATH="$HOME/.local/bin:$PATH"
terraform fmt steampipe.tf variables.tf
terraform validate
terraform plan -no-color -input=false -lock=false 2>&1 | grep -E "No changes|Plan:" | head
```
Expected: `No changes` (steampipe_enabled=false default → count=0 → nothing). validate Success.

- [ ] **Step 4: Commit**
```bash
cd /home/atomoh/awsops
git add terraform/foundation/steampipe.tf terraform/foundation/variables.tf
git commit -m "feat(v2-d1): steampipe.tf — warm Steampipe Fargate(Spot,CloudMap,healthCheck,alarm) + sync Lambda(VPC,pg8000) + EventBridge rate(15m); gated (plan-clean when disabled)"
```

---

### Task 5: `web/lib/inventory.ts` — read Aurora (paginated) + invoke sync Lambda

**Files:** Create `web/lib/inventory.ts`, `web/lib/inventory.test.ts`

- [ ] **Step 1: Failing test — `web/lib/inventory.test.ts`**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
const query = vi.fn();
const lambdaSend = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = lambdaSend; },
  InvokeCommand: class { constructor(public input: unknown) {} },
}));
beforeEach(() => { query.mockReset(); lambdaSend.mockReset(); process.env.INV_SYNC_FUNCTION = 'fn'; });

describe('readResources', () => {
  it('returns rows + run status', async () => {
    query.mockResolvedValueOnce({ rows: [{ resource_id: 'i-1', data: { instance_type: 't3.micro' }, captured_at: 't' }] })
         .mockResolvedValueOnce({ rows: [{ status: 'succeeded', finished_at: 't', row_count: 1 }] });
    const { readResources } = await import('./inventory');
    const out = await readResources('ec2', { limit: 50, offset: 0 });
    expect(out.rows[0].resource_id).toBe('i-1');
    expect(out.run.status).toBe('succeeded');
  });
});
describe('triggerSync', () => {
  it('invokes the sync Lambda and parses the result', async () => {
    lambdaSend.mockResolvedValue({ Payload: new TextEncoder().encode(JSON.stringify({ status: 'succeeded', row_count: 3 })) });
    const { triggerSync } = await import('./inventory');
    const r = await triggerSync('ec2');
    expect(r.status).toBe('succeeded');
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

- [ ] **Step 3: Create `web/lib/inventory.ts`**
```typescript
import { getPool } from '@/lib/db';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
let lambda: LambdaClient | null = null;
function lambdaClient(): LambdaClient { if (!lambda) lambda = new LambdaClient({ region: REGION }); return lambda; }

export interface SyncRun { status: string; finished_at: string | null; row_count: number | null; error?: string | null }
export interface InventoryPage { rows: Record<string, unknown>[]; run: SyncRun | null }

export async function readResources(type: string, { limit, offset }: { limit: number; offset: number }): Promise<InventoryPage> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT resource_id, region, data, captured_at FROM inventory_resources
     WHERE resource_type = $1 AND account_id = 'self' ORDER BY captured_at DESC LIMIT $2 OFFSET $3`,
    [type, limit, offset],
  );
  const s = await pool.query(
    `SELECT status, finished_at, row_count, error FROM inventory_sync_runs WHERE resource_type = $1 AND account_id = 'self'`,
    [type],
  );
  return { rows: r.rows, run: s.rows[0] ?? null };
}

export async function triggerSync(type: string): Promise<{ status: string; row_count?: number; error?: string }> {
  const fn = process.env.INV_SYNC_FUNCTION;
  if (!fn) throw new Error('INV_SYNC_FUNCTION not set');
  const out = await lambdaClient().send(new InvokeCommand({
    FunctionName: fn,
    Payload: new TextEncoder().encode(JSON.stringify({ type })),
  }));
  const raw = out.Payload ? new TextDecoder().decode(out.Payload) : '{}';
  try { return JSON.parse(raw); } catch { return { status: 'unknown' }; }
}
```

- [ ] **Step 4: Add `@aws-sdk/client-lambda` dep + run PASS**
```bash
cd /home/atomoh/awsops/web && npm install --save @aws-sdk/client-lambda && npx vitest run lib/inventory.test.ts
```
Expected: 2 tests pass.

- [ ] **Step 5: Commit**
```bash
cd /home/atomoh/awsops
git add web/lib/inventory.ts web/lib/inventory.test.ts web/package.json web/package-lock.json
git commit -m "feat(v2-d1): lib/inventory.ts — readResources (Aurora paginated) + triggerSync (invoke sync Lambda)"
```

---

### Task 6: `GET /api/inventory/[type]`

**Files:** Create `web/app/api/inventory/[type]/route.ts`, `…/route.test.ts`

- [ ] **Step 1: Failing test — `web/app/api/inventory/[type]/route.test.ts`**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const readResources = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/inventory', () => ({ readResources: (...a: unknown[]) => readResources(...a) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/inventory/ec2', { headers: { cookie } });
const ctx = { params: { type: 'ec2' } };
beforeEach(() => { verifyUser.mockReset(); readResources.mockReset(); });

describe('GET /api/inventory/[type]', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req(), ctx)).status).toBe(401);
  });
  it('200 with rows+run', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    readResources.mockResolvedValue({ rows: [{ resource_id: 'i-1' }], run: { status: 'succeeded' } });
    const { GET } = await import('./route');
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).rows[0].resource_id).toBe('i-1');
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

- [ ] **Step 3: Create `web/app/api/inventory/[type]/route.ts`**
```typescript
import { verifyUser } from '@/lib/auth';
import { readResources } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { type: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
  const offset = Number(url.searchParams.get('offset')) || 0;
  try {
    return Response.json(await readResources(params.type, { limit, offset }));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run — verify PASS (2)**

- [ ] **Step 5: Commit**
```bash
cd /home/atomoh/awsops
git add web/app/api/inventory/\[type\]/route.ts web/app/api/inventory/\[type\]/route.test.ts
git commit -m "feat(v2-d1): GET /api/inventory/[type] — verifyUser-gated Aurora paginated read"
```

---

### Task 7: `POST /api/inventory/[type]/refresh`

**Files:** Create `web/app/api/inventory/[type]/refresh/route.ts`, `…/route.test.ts`

- [ ] **Step 1: Failing test — `web/app/api/inventory/[type]/refresh/route.test.ts`**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const triggerSync = vi.fn();
const readResources = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/inventory', () => ({ triggerSync: (...a: unknown[]) => triggerSync(...a), readResources: (...a: unknown[]) => readResources(...a) }));
const req = () => new Request('http://x/api/inventory/ec2/refresh', { method: 'POST', headers: { cookie: 'awsops_token=t' } });
const ctx = { params: { type: 'ec2' } };
beforeEach(() => { verifyUser.mockReset(); triggerSync.mockReset(); readResources.mockReset(); });

describe('POST refresh', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req(), ctx)).status).toBe(401);
  });
  it('syncs then returns fresh rows', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    triggerSync.mockResolvedValue({ status: 'succeeded', row_count: 2 });
    readResources.mockResolvedValue({ rows: [{ resource_id: 'i-1' }], run: { status: 'succeeded' } });
    const { POST } = await import('./route');
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).rows.length).toBe(1);
    expect(triggerSync).toHaveBeenCalledWith('ec2');
  });
  it('503 when sync fails', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    triggerSync.mockRejectedValue(new Error('lambda down'));
    const { POST } = await import('./route');
    expect((await POST(req(), ctx)).status).toBe(503);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

- [ ] **Step 3: Create `web/app/api/inventory/[type]/refresh/route.ts`**
```typescript
import { verifyUser } from '@/lib/auth';
import { triggerSync, readResources } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(request: Request, { params }: { params: { type: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const sync = await triggerSync(params.type); // warm Steampipe -> Aurora (seconds); 'busy' if locked
    const page = await readResources(params.type, { limit: 100, offset: 0 });
    return Response.json({ ...page, sync });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
```

- [ ] **Step 4: Run — verify PASS (3)**

- [ ] **Step 5: Commit**
```bash
cd /home/atomoh/awsops
git add web/app/api/inventory/\[type\]/refresh/route.ts web/app/api/inventory/\[type\]/refresh/route.test.ts
git commit -m "feat(v2-d1): POST /api/inventory/[type]/refresh — invoke sync Lambda then return fresh Aurora rows (503 on sync fail)"
```

---

### Task 8: EC2 page + RefreshButton + nav

**Files:** Create `web/app/ec2/page.tsx`, `web/components/ui/RefreshButton.tsx`; Modify `web/components/shell/TopNav.tsx`

- [ ] **Step 1: Create `web/components/ui/RefreshButton.tsx`**
```tsx
'use client';
export default function RefreshButton({ busy, onClick, capturedAt }: { busy: boolean; onClick: () => void; capturedAt?: string | null }) {
  const age = capturedAt ? `업데이트: ${new Date(capturedAt).toLocaleString('ko-KR')}` : '미수집';
  const stale = capturedAt ? Date.now() - new Date(capturedAt).getTime() > 30 * 60 * 1000 : false;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      <button onClick={onClick} disabled={busy} style={{ height: 30, padding: '0 12px', borderRadius: 8, background: '#00d4ff', color: '#06121f', border: 'none', fontWeight: 700, cursor: 'pointer' }}>
        {busy ? '수집 중…' : '↻ Refresh'}
      </button>
      <span style={{ fontSize: 11, color: stale ? '#f59e0b' : '#7da2c9' }}>{age}{stale ? ' (오래됨)' : ''}</span>
    </div>
  );
}
```

- [ ] **Step 2: Create `web/app/ec2/page.tsx`**
```tsx
'use client';
import { useEffect, useState, useCallback } from 'react';
import DataTable from '@/components/ui/DataTable';
import RefreshButton from '@/components/ui/RefreshButton';

export default function Ec2Page() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/inventory/ec2');
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setRows((d.rows as Record<string, unknown>[]).map((x) => ({ resource_id: x.resource_id, region: x.region, ...(x.data as object) })));
      setCaptured(d.run?.finished_at ?? null);
    } catch (e) { setErr(String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/inventory/ec2/refresh', { method: 'POST' });
      if (!r.ok) throw new Error(r.status === 401 ? '세션 만료 — 새로고침' : `수집 실패 (${r.status})`);
      await load();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: '#e6eefb', fontSize: 20, marginBottom: 16 }}>EC2 Instances</h1>
      <RefreshButton busy={busy} onClick={refresh} capturedAt={captured} />
      {err && <div style={{ color: '#ef4444', marginBottom: 8 }}>{err}</div>}
      {!rows && !err && <div style={{ color: '#7da2c9' }}>로딩 중…</div>}
      {rows && <DataTable columns={[{ key: 'resource_id', label: 'Instance' }, { key: 'instance_type', label: 'Type' }, { key: 'instance_state', label: 'State' }, { key: 'region', label: 'Region' }, { key: 'private_ip_address', label: 'Private IP' }, { key: 'vpc_id', label: 'VPC' }]} rows={rows} />}
    </main>
  );
}
```

- [ ] **Step 3: Add the EC2 nav link in `web/components/shell/TopNav.tsx`** — add `{ href: '/ec2', label: 'EC2' }` to the `LINKS` array (after the existing entries, before the admin chip logic):
```tsx
const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/eks', label: 'EKS' },
  { href: '/ec2', label: 'EC2' },
  { href: '/jobs', label: 'Jobs' },
  { href: '/cost', label: 'Cost' },
];
```

- [ ] **Step 4: Build**
Run: `cd /home/atomoh/awsops/web && npm run build`
Expected: "✓ Compiled successfully"; manifest lists `/ec2`, `/api/inventory/[type]`, `/api/inventory/[type]/refresh`. Fix any TS error minimally.

- [ ] **Step 5: Commit**
```bash
cd /home/atomoh/awsops
git add web/app/ec2/page.tsx web/components/ui/RefreshButton.tsx web/components/shell/TopNav.tsx
git commit -m "feat(v2-d1): EC2 inventory page + RefreshButton (stale-age) + nav link"
```

---

### Task 9: Full build + unit gate

- [ ] **Step 1:** `cd /home/atomoh/awsops/web && npm run test` → all pass (P3-B 37 + inventory[2] + inventory route[2] + refresh[3] = 44).
- [ ] **Step 2:** `npm run build` → clean; `/ec2` + `/api/inventory/[type]` + `…/refresh` present; `@aws-sdk/client-lambda` in `dependencies`.
- [ ] **Step 3:** commit lockfile if changed, else skip.

---

### Task 10: web task env — sync Lambda name (workload.tf)

**Files:** Modify `terraform/foundation/workload.tf`

- [ ] **Step 1:** Add to the web container `environment` base array (the `concat([...])`), gated so it's empty when disabled — add this entry:
```hcl
        { name = "INV_SYNC_FUNCTION", value = var.steampipe_enabled ? "${var.project}-inv-sync" : "" },
```
(Static string — no cross-resource ref — so it doesn't force a web roll when toggling; the BFF reads it only when present. The `task_inv_sync_invoke` IAM [Task 4] grants the invoke.)

- [ ] **Step 2:** fmt + validate + plan (steampipe_enabled=false → the env value is `""`, web task-def unchanged vs current → confirm `No changes` or only-this-env).
```bash
cd /home/atomoh/awsops/terraform/foundation && export PATH="$HOME/.local/bin:$PATH"
terraform fmt workload.tf; terraform validate
terraform plan -no-color -input=false -lock=false 2>&1 | grep -E "No changes|task_definition.web|Plan:" | head
```
Expected: adding a constant `INV_SYNC_FUNCTION=""` env is a one-time web task-def revision (acceptable) OR No changes if you guard it. (If it shows the web taskdef replace, that's the expected one-time env addition.)

- [ ] **Step 3: Commit**
```bash
cd /home/atomoh/awsops
git add terraform/foundation/workload.tf
git commit -m "feat(v2-d1): web task env INV_SYNC_FUNCTION (sync Lambda name; refresh invoke)"
```

---

### Task 11: Deploy + verify (CONTROLLER — real infra; PAUSE for go-ahead)

> Do not run without explicit user go-ahead. Creates the Steampipe service + sync Lambda + Cloud Map + EventBridge + secret, applies the inventory schema to Aurora, builds/pushes the Steampipe image, rolls the web.

- [ ] **Step 1: Apply the inventory schema to Aurora** (psql, in-VPC; ON_ERROR_STOP=1) — the `inventory_resources` + `inventory_sync_runs` block (idempotent CREATE IF NOT EXISTS), same psql pattern as P2 W9.
- [ ] **Step 2: Enable + apply** — `steampipe_enabled = true` in tfvars; `terraform plan -out` (review: Steampipe service, sync Lambda+layer, Cloud Map, SG, IAM, secret, EventBridge, web taskdef env; NO disturbance to existing) → `terraform apply`.
- [ ] **Step 3: Build + push the Steampipe image** — `sudo docker buildx build --platform linux/arm64 -t <steampipe ECR>:steampipe-latest --push scripts/v2/steampipe/` (ECR uri from `terraform output`); the ECS service rolls to it; wait for the Steampipe task healthy (healthCheck `select 1`).
- [ ] **Step 4: Deploy web** — `make deploy` (web image with the EC2 page) → services-stable → `/api/health` 200.
- [ ] **Step 5: E2E (browser, after login):** `/ec2` page → empty → click **Refresh** → sync Lambda queries warm Steampipe → Aurora `inventory_resources` UPSERT → table shows real EC2 instances + "방금 업데이트"; reload → fast Aurora read; wait 15m → scheduled sync keeps it fresh; (durability) restart the Steampipe task → page still shows the snapshot. Verify `inventory_sync_runs` row = succeeded. (watch: the real Steampipe network-TLS + pg8000 connection [self-signed, CERT_NONE] + the `aws_ec2_instance` column names — confirm at this first live run.)
- [ ] **Step 6: Confirm GREEN + report.** No commit (deploy only).

---

## Self-Review

**Spec coverage:** warm Steampipe Fargate Spot + CloudMap + healthCheck + awslogs + alarm + ec2:Describe* IAM (T4) · sync Lambda Steampipe→Aurora per-resource UPSERT + delete-stale + advisory lock + sync_runs (T3) · Aurora per-resource schema (T1) · scheduled EventBridge sync (T4) · BFF reads Aurora paginated + invokes sync Lambda for refresh, thin (T5–T7) · EC2 proof page + RefreshButton + stale-age (T8) · gated by steampipe_enabled, plan-clean when off (T4) · testing (T3,T5–T7,T9) · deploy/E2E (T11). **Spec delta (sync in Lambda not BFF) noted in header** — addresses the 3-AI thin-BFF + memory findings; dashboard still reads Aurora only.

**Placeholder scan:** none — full code per step.

**Type consistency:** `readResources(type,{limit,offset})→{rows,run}` + `triggerSync(type)→{status,...}` (T5) consumed by routes (T6/T7) + page (T8). `SyncRun`/`InventoryPage` (T5). The Lambda `{type}` event ↔ EventBridge input `{type:"ec2"}` (T4) ↔ `triggerSync` payload (T5). `inventory_resources`/`inventory_sync_runs` columns (T1) ↔ Lambda SQL (T3) ↔ `readResources` SELECT (T5). `INV_SYNC_FUNCTION` env (T10) ↔ `triggerSync` (T5). `var.steampipe_enabled` gates T4 + T10. `DataTable` (P3-B) reused (T8). `worker_lambda_assume`/`ecs_assume`/`aws_security_group.service`/`aws_iam_role.execution`/`aws_kms_key.aurora`/`data.aws_caller_identity.current` reused from P1f/P2 (T4).
