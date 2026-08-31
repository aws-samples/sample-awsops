#!/usr/bin/env bash
# Grant the AWSops worker Fargate task role a minimal EKS Access Entry so the Network Path
# Check's resolve_live_identity() can GET a single named Pod or Node object
# (scripts/v2/workers/network_path.py) — nothing more.
#
# Run this as an operator who holds cluster permissions — CI-review MINOR fix (round 24): the
# prerequisite list previously named only eks:CreateAccessEntry/UpdateAccessEntry, but this
# script's own round-20/21 logic also needs eks:DescribeAccessEntry (merged_kubernetes_groups),
# eks:ListAssociatedAccessPolicies, and eks:DisassociateAccessPolicy (disassociate_stale_policies)
# — full list: eks:CreateAccessEntry, eks:UpdateAccessEntry, eks:DescribeAccessEntry,
# eks:ListAssociatedAccessPolicies, eks:DisassociateAccessPolicy — AND cluster-admin (or
# equivalent RBAC-write) k8s access to apply the ClusterRole/ClusterRoleBinding below. AWSops
# deliberately does NOT create this access entry in terraform — granting a principal k8s access
# is the cluster owner's call (read-only stance; the apply principal may not own third-party
# clusters). Re-running is safe (already-exists is tolerated).
#
# Usage:
#   scripts/v2/eks/register-network-path-access.sh <cluster-name> [<cluster-name> ...]
#   ROLE_ARN=arn:aws:iam::...:role/awsops-v2-worker-task scripts/v2/eks/register-network-path-access.sh <cluster>
#
# The worker task role ARN is read from `terraform output -raw worker_task_role_arn` unless
# ROLE_ARN is set.
#
# CI-review MAJOR fix (round 19): this used to associate the AWS-managed `AmazonEKSAdminViewPolicy`
# (cluster scope) on the access entry, the SAME policy eks.tf binds for the web task role's OWN
# manual-registration Access Entry. That was the wrong precedent to reuse here: this feature's
# resolve_live_identity() only ever GETs ONE named Node and ONE named Pod, but AdminView grants
# cluster-wide LIST/GET/WATCH on every cluster-scoped resource AND every Secret in every namespace
# — to the SAME shared worker task role every other job type runs under. The sibling script,
# register-istio-access.sh, explicitly documents why NOT to do this ("do NOT widen to AdminView —
# that would grant cluster-wide Secret read to an automated agent"); this script was the one place
# that violated its own repo's documented convention.
#
# Fix: bind the principal to a Kubernetes GROUP (`awsops-network-path-reader`, see the round-24
# prefix fix below) via `--kubernetes-groups`
# instead of an AWS-managed access policy, and authorize that group with a minimal ClusterRole
# granting ONLY `get` on `nodes` and `pods` — no Secret access, no LIST/WATCH, no other resource
# kind. See network-path-reader-rbac.yaml (applied separately via kubectl, since Access Entries
# alone establish the IAM-principal -> k8s-group mapping; RBAC authorization is still needed).
#
# CI-review MAJOR fix (round 20): the round-19 "converged" path only ran `update-access-entry
# --kubernetes-groups` on an already-existing entry — but an AWS-managed access policy (e.g. the
# round-18-era `AmazonEKSAdminViewPolicy`, with its cluster-wide Secret read) is associated via a
# SEPARATE API (`associate-access-policy`) and is completely untouched by `update-access-entry`.
# An entry left over from this script's own round-18 shape kept that policy while this script
# printed a false "converged to least-privilege" claim. Every run now also lists and disassociates
# any access policy still attached to the entry, so "converged" is actually true regardless of how
# the entry got there. This needs `eks:ListAssociatedAccessPolicies` +
# `eks:DisassociateAccessPolicy` in addition to the create/update permissions above.
#
# CI-review MAJOR fix (round 21): the round-20 fix itself had two problems, both because the
# worker task role's Access Entry is a SHARED-principal resource this script does not exclusively
# own. (a) `list-associated-access-policies ... 2>/dev/null || true` swallowed AccessDenied/
# throttling/network errors the SAME way as "no policies found" — a listing failure silently
# printed a false "converged" claim while a stale over-broad policy could still be attached; a
# listing failure is now FATAL, not treated as empty. (b) `update-access-entry
# --kubernetes-groups "$K8S_GROUP"` REPLACES the entry's entire groups list, and disassociating
# EVERY attached policy could revoke a legitimate out-of-band grant this script knows nothing
# about — this now MERGES with whatever groups are already present (never drops one), and only
# disassociates the SPECIFIC policy ARNs this script's own earlier rounds are known to have
# associated (`_KNOWN_STALE_POLICY_ARNS` below), not an unbounded "whatever is attached."
#
# CI-review MAJOR fix (round 22): `_KNOWN_STALE_POLICY_ARNS` wrongly included
# `AmazonEKSViewPolicy` — no round of THIS script ever associated it; it is what
# `register-istio-access.sh` associates for the agent Lambda role, and what the multi-account
# onboarding docs provision for a MEMBER account's `AWSopsReadOnlyRole` (this script's own
# README-documented `ROLE_ARN=` override target for that case). A compliant operator running this
# script against `AWSopsReadOnlyRole` would have had its legitimate, documented EKS View grant
# silently stripped while this script printed "converged" — destructive on a principal this
# script does not own, the exact failure mode round 21 claimed to have closed. Fixed two ways:
# (1) `AmazonEKSViewPolicy` is dropped from the known-stale list — only `AdminViewPolicy` (this
# script's own round-18 shape) remains. (2) Auto-disassociation now runs ONLY when the effective
# principal is the DEFAULT worker task role (i.e. `ROLE_ARN` was not overridden away from
# `terraform output -raw worker_task_role_arn`) — for any overridden principal (the member-account
# `AWSopsReadOnlyRole` case), this script only LISTS and reports what is attached, never
# disassociates anything, since it has no basis for knowing what that principal's OTHER grants
# (from onboarding, or any other process) legitimately need.
set -euo pipefail

