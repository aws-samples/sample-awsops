#!/bin/bash
# Static wiring checks for the Steampipe multi-account/region fan-out terraform (Task 8).
# (terraform apply behavior is verified at deploy; these assert the config is wired.)
cd "$(dirname "$0")/../.."

pass() { echo "ok - $1"; }
FAILS=0
fail() { echo "not ok - $1"; FAILS=$((FAILS+1)); }

echo "# Steampipe fan-out terraform wiring"

SP=terraform/foundation/steampipe.tf
AI=terraform/foundation/ai.tf
DT=terraform/foundation/data.tf
VARS=terraform/foundation/variables.tf
RUNBOOK=docs/runbooks/steampipe-quota-and-staleness.md

check_number_variable() {
  local name=$1
  local default=$2
  local block

  block=$(sed -n "/^variable \"$name\" {/,/^}$/p" "$VARS")
  printf '%s\n' "$block" | grep -Eq 'type[[:space:]]*=[[:space:]]*number' \
    && printf '%s\n' "$block" | grep -Eq "default[[:space:]]*=[[:space:]]*$default" \
    && printf '%s\n' "$block" | grep -Eq 'validation[[:space:]]*\{' \
    && pass "$name is a validated number variable with default $default" \
    || fail "$name is a validated number variable with default $default"
}

check_number_variable "steampipe_aws_max_concurrency" 4
check_number_variable "steampipe_aws_bucket_size" 4
check_number_variable "steampipe_aws_fill_rate" 2
check_number_variable "steampipe_sync_reserved_concurrency" 4
check_number_variable "inventory_stale_after_minutes" 30

grep -Eq 'STEAMPIPE_AWS_MAX_CONCURRENCY' "$SP" \
  && pass "Steampipe task gets STEAMPIPE_AWS_MAX_CONCURRENCY env" \
  || fail "Steampipe task gets STEAMPIPE_AWS_MAX_CONCURRENCY env"

grep -Eq 'STEAMPIPE_AWS_BUCKET_SIZE' "$SP" \
  && pass "Steampipe task gets STEAMPIPE_AWS_BUCKET_SIZE env" \
  || fail "Steampipe task gets STEAMPIPE_AWS_BUCKET_SIZE env"

grep -Eq 'STEAMPIPE_AWS_FILL_RATE' "$SP" \
  && pass "Steampipe task gets STEAMPIPE_AWS_FILL_RATE env" \
  || fail "Steampipe task gets STEAMPIPE_AWS_FILL_RATE env"

grep -Eq 'reserved_concurrent_executions[[:space:]]*=[[:space:]]*var\.steampipe_sync_reserved_concurrency' "$SP" \
  && pass "inventory sync Lambda uses reserved concurrency variable" \
  || fail "inventory sync Lambda uses reserved concurrency variable"

grep -Eq 'INVENTORY_STALE_AFTER_MINUTES[[:space:]]*=[[:space:]]*tostring\(var\.inventory_stale_after_minutes\)' "$AI" \
  && pass "inventory-read Lambda gets INVENTORY_STALE_AFTER_MINUTES env" \
  || fail "inventory-read Lambda gets INVENTORY_STALE_AFTER_MINUTES env"

grep -Eq 'maximum_event_age_in_seconds[[:space:]]*=[[:space:]]*900' "$SP" \
  && pass "inventory sync Lambda expires delayed async events after 900 seconds" \
  || fail "inventory sync Lambda expires delayed async events after 900 seconds"

grep -Eq 'maximum_retry_attempts[[:space:]]*=[[:space:]]*0' "$SP" \
  && pass "inventory sync Lambda disables asynchronous retries" \
  || fail "inventory sync Lambda disables asynchronous retries"

EVENT_TARGET_BLOCK=$(sed -n '/^resource "aws_cloudwatch_event_target" "inv_sync" {/,/^}/p' "$SP")
printf '%s\n' "$EVENT_TARGET_BLOCK" | grep -Eq 'retry_policy[[:space:]]*\{' \
  && printf '%s\n' "$EVENT_TARGET_BLOCK" | grep -Eq 'maximum_event_age_in_seconds[[:space:]]*=[[:space:]]*900' \
  && printf '%s\n' "$EVENT_TARGET_BLOCK" | grep -Eq 'maximum_retry_attempts[[:space:]]*=[[:space:]]*0' \
  && pass "EventBridge target expires scheduled deliveries after 900 seconds with zero retries" \
  || fail "EventBridge target must set retry_policy age 900 and retries 0"

grep -q 'AURORA_ENDPOINT' "$SP" && grep -q 'AURORA_DATABASE' "$SP" \
  && pass "steampipe task gets AURORA_ENDPOINT + AURORA_DATABASE env" \
  || fail "steampipe task gets AURORA_ENDPOINT + AURORA_DATABASE env"

# M1: no Aurora secret of any kind (master or otherwise) is granted to the steampipe task —
# IAM database auth (rds-db:connect) replaces it entirely. Exact match on the quoted env var name
# ("AURORA_SECRET") so this does NOT false-positive on the unrelated inv-sync lambda's
# AURORA_SECRET_ARN (that Lambda legitimately needs write access via the master secret — out of
# M1's scope, which is specifically the network-listening steampipe task).
grep -Eq '"AURORA_SECRET"' "$SP" \
  && fail "steampipe task must NOT be granted any Aurora secret (M1 — use IAM auth instead)" \
  || pass "steampipe task is not granted any Aurora secret (M1)"

