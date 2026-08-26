#!/bin/bash
# Guard: synthesize.sh's run_chair() must feed the chair diff+panel via synth-stdin.txt, not
# the bare $DIFF file — found during a merge-conflict reconciliation (PR #132 x #129): a
# stdin-source regression would silently make the chair synthesize with zero visibility into
# the panel's actual findings, while the whole review still appears to succeed (VERDICT still
# gets produced, just uninformed by the panel). Also guards against a duplicate run_chair
# definition/invocation (same conflict produced a second, stale primary→fallback block).
cd "$(dirname "$0")/../.."

FAILED=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1"; FAILED=$((FAILED+1)); }

echo "# pr-review chair stdin wiring"

SCRIPT="scripts/pr-review/synthesize.sh"
if [ ! -f "$SCRIPT" ]; then
  fail "synthesize.sh exists"
  exit 1
fi
pass "synthesize.sh exists"

if [ "$(grep -c '^run_chair()' "$SCRIPT")" -eq 1 ]; then
  pass "exactly one run_chair() definition (no duplicate fallback block)"
else
  fail "exactly one run_chair() definition (no duplicate fallback block)"
fi

RUN_CHAIR_BODY="$(sed -n '/^run_chair()/,/^}/p' "$SCRIPT")"

if echo "$RUN_CHAIR_BODY" | grep -q 'synth-stdin.txt'; then
  pass "run_chair reads from synth-stdin.txt (diff + panel reviews combined)"
else
  fail "run_chair reads from synth-stdin.txt (diff + panel reviews combined)"
fi

if echo "$RUN_CHAIR_BODY" | grep -qE '<\s*"\$DIFF"'; then
  fail "run_chair does not read the bare \$DIFF file (would drop all panel content)"
else
  pass "run_chair does not read the bare \$DIFF file (would drop all panel content)"
fi

[ "$FAILED" -eq 0 ] || exit 1
