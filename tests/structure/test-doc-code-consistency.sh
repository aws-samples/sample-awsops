#!/bin/bash
# Doc↔code consistency: host and member EKS roles have different access contracts.
# The existing Terraform host association uses AdminView. Member defaults use View
# plus minimal node-read RBAC. Assertions must distinguish those documented scopes;
# banning the View name throughout CLAUDE.md would reject correct member guidance.
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

# 1. Keep the host contract explicit, without importing the member policy.
host_line=$(grep -F -- "- **EKS host onboarding**:" "$DOC")
if [[ "$host_line" == *"Access Entry + AmazonEKSAdminViewPolicy"* ]] &&
   [[ "$host_line" != *"AmazonEKSViewPolicy"* ]]; then
  ok "host onboarding documents the actual Terraform AdminView policy"
else
  notok "host onboarding must explicitly retain AdminView, not member View"
fi

# 2. Member guidance must include the node permission missing from View.
member_line=$(grep -F -- "- **EKS member onboarding**:" "$DOC")
if [[ "$member_line" == *"Access Entry + AmazonEKSViewPolicy"* ]] &&
   [[ "$member_line" == *"awsops:eks-readonly"* ]] &&
   [[ "$member_line" != *"AmazonEKSAdminViewPolicy"* ]]; then
  ok "member onboarding documents View plus minimal node-read RBAC"
else
  notok "member onboarding must document View plus node RBAC without AdminView"
fi
if grep -Fq 'AmazonEKSViewPolicy' web/lib/eks-access.ts &&
   grep -Fq 'awsops:eks-readonly' web/lib/eks-member-rbac.ts; then
  ok "member guide and generated RBAC implement the documented policy/group"
else
  notok "member guide or generated node-read group is missing"
fi

echo "# $PASS passed, $FAIL failed, $N total"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
