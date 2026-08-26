#!/bin/bash
# Guard the pr-review panel prompt: the diff is delivered by file path + trusted-tool read to
# kiro-cli (PR #115) and via stdin to codex, both fed by the SAME shared prompt
# (.github/workflows/pr-review.yml's panel-prompt heredoc) — so the data-only / prompt-injection
# guard must live there (covers all 4 panelists), not only in run-panel.sh's kiro-only addendum
# (PR #115 review follow-up: codex was left unprotected when the guard was kiro-only).
cd "$(dirname "$0")/../.."

FAILED=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1"; FAILED=$((FAILED+1)); }

echo "# pr-review panel prompt safety"

WORKFLOW=".github/workflows/pr-review.yml"
SCRIPT="scripts/pr-review/run-panel.sh"
if [ ! -f "$SCRIPT" ]; then
  fail "run-panel.sh exists"
  exit 1
fi
pass "run-panel.sh exists"

# Isolate the shared panel-prompt heredoc (covers codex + all kiro models) — not just kiro's addendum.
# Terminator line is indented under the YAML step, so match optional leading whitespace.
SHARED_PROMPT="$(sed -n "/cat <<'PROMPT_EOF'/,/^[[:space:]]*PROMPT_EOF[[:space:]]*$/p" "$WORKFLOW")"

if [ -n "$SHARED_PROMPT" ]; then
  pass "shared panel-prompt heredoc found"
else
  fail "shared panel-prompt heredoc found"
fi

if echo "$SHARED_PROMPT" | grep -qiE "data only|not follow|never follow"; then
  pass "shared panel prompt (codex + kiro) carries a prompt-injection / data-only guard"
else
  fail "shared panel prompt (codex + kiro) carries a prompt-injection / data-only guard"
fi

# Isolate just the KIRO_PROMPT assignment (avoid matching unrelated comments elsewhere).
BLOCK="$(sed -n '/^KIRO_PROMPT=/,/^KIRO_MODELS=/p' "$SCRIPT")"

if [ -n "$BLOCK" ]; then
  pass "KIRO_PROMPT assignment block found"
else
  fail "KIRO_PROMPT assignment block found"
fi

if echo "$BLOCK" | grep -q '\$DIFF'; then
  pass "KIRO_PROMPT still references \$DIFF file path (PR #115 file-read delivery)"
else
  fail "KIRO_PROMPT still references \$DIFF file path (PR #115 file-read delivery)"
fi

# --trust-tools and the prompt's tool-name mentions must be documented as staying in sync.
if grep -B2 -- '--trust-tools=read,grep,fs_read' "$SCRIPT" | grep -qiE "sync|align"; then
  pass "trust-tools / prompt tool-name alignment is documented"
else
  fail "trust-tools / prompt tool-name alignment is documented"
fi

[ "$FAILED" -eq 0 ] || exit 1
