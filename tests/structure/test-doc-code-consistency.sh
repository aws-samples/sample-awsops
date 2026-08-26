#!/bin/bash
# Doc↔code consistency: CLAUDE.md must name the EKS access-entry policy the code actually binds.
#
# The web task role's EKS Access Entry is associated with AmazonEKSAdminViewPolicy
# (terraform/foundation/eks.tf:34) — NOT AmazonEKSViewPolicy. Plain View has no cluster-scoped
# resources, so it can't list nodes (see the eks.tf comment); AmazonEKSViewPolicy is used ONLY for
# the separate, out-of-band istio-read role (eks.tf:46), which CLAUDE.md does not document.
#
# Assertions are scoped to CLAUDE.md (NOT repo-wide — eks.tf legitimately keeps AmazonEKSViewPolicy
# for the istio role) and use fixed-string matching (grep -F) to avoid any regex ambiguity. The "Admin"
# prefix breaks both forbidden literals (" + View" != " + AdminView"; "EKSViewPolicy" != "EKSAdminViewPolicy"),
# so the corrected "AdminView" text cannot false-fail.
#
# Standalone, no deps (no vitest/tfvars/node): bash tests/structure/test-doc-code-consistency.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

EKS_TF="terraform/foundation/eks.tf"
DOC="CLAUDE.md"
PASS=0; FAIL=0; N=0
ok()    { N=$((N+1)); PASS=$((PASS+1)); echo "ok $N - $1"; }
notok() { N=$((N+1)); FAIL=$((FAIL+1)); echo "not ok $N - $1"; }

echo "TAP version 13"
echo "# CLAUDE.md <-> eks.tf EKS access-entry policy consistency"

# 0. Precondition: the code really binds AdminView to the web access entry (guards against the
#    test premise going stale if eks.tf changes).
if grep -Fq "cluster-access-policy/AmazonEKSAdminViewPolicy" "$EKS_TF"; then
  ok "eks.tf binds AmazonEKSAdminViewPolicy to the web task role"
else
  notok "eks.tf no longer binds AmazonEKSAdminViewPolicy — update this test's premise"
fi

# 1. CLAUDE.md must NOT name the web-role policy as plain AmazonEKSViewPolicy.
if grep -Fq "AmazonEKSViewPolicy" "$DOC"; then
  notok "CLAUDE.md still says AmazonEKSViewPolicy (web task role uses AdminView per eks.tf:34)"
else
  ok "CLAUDE.md has no stale 'AmazonEKSViewPolicy'"
fi

# 2. CLAUDE.md must NOT pair 'Access Entry' with a bare 'View policy' (the web-role phrasing).
if grep -Fq "Access Entry + View policy" "$DOC"; then
  notok "CLAUDE.md still says 'Access Entry + View policy' (should be 'Access Entry + AdminView policy')"
else
  ok "CLAUDE.md has no stale 'Access Entry + View policy'"
fi

echo "# $PASS passed, $FAIL failed, $N total"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
