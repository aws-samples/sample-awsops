# Decision Record — OpenCost (read-only) design + EKS-page / OpenCost coordination

> 2026-06-11 · `/co-agent:consensus` (review mode) · 5/5 cross-family panel (kiro opus-4.8 / kimi-k2.5 / glm-5 + codex/gpt + gemini) · Claude as chair.
> Status: **Accepted**. Refines ADR-029's OpenCost stance (mutating → read-only generator); coordinates with the concurrent EKS-page buildout (`docs/superpowers/specs/2026-06-11-eks-page-buildout-design.md`).

## Context
The v1→v2 gap audit (`docs/v1-v2-gap-audit-2026-06-10.md`) listed OpenCost as a P3 backlog item, originally framed as an **ADR-029 mutating action** (SQS+SFN/ECS one-shot that runs `helm install` → EKS write). Wave-1 (PR #31) is merged + deployed. The user proposed reframing OpenCost to fit the **read-only invariant** (AWSops never writes to a cluster / AWS resources; installs are out-of-band, per the ADR-035 K8sGPT-operator precedent). A separate session is concurrently building the **EKS-page buildout** (runtime registration = the v2 equivalent of v1 "register kubeconfig").

## Decision 1 — OpenCost = read-only config generator (NOT a mutating action)
- **No cluster write.** AWSops does **not** run `helm install`. It **generates** an install bundle the user runs out-of-band (mirrors ADR-035 operator-install runbook).
- **Config persistence**: a new Aurora table `opencost_config` (chart version + curated values + free-form values override), admin-write (ADR-023/031 admin model). Writing app config to our own Aurora is in scope; cluster/AWS write is not.
- **Downloadable bundle**: `values.yaml` + a complete `install.sh` = `aws eks update-kubeconfig --name <cluster> --region <region>` **+** `helm repo add/upgrade --install opencost … --version <X> -f values.yaml`.
  - **Panel correction**: the bundle **does** include `aws eks update-kubeconfig`. `eks-registry.isAllowed`/presigned-STS is the **dashboard's** read access; the **user's** local `helm install` needs the **user's own** kubeconfig. The earlier "no kubeconfig script" view conflated dashboard-read-access with user-install-access.
- **Read-only install-status detection**: GET the opencost deployment/service via the existing `eks-incluster.ts` presigned-STS path → "installed / not-installed" badge + (if installed) read cost data. **Must degrade on in-cluster 403** (registered ≠ readable if the Access Entry was revoked) — do not trust `isAllowed` alone (panel: opus #2, kimi #2).

## Decision 2 — Coordination: Option A + parallelization (panel: A=3, reject C=5/5)
- The **EKS-page buildout stays owned by the concurrent session** end-to-end (incl. `eks-registry.ts`, `/eks` list rewrite, `GET /api/eks` extension, `aws.ts` `ClusterInfo`). We do **not** re-implement another session's spec.
- **OpenCost proceeds now in NEW files only** (`web/lib/opencost.ts` + new route(s) + new page) — touching **none** of the shared surfaces (`web/app/api/eks/route.ts`, `web/lib/aws.ts` `ClusterInfo`, the migration integer).
- OpenCost gates on the **existing `ONBOARDED_EKS_CLUSTERS` env allow-list + `eks-incluster.ts`** now, and **switches to `eks-registry.isAllowed` only at merge** (a 1-line swap; the `isAllowed` signature is the locked contract).
- This is Option A enhanced by opus's "parallelize-D": resolves pure-A's only downside (OpenCost blocked if the EKS-page slips) while confining us to new files (no contention). **C rejected unanimously** (preempts the most-shared files).

## Verified facts (resolve panel concerns)
- `terraform/foundation/eks.tf:42` grants the web task role `eks:DescribeCluster/ListClusters/DescribeAccessEntry` → the EKS-page's "no new IAM / terraform apply 0" claim holds.
- `web/lib/admin.ts` `isAdmin` is landed: `cognito:groups` **OR** SSM admin-email allowlist, fail-closed (ADR-031 Phase 1).

## EKS-page review verdict (for the owning session)
**Sound + read-only-correct — APPROVE with one must-fix and notes:**
- 🔴 **Migration version**: spec/plan target **v10**, but ADR-032 P4 `prevention_insights` already took v10 (commit `86caf0b`). **Do not hardcode** — pick **max(version)+1 at apply** against the live `schema_migrations`, `ON CONFLICT (version) DO NOTHING`-guard the tracking insert (panel: opus). Same rule applies to OpenCost's `opencost_config` migration.
- 🟡 **Multi-task cache staleness**: the 30s in-memory allow-list cache is per-ECS-task; `registerCluster` busts only the local task → other Fargate tasks stay stale ≤30s (register→immediate 403 / list shows `entry-only`). Accept the 30s eventual consistency explicitly, shorten the TTL, or update the UI optimistically (panel: codex/gemini/kimi/glm).
- 🟡 `hasAccessEntry === null` (unknown) in `POST …/register` should be a **retryable 503**, not folded into `409 + guide` (panel: codex).
- 🟡 Use `Promise.allSettled` in `GET /api/eks` so one cluster's `DescribeAccessEntry` failure can't hang the list (panel: gemini); add a short per-cluster cache.
- 🟡 `register` should **404** a non-existent cluster (not 409+guide); DELETE should still purge a stale DB row when a cluster later becomes env-managed; never log the presigned bearer token / URL (panel: opus).
- 🔧 Chair-review correction: "no file overlap" was overstated — `GET /api/eks/route.ts` and `aws.ts ClusterInfo` **are** shared surfaces both efforts could touch (hence Decision 2's new-files-only rule for OpenCost).

## Consequences
- OpenCost ships as a read-only feature: **no `terraform apply`** for compute (only an `opencost_config` migration via psql + `make deploy`), no EKS/AWS write, no ADR-029 mutating substrate dependency.
- OpenCost is unblocked immediately (env allow-list), with a clean 1-line cutover to `eks-registry.isAllowed` once the EKS-page lands.
- Promote to a numbered ADR if a formal architecture record is later desired (kept here as a cross-review result to avoid ADR-number contention with concurrent work).
