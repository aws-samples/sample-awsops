#!/bin/bash
# Guard the pr-review panel prompt: every panelist (Codex + Claude) must receive the
# data-only / prompt-injection guard. Since the lens refactor (PR #205-era), the shared guard
# lives in the workflow's COMMON variable, fanned into every lens prompt file (L2..L5) that
# run-panel.sh feeds to both CLIs over stdin. Executable CLI fixtures below check exact
# prompt forwarding, read-only tools, timeout/retry behavior and complete lens coverage.
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

# The shared COMMON block (source of every lens prompt) must exist and carry the guard.
COMMON_BLOCK="$(sed -n '/COMMON="/,/"$/p' "$WORKFLOW")"

if [ -n "$COMMON_BLOCK" ]; then
  pass "shared COMMON prompt block found in workflow"
else
  fail "shared COMMON prompt block found in workflow"
fi

if echo "$COMMON_BLOCK" | grep -qiE "data only|not follow|never follow"; then
  pass "shared COMMON prompt carries a prompt-injection / data-only guard"
else
  fail "shared COMMON prompt carries a prompt-injection / data-only guard"
fi

# Every lens prompt file the workflow writes must include $COMMON (else that lens's
# panelists run unguarded).
LENS_HEREDOCS=$(grep -c "cat <<PROMPT_EOF > /tmp/pr-review/lenses/" "$WORKFLOW")
# Flag resets at each heredoc terminator, so a lens missing $COMMON cannot borrow
# credit from the next heredoc's $COMMON line.
LENS_WITH_COMMON=$(awk '
  /cat <<PROMPT_EOF > \/tmp\/pr-review\/lenses\//{f=1; next}
  /^[[:space:]]*PROMPT_EOF[[:space:]]*$/{f=0}
  f && /\$COMMON/{c++; f=0}
  END{print c+0}' "$WORKFLOW")
if [ "$LENS_HEREDOCS" -ge 1 ] && [ "$LENS_HEREDOCS" -eq "$LENS_WITH_COMMON" ]; then
  pass "every lens prompt heredoc ($LENS_HEREDOCS) embeds \$COMMON"
else
  fail "every lens prompt heredoc embeds \$COMMON ($LENS_WITH_COMMON of $LENS_HEREDOCS do)"
fi

# Exercise the actual panel script with fake external CLIs: this checks what each
# CLI receives, rather than requiring the source text of the retired Kiro adapter.
if PANEL_RESULT=$(python3 -m unittest scripts.v2.test_pr_review_pipeline scripts.v2.test_pr_review_head_images 2>&1); then
  pass "Codex/Claude receive guarded prompts and read-only tools; coverage fails closed"
else
  printf '%s\n' "$PANEL_RESULT" | sed 's/^/# /'
  fail "executable panel contracts"
fi

[ "$FAILED" -eq 0 ] || exit 1
