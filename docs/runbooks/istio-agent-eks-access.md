# Runbook — grant the istio-read MCP access to an EKS cluster

The `istio-read` MCP (Container gateway) lists Istio CRDs (VirtualService, DestinationRule, …) by
calling the cluster's **Kubernetes API** as the **agent Lambda role** (`awsops-v2-agent-lambda`). EKS
authorization is **per IAM principal**: onboarding a cluster only grants the *web task role* an access
entry — the *agent Lambda role* is a different principal and gets `401/403` until it has its own entry.

AWSops does **not** create this entry in terraform on purpose: granting a principal k8s access is the
**cluster owner's** decision, and the terraform apply principal may not hold `eks:CreateAccessEntry` on
third-party clusters. So an operator with cluster permissions registers it out-of-band (read-only
**`AmazonEKSViewPolicy`**, cluster scope). This mirrors the v2 stance: AWSops never mutates a cluster.

**Why View, not AdminView (least privilege):** `view` grants read on namespaced resources + namespaces
but **not Secrets** and **not cluster-scoped resources** (nodes, etc.) — so an automated AI-agent
principal never gains cluster-wide Secret read. istio-read only LISTs namespaced Istio CRDs +
namespaces, so `view` suffices. Istio's standard install aggregates its CRD read into `view` (rbac
`aggregate-to-view`); if a cluster lacks that, apply a minimal istio-reader ClusterRole (Notes) — do
NOT widen to AdminView.

## Prerequisites
- `agentcore_enabled = true` and the foundation applied (the agent Lambda role exists).
- You hold `eks:CreateAccessEntry` + `eks:AssociateAccessPolicy` on the target cluster.

## Grant (idempotent)
```bash
scripts/v2/eks/register-istio-access.sh <cluster-name> [<cluster-name> ...]
# or, if you can't run terraform output:
ROLE_ARN=arn:aws:iam::<acct>:role/awsops-v2-agent-lambda \
  scripts/v2/eks/register-istio-access.sh <cluster-name>
```
The script reads `terraform output -raw agent_lambda_role_arn`, then runs
`aws eks create-access-entry` + `aws eks associate-access-policy` (ViewPolicy, `type=cluster`).

## Verify
```bash
aws eks list-access-entries --cluster-name <cluster-name> | grep agent-lambda
```
Then in chat, ask the Container agent for an Istio mesh overview on that cluster.

## Revoke
```bash
aws eks delete-access-entry --cluster-name <cluster-name> \
  --principal-arn arn:aws:iam::<acct>:role/awsops-v2-agent-lambda
```

## Notes
- istio-read only GET/LISTs Istio CRDs + namespaces — it never writes.
- **If `view` doesn't surface Istio CRDs** (cluster without Istio's view-aggregation), apply a minimal
  reader instead of widening to AdminView:
  ```yaml
  apiVersion: rbac.authorization.k8s.io/v1
  kind: ClusterRole
  metadata: { name: istio-reader-awsops, labels: { rbac.authorization.k8s.io/aggregate-to-view: "true" } }
  rules:
    - apiGroups: ["networking.istio.io", "security.istio.io"]
      resources: ["*"]
      verbs: ["get", "list", "watch"]
  ```
  (The aggregate-to-view label folds it into the `view` role the access policy already grants.)
- Private-only cluster endpoint? Set `istio_vpc_enabled = true` (attaches the Lambda to the private
  subnets) before the agent can reach the API server.
