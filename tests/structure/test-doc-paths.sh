#!/bin/bash
# Doc path integrity: published docs paths must exist after a move, rename or deletion.
# Checks (1) relative Markdown links in tracked Markdown outside docs-site/ and blog/, and
# (2) mentions of docs/<runbooks|reference|guides|development>/*.md or docs/*.md in tracked
# source, workflow, Terraform and Markdown files. Private-upstream paths (docs/decisions,
# docs/reviews, docs/superpowers, docs/history) are citations, not links, and are skipped.
#
# Standalone, no deps beyond python3: bash tests/structure/test-doc-paths.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

echo "TAP version 13"
echo "# published docs paths resolve"
python3 - <<'PY'
import os, re, subprocess, sys

files = [f for f in subprocess.check_output(["git", "ls-files"], text=True).splitlines() if f]
skip_prefix = ("docs-site/", "blog/")
private = re.compile(r"^docs/(decisions|reviews|superpowers|history)/")
mention = re.compile(r"(?<![\w/.-])docs/(?:(?:runbooks|reference|guides|development)/)?[A-Za-z0-9_.-]+\.md")
text_ext = re.compile(r"\.(md|ts|tsx|py|sh|mjs|js|tf|yml|yaml|json|hcl|tftpl)$")
bad = []

for f in files:
    if f.startswith(skip_prefix) or f == "CHANGELOG.md" or not text_ext.search(f):
        continue
    try:
        s = open(f, encoding="utf-8").read()
    except (UnicodeDecodeError, OSError):
        continue
    if f.endswith(".md"):
        body = re.sub(r"```.*?```", "", s, flags=re.S)
        for m in re.finditer(r"\]\(([^)\s#]+)(?:#[^)]*)?\)", body):
            target = m.group(1)
            if re.match(r"[a-z][a-z0-9+.-]*:", target) or target.startswith("/"):
                continue
            resolved = os.path.normpath(os.path.join(os.path.dirname(f), target))
            if resolved.startswith("docs/") and private.match(resolved):
                continue
            if not os.path.exists(resolved):
                bad.append(f"{f}: link {target}")
    for m in mention.finditer(s):
        path = m.group(0)
        if "blob/" in s[max(0, m.start() - 80):m.start()]:
            continue
        if not os.path.exists(path):
            bad.append(f"{f}: path {path}")

if bad:
    for b in sorted(set(bad)):
        print(f"#   {b}")
    print(f"not ok 1 - {len(set(bad))} published docs path(s) do not exist")
    print("1..1")
    sys.exit(1)
print("ok 1 - all published docs paths resolve")
print("1..1")
PY
