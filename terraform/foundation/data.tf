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
  description = "Aurora - app/Fargate + in-VPC migration on 5432"
  vpc_id      = local.vpc_id

  ingress {
    description     = "App/Fargate tasks to Aurora"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
  # Steampipe FDW task reads accounts ⋈ account_regions at boot to generate aws.spc (gated on
  # steampipe_enabled via local.sp). In-place ingress add — the SG description is unchanged.
  dynamic "ingress" {
    for_each = local.sp > 0 ? [1] : []
    content {
      description     = "Steampipe FDW task to Aurora (multi-account fan-out)"
      from_port       = 5432
      to_port         = 5432
      protocol        = "tcp"
      security_groups = [aws_security_group.steampipe[0].id]
    }
  }
  dynamic "ingress" {
    for_each = var.allow_vpc_db_access ? [1] : []
    content {
      description = "In-VPC migration (deploy host) - dev only"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [local.vpc_cidr]
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier          = "${var.project}-aurora"
  engine                      = "aurora-postgresql"
  engine_mode                 = "provisioned"
  engine_version              = var.aurora_engine_version
  allow_major_version_upgrade = true # required for 15.x→17 major bump (default param groups → no param-group work)
  apply_immediately           = true # perform the major-upgrade reboot synchronously, not deferred to a maintenance window
  database_name               = "awsops"
  master_username             = "awsops_admin"
  manage_master_user_password = true
  # RDS Data API (HTTP endpoint): lets the read-only inventory-read MCP Lambda query the synced
  # inventory without a VPC attachment or pg8000 bundling. In-place enable (no reboot/replace).
  enable_http_endpoint          = true
  # IAM database authentication: lets long-running Fargate tasks connect via a short-lived
  # STS-signed auth token (rds-db:connect) instead of the Aurora master secret. The master secret
  # is RDS-managed and auto-rotates every 7 days; a task that only reads it once at container
  # start (secrets/valueFrom) is left holding a stale password after the next rotation — every
  # Postgres-backed route then fails with "password authentication failed" until the task happens
  # to be replaced. Two consumers today, both dedicated least-privilege roles, no shared password:
  # Steampipe's boot-time generator (`steampipe_reader`, M1 fix) and the web BFF (`awsops_web`).
  # In-place enable, no reboot/replace. Unconditional now that web depends on it too.
  iam_database_authentication_enabled = true
  master_user_secret_kms_key_id = aws_kms_key.aurora.key_id
  storage_encrypted             = true
  kms_key_id                    = aws_kms_key.aurora.arn
  db_subnet_group_name          = aws_db_subnet_group.aurora.name
  vpc_security_group_ids        = [aws_security_group.aurora.id]
  backup_retention_period       = 7
  deletion_protection           = false
  skip_final_snapshot           = true

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_acu
    max_capacity = var.aurora_max_acu
  }

  # A major upgrade is a deliberate, exact-version action (bump var.aurora_engine_version
  # to a verified target + a fresh apply). Absorb AWS auto-MINOR upgrades (17.x→17.y) so
  # they never surface as Terraform drift. (Major-only "17" pinning mis-fires on
  # aws_rds_cluster — the provider's prefix diff-suppress is fixed only for aws_db_instance.)
  lifecycle {
    ignore_changes = [engine_version]
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "${var.project}-aurora-1"
  cluster_identifier = aws_rds_cluster.aurora.id
  engine             = aws_rds_cluster.aurora.engine
  engine_version     = aws_rds_cluster.aurora.engine_version
  instance_class     = "db.serverless"

  # Instance follows the cluster engine version; ignore minor auto-upgrades like the cluster.
  lifecycle {
    ignore_changes = [engine_version]
  }
}
