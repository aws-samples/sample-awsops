#!/usr/bin/env bash
# Platform review panel: Codex + Claude, each independently reviewing all four lenses.
# Both CLIs read the diff through stdin and run from the trusted base context.
# Application changes remain data; missing/failed cells keep coverage fail-closed.
set -uo pipefail
DIFF="$1"; LENSES_DIR="$2"; WORK="$3"
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/lib.sh"
ensure_slots "$WORK"
SLOT="$WORK/slot"; RESP="$WORK/responded.txt"; : > "$RESP"
rm -f "$WORK/coverage-severe.flag"
T="${PANEL_TIMEOUT:-300}"
CLAUDE_TIMEOUT="${CLAUDE_PANEL_TIMEOUT:-600}"
CLAUDE_L2_TIMEOUT="${CLAUDE_PANEL_L2_TIMEOUT:-$CLAUDE_TIMEOUT}"
KILL_AFTER="${PANEL_KILL_AFTER:-10s}"
RETRIES="${PANEL_RETRIES:-2}"
CLAUDE_MODEL="${CLAUDE_PANEL_MODEL:-${ANTHROPIC_MODEL:-us.anthropic.claude-opus-5}}"
PANEL_MODELS=(codex claude)
TOTAL_MODELS=${#PANEL_MODELS[@]}

LENS_FILES=()
for lens in L2 L3 L4 L5; do
  if [ ! -s "$LENSES_DIR/$lens.txt" ]; then
    echo "run-panel.sh: required lens $lens is missing or empty" >&2
    exit 1
  fi
  LENS_FILES+=("$LENSES_DIR/$lens.txt")
done

try_panel() {
  local slot="$1" err="$2"; shift 2
  local a started rc
  for a in $(seq 1 "$RETRIES"); do
    started=$SECONDS
    if "$@" > "$slot" 2>"$err" < "$DIFF"; then
      [ -s "$slot" ] && return 0
      rc=0
    else
      rc=$?
    fi
    # A failed CLI may print its error on stdout: it is not a completed review.
    : > "$slot"
    echo "[attempt $a/$RETRIES] $(basename "$slot" .md) exit=$rc elapsed=$((SECONDS-started))s; no completed review" >&2
    [ "$a" -lt "$RETRIES" ] && echo "[retry $a/$RETRIES] $(basename "$slot" .md)" >&2
  done
  return 1
}

for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  LENS_PROMPT="$(cat "$lens_file")"
  if command -v codex >/dev/null 2>&1; then
    ( try_panel "$SLOT/codex-$lens.md" "$SLOT/codex-$lens.err" \
        env AWS_REGION="${CODEX_AWS_REGION:-us-east-1}" AWS_DEFAULT_REGION="${CODEX_AWS_REGION:-us-east-1}" \
        timeout --kill-after="$KILL_AFTER" "$T" codex exec -s read-only --skip-git-repo-check "$LENS_PROMPT" ) &
  else echo "[skip] codex/$lens (binary absent)" >&2; : > "$SLOT/codex-$lens.md"; fi

  if command -v claude >/dev/null 2>&1; then
    lens_timeout="$CLAUDE_TIMEOUT"
    [ "$lens" != "L2" ] || lens_timeout="$CLAUDE_L2_TIMEOUT"
    ( try_panel "$SLOT/claude-$lens.md" "$SLOT/claude-$lens.err" \
        env ANTHROPIC_MODEL="$CLAUDE_MODEL" \
        timeout --kill-after="$KILL_AFTER" "$lens_timeout" claude -p "$LENS_PROMPT" --output-format text \
        --strict-mcp-config --tools "Read,Grep,Glob" --allowedTools "Read,Grep,Glob" \
        --setting-sources "" ) &
  else echo "[skip] claude/$lens (binary absent)" >&2; : > "$SLOT/claude-$lens.md"; fi
done
wait

for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  for model_tag in "${PANEL_MODELS[@]}"; do
    record_result "$SLOT/$model_tag-$lens.md" "$model_tag/$lens" "$RESP"
  done
done
echo "Panel responded ($(wc -l < "$RESP") / $((TOTAL_MODELS * ${#LENS_FILES[@]})) cells): $(tr '\n' ' ' < "$RESP")"

: > "$WORK/degraded-models.txt"
for model_tag in "${PANEL_MODELS[@]}"; do
  row_count="$(grep -c "^${model_tag}/" "$RESP" 2>/dev/null)"
  if [ "${row_count:-0}" -eq 0 ]; then
    echo "::warning::model '$model_tag' produced zero responses across all ${#LENS_FILES[@]} lenses — coverage degraded" >&2
    echo "$model_tag" >> "$WORK/degraded-models.txt"
  fi
done
DEGRADED_COUNT=$(wc -l < "$WORK/degraded-models.txt")
if [ "$DEGRADED_COUNT" -ge "$((TOTAL_MODELS - 1))" ]; then
  echo "::error::coverage collapsed to ≤1 vendor ($DEGRADED_COUNT/$TOTAL_MODELS models degraded) — forcing VERDICT: FAIL" >&2
  : > "$WORK/coverage-severe.flag"
fi

# Every lens needs both vendors, even when a model succeeds on other lenses.
: > "$WORK/degraded-lenses.txt"
for lens_file in "${LENS_FILES[@]}"; do
  lens="$(basename "$lens_file" .txt)"
  lens_count="$(grep -c "/${lens}$" "$RESP" 2>/dev/null)"
  if [ "${lens_count:-0}" -lt "$TOTAL_MODELS" ]; then
    echo "::warning::lens '$lens' received ${lens_count:-0}/$TOTAL_MODELS required model responses" >&2
    echo "$lens" >> "$WORK/degraded-lenses.txt"
    : > "$WORK/coverage-severe.flag"
  fi
done

for e in "$SLOT"/*.err; do
  [ -s "$e" ] || continue
  b="$(basename "$e" .err)"
  [ -s "$SLOT/$b.md" ] && continue
  echo "--- [$b] skipped; stderr (last 25 lines, scrubbed) ---" >&2
  tail -25 "$e" | scrub_secrets >&2
done