grep -Eq 'rds-db:connect' "$SP" && grep -Eq 'dbuser:.*steampipe_reader' "$SP" \
  && pass "steampipe task role gets rds-db:connect scoped to steampipe_reader (M1 IAM auth)" \
  || fail "steampipe task role gets rds-db:connect scoped to steampipe_reader (M1 IAM auth)"

grep -Eq 'AURORA_USER' "$SP" \
  && pass "steampipe task gets AURORA_USER env (non-secret role name)" \
  || fail "steampipe task gets AURORA_USER env (non-secret role name)"

# Unconditional since the web BFF also authenticates via IAM DB auth (awsops_web, PR #123 —
# the rotation-outage fix): gating it on steampipe_enabled would break web when steampipe is off.
grep -Eq 'iam_database_authentication_enabled\s*=\s*true' "$DT" \
  && pass "Aurora cluster IAM database authentication is unconditionally enabled (web + steampipe depend on it)" \
  || fail "Aurora cluster IAM database authentication is unconditionally enabled (web + steampipe depend on it)"

# task-role AssumeRole scoped to the read-only role name (not a wildcard role)
grep -Eq 'sts:AssumeRole' "$SP" && grep -Eq 'role/AWSopsReadOnlyRole' "$SP" \
  && pass "steampipe task role assume scoped to AWSopsReadOnlyRole" \
  || fail "steampipe task role assume scoped to AWSopsReadOnlyRole"

# M2 (round 5): the reachability probe queries the account's own Steampipe connection directly
# (data path) instead of an independent sts:AssumeRole — inv_sync must NOT be granted AssumeRole
# at all (an AssumeRole-based probe only proves the trust policy, not that Steampipe actually
# queried the account this run — see sync_lambda._account_reachable's docstring). Exact match on
# the Action array literal (not prose mentions of the string in comments).
grep -c '\["sts:AssumeRole"\]' "$SP" | grep -q '^1$' \
  && pass "sts:AssumeRole granted to exactly one role (steampipe_task only — M2 uses the data path, not IAM)" \
  || fail "sts:AssumeRole granted to exactly one role (steampipe_task only — M2 uses the data path, not IAM)"

# Aurora SG opens 5432 to the steampipe SG (gated on local.sp)
grep -q 'aws_security_group.steampipe' "$DT" \
  && pass "Aurora SG ingress from the steampipe SG" \
  || fail "Aurora SG ingress from the steampipe SG"

# M3: the boot generator verifies Aurora's TLS certificate (RDS CA bundle baked into the image)
# instead of disabling verification entirely.
DOCKERFILE=scripts/v2/steampipe/Dockerfile
ENTRYPOINT=scripts/v2/steampipe/gen_spc_entrypoint.py
grep -Eq 'rds-ca-bundle\.pem' "$DOCKERFILE" \
  && pass "Dockerfile bakes in the RDS CA bundle (M3)" \
  || fail "Dockerfile bakes in the RDS CA bundle (M3)"
# Exact match on the actual assignment (not prose mentions of "CERT_NONE" in explanatory comments).
grep -Eq 'cafile=RDS_CA_BUNDLE' "$ENTRYPOINT" && ! grep -Eq 'verify_mode\s*=\s*ssl\.CERT_NONE' "$ENTRYPOINT" \
  && pass "gen_spc_entrypoint uses VERIFY_FULL (cafile), not CERT_NONE (M3)" \
  || fail "gen_spc_entrypoint uses VERIFY_FULL (cafile), not CERT_NONE (M3)"

# The inv-sync Lambda package is owned by Terraform, while its running UPSERT depends on the
# run_token column created by make migrate. Guard the operator contract against documenting
# Terraform apply before the migration (which would create a schema/code incompatibility window).
DEPLOY_ORDER=$(sed -n '/^## 4\. 배포 순서/,/^## 5\./p' "$RUNBOOK")
MIGRATE_LINE=$(printf '%s\n' "$DEPLOY_ORDER" | grep -n -m1 '^make migrate' | cut -d: -f1)
APPLY_LINE=$(printf '%s\n' "$DEPLOY_ORDER" | grep -n -m1 '^terraform -chdir=terraform/foundation apply tfplan' | cut -d: -f1)
if [ -n "$MIGRATE_LINE" ] && [ -n "$APPLY_LINE" ] && [ "$MIGRATE_LINE" -lt "$APPLY_LINE" ]; then
  pass "runbook migrates Aurora before Terraform rolls the inv-sync Lambda"
else
  fail "runbook must place make migrate before apply tfplan in the deployment-order section"
fi

FIRST_ENABLE=$(printf '%s\n' "$DEPLOY_ORDER" | sed -n '/^### 최초 활성화/,$p')
FIRST_ENABLE_APPLIES=$(printf '%s\n' "$FIRST_ENABLE" \
  | grep -c '^terraform -chdir=terraform/foundation apply ')
FIRST_ENABLE_QUALIFIED=$(printf '%s\n' "$FIRST_ENABLE" | awk '
  /^terraform -chdir=terraform\/foundation apply / {
    if (previous == "# Controller-approved operation only:") qualified++
  }
  { previous = $0 }
  END { print qualified + 0 }
')
if [ "$FIRST_ENABLE_APPLIES" -eq 2 ] \
  && [ "$FIRST_ENABLE_QUALIFIED" -eq "$FIRST_ENABLE_APPLIES" ]; then
  pass "every first-time shared-infra apply has the exact controller-only qualifier"
else
  fail "both first-time applies must be immediately preceded by # Controller-approved operation only:"
fi

[ "$FAILS" -eq 0 ] || exit 1
