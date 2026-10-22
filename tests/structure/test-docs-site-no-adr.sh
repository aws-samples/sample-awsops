#!/bin/bash
# The multilingual product guide (docs-site/) describes product behavior, not decision records:
# no ADR identifiers, decision-record paths or "Architecture Decision Record" wording in any
# tracked text file under docs-site/ (pages, release notes, presentation sources and builders).
# Binary assets are skipped (git grep -I).
#
# Standalone, no deps: bash tests/structure/test-docs-site-no-adr.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

echo "TAP version 13"
echo "# docs-site carries no ADR references"
hits=$(git grep -n -I -E '\bADRs?\b|ADR-?[0-9]{3}|docs/decisions|Architecture Decision Record' -- docs-site ':!docs-site/package-lock.json' || true)
if [ -n "$hits" ]; then
  printf '%s\n' "$hits" | head -40 | sed 's/^/#   /'
  echo "not ok 1 - docs-site contains $(printf '%s\n' "$hits" | wc -l) ADR reference line(s)"
  echo "1..1"
  exit 1
fi
echo "ok 1 - docs-site contains no ADR references"
echo "1..1"
