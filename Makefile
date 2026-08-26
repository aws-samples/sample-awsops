# AWSops v2 — deployment entrypoints (OSS-portable, consumer-facing).
#
# Prerequisites (must be on PATH):
#   - terraform >= 1.15   (S3 native state locking via use_lockfile)
#   - node >= 18          (configurator TUI)
#   - aws CLI (configured credentials for the target account)
#   - docker w/ buildx    (image build, later phases)
#
# Usage:
#   make configure   # interactive: pick VPC/domain → terraform.tfvars + backend.hcl
#   make help        # list targets

.DEFAULT_GOAL := help
.PHONY: help configure deps migrate migrate-status deploy upgrade agentcore workers

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

deps: ## Install node deps required by the configurator (idempotent; first run only)
	@[ -d scripts/v2/node_modules/@inquirer/prompts ] || npm ci --prefix scripts/v2

configure: deps ## Interactive TUI: choose new/existing VPC, domain, bucket → terraform.tfvars + backend.hcl
	@node scripts/v2/configure.mjs

migrate: ## Apply pending DB migrations (collision-free ULID files, advisory-locked, version-stamped). DRY_RUN=1 to preview.
	@node scripts/v2/migrate.mjs

migrate-status: ## Offline: app version + each migration's declared release (no DB connect)
	@node scripts/v2/migrate.mjs --status

deploy: migrate ## Apply pending migrations, then build arm64, push to ECR, roll ECS, wait stable, smoke /api/health
	@node scripts/v2/deploy.mjs

upgrade: ## Safe release upgrade: RDS snapshot → migrate (+bootstrap if legacy) → deploy. PREVIEW unless CONFIRM=go.
	@bash scripts/v2/upgrade.sh

agentcore: ## Build arm64 agent image, push ECR, run idempotent AgentCore provisioner (--smoke to invoke). Run after `terraform apply`.
	@node scripts/v2/agentcore.mjs $(if $(SMOKE),--smoke,)

workers: ## Build arm64 worker image, push to worker ECR (P2 Fargate worker). Run after `terraform apply` with workers_enabled=true.
	@node scripts/v2/workers.mjs
