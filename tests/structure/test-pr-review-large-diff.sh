#!/bin/bash
# Guard: pr-review.yml must fetch the diff via local git (no cap on file count), not the
# GitHub REST "Get PR diff" API (gh pr diff), which 406s past 300 changed files — confirmed
# on PR #124 (666-file v2-architecture-design → main integration PR).
cd "$(dirname "$0")/../.."

FAILED=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1"; FAILED=$((FAILED+1)); }

echo "# pr-review large-diff support"

WORKFLOW=".github/workflows/pr-review.yml"
if [ ! -f "$WORKFLOW" ]; then
  fail "pr-review.yml exists"
  exit 1
fi
pass "pr-review.yml exists"

# The "Get PR diff" step must not call the file-count-capped REST diff endpoint.
DIFF_STEP="$(sed -n '/name: Get PR diff/,/^      - name:/p' "$WORKFLOW")"
# Strip comment lines: only an actual invocation counts, not an explanatory mention.
DIFF_CMDS="$(echo "$DIFF_STEP" | grep -v '^[[:space:]]*#')"

if echo "$DIFF_CMDS" | grep -q "gh pr diff"; then
  fail "diff step does not call the capped gh pr diff API"
else
  pass "diff step does not call the capped gh pr diff API"
fi

if echo "$DIFF_CMDS" | grep -qE "git (fetch|diff)"; then
  pass "diff step computes the diff via local git instead"
else
  fail "diff step computes the diff via local git instead"
fi

# Must still fetch the PR head SHA explicitly — the base-only checkout (M1 security boundary)
# has no head objects locally without this.
if echo "$DIFF_STEP" | grep -q "pull_request.head.sha"; then
  pass "diff step fetches the PR head sha"
else
  fail "diff step fetches the PR head sha"
fi

# M1 security boundary must survive: the head ref is never checked out as the working tree
# (no `git checkout`/`git switch` to the head sha anywhere in the diff step). Case-insensitive:
# the real risky pattern is `git checkout "$HEAD_SHA"` (uppercase var name), which a
# lowercase-only "head" match misses entirely.
if echo "$DIFF_STEP" | grep -qiE "git (checkout|switch)[^|]*head"; then
  fail "diff step does not check out the PR head as the working tree (M1 boundary)"
else
  pass "diff step does not check out the PR head as the working tree (M1 boundary)"
fi

# The lockfile/binary exclusion filter (awk skip-list) must be preserved.
if echo "$DIFF_STEP" | grep -q "package-lock"; then
  pass "diff step still filters out lockfiles/binaries"
else
  fail "diff step still filters out lockfiles/binaries"
fi

[ "$FAILED" -eq 0 ] || exit 1
