#!/usr/bin/env bash
# Grant the AWSops WORKER Lambda role READ access (AmazonEKSViewPolicy, cluster scope) on EKS
# cluster(s) so the AI-Insights k8s_events collector can LIST core/v1 Events via the Kubernetes API.
#
# Run this as an operator WHO HOLDS cluster permissions (eks:CreateAccessEntry +
# eks:AssociateAccessPolicy). AWSops deliberately does NOT create this access entry in terraform —
# granting a principal k8s access is the cluster owner's call (read-only stance). Re-running is safe.
#
# Usage:
#   scripts/v2/eks/register-insight-access.sh <cluster-name> [<cluster-name> ...]
#   ROLE_ARN=arn:aws:iam::...:role/awsops-v2-worker-lambda scripts/v2/eks/register-insight-access.sh <cluster>
#
# The worker Lambda role ARN is read from `terraform output -raw worker_lambda_role_arn` unless ROLE_ARN
# is set. Mirrors register-istio-access.sh (same View policy = read on namespaced resources + namespaces,
# NOT Secrets, NOT cluster-scoped) — k8s_events only LISTs core/v1 Events, so `view` suffices.
set -euo pipefail

CHDIR="$(cd "$(dirname "$0")/../../../terraform/foundation" && pwd)"
POLICY="arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy"

ROLE_ARN="${ROLE_ARN:-$(terraform -chdir="$CHDIR" output -raw worker_lambda_role_arn 2>/dev/null || true)}"
if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "null" ]; then
  echo "ERROR: worker_lambda_role_arn unavailable (is workers_enabled + apply done?). Pass ROLE_ARN=..." >&2
  exit 1
fi
if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <cluster-name> [<cluster-name> ...]" >&2
  exit 1
fi

echo "Principal: $ROLE_ARN"
for C in "$@"; do
  echo "== ${C}: register read-only access =="
  if err=$(aws eks create-access-entry --cluster-name "$C" --principal-arn "$ROLE_ARN" --type STANDARD 2>&1); then
    echo "  access entry created"
  elif printf '%s' "$err" | grep -q "ResourceInUseException"; then
    echo "  access entry already exists (ok)"
  else
    echo "  ERROR creating access entry on ${C}: $err" >&2
    exit 1
  fi
  if aerr=$(aws eks associate-access-policy --cluster-name "$C" --principal-arn "$ROLE_ARN" \
      --policy-arn "$POLICY" --access-scope type=cluster 2>&1); then
    echo "  View policy associated (cluster scope, least-privilege — no Secret/node read)"
  else
    echo "  ERROR associating View policy on ${C} (entry exists but policy NOT attached): $aerr" >&2
    exit 1
  fi
done
