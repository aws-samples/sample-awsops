#!/usr/bin/env bash
# Grant the AWSops agent Lambda role READ access (AmazonEKSViewPolicy, cluster scope) on EKS
# cluster(s) so the istio-read MCP can LIST Istio CRDs via the Kubernetes API.
#
# Run this as an operator WHO HOLDS cluster permissions (eks:CreateAccessEntry +
# eks:AssociateAccessPolicy). AWSops deliberately does NOT create this access entry in terraform —
# granting a principal k8s access is the cluster owner's call (read-only stance; the apply principal
# may not own third-party clusters). Re-running is safe (already-exists is tolerated).
#
# Usage:
#   scripts/v2/eks/register-istio-access.sh <cluster-name> [<cluster-name> ...]
#   ROLE_ARN=arn:aws:iam::...:role/awsops-v2-agent-lambda scripts/v2/eks/register-istio-access.sh <cluster>
#
# The agent Lambda role ARN is read from `terraform output -raw agent_lambda_role_arn` unless ROLE_ARN
# is set.
#
# POLICY = AmazonEKSViewPolicy (least privilege): maps to the k8s `view` ClusterRole — read on
# namespaced resources + namespaces, but NOT Secrets and NOT cluster-scoped resources (nodes etc.).
# istio-read only LISTs namespaced Istio CRDs + namespaces, so `view` suffices. Istio's standard
# install aggregates its CRD read perms into `view` (rbac aggregate-to-view). If a cluster lacks that
# aggregation, the operator additionally applies a minimal istio-reader ClusterRole (see runbook) —
# do NOT widen to AdminView (that would grant cluster-wide Secret read to an automated agent).
set -euo pipefail

CHDIR="$(cd "$(dirname "$0")/../../../terraform/foundation" && pwd)"
POLICY="arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy"

ROLE_ARN="${ROLE_ARN:-$(terraform -chdir="$CHDIR" output -raw agent_lambda_role_arn 2>/dev/null || true)}"
if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "null" ]; then
  echo "ERROR: agent_lambda_role_arn unavailable (is agentcore_enabled + apply done?). Pass ROLE_ARN=..." >&2
  exit 1
fi
if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <cluster-name> [<cluster-name> ...]" >&2
  exit 1
fi

echo "Principal: $ROLE_ARN"
for C in "$@"; do
  echo "== ${C}: register read-only access =="
  # Only treat ResourceInUseException (already registered) as benign — surface real errors
  # (e.g. AccessDenied) instead of masking them as "already exists".
  if err=$(aws eks create-access-entry --cluster-name "$C" --principal-arn "$ROLE_ARN" --type STANDARD 2>&1); then
    echo "  access entry created"
  elif printf '%s' "$err" | grep -q "ResourceInUseException"; then
    echo "  access entry already exists (ok)"
  else
    echo "  ERROR creating access entry on ${C}: $err" >&2
    exit 1
  fi
  # associate-access-policy is an upsert (idempotent), but guard it so a failure here surfaces clearly
  # instead of leaving an access-entry-without-policy partial state under `set -e`.
  if aerr=$(aws eks associate-access-policy --cluster-name "$C" --principal-arn "$ROLE_ARN" \
      --policy-arn "$POLICY" --access-scope type=cluster 2>&1); then
    echo "  View policy associated (cluster scope, least-privilege — no Secret/node read)"
  else
    echo "  ERROR associating View policy on ${C} (entry exists but policy NOT attached): $aerr" >&2
    exit 1
  fi
done
echo "Done. istio-read can now LIST Istio CRDs on: $*"
echo "To revoke: aws eks delete-access-entry --cluster-name <c> --principal-arn $ROLE_ARN"
