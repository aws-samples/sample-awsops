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

# --- chair MCP isolation (PR #204) ---------------------------------------------------------------
# Assert on the ACTUAL invocation, not on the function body: the comments in run_chair() name both flags,
# so grepping the body passed even with the flags deleted from the command — my own regression check showed
# only 1 of 3 guards failing and I read past it (review finding). Strip comments, join backslash
# continuations, then take the line that actually runs claude.
CHAIR_INVOCATION="$(echo "$RUN_CHAIR_BODY" | grep -v '^[[:space:]]*#' \
  | awk '{ if (sub(/\\$/, "")) printf "%s", $0; else print $0 }' | grep 'claude -p')"
if [ -n "$CHAIR_INVOCATION" ]; then
  pass "found the chair claude invocation to assert on"
else
  fail "found the chair claude invocation to assert on"
fi
# A user-scope MCP server whose auth is broken makes `claude -p` wait for the tool with no error until
# CHAIR_TIMEOUT, which kills primary AND fallback and fails the gate regardless of the diff (observed on
# PR #194/#197/#202, and seven times on #203). --strict-mcp-config is the switch that stops MCP loading;
# --allowedTools is only a permission allowlist and does NOT substitute for it.
if echo "$CHAIR_INVOCATION" | grep -q -- '--strict-mcp-config'; then
  pass "chair call passes --strict-mcp-config (ignores user-scope MCP servers)"
else
  fail "chair call passes --strict-mcp-config (ignores user-scope MCP servers)"
fi

if echo "$CHAIR_INVOCATION" | grep -q -- '--allowedTools'; then
  pass "chair call narrows --allowedTools"
else
  fail "chair call narrows --allowedTools"
fi

# No Bash in the allowlist: the step has no GH_TOKEN so it buys nothing, while promoting Bash from
# "auto-denied in non-interactive mode" to auto-approved would let the chair fetch an unscrubbed,
# untruncated diff around strip_controls|scrub_secrets.
if echo "$CHAIR_INVOCATION" | grep -q 'Bash'; then
  fail "chair allowlist has no Bash (would bypass the input scrub via gh)"
else
  pass "chair allowlist has no Bash (would bypass the input scrub via gh)"
fi

[ "$FAILED" -eq 0 ] || exit 1
