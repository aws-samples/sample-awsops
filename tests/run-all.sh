#!/bin/bash
# AWSops test runner — TAP-style output
# Usage: bash tests/run-all.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
TOTAL=0

pass() { TOTAL=$((TOTAL+1)); PASS=$((PASS+1)); echo "ok $TOTAL - $1"; }
fail() { TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1)); echo "not ok $TOTAL - $1"; }

echo "TAP version 13"
echo "# AWSops Project Structure Tests"
echo ""

# ── Hook Tests ──
echo "# Hook tests"
for f in tests/hooks/test-*.sh; do
  [ -f "$f" ] && bash "$f"
done

# ── Structure Tests ──
echo "# Structure tests"
for f in tests/structure/test-*.sh; do
  [ -f "$f" ] && bash "$f"
done

# ── Core Structure Assertions ──
echo "# Core structure"

[ -f "CLAUDE.md" ] && pass "CLAUDE.md exists" || fail "CLAUDE.md missing"
[ -f ".claude/settings.json" ] && pass ".claude/settings.json exists" || fail ".claude/settings.json missing"

# Check ADR count
ADR_COUNT=$(find docs/decisions -name '*.md' -not -name '.template.md' 2>/dev/null | wc -l)
[ "$ADR_COUNT" -ge 1 ] && pass "ADRs exist ($ADR_COUNT found)" || fail "No ADRs found"

# ── Agent Python Tests ──
# Run the AgentCore agent unittests (pure helpers, the Anthropic dark-path loop, account logic,
# connector freeze guards). These previously ran only by hand; wire them into the gate so the
# anthropic_loop golden tests actually block a regression.
echo "# Agent Python tests"
if command -v python3 &>/dev/null; then
  agent_ok=1
  # unittest-style suites (NO pytest dependency): handler/dark-path routing + tests/ (incl. the
  # anthropic_loop golden tests). Root pattern is test_agent.py — NOT test_*.py — so the pytest-style
  # test_account_logic.py is not swept into unittest discovery (it would ModuleNotFoundError without pytest).
  ( cd agent && python3 -m unittest discover -s . -p 'test_agent.py' \
             && python3 -m unittest discover -s tests -p 'test_*.py' ) >/dev/null 2>&1 || agent_ok=0
  # test_account_logic.py is pytest-style (pytest is an undeclared dep) — run it only when pytest is
  # importable; skip (don't fail the gate) where it isn't, but surface real failures when it is.
  if python3 -c "import pytest" >/dev/null 2>&1; then
    ( cd agent && python3 -m pytest -q test_account_logic.py ) >/dev/null 2>&1 || agent_ok=0
  fi
  [ "$agent_ok" -eq 1 ] && pass "Agent Python unittests passed" || fail "Agent Python unittests failed"
else
  echo "# SKIP: python3 not available"
fi

echo ""
echo "# Results: $PASS passed, $FAIL failed, $TOTAL total"
echo "1..$TOTAL"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
