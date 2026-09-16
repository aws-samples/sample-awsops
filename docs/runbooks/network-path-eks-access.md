# Runbook — grant the Network Path Check access to an EKS cluster's Nodes/Pods

The **Network Path Check** (`network_path_check_enabled`) resolves a pod/node source's LIVE
identity via `resolve_live_identity()` in `scripts/v2/workers/network_path.py` — it GETs
`/api/v1/nodes/{name}` (and, for a pod source, `/api/v1/namespaces/{ns}/pods/{name}`) against the
cluster's own Kubernetes API, presigning the request as the **worker Fargate task role**
(`awsops-v2-worker-task`; the `network_path` job runs entirely inside the worker Fargate task, not
a Lambda — see `network-path.tf`'s own header comment). EKS authorization is **per IAM principal**:
host Terraform onboarding grants the *web task role* an access entry (`eks.tf`) — the *worker task
role* is a different principal and needs its own entry for host-cluster pod/node checks.
Member clusters use the shared member role described below; its existing web-query grants must
survive Network Path Check setup and removal.

AWSops does **not** create this entry in terraform on purpose: granting a principal k8s access is
the **cluster owner's** decision, and the terraform apply principal may not hold
`eks:CreateAccessEntry` on third-party clusters. So an operator with cluster permissions registers
it out-of-band, same as the istio-read MCP's own access entry
(`docs/runbooks/istio-agent-eks-access.md`).

**CI-review MAJOR fix (round 20) — the principal to register depends on the SOURCE's account, NOT
always the worker task role.** `_assumed_session()` (`network_path.py`) returns the worker task
role's own credentials directly ONLY when the pod/node source's account is the HOST account —
for a target/MEMBER-account source, it assumes that account's `AWSopsReadOnlyRole` instead, and
`_default_k8s_get()`'s presigned bearer token is generated from whichever session was actually
returned. Registering the worker task role's Access Entry (this script's default) does nothing
for a member-account cluster's own EKS API — every GET still 403s, since the principal that
actually authenticates there is `AWSopsReadOnlyRole`, not the worker task role. **Host-account
cluster → register the worker task role (the default below). Member-account cluster → register
that target account's `AWSopsReadOnlyRole` via `ROLE_ARN=arn:aws:iam::<member-acct>:role/
AWSopsReadOnlyRole`.**

**Why a minimal Kubernetes-group RBAC binding, not an AWS-managed access policy (unlike
istio-read's `AmazonEKSViewPolicy`):** `resolve_live_identity()` GETs `/api/v1/nodes/{name}` — a
**cluster-scoped** resource — plus one namespaced Pod GET. `AmazonEKSViewPolicy` mirrors the k8s
`view` ClusterRole: it includes namespaces but **does not grant node reads**, so View alone is
insufficient. The next AWS-managed step up, `AmazonEKSAdminViewPolicy` (what `eks.tf` binds for the
web task role's own manual-registration Access Entry), DOES cover cluster-scoped resources — but it
also grants cluster-wide `get`/`list`/`watch` on **every Secret in every namespace**, to the SAME
shared worker task role every other job type runs under. That is a materially larger grant than
this feature needs (exactly one Node GET, one Pod GET), and it is the exact pattern
`register-istio-access.sh` explicitly warns against ("do NOT widen to AdminView — that would grant
cluster-wide Secret read to an automated agent") — round-19 CI review flagged this script as the
one place that violated its own repo's documented convention.

**The feature-specific grant:** bind the selected principal's Access Entry to a Kubernetes **group**
(`awsops-network-path-reader` — prefixed like the ClusterRole/Binding themselves, round-24 CI
review: an unprefixed generic name could collide with a group a cluster already maps some other
principal into) via `--kubernetes-groups`, rather than an AWS-managed access policy, and
author a minimal `ClusterRole` (`network-path-reader-rbac.yaml`) granting **only** `get` on
`nodes` and `pods` to that group — no Secret access, no LIST/WATCH, no other resource kind. An
Access Entry's `--kubernetes-groups` only establishes the IAM-principal → k8s-group mapping;
authorization still requires the `ClusterRoleBinding` in that manifest, applied separately via
`kubectl` (an EKS Access Entry alone cannot grant custom fine-grained RBAC — only AWS-managed
access policies or your own RBAC objects can).
For a shared member role, this group is additive to the web-query
`AmazonEKSViewPolicy` and `awsops:eks-readonly` node-read group. Removing this feature's group
does not revoke read access granted independently by those other bindings.

## Prerequisites
- `workers_enabled = true` and the foundation applied (the worker task role exists).
- `network_path_check_enabled = true` (see the README's flag table — this feature only queries
  live K8s/EC2 state for a pod/node source once this AND the Access Entry + RBAC below are all
  true; without them, such a check still runs but fails closed on that one source with a bounded
  "could not resolve pod/node identity" error, per `resolve_live_identity()`'s own AccessDenied
  handling).
- Configure AWS CLI credentials/region and the kubectl context for the target cluster.
  `ROLE_ARN` chooses the principal receiving access; it does not switch the operator's AWS account.
- You hold `eks:CreateAccessEntry`, `eks:UpdateAccessEntry`, `eks:DescribeAccessEntry` and
  `eks:ListAssociatedAccessPolicies` on the target cluster. Default-worker stale-policy cleanup
  also requires `eks:DisassociateAccessPolicy`. You need cluster-admin (or equivalent RBAC-write)
  Kubernetes access for the `kubectl apply` step.

## Grant (idempotent)
```bash
# Host-account cluster (default — registers the worker task role):
scripts/v2/eks/register-network-path-access.sh <cluster-name> [<cluster-name> ...]
# or, if you can't run terraform output:
ROLE_ARN=arn:aws:iam::<host-acct>:role/awsops-v2-worker-task \
  scripts/v2/eks/register-network-path-access.sh <cluster-name>

