#!/bin/bash
# Static wiring checks for the Steampipe multi-account/region fan-out terraform (Task 8).
# (terraform apply behavior is verified at deploy; these assert the config is wired.)
cd "$(dirname "$0")/../.."

pass() { echo "ok - $1"; }
FAILS=0
fail() { echo "not ok - $1"; FAILS=$((FAILS+1)); }

echo "# Steampipe fan-out terraform wiring"

SP=terraform/foundation/steampipe.tf
DT=terraform/foundation/data.tf

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

# Gated on steampipe_enabled (not a bare `true`) so steampipe_enabled=false stays plan-clean.
grep -Eq 'iam_database_authentication_enabled\s*=\s*var\.steampipe_enabled' "$DT" \
  && pass "Aurora cluster IAM database authentication is gated on steampipe_enabled" \
  || fail "Aurora cluster IAM database authentication is gated on steampipe_enabled"

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

[ "$FAILS" -eq 0 ] || exit 1
