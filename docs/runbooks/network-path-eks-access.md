# Runbook — grant the Network Path Check access to an EKS cluster's Nodes/Pods

The **Network Path Check** (`network_path_check_enabled`) resolves a pod/node source's LIVE
identity via `resolve_live_identity()` in `scripts/v2/workers/network_path.py` — it GETs
`/api/v1/nodes/{name}` (and, for a pod source, `/api/v1/namespaces/{ns}/pods/{name}`) against the
cluster's own Kubernetes API, presigning the request as the **worker Fargate task role**
(`awsops-v2-worker-task`; the `network_path` job runs entirely inside the worker Fargate task, not
a Lambda — see `network-path.tf`'s own header comment). EKS authorization is **per IAM principal**:
onboarding a cluster only grants the *web task role* an access entry (`eks.tf`) — the *worker task
role* is a different principal and gets `403` on every pod/node check until it has its own entry.

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
`view` ClusterRole, which has **no cluster-scoped resources at all** (`eks.tf`'s own comment on the
web task role's Access Entry notes plainly that "listing nodes 403s" under View), so it cannot be
reused as-is. The next AWS-managed step up, `AmazonEKSAdminViewPolicy` (what `eks.tf` binds for the
web task role's own manual-registration Access Entry), DOES cover cluster-scoped resources — but it
also grants cluster-wide `get`/`list`/`watch` on **every Secret in every namespace**, to the SAME
shared worker task role every other job type runs under. That is a materially larger grant than
this feature needs (exactly one Node GET, one Pod GET), and it is the exact pattern
`register-istio-access.sh` explicitly warns against ("do NOT widen to AdminView — that would grant
cluster-wide Secret read to an automated agent") — round-19 CI review flagged this script as the
one place that violated its own repo's documented convention.

**The fix:** bind the worker task role's Access Entry to a Kubernetes **group**
(`awsops-network-path-reader` — prefixed like the ClusterRole/Binding themselves, round-24 CI
review: an unprefixed generic name could collide with a group a cluster already maps some other
principal into) via `--kubernetes-groups`, rather than an AWS-managed access policy, and
author a minimal `ClusterRole` (`network-path-reader-rbac.yaml`) granting **only** `get` on
`nodes` and `pods` to that group — no Secret access, no LIST/WATCH, no other resource kind. An
Access Entry's `--kubernetes-groups` only establishes the IAM-principal → k8s-group mapping;
authorization still requires the `ClusterRoleBinding` in that manifest, applied separately via
`kubectl` (an EKS Access Entry alone cannot grant custom fine-grained RBAC — only AWS-managed
access policies or your own RBAC objects can).

## Prerequisites
- `workers_enabled = true` and the foundation applied (the worker task role exists).
- `network_path_check_enabled = true` (see the README's flag table — this feature only queries
  live K8s/EC2 state for a pod/node source once this AND the Access Entry + RBAC below are all
  true; without them, such a check still runs but fails closed on that one source with a bounded
  "could not resolve pod/node identity" error, per `resolve_live_identity()`'s own AccessDenied
  handling).
- You hold `eks:CreateAccessEntry` + `eks:UpdateAccessEntry` on the target cluster (for the IAM
  side), AND cluster-admin (or equivalent RBAC-write) Kubernetes access (for the `kubectl apply`
  RBAC side).

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
`awsops-network-path-reader` Kubernetes group — no AWS-managed access policy is associated (a stale one
from an earlier run is actively disassociated, since `update-access-entry` alone doesn't remove
it). The `kubectl apply` step is what actually authorizes that group (`get` on `nodes`/`pods`
only) — run it once per cluster, against whichever cluster this Access Entry targets.

## Verify
```bash
# <principal-arn> = whichever role you registered above (worker task role, or a member account's
# AWSopsReadOnlyRole)
aws eks list-access-entries --cluster-name <cluster-name>
aws eks describe-access-entry --cluster-name <cluster-name> --principal-arn <principal-arn> \
  --query kubernetesGroups
aws eks list-associated-access-policies --cluster-name <cluster-name> --principal-arn <principal-arn>
  # should be EMPTY — a non-empty result means a stale AWS-managed policy (e.g. from an earlier
  # AdminView-era run) is still attached and needs the script re-run or a manual disassociate
kubectl get clusterrolebinding awsops-network-path-reader
```
Then create a Network Path Check whose source is a pod/node on that cluster and confirm the run's
live-identity step no longer reports an AccessDenied.

## Revoke
```bash
aws eks delete-access-entry --cluster-name <cluster-name> --principal-arn <principal-arn>
# optional — only if no other principal is bound to the awsops-network-path-reader group on this cluster:
kubectl delete -f scripts/v2/eks/network-path-reader-rbac.yaml
```

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
