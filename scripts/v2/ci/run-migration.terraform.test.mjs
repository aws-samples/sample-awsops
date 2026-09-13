import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));

test('real migration Terraform plans: default off, private ARM64 task and exact runtime secret/KMS grants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-tf-'));
  try {
    // Test the real owned file against a small provider-backed fixture of its
    // existing dependencies. Every provider is mocked; no backend or AWS call.
    await copyFile(join(root, 'terraform/foundation/ci-migrations.tf'), join(dir, 'ci-migrations.tf'));
    await copyFile(join(root, 'terraform/foundation/.terraform.lock.hcl'), join(dir, '.terraform.lock.hcl'));
    await writeFile(join(dir, 'fixture.tf'), `
terraform {
  required_version = "= 1.15.7"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}
provider "aws" { region = var.region }
variable "project" { default = "awsops-v2-dev" }
variable "region" { default = "ap-northeast-2" }
variable "agentcore_enabled" { default = false }
locals {
  ac_count = var.agentcore_enabled ? 1 : 0
  private_subnet_ids = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
}
data "aws_caller_identity" "current" {}
resource "aws_kms_key" "aurora" {}
resource "aws_rds_cluster" "aurora" {
  cluster_identifier = "awsops-v2-dev-aurora"
  engine = "aurora-postgresql"
  database_name = "awsops"
}
resource "aws_secretsmanager_secret" "agent_sql_reader" {
  count = local.ac_count
  name = "ops/awsops-v2-dev/agent/sql-reader"
}
resource "aws_ecr_repository" "web" { name = "awsops-v2-dev-web" }
resource "aws_iam_role" "execution" {
  name = "awsops-v2-dev-task-execution"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [] })
}
resource "aws_ecs_cluster" "main" { name = "awsops-v2-dev" }
resource "aws_security_group" "service" { name = "awsops-v2-dev-service" }
`);
    await copyFile(new URL('./run-migration.tftest.hcl', import.meta.url), join(dir, 'migration.tftest.hcl'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      !/^(AWS_|GH_TOKEN$|GITHUB_TOKEN$|TF_VAR_|TF_CLI_ARGS|TF_DATA_DIR$|TF_WORKSPACE$|TF_LOG|TF_REATTACH_PROVIDERS$)/.test(k)));
    Object.assign(env, {
      TF_DATA_DIR: join(dir, '.terraform'), CHECKPOINT_DISABLE: '1',
      AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    });
    for (const args of [
      ['init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color'],
      ['validate', '-no-color'], ['test', '-no-color'],
    ]) {
      const result = execFileSync('terraform', args, { cwd: dir, env, timeout: 120_000, encoding: 'utf8', stdio: 'pipe' });
      if (args[0] === 'test') assert.match(result, /Success! 3 passed, 0 failed/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
