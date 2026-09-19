#!/usr/bin/env bash
# Publish bounded surviving observations without spending another model call or
# suggesting incomplete review proves the code is safe.
set -euo pipefail
WORK="$1"; OUT="$2"
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/lib.sh"
umask 077
{
  echo "Panel review incomplete; no code verdict is available. Chair was not called."
  for model in codex claude; do
    if [ ! -s "$WORK/slot/$model-ALL.md" ]; then
      printf '\n%s: no completed reviewer response.\n' "$model"
    fi
  done
  if [ -f "$WORK/lens-coverage-failed.flag" ]; then
    echo "Required checklist coverage is missing or invalid."
  fi
  if [ -f "$WORK/image-coverage-failed.flag" ]; then
    echo "Required image coverage is incomplete or unavailable."
  fi
  if [ -f "$WORK/report-invalid.flag" ]; then
    echo "Review output is unreadable or exceeds its byte allocation."
  fi
  for model in codex claude; do
    report="$WORK/slot/$model-ALL.md"
    [ -s "$report" ] || continue
    printf '\nUnadjudicated %s observations (diagnostic excerpt, not approval):\n\n' "$model"
    if python3 "$DIR/image_coverage.py" report "$report" 0 >/dev/null 2>&1; then
      :
    else
      rc=$?
      if [ "$rc" -ne 1 ]; then
        echo "Report unreadable or over the validation bound."
        continue
      fi
    fi
    # Scrub the entire bounded report before clipping. Quote every line so model
    # headings/verdicts remain data in the diagnostic, never the gate's verdict.
    strip_controls < "$report" | scrub_secrets > "$WORK/panel-diagnostic.tmp"
    python3 - "$WORK/panel-diagnostic.tmp" <<'PY'
import sys
from pathlib import Path
data = Path(sys.argv[1]).read_bytes()
text = data[:24000].decode("utf-8", errors="ignore")
lines = text.splitlines()
for line in lines[:1000]:
    print("> " + line)
if len(data) > 24000 or len(lines) > 1000:
    print("\nDiagnostic excerpt truncated; remaining observations are unreviewed.")
PY
    rm -f "$WORK/panel-diagnostic.tmp"
  done
  printf '\nVERDICT: FAIL\n'
} > "$OUT"