# Member-account cluster (registers that account's AWSopsReadOnlyRole instead — see the callout
# above; the worker task role is NOT the authenticating principal there):
ROLE_ARN=arn:aws:iam::<member-acct>:role/AWSopsReadOnlyRole \
  scripts/v2/eks/register-network-path-access.sh <cluster-name>

kubectl apply -f scripts/v2/eks/network-path-reader-rbac.yaml
```
The script reads `terraform output -raw worker_task_role_arn` as its default (host-account case
only) unless `ROLE_ARN` overrides it, then runs `aws eks create-access-entry` (or
`update-access-entry` if the entry already exists) binding whichever role to the
`awsops-network-path-reader` Kubernetes group, preserving every existing group. It adds no
AWS-managed policy. For the resolved default worker task role, it removes only the known-stale
`AmazonEKSAdminViewPolicy` association from this script's earlier behavior; other policies remain.
For a member or other overridden principal, it lists and reports policies without disassociating
any of them. The `kubectl apply` step authorizes this feature's group (`get` on `nodes`/`pods`
only) — run it once per cluster, against whichever cluster this Access Entry targets.

## Verify
```bash
# <principal-arn> = whichever role you registered above (worker task role, or a member account's
# AWSopsReadOnlyRole)
aws eks list-access-entries --cluster-name <cluster-name>
aws eks describe-access-entry --cluster-name <cluster-name> --principal-arn <principal-arn> \
  --query 'accessEntry.kubernetesGroups'
aws eks list-associated-access-policies --cluster-name <cluster-name> --principal-arn <principal-arn>
kubectl get clusterrolebinding awsops-network-path-reader
```
Confirm `awsops-network-path-reader` is present and other groups have been retained.
An empty access-policy list is expected only for a dedicated default worker entry with no other
grants. A shared member `AWSopsReadOnlyRole` legitimately has `AmazonEKSViewPolicy` for web queries,
and may retain `awsops:eks-readonly` in its group list. **Do not disassociate that View policy or
remove unrelated groups.** A non-empty policy list alone is not an error. Review unexpected
associations with the cluster owner; the script intentionally does not remove policies from an
overridden principal.

Then create a Network Path Check whose source is a pod/node on that cluster and confirm the run's
live-identity step no longer reports an AccessDenied.

## Revoke
For either principal, remove only this feature's group. First inspect the current grants:

```bash
aws eks describe-access-entry --cluster-name <cluster-name> --principal-arn <principal-arn> \
  --query 'accessEntry.kubernetesGroups' --output json
aws eks list-associated-access-policies --cluster-name <cluster-name> --principal-arn <principal-arn>
```

Prepare `remaining-groups.json` as a JSON array containing **every current group except
`awsops-network-path-reader`**. Preserve `awsops:eks-readonly` and any other group; use `[]` only
when no group remains. Re-read the current groups before applying the reviewed list because
`update-access-entry` replaces the entire group list.
See [Update access entries](https://docs.aws.amazon.com/eks/latest/userguide/updating-access-entries.html)
and the [UpdateAccessEntry API](https://docs.aws.amazon.com/eks/latest/APIReference/API_UpdateAccessEntry.html);
group permissions and associated access-policy permissions are additive.

```bash
aws eks update-access-entry --cluster-name <cluster-name> --principal-arn <principal-arn> \
  --kubernetes-groups file://remaining-groups.json
```

Only after confirming that no other principal uses `awsops-network-path-reader` on this cluster
may the owner remove its shared RBAC objects:

```bash
kubectl delete -f scripts/v2/eks/network-path-reader-rbac.yaml
```

**Do not delete a shared member Access Entry or disassociate its policies.** Those grants may
still serve EKS web queries or other features. Full entry deletion is an optional owner action
only for the resolved default worker task role when the entry belongs solely to this feature
and both its remaining group list and policy-association list are confirmed empty.

## Notes
- The worker task role also needs the target account registered (ENABLED row in the `accounts`
  table) and, for a target-account source, the target account's `AWSopsReadOnlyRole` trust policy
  to include this principal. `infra/cfn/awsops-target-account-role.yaml` now takes an OPTIONAL
  `WorkerTaskRoleArn` parameter for exactly this (additive — a target account onboarded before this
  parameter existed keeps working for the web task role, and gains worker-driven reads once
  re-deployed with it set); see `docs/runbooks/onboard-target-account.md`'s Prerequisites. This is
  the SAME trust policy the `sg-rules` worker grant shares — set `WorkerTaskRoleArn` once and both
  workers gain member-account access to that target account, not something this script or the
  Access Entry above manages on its own.
- `resolve_live_identity()` never trusts a check definition's stale `eni_id`/`subnet_id` fields as
  already-verified — every pod/node source is re-confirmed against this live read on every run.
- This grant is per-cluster; a fleet with multiple onboarded clusters needs the script run once per
  cluster that will be used as a Network Path Check source.
