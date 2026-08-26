# AWSops v2 — P1c: Aurora Serverless v2 + Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (auto plan+apply). Steps use checkbox (`- [ ]`).

**Goal:** Provision the v2 application-state database — **Aurora Serverless v2 (PostgreSQL)** in the reused `mgmt-vpc` private subnets, encrypted, app-only access on 5432 — and apply the **7-table ADR-030 schema** (reusing v1's `infra-cdk/data/schema.sql`). The real app consumes the connection in P1d; P1c only provisions + migrates.

**Architecture:** Ports v1's `infra-cdk/lib/awsops-data-stack.ts` (ADR-030 Phase 1) to Terraform in the `terraform/foundation/` module. Master credentials via **RDS-managed Secrets Manager secret** (`manage_master_user_password`), KMS-encrypted storage, SG ingress on 5432 from the app/Fargate service SG (+ VPC CIDR for in-VPC migration from the deploy host). Schema applied with `psql` from the deploy host (which lives in `mgmt-vpc`).

**Tech Stack:** Terraform `>= 1.15`, AWS provider `~> 6.0`, Aurora PostgreSQL (Serverless v2), Secrets Manager (RDS-managed), KMS, `psql` (PostgreSQL client) for the migration.

**Builds on P1a/P1b:** foundation module with `local.vpc_id`, `local.private_subnet_ids`, `local.vpc_cidr` (mgmt-vpc reuse) and `aws_security_group.service` (the Fargate app SG).

---

## File Structure
```
terraform/foundation/
  data.tf                 # KMS, secret(managed), subnet group, SG, Aurora cluster + writer instance
  data/schema.sql         # 7-table schema (copied from infra-cdk/data/schema.sql — v2 owns its copy)
  variables.tf            # (MODIFY) add aurora_engine_version, aurora_min_acu, aurora_max_acu
  outputs.tf              # (MODIFY) aurora_endpoint, aurora_secret_arn, aurora_database
```

---

## Task C1: Aurora Serverless v2 cluster (Terraform)

**Files:** Create `terraform/foundation/data.tf`; Modify `variables.tf`, `outputs.tf`.

- [ ] **Step 1: add variables to `variables.tf`**
```hcl
variable "aurora_engine_version" {
  type        = string
  description = "Aurora PostgreSQL engine version (must be an available Serverless v2 version). Verify via describe-db-engine-versions."
  default     = "15.10"
}
variable "aurora_min_acu" {
  type    = number
  default = 0.5
}
variable "aurora_max_acu" {
  type    = number
  default = 4
}
```

- [ ] **Step 2: write `data.tf`**
```hcl
resource "aws_kms_key" "aurora" {
  description             = "${var.project} Aurora storage + master-secret encryption"
  deletion_window_in_days = 7
}

resource "aws_kms_alias" "aurora" {
  name          = "alias/${var.project}-aurora"
  target_key_id = aws_kms_key.aurora.key_id
}

resource "aws_db_subnet_group" "aurora" {
  name       = "${var.project}-aurora"
  subnet_ids = local.private_subnet_ids
}

resource "aws_security_group" "aurora" {
  name        = "${var.project}-aurora-sg"
  description = "Aurora — app/Fargate + in-VPC migration on 5432"
  vpc_id      = local.vpc_id

  ingress {
    description     = "App/Fargate tasks -> Aurora"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
  ingress {
    description = "In-VPC migration (deploy host)"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [local.vpc_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier            = "${var.project}-aurora"
  engine                        = "aurora-postgresql"
  engine_mode                   = "provisioned"
  engine_version                = var.aurora_engine_version
  database_name                 = "awsops"
  master_username               = "awsops_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.aurora.key_id
  storage_encrypted             = true
  kms_key_id                    = aws_kms_key.aurora.arn
  db_subnet_group_name          = aws_db_subnet_group.aurora.name
  vpc_security_group_ids        = [aws_security_group.aurora.id]
  backup_retention_period       = 7
  deletion_protection           = false # dev; set true for prod
  skip_final_snapshot           = true  # dev; set false + final_snapshot_identifier for prod

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_acu
    max_capacity = var.aurora_max_acu
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "${var.project}-aurora-1"
  cluster_identifier = aws_rds_cluster.aurora.id
  engine             = aws_rds_cluster.aurora.engine
  engine_version     = aws_rds_cluster.aurora.engine_version
  instance_class     = "db.serverless"
}
```

- [ ] **Step 3: add outputs to `outputs.tf`**
```hcl
output "aurora_endpoint"    { value = aws_rds_cluster.aurora.endpoint }
output "aurora_database"    { value = aws_rds_cluster.aurora.database_name }
output "aurora_secret_arn"  { value = aws_rds_cluster.aurora.master_user_secret[0].secret_arn }
```

- [ ] **Step 4: confirm an available engine version, then validate + apply**
```bash
cd terraform/foundation
# Confirm the default 15.10 is a real Serverless-v2-capable Aurora PG version; if not, pick one:
aws rds describe-db-engine-versions --engine aurora-postgresql --region ap-northeast-2 \
  --query "DBEngineVersions[?contains(SupportedEngineModes,'provisioned')].EngineVersion" --output text | tr '\t' '\n' | grep '^15\.' | tail -5
# If 15.10 is NOT listed, add e.g. `aurora_engine_version = "15.x"` (a listed one) to terraform.tfvars.
terraform fmt && terraform validate && terraform plan -out tfplan && terraform apply tfplan
```
Expected: KMS key+alias, subnet group, SG, RDS cluster + 1 serverless instance, RDS-managed master secret. **Cluster create takes ~10–15 min.** NO vpc/subnet/nat changes.

- [ ] **Step 5: verify + commit**
```bash
terraform output aurora_endpoint
aws rds describe-db-clusters --db-cluster-identifier awsops-v2-aurora --region ap-northeast-2 --query 'DBClusters[0].Status' --output text
git add terraform/foundation/data.tf terraform/foundation/variables.tf terraform/foundation/outputs.tf
git commit -m "feat(v2-p1c): Aurora Serverless v2 cluster (KMS, managed secret, app-only SG)"
```
Expected: endpoint printed; cluster status `available`.

---

## Task C2: Apply the 7-table schema

**Files:** Create `terraform/foundation/data/schema.sql` (copy of v1's).

- [ ] **Step 1: copy v1 schema into the v2 module (v2 owns its copy)**
```bash
mkdir -p terraform/foundation/data
cp infra-cdk/data/schema.sql terraform/foundation/data/schema.sql
```
(The schema is idempotent — `CREATE TABLE IF NOT EXISTS` for `schema_migrations` + the 7 tables: `inventory_snapshots`, `cost_snapshots`, `agentcore_memory`, `agentcore_stats`, `alert_diagnosis`, `event_scaling_plans`, `report_schedules` + indexes.)

- [ ] **Step 2: ensure a PostgreSQL client is available** (deploy host is in mgmt-vpc → can reach Aurora)
```bash
command -v psql >/dev/null || sudo dnf install -y postgresql15 || sudo dnf install -y postgresql
psql --version
```

- [ ] **Step 3: fetch creds + endpoint, apply schema**
```bash
cd terraform/foundation
EP=$(terraform output -raw aurora_endpoint)
SECRET_ARN=$(terraform output -raw aurora_secret_arn)
CREDS=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --region ap-northeast-2 --query SecretString --output text)
PGUSER=$(echo "$CREDS" | python3 -c "import json,sys;print(json.load(sys.stdin)['username'])")
PGPW=$(echo "$CREDS" | python3 -c "import json,sys;print(json.load(sys.stdin)['password'])")
PGPASSWORD="$PGPW" psql "host=$EP port=5432 dbname=awsops user=$PGUSER sslmode=require" -v ON_ERROR_STOP=1 -f data/schema.sql
```
Expected: `CREATE TABLE` / `CREATE INDEX` output, no errors. (If the host can't reach Aurora, confirm the `aws_security_group.aurora` VPC-CIDR ingress + that the host is in `mgmt-vpc`.)

- [ ] **Step 4: verify the 7 tables exist**
```bash
PGPASSWORD="$PGPW" psql "host=$EP port=5432 dbname=awsops user=$PGUSER sslmode=require" -At \
  -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1;"
```
Expected (8 rows): `agentcore_memory, agentcore_stats, alert_diagnosis, cost_snapshots, event_scaling_plans, inventory_snapshots, report_schedules, schema_migrations`.

- [ ] **Step 5: commit**
```bash
git add terraform/foundation/data/schema.sql
git commit -m "feat(v2-p1c): apply 7-table ADR-030 schema to Aurora"
```

---

## Self-Review
**Spec coverage (design §7 Aurora state, ADR-030):** Aurora Serverless v2 + 7-table schema → C1+C2. ✓ Reuses mgmt-vpc private subnets (P1a `local.private_subnet_ids`), app-only SG (from `aws_security_group.service`). ✓ Master creds via RDS-managed secret (P1d's app reads `aurora_secret_arn`). ✓
**Placeholder scan:** none. `aurora_engine_version` default `15.10` is verified/adjusted in C1 Step 4 (concrete command).
**Type/name consistency:** `aws_rds_cluster.aurora`, `aws_rds_cluster_instance.writer`, `aws_security_group.aurora`, `aws_db_subnet_group.aurora`, db name `awsops`, outputs `aurora_endpoint`/`aurora_secret_arn`/`aurora_database`. Consistent.
**Note:** `deletion_protection=false` + `skip_final_snapshot=true` are dev-friendly (easy teardown) — flip both for prod. The real app wiring (env `AURORA_*` / secret) is P1d.

## Execution Handoff
Subagent-driven, auto plan+apply. C1 (cluster create) is slow (~10–15 min). C2 (schema via psql from the in-VPC deploy host) is fast.
