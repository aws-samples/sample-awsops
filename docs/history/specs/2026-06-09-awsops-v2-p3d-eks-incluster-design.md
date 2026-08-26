# AWSops v2 — P3-D EKS In-Cluster Visibility (base) Design

**Status:** Accepted. 2026-06-09. Auth approach confirmed by user ("access entry로 함") + mechanism validated live (`aws eks get-token` → `k8s-aws-v1.` token → K8s API returned NodeList/namespaces on fsi-demo-cluster, PUBLIC endpoint).

**Goal:** Give the v2 dashboard **read-only in-cluster Kubernetes visibility** — list nodes / pods / deployments / services of an onboarded EKS cluster — surfaced as a **drill-in from the EKS page**. This is the P3-D **base** layer (the in-cluster query the ADR-035 K8sGPT diagnosis layer later builds on); K8sGPT is NOT in this scope.

**Builds on P1e** (deployed): the web task role `awsops-v2-task` already has, per onboarded cluster, an **EKS Access Entry + `AmazonEKSViewPolicy`** (cluster-scoped read) + `eks:DescribeCluster`. **No new IAM/Terraform** — the auth is the existing P1e access-entry path the user confirmed.

---

## Decisions

- **Auth = BFF-direct via the task role's Access Entry** (user-confirmed). The Next.js BFF (Fargate, runs as `awsops-v2-task`) generates an **EKS bearer token by presigning an STS `GetCallerIdentity` GET** (the `aws-iam-authenticator` / `aws eks get-token` algorithm) and calls the cluster's K8s API directly. The **Access Entry + ViewPolicy** authorize the read. *(Not the agent-Lambda path — `awsops-v2-agent-lambda` has no access entry; the web task role does. Not aws-auth configmap — Access Entry per user.)*
  - Token = `k8s-aws-v1.` + base64url( presigned `https://sts.<region>.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15`, `X-Amz-Expires=60`, with header **`x-k8s-aws-id: <clusterName>` included in SignedHeaders** ). Verified the exact shape against `aws eks get-token` output (len ~2506, prefix `k8s-aws-v1.aHR0cHM6L...`).
- **Reachability**: onboarded cluster endpoints are PUBLIC (fsi-demo-cluster `endpointPublicAccess=true`, `0.0.0.0/0`); the BFF reaches them over NAT egress. TLS verified with the cluster CA (`certificateAuthority.data`, base64 PEM from DescribeCluster).
- **Scope of queries (read-only)**: `nodes` (core/v1), `pods` (core/v1, all namespaces), `deployments` (apps/v1, all namespaces), `services` (core/v1, all namespaces), `namespaces` (for the filter). All via the ViewPolicy (get/list/watch).
- **Cluster allow-list**: the BFF only queries **onboarded** clusters (validate the `cluster` route param against the onboarded set — env `ONBOARDED_EKS_CLUSTERS` injected from the `onboard_eks_clusters` tfvar, or the existing `/api/eks` list). Prevents arbitrary-cluster SSRF; non-onboarded clusters lack the access entry anyway (403).
- **Surface**: drill-in from the EKS page → `/eks/[cluster]` with tabs (Nodes / Pods / Deployments / Services), each a **sortable DataTable** (reuses the new sorting + StatePill). The existing `/eks` cluster list (P3-B) links each cluster row to its drill-in.

---

## Architecture

