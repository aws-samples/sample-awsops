#!/usr/bin/env bash
# Run one wave of batched review cells: run-panel.sh (panel) or synthesize.sh (chair) for every
# admitted batch whose wave column matches, at most max_parallel_batches at once.
# Usage: run-batches.sh <panel|chair> <wave> <root>   (cwd = the BASE review worktree)
# Each wave runs in its own workflow step after a fresh one-hour AWS session, so a two-wave
# phase never outlives its credentials. After the last wave (WAVES) it publishes the
# aggregated outputs. Every per-batch exit status is recorded; any failure exits 1.
set -uo pipefail
PHASE="$1"; WAVE="$2"; ROOT="$3"
DIR="$(cd "$(dirname "$0")" && pwd)"
WORKS="$ROOT/batch-works.tsv"
[ -s "$WORKS" ] || { echo "::error::no admitted review batch"; exit 1; }
case "$PHASE" in panel|chair) ;; *) echo "run-batches.sh: unknown phase" >&2; exit 2 ;; esac
MAX_PARALLEL=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["max_parallel_batches"])' \
  "$DIR/review-limits.json") || exit 1

STARTED=0
while IFS=$'\t' read -r work diff lenses wave; do
  [ "${wave:-1}" = "$WAVE" ] || continue
  while [ "$(jobs -rp | wc -l)" -ge "$MAX_PARALLEL" ]; do wait -n || true; done
  rm -f "$work/$PHASE.rc"
  if [ "$PHASE" = panel ]; then
    : > "$work/github.env"
    ( GITHUB_ENV="$work/github.env" bash "$DIR/run-panel.sh" "$diff" "$lenses" "$work"
      echo "$?" > "$work/panel.rc" ) < /dev/null &
  else
    rm -f "$work/review.md"
    ( GITHUB_ENV="$work/github.env" bash "$DIR/synthesize.sh" "$diff" "$work" \
        "$PR_NUMBER" "$PR_TITLE" "$work/review.md"
      echo "$?" > "$work/chair.rc" ) < /dev/null &
  fi
  STARTED=$((STARTED + 1))
done < "$WORKS"
[ "$STARTED" -gt 0 ] || { echo "::error::no review batch in wave $WAVE"; exit 1; }
wait

RC=0
while IFS=$'\t' read -r work _ _ wave; do
  [ "${wave:-1}" = "$WAVE" ] || continue
  [ "$(cat "$work/$PHASE.rc" 2>/dev/null)" = 0 ] || RC=1
done < "$WORKS"
if [ "$PHASE" = chair ]; then
  # Scrubbed chair reports, so text cut from an oversized comment stays retrievable. Model text
  # must never be parsed as workflow commands: suspend command processing with a fresh token.
  while IFS=$'\t' read -r work _ _ wave; do
    [ "${wave:-1}" = "$WAVE" ] || continue
    echo "::group::Batch review ${work##*/}"
    STOP_TOKEN=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
    echo "::stop-commands::$STOP_TOKEN"
    if [ -f "$work/review.md" ]; then
      tr -d '\r' < "$work/review.md" | sed -E 's/^([[:space:]]*)::/\1: :/'
    else
      echo "(no review)"
    fi
    echo "::$STOP_TOKEN::"
    echo "::endgroup::"
  done < "$WORKS"
fi
# Aggregate every batch's flags so far (failure flags OR-ed; see review_batches.py env).
python3 -I "$DIR/review_batches.py" env "$ROOT" >> "$GITHUB_ENV" || RC=1
[ "$RC" -eq 0 ] || exit 1
[ "$WAVE" = "${WAVES:-1}" ] || exit 0

if [ "$PHASE" = panel ]; then
  RESPONDED=$(python3 -I "$DIR/review_batches.py" responded "$ROOT") || exit 1
  echo "panel_responded=$RESPONDED" >> "$GITHUB_ENV"
  READY=true
  while IFS=$'\t' read -r work _; do
    [ ! -f "$work/coverage-severe.flag" ] || READY=false
  done < "$WORKS"
  echo "ready=$READY" >> "$GITHUB_OUTPUT"
else
  python3 -I "$DIR/review_batches.py" combine "$ROOT" "${REVIEW_OUT:-/tmp/review.md}" || exit 1
fi
