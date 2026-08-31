#!/bin/bash
# Static checks for the externalId-optional feature (Gap 1).
# (DB-behavior + terraform-apply are verified at deploy; these are runnable structure asserts.)
cd "$(dirname "$0")/../.."

pass() { echo "ok - $1"; }
FAILS=0
fail() { echo "not ok - $1"; FAILS=$((FAILS+1)); }

echo "# externalId-optional structure"

MIG=terraform/foundation/migrations

# Task 2 — a migration drops the blanket external_id NOT-NULL constraint
if grep -rqlE "DROP CONSTRAINT IF EXISTS external_id_required_for_target" "$MIG"/*.sql 2>/dev/null; then
  pass "migration drops external_id_required_for_target"
else
  fail "migration drops external_id_required_for_target"
fi

[ "$FAILS" -eq 0 ] || exit 1