CHDIR="$(cd "$(dirname "$0")/../../../terraform/foundation" && pwd)"
# CI-review MINOR fix (round 24): prefixed like the ClusterRole/Binding themselves — an
# unprefixed generic group name could collide with a group a cluster already maps some other
# principal into, silently widening that principal's grant too.
K8S_GROUP="awsops-network-path-reader"
RBAC_MANIFEST="$(cd "$(dirname "$0")" && pwd)/network-path-reader-rbac.yaml"
# Policy ARNs this script's OWN earlier rounds are known to have associated on this Access Entry
# (round 18's AdminView only — NOT AmazonEKSViewPolicy, which this script never associated; see
# the round-22 comment above). Kept as a specific list rather than "whatever is currently
# attached" so a disassociate never touches a policy some other, unrelated process put there.
_KNOWN_STALE_POLICY_ARNS="arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy"

DEFAULT_ROLE_ARN="$(terraform -chdir="$CHDIR" output -raw worker_task_role_arn 2>/dev/null || true)"
ROLE_ARN="${ROLE_ARN:-$DEFAULT_ROLE_ARN}"
if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "null" ]; then
  echo "ERROR: worker_task_role_arn unavailable (is workers_enabled + apply done?). Pass ROLE_ARN=..." >&2
  exit 1
fi
IS_DEFAULT_PRINCIPAL=""
if [ -n "$DEFAULT_ROLE_ARN" ] && [ "$DEFAULT_ROLE_ARN" != "null" ] && [ "$ROLE_ARN" = "$DEFAULT_ROLE_ARN" ]; then
  IS_DEFAULT_PRINCIPAL=1
fi
if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <cluster-name> [<cluster-name> ...]" >&2
  exit 1
fi

# Union of the entry's CURRENT kubernetesGroups (if any) with $K8S_GROUP — never a replacement,
# so an unrelated group already bound to this shared principal's entry survives.
merged_kubernetes_groups() {
  local cluster="$1"
  local existing
  if ! existing=$(aws eks describe-access-entry --cluster-name "$cluster" --principal-arn "$ROLE_ARN" \
      --query 'accessEntry.kubernetesGroups' --output text 2>&1); then
    echo "  ERROR describing existing access entry on ${cluster} (cannot safely merge groups): $existing" >&2
    exit 1
  fi
  if [ "$existing" = "None" ] || [ -z "$existing" ]; then
    echo "$K8S_GROUP"
    return 0
  fi
  printf '%s\n%s\n' "$existing" "$K8S_GROUP" | tr '\t' '\n' | sort -u | tr '\n' ' '
}

disassociate_stale_policies() {
  local cluster="$1"
  local arns
  # CI-review MAJOR fix (round 21): a listing failure (AccessDenied, throttling, network) must NOT
  # be treated the same as "no policies associated" — that was round 20's fail-open bug. Fatal now.
  if ! arns=$(aws eks list-associated-access-policies --cluster-name "$cluster" --principal-arn "$ROLE_ARN" \
      --query 'associatedAccessPolicies[].policyArn' --output text 2>&1); then
    echo "  ERROR listing associated access policies on ${cluster} (cannot confirm 'converged' is" >&2
    echo "  actually true — refusing to report success): $arns" >&2
    exit 1
  fi
  if [ -z "$IS_DEFAULT_PRINCIPAL" ]; then
    # An overridden principal (e.g. a member account's AWSopsReadOnlyRole) is NOT this script's
    # to auto-converge — it may carry legitimate grants from onboarding or another process. List
    # only, never disassociate.
    if [ -n "$arns" ]; then
      echo "  principal is an overridden ROLE_ARN (not the default worker task role) — found"
      echo "  associated access policies but NOT auto-disassociating any of them (this script"
      echo "  only owns least-privilege convergence for its OWN default principal):"
      for arn in $arns; do echo "    $arn"; done
    fi
    return 0
  fi
  local arn found
  for arn in $arns; do
    found=""
    for stale in $_KNOWN_STALE_POLICY_ARNS; do
      [ "$arn" = "$stale" ] && found=1
    done
    if [ -z "$found" ]; then
      echo "  found an associated access policy ($arn) this script did not itself associate —"
      echo "  leaving it untouched (not one of this script's own known-stale ARNs)"
      continue
    fi
    echo "  found stale associated access policy $arn (from an earlier round of this script) —"
    echo "  disassociating (least-privilege now comes from the RBAC manifest below, not an"
    echo "  AWS-managed policy)"
    if ! derr=$(aws eks disassociate-access-policy --cluster-name "$cluster" --principal-arn "$ROLE_ARN" \
        --policy-arn "$arn" 2>&1); then
      echo "  ERROR disassociating $arn on ${cluster}: $derr" >&2
      exit 1
    fi
  done
}

