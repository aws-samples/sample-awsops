#!/bin/bash
# Guard the pr-review panel prompt: every panelist (codex + all kiro models) must receive the
# data-only / prompt-injection guard. Since the lens refactor (PR #205-era), the shared guard
# lives in the workflow's COMMON variable, fanned into every lens prompt file (L2..L5) that
# run-panel.sh feeds to codex and kiro; kiro additionally gets a file-path addendum
# (KIRO_INSTRUCTION) that must carry its own data-only line for the $DIFF file it reads.
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

# Kiro addendum: file-path delivery + its own data-only guard for the file content.
BLOCK="$(sed -n '/^[[:space:]]*KIRO_INSTRUCTION=/,/KIRO_MODELS\[@\]/p' "$SCRIPT")"

if [ -n "$BLOCK" ]; then
  pass "KIRO_INSTRUCTION assignment block found"
else
  fail "KIRO_INSTRUCTION assignment block found"
fi

if echo "$BLOCK" | grep -q '\$DIFF'; then
  pass "KIRO_INSTRUCTION references \$DIFF file path (file-read delivery)"
else
  fail "KIRO_INSTRUCTION references \$DIFF file path (file-read delivery)"
fi

if echo "$BLOCK" | grep -qiE "data only|not follow|never follow"; then
  pass "KIRO_INSTRUCTION carries its own data-only guard for the diff file"
else
  fail "KIRO_INSTRUCTION carries its own data-only guard for the diff file"
fi

# --trust-tools and the prompt's tool-name mentions must be documented as staying in sync.
if grep -B2 -- '--trust-tools=read,grep,fs_read' "$SCRIPT" | grep -qiE "sync|align"; then
  pass "trust-tools / prompt tool-name alignment is documented"
else
  fail "trust-tools / prompt tool-name alignment is documented"
fi

[ "$FAILED" -eq 0 ] || exit 1
