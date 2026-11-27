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

# 2. Member guidance: View only (no Secrets/AdminView), no kubectl/RBAC step; nodes come
#    from EC2/node-group APIs via the registered member read role.
member_line=$(grep -F -- "- **EKS member onboarding**:" "$DOC")
if [[ "$member_line" == *"Access Entry + AmazonEKSViewPolicy"* ]] &&
   [[ "$member_line" != *"awsops:eks-readonly"* ]] &&
   [[ "$member_line" != *"AmazonEKSAdminViewPolicy"* ]]; then
  ok "member onboarding documents View-only Access Entry without node RBAC"
else
  notok "member onboarding must document View-only Access Entry without AdminView or node RBAC"
fi
if grep -Fq 'cluster-access-policy/AmazonEKSViewPolicy' web/lib/eks-access.ts &&
   ! grep -Eq 'kubernetes-groups|kubectl --context|update-kubeconfig' web/lib/eks-access.ts &&
   grep -Fq 'listAwsApiNodes' web/lib/eks-incluster.ts; then
  ok "member guide is View-only and nodes fall back to the AWS-API view"
else
  notok "member guide must be View-only and nodes must fall back to the AWS-API view"
fi

echo "# $PASS passed, $FAIL failed, $N total"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
