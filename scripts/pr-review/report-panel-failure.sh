#!/usr/bin/env bash
# Public failure diagnostics contain only fixed labels and keyword-presence booleans.
# Raw model text, filenames from reports, links and excerpts never leave this path.
set -euo pipefail
WORK="$1"; OUT="$2"
DIR="$(cd "$(dirname "$0")" && pwd)"
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
    printf '\n%s: response received; observations remain unadjudicated.\n' "$model"
    python3 -I - "$report" "$DIR" <<'PY'
import re, sys
sys.path.insert(0, sys.argv[2])
from image_coverage import read_data, report_lines, REPORT_LIMIT
try:
    text = read_data(sys.argv[1], REPORT_LIMIT)
except (OSError, ValueError, UnicodeError):
    print("Severity markers unavailable: report unreadable or over limit.")
else:
    # Literal keyword presence is not an issue count or an adjudicated finding.
    lines = []
    for line in report_lines(text):
        if re.match(r"^[ \t]*>", line):
            continue
        if re.match(r"^(?: {4}|\t)", line) and not re.match(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+", line):
            continue
        lines.append(line)
    for severity in ("CRITICAL", "MAJOR", "MINOR"):
        present = any(re.search(r"\b" + severity + r"\b", line, re.IGNORECASE) for line in lines)
        print(f"Unadjudicated {severity} keyword present: {str(present).lower()}")
print("Report text is withheld; keyword presence is neither an issue count nor a correctness verdict.")
PY
  done
  printf '\nVERDICT: FAIL\n'
} > "$OUT"
