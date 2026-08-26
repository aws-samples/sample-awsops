# P3-D EKS In-Cluster Visibility (base) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Spec: `docs/superpowers/specs/2026-06-09-awsops-v2-p3d-eks-incluster-design.md`. Steps `- [ ]`.

**Goal:** Read-only in-cluster K8s visibility (nodes/pods/deployments/services) for onboarded EKS clusters, surfaced as an EKS-page drill-in. Auth = the web task role's P1e Access Entry + ViewPolicy via a presigned-STS bearer token (mechanism validated live).

**Invariants:** no new IAM/Terraform except a static web env var; verifyUser-gate all routes; only onboarded clusters (allow-list); read-only; reuse F1/F2 components + the new sortable DataTable; existing 88 tests stay green.

---

### Task 1: `web/lib/eks-incluster.ts` — token + conn + list/normalize

**Files:** Create `web/lib/eks-incluster.ts`, `web/lib/eks-incluster.test.ts`; Modify `web/package.json`

- [ ] **Step 1: deps** — `cd /home/atomoh/awsops/web && npm install @smithy/signature-v4 @smithy/protocol-http @aws-crypto/sha256-js @aws-sdk/credential-providers` (peers of the existing @aws-sdk v3).
- [ ] **Step 2: `eksToken(cluster, region)`** — replicate `aws eks get-token` (verified format `k8s-aws-v1.aHR0cHM6L...`, ~2506 chars):
```ts
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

export async function eksToken(cluster: string, region: string): Promise<string> {
  const host = `sts.${region}.amazonaws.com`;
  const signer = new SignatureV4({ service: 'sts', region, sha256: Sha256, credentials: fromNodeProviderChain() });
  const req = new HttpRequest({
    method: 'GET', protocol: 'https:', hostname: host, path: '/',
    query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    headers: { host, 'x-k8s-aws-id': cluster }, // x-k8s-aws-id MUST be signed
  });
  const p = await signer.presign(req, { expiresIn: 60 });
  const qs = Object.entries(p.query as Record<string, string | string[]>)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v[0] : v)}`).join('&');
  const url = `https://${host}/?${qs}`;
  return `k8s-aws-v1.${Buffer.from(url).toString('base64url').replace(/=+$/, '')}`;
}
```
- [ ] **Step 3: `clusterConn(cluster)`** — `DescribeClusterCommand` (`@aws-sdk/client-eks`) → `{ endpoint, caPem: Buffer.from(cluster.certificateAuthority.data, 'base64') }`; 5-min in-memory cache (Map).
- [ ] **Step 4: `listInCluster(cluster, kind)`** — path map `{ nodes:'/api/v1/nodes', pods:'/api/v1/pods', deployments:'/apis/apps/v1/deployments', services:'/api/v1/services', namespaces:'/api/v1/namespaces' }`; HTTPS GET via `node:https` `request({ hostname, path, headers:{Authorization:`Bearer ${token}`}, agent:new https.Agent({ca:caPem}) })`; parse `.items`; **normalize** per the spec (nodes: name/status[Ready cond]/version/instanceType/zone/age; pods: name/namespace/phase/node/restarts/age; deployments: name/namespace/ready/upToDate/available/age; services: name/namespace/type/clusterIP/ports). Throw with the K8s `.message` on non-2xx.
- [ ] **Step 5: unit test** `eks-incluster.test.ts` — (1) `eksToken('c','ap-northeast-2')` starts `k8s-aws-v1.`, base64url-decodes to a URL with `X-Amz-Signature=` and `x-k8s-aws-id` in `X-Amz-SignedHeaders` (mock `fromNodeProviderChain` to static creds); (2) the per-kind normalizers map a mock K8s list JSON → expected flat rows. (jsdom not needed — node env.) Run: `cd web && npx vitest run lib/eks-incluster.test.ts`.
- [ ] **Step 6: LOCAL smoke (proves the real path before deploy)** — a throwaway script run from repo root with the deploy-host creds (which CAN auth to fsi-demo-cluster, verified):
```bash
cd /home/atomoh/awsops/web && AWS_REGION=ap-northeast-2 npx tsx -e "import('./lib/eks-incluster.ts').then(async m=>{for(const k of ['nodes','pods','deployments','services']){const r=await m.listInCluster('fsi-demo-cluster',k);console.log(k, r.length, JSON.stringify(r[0]||{}).slice(0,120));}})"
```
(If `tsx` unavailable, the controller runs this in T4; mark Step 6 as controller-verified.) Expected: nodes ~8, namespaces 13, real rows.
- [ ] **Step 7: Commit** — `git add web/lib/eks-incluster.ts web/lib/eks-incluster.test.ts web/package.json web/package-lock.json && git commit -m "feat(v2-p3d): eks-incluster lib — presigned-STS k8s token + DescribeCluster conn + list/normalize nodes/pods/deployments/services"`

---

### Task 2: `GET /api/eks/[cluster]/incluster` route

**Files:** Create `web/app/api/eks/[cluster]/incluster/route.ts`, `…/route.test.ts`

- [ ] **Step 1: failing test** — 401 unauth (verifyUser null); 404 when cluster not in `ONBOARDED_EKS_CLUSTERS`; 400 bad `kind`; 200 returns `{kind,rows}` (mock `@/lib/eks-incluster` listInCluster + `@/lib/auth` verifyUser). Mirror the inventory route test pattern.
- [ ] **Step 2: implement** — `export const dynamic='force-dynamic'`. `GET(req,{params:{cluster}})`: verifyUser gate → 401; `const allow=(process.env.ONBOARDED_EKS_CLUSTERS||'').split(',').filter(Boolean); if(!allow.includes(params.cluster)) 404`; `kind` from `new URL(req.url).searchParams` ∈ {nodes,pods,deployments,services,namespaces} else 400; `try { return Response.json({kind, rows: await listInCluster(params.cluster, kind)}) } catch(e){ return Response.json({status:'error',message:...}, {status:502}) }`.
- [ ] **Step 3: PASS** (`npx vitest run app/api/eks/\[cluster\]/incluster/route.test.ts`)
- [ ] **Step 4: Commit** — `git add web/app/api/eks && git commit -m "feat(v2-p3d): GET /api/eks/[cluster]/incluster — verifyUser-gated, onboarded allow-list, kind-validated in-cluster read"`

---

### Task 3: EKS drill-in page + nav link + web env

**Files:** Create `web/app/eks/[cluster]/page.tsx`; Modify `web/app/eks/page.tsx`, `terraform/foundation/workload.tf`

- [ ] **Step 1: drill-in page** (`'use client'`) — `useParams().cluster`; PageHeader (cluster name); a `SegmentedControl` tab `['Nodes','Pods','Deployments','Services']`; on tab change fetch `/api/eks/${cluster}/incluster?kind=${tab.toLowerCase()}`; render the sortable `<DataTable>` with per-kind columns (reuse the F1/F3 patterns); for pods/deployments/services add a namespace filter (Input or SegmentedControl from distinct `namespace`); loading/error with tokens. Reuse `@/components/ui/{PageHeader,SegmentedControl,DataTable,Input,Card}`.
- [ ] **Step 2: link from EKS list** — in `web/app/eks/page.tsx`, make each cluster row/name a `<Link href={`/eks/${name}`}>` (drill-in). Keep the existing cluster list/StatCards.
- [ ] **Step 3: web env** — `terraform/foundation/workload.tf` web container base `environment`: add `{ name = "ONBOARDED_EKS_CLUSTERS", value = join(",", var.onboard_eks_clusters) }` (static; no cross-resource ref). `terraform fmt; terraform validate; terraform plan` → only the web taskdef env addition (one-time revision), no other diffs.
- [ ] **Step 4: build** — `cd web && npm run build` clean; `/eks/[cluster]` + `/api/eks/[cluster]/incluster` in manifest.
- [ ] **Step 5: Commit** — `git add web/app/eks terraform/foundation/workload.tf && git commit -m "feat(v2-p3d): EKS drill-in page (Nodes/Pods/Deployments/Services tabs, sortable + ns filter) + cluster-row link + ONBOARDED_EKS_CLUSTERS web env"`

---

### Task 4: Deploy + verify (CONTROLLER)
- [ ] **Step 1:** full gate `cd web && npm run test && npm run build`.
- [ ] **Step 2 (local smoke, the real auth proof):** run the Task 1 Step 6 local smoke from the deploy host (creds can auth to fsi-demo-cluster) → confirm nodes/pods/deployments/services return real rows. If it fails, fix lib/eks-incluster before deploy.
- [ ] **Step 3:** `terraform plan -out` (visible) → `apply` (web taskdef env ONBOARDED_EKS_CLUSTERS — one revision); `make deploy`.
- [ ] **Step 4:** edge check `/eks/fsi-demo-cluster` 302; confirm the deployed BFF (task role Access Entry) serves the in-cluster data (browser, or note the local-smoke already proved the auth path). Report GREEN + counts.

---

## Self-Review
- Auth = task-role Access Entry (user-confirmed), token mechanism live-validated; no new IAM (P1e), only a static web env.
- Risk (Node token-presign) is de-risked by the local smoke (deploy-host creds auth to the cluster) BEFORE deploy.
- All routes verifyUser-gated + onboarded allow-list (no arbitrary-cluster SSRF); read-only (ViewPolicy).
- Reuses the new sortable DataTable + F1/F2 components; tests stay green.