### Data layer — `web/lib/eks-incluster.ts`
- `eksToken(cluster, region)` → presigned-STS `k8s-aws-v1.` token. Uses `@smithy/signature-v4` `SignatureV4.presign()` (service `sts`, region, creds from the node provider chain = the task role) over an `@smithy/protocol-http` `HttpRequest` (GET, host `sts.<region>.amazonaws.com`, query `Action=GetCallerIdentity&Version=2011-06-15`, header `x-k8s-aws-id=<cluster>` so it's signed), `expiresIn: 60`; then `'k8s-aws-v1.' + base64url(formatUrl(presigned))` (strip `=` padding). `@aws-crypto/sha256-js` for the hash.
- `clusterConn(cluster)` → `{ endpoint, caPem }` from `DescribeClusterCommand` (`@aws-sdk/client-eks`, already a dep), 5-min cached.
- `listInCluster(cluster, kind)` → builds the K8s API path per `kind` (`/api/v1/nodes`, `/api/v1/pods`, `/apis/apps/v1/deployments`, `/api/v1/services`, `/api/v1/namespaces`), does an HTTPS GET via the `node:https` module with an `Agent({ ca: caPem })` + `Authorization: Bearer <token>`, parses the list, and **normalizes** to flat rows (see below). Throws on non-2xx (surface the K8s `message`).
- Normalized rows (per kind) — pick fields useful in a table:
  - nodes: name, status (Ready condition), roles (labels), version (kubeletVersion), instanceType (label), zone (label), age (creationTimestamp).
  - pods: name, namespace, status (phase), node (spec.nodeName), restarts (sum containerStatuses), age.
  - deployments: name, namespace, ready (`status.readyReplicas/spec.replicas`), upToDate, available, age.
  - services: name, namespace, type, clusterIP, ports (joined), age.

### API — `web/app/api/eks/[cluster]/incluster/route.ts`
- `GET` (verifyUser-gated, `dynamic='force-dynamic'`). Query `?kind=nodes|pods|deployments|services|namespaces`. Validate `cluster` ∈ onboarded allow-list → else 404; validate `kind` ∈ set → else 400. Returns `{ kind, rows }`. 5xx with the K8s error message on failure (502 if the cluster API errors, 401 already handled by verifyUser).

### UI — `web/app/eks/[cluster]/page.tsx` + EKS list link
- `'use client'` drill-in: PageHeader (cluster name + version/status from `/api/eks`), a SegmentedControl tab (Nodes/Pods/Deployments/Services), fetches `/api/eks/<cluster>/incluster?kind=<tab>`, renders the sortable `<DataTable>` with per-kind columns; a namespace filter (Input/SegmentedControl) for pod/deploy/svc; loading/error states with tokens.
- `web/app/eks/page.tsx` (existing P3-B): make each cluster row link to `/eks/<name>` (drill-in).

### Terraform — env only
- `workload.tf` web container env: add `ONBOARDED_EKS_CLUSTERS = join(",", var.onboard_eks_clusters)` (static; allow-list source). No IAM change (P1e's access entry + ViewPolicy + eks:DescribeCluster already on `awsops-v2-task`). The `/api/eks` route already lists clusters.

---

## Verification
- **Local smoke (pre-deploy)**: the deploy host's role (`mgmt-vpc-VSCode-Role`) CAN auth to fsi-demo-cluster's K8s API (verified — returned NodeList/namespaces). Run the Node `listInCluster('fsi-demo-cluster', kind)` locally (deploy-host creds) for each kind → assert real rows. This validates the Node token-presign + CA + normalization BEFORE deploy.
- **Unit (vitest)**: `eksToken` format (starts `k8s-aws-v1.`, decodes to an sts presigned URL containing `X-Amz-Signature` + `x-k8s-aws-id`); normalization functions (mock K8s list JSON → expected rows); GET route 401 unauth / 404 non-onboarded / 400 bad kind.
- **Live (controller)**: `make deploy` → browser drill-in `/eks/fsi-demo-cluster` shows real nodes/pods/deployments/services (the task role's Access Entry authorizes). 8 nodes + 13 namespaces expected.

## Out of scope (later)
- K8sGPT diagnosis layer (ADR-035, separate). 
- Container-agent MCP tool for in-cluster (would need an access entry for the agent-lambda role).
- Write/exec/logs (ViewPolicy is read-only); private-only-endpoint clusters (need VPC reachability); pod logs/describe drill-down.