echo "Principal: $ROLE_ARN"
echo "Kubernetes group: $K8S_GROUP (authorized via $RBAC_MANIFEST — apply that manifest separately"
echo "with kubectl once per cluster; this script only manages the IAM-side Access Entry)"
for C in "$@"; do
  echo "== ${C}: register minimal Node/Pod GET access =="
  # Only treat ResourceInUseException (already registered) as benign — surface real errors
  # (e.g. AccessDenied) instead of masking them as "already exists".
  if err=$(aws eks create-access-entry --cluster-name "$C" --principal-arn "$ROLE_ARN" \
      --type STANDARD --kubernetes-groups "$K8S_GROUP" 2>&1); then
    echo "  access entry created (kubernetes-groups=$K8S_GROUP)"
  elif printf '%s' "$err" | grep -q "ResourceInUseException"; then
    # Entry already exists (e.g. from a prior run, or created without the group) — make the
    # kubernetes-groups binding converge via an explicit update rather than assuming it's already
    # correct, so this script stays idempotent regardless of how the entry got there. Merged (not
    # replaced) so an unrelated group already on this shared principal's entry is never dropped.
    merged="$(merged_kubernetes_groups "$C")"
    # shellcheck disable=SC2206 -- deliberate word-splitting of a space-separated group list;
    # group names are drawn only from $K8S_GROUP and AWS's own kubernetesGroups response, never
    # from unsanitized external input, but quoted to avoid pathname (glob) expansion.
    read -r -a merged_arr <<< "$merged"
    if uerr=$(aws eks update-access-entry --cluster-name "$C" --principal-arn "$ROLE_ARN" \
        --kubernetes-groups "${merged_arr[@]}" 2>&1); then
      echo "  access entry already existed; kubernetes-groups converged to: $merged"
    else
      echo "  ERROR updating kubernetes-groups on ${C}: $uerr" >&2
      exit 1
    fi
  else
    echo "  ERROR creating access entry on ${C}: $err" >&2
    exit 1
  fi
  disassociate_stale_policies "$C"
done
echo "Done. Now apply the RBAC manifest once per cluster (requires cluster-admin k8s access):"
echo "  kubectl apply -f $RBAC_MANIFEST"
echo "Network Path checks sourced from a pod/node on: $* can then resolve live identity."
echo ""
# CI-review MAJOR fix (round 23): this used to unconditionally print
# "delete-access-entry --principal-arn $ROLE_ARN" — for the documented member-account
# `ROLE_ARN=...AWSopsReadOnlyRole` override case, that DELETES THE WHOLE ACCESS ENTRY, including
# any onboarding-provisioned `AmazonEKSViewPolicy` grant that principal legitimately carries for
# unrelated reasons — reproducing on this script's own printed output the exact shared-principal
# destructiveness rounds 21/22 fixed in the script's actual BEHAVIOR. The guidance is now scoped:
# remove only the "$K8S_GROUP" group (never the whole entry) for an overridden
# principal, and only offer full entry deletion for the DEFAULT worker task role, with an
# explicit warning to confirm nothing else is attached first.
echo "To revoke access for this feature specifically (works for either principal):"
echo "  # 1) remove ONLY the $K8S_GROUP group (never the whole entry on a shared principal):"
echo "  aws eks describe-access-entry --cluster-name <c> --principal-arn $ROLE_ARN \\"
echo "    --query 'accessEntry.kubernetesGroups' --output text"
echo "  # then re-run update-access-entry --kubernetes-groups with that list MINUS $K8S_GROUP"
echo "  # (an empty resulting list is fine; it does not delete the entry)"
if [ -n "$IS_DEFAULT_PRINCIPAL" ]; then
  echo "  # 2) this IS the default worker task role — full entry deletion is safe ONLY if"
  echo "  #    'aws eks list-associated-access-policies' and the kubernetesGroups list above are"
  echo "  #    BOTH confirmed empty (nothing else attached):"
  echo "  aws eks delete-access-entry --cluster-name <c> --principal-arn $ROLE_ARN"
else
  echo "  # 2) this is an OVERRIDDEN principal (e.g. a member account's AWSopsReadOnlyRole) —"
  echo "  #    do NOT delete-access-entry: it is not this script's to own, and other grants (e.g."
  echo "  #    onboarding's AmazonEKSViewPolicy) may legitimately depend on this entry surviving."
fi
