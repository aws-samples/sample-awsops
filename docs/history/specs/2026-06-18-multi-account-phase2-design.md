# Multi-account Phase 2 — implementation design (inventory · topology · EKS)

> ⚠️ **ARCHIVED — historical planning artifact, NOT a live spec.** Salvaged (PR #73) from a pruned worktree
> for reference only; the **shipped code, not this doc, is the source of truth.** Phase 1 (accounts registry +
> STS AssumeRole + `/accounts` + global selector + per-account bedrock/cost) is LIVE. Known issue flagged in
> the PR #73 review: Prereq #2 leans on the **v1 legacy `scripts/12-setup-multi-account.sh`** (writes
> `data/config.json` / `~/.steampipe`, restarts local EC2 Steampipe) — this **violates the v2 boundary**
> (Terraform/Fargate/Aurora + `scripts/v2/steampipe/aws.spc`); the aggregation prereq must be re-expressed via
> the v2 sync-Lambda path. Also confirm `__all__` authz intent + strict `account` param validation before any
> Phase-2 implementation. **Do not implement from this doc without reconciling against the v2 architecture.**

> Status: **READY TO IMPLEMENT once a target account is registered** (owner gate, AskUserQuestion 2026-06-18).
> Phase 1 (accounts registry + STS AssumeRole + `/accounts` + global selector + bedrock/cost per-account) is LIVE.
> Grounding: parallel Explore map `wf_ddefd2d1-8b6`. File:line refs are from feat/v2 @ 2318b72.

## TL;DR — Phase 2 is NOT a mechanical repeat of bedrock/cost
bedrock/cost were live-AWS-API pages → `assumedClient(accountId)` direct + client `__all__` fan-out. The 3
remaining surfaces are different:
- **inventory** & **topology** read Aurora `inventory_resources` (a DB cache), not live AWS. The schema is
  already multi-account-ready (`account_id` in the PK), but the **sync writer hardcodes `account_id='self'`**.
  → the work is sync-side (writer + readers), and all-accounts is a **server-side SQL GROUP BY**, not a client fan-out.
- **EKS** control-plane is mechanical, but the K8s **data-plane** token needs the assumed role to hold an
  **EKS Access Entry provisioned in the target account** → owner chose the **copy-paste CLI** model.

## Prerequisites (all gated on a registered target account)
1. A target account registered via `/accounts` (CFN `infra/cfn/awsops-target-account-role.yaml` + verified row).
2. For inventory/topology: the Steampipe **aggregator** (`scripts/12-setup-multi-account.sh`, `aws` = union of
   `aws_<id>` connections) must have a connection for each registered account, available to the sync Lambda's
   Steampipe config. **Open question to resolve at build time:** is step-12 wired to the `accounts` registry, or
   manual? If manual, add a step (or a sync-Lambda bootstrap) that materializes `aws_<id>` connections from the
   `accounts` table before the multi-account sync. This is the real upstream dependency.

---

## A. Inventory (effort: HIGH — sync-side)

### A1. Writer — `scripts/v2/steampipe/sync_lambda.py`
- Stop hardcoding `'self'`. Every Steampipe QUERY already `SELECT`s `account_id`; the aggregator returns rows
  from all accounts tagged with their id. Key the writes by the row's real `account_id`:
  - INSERT (~462-466): use `rec['account_id']` instead of literal `'self'`.
  - stale-delete WHERE (~468-471): scope per `(resource_type, account_id)` actually synced this run.
  - `inventory_sync_runs` UPSERT/UPDATE (~441-444, 472-473, 476-477): one row per `(resource_type, account_id)`.
- **SDK_SYNCS fetchers** `cloudfront_vpc_origin`, `alb_listener_rule`, `s3_public_access` are boto3 against the
  host only → wrap each in a per-account loop that uses cross-account creds (reuse the agent-side
  `agent/lambda/cross_account.py` pattern / port `web/lib/aws-assume.ts` semantics to Python): for each enabled
  account, AssumeRole `AWSopsReadOnlyRole` (ExternalId from the `accounts` row), tag results with that account_id.
  Host account → own role creds, account_id='self'.
- Account list source: read the `accounts` table (enabled rows) at sync start, or accept an `accounts` env/arg.

### A2. Readers — thread an `account` param (default keeps today's behavior)
- `web/lib/inventory.ts` `readResources` (:15 `account_id='self'`) and the sync-runs read (:19): add
  `account?: string` → `WHERE account_id = $n` when a single account, or `account_id = ANY($accounts)` /
  no-filter+`GROUP BY account_id` for all-accounts.
- Same de-hardcode in: `web/app/api/inventory/summary/route.ts` (:21-27,39), `…/[type]/route.ts`,
  `…/[type]/metrics/route.ts`, `web/lib/security-findings.ts` (:47,54,59,64) + `web/app/api/security/route.ts` (:21).
- Routes read `?account` (mirror bedrock/cost route guard: `__all__` → handled, not 400, because here all-accounts
  is a legit SQL query — see A3).

### A3. All-accounts UX — server-side SQL (NOT client fan-out)
Because every account's rows already coexist in one Aurora table, `__all__` is a single query (no
`account_id` filter, optionally `GROUP BY account_id` for per-account breakdown / a column in the table).
This diverges from bedrock/cost's client fan-out — simpler at read time. The route accepts `account=__all__`
and omits the filter; the page just sets the param.

### A4. Page — `web/app/inventory/[type]/page.tsx`
- `import { useActiveAccount, accountParam, ALL_ACCOUNTS } from '@/lib/account-context'`.
- Thread the active account into every fetch (`/api/inventory/[type]`, `/summary`, `/metrics`). For `__all__`,
  send `account=__all__` (server aggregates). Add an `account_id` column to the table view when all-accounts.
- EC2 KPI live cards (`web/lib/metrics.ts` CloudWatch/Pricing over instance ids): thread `assumedClient(account)`
  like bedrock — but only meaningful for a single account; for `__all__` either skip or fan-out (decide at build).

---

## B. Topology (effort: HIGH — depends on A)
Topology bottoms out on the same `inventory_resources` + materialized `topology_nodes/topology_edges`. **Blocked
on A** (inventory must have per-account rows first).
- **Materializer** `web/lib/graph-store.ts` (writes literal `'self'` at :51,61,68,69,84,108) +
  `scripts/v2/graph-rebuild.mjs`: materialize per `account_id` (the `topology_*` PKs already include
  `account_id`). graph-rebuild runs as a post-sync worker job → loop per account.
- **`/api/graph`** (`web/app/api/graph/route.ts`) + traversal `web/lib/graph-query.ts` (:28,36 `account_id='self'`):
  accept `?account` and parameterize.
- **Pages**: `web/app/topology/page.tsx` (the client-side flow graph) threads `?account` into its many
  `/api/inventory/*` + `/api/eks/*` fetches; `web/app/topology/resource/[id]/page.tsx` threads `?account` into
  `/api/graph`. For all-accounts on the flow page, fan-out over the inventory fetches it already loops.
- **EKS IP-target enrichment** in the flow page (`/api/eks/<c>/incluster`) for non-self accounts depends on C
  (cross-account EKS) — degrade to raw-IP targets when the cluster isn't cross-account-accessible.

---

## C. EKS (effort: HIGH; ADR-008 says "unsupported" → update it)
Owner decision: **provide a copy-paste create-access-entry CLI** so an admin grants the assumed role access in the
target account, the same way host clusters are onboarded today.

### C1. Control-plane (mechanical)
- `web/lib/aws.ts` `listClusters()` (:20-38, host-only `eksClient()` singleton :7-8): add `accountId?` →
  `assumedClient(accountId, EKSClient, {region})` (mirror `ceClient(accountId)` :11-13).
- `web/lib/eks-access.ts` `getTaskRoleArn`/`hasAccessEntry`: accept `accountId`.
- Routes `api/eks/route.ts`, `fleet/route.ts`, `[cluster]/incluster`, `[cluster]/register`, `summary`,
  `[cluster]/k8sgpt`: accept + forward `?account`. Page does `__all__` fan-out like bedrock/cost.
- `eks_registrations` table has `cluster_name` as PK with **no account_id** → add an `account_id` column to
  disambiguate same-named clusters across accounts (migration `migrations/<ULID>_eks_reg_account.sql`).

### C2. Data-plane (the real blocker → solved by the CLI guide)
- `web/lib/eks-incluster.ts` `eksToken()` (:19-32) presigns STS GetCallerIdentity with `fromNodeProviderChain()`
  (local task role). For a target cluster, presign with the **assumed** `AWSopsReadOnlyRole` creds of that account
  (use `credsForAccount(accountId)` from `web/lib/aws-assume.ts`), and the signed identity ARN must match an
  Access Entry on that cluster.
- **Access Entry copy-paste CLI** — extend `eks-access.ts onboardingGuide` (:43-54) to take an account context:
  for a cross-account cluster, emit (principalArn = the assumed role ARN in that account):
  ```
  aws eks create-access-entry   --cluster-name <C> --region <R> \
      --principal-arn arn:aws:iam::<acct>:role/AWSopsReadOnlyRole --type STANDARD
  aws eks associate-access-policy --cluster-name <C> --region <R> \
      --principal-arn arn:aws:iam::<acct>:role/AWSopsReadOnlyRole \
      --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy --access-scope type=cluster
  ```
  The EKS page shows this per registered cross-account cluster (admin pastes it in the target account) — exactly
  the host-onboarding UX, just with the assumed-role ARN.
- **Network caveat (document, don't silently fail):** private-endpoint clusters in another account/VPC aren't
  reachable from the host Fargate task without VPC peering/PrivateLink. The page should surface "endpoint
  unreachable" rather than hang. Public-endpoint clusters work once the Access Entry exists.

### C3. ADR-008 update
ADR-008 (:115) says K8s tables don't support multi-account. Add an addendum: cross-account EKS read is supported
via assumed-role Access Entries provisioned per target account (copy-paste CLI), public-endpoint (or
network-reachable) clusters only. Keep it read-only (`AmazonEKSViewPolicy`).

---

## Build order (after a target account is registered + verified)
1. **Inventory writer (A1)** + Steampipe aggregator connections (prereq #2) → confirm `inventory_resources` gets
   rows tagged with the real target account_id.
2. **Inventory readers + page (A2-A4)** → `/inventory` account selector works; verify single + all-accounts.
3. **Topology (B)** once inventory has per-account rows.
4. **EKS (C)** — control-plane threading + data-plane assumed-creds token + the access-entry CLI guide + ADR-008.
   Test with a public-endpoint cluster in the target account after pasting the CLI.

## Testing
- Unit (vitest): readers/route account-param threading; mergeX/SQL-GROUP-BY shape; EKS CLI string generation;
  eksToken uses assumed creds for non-self. (No live account needed for these.)
- Live (needs the registered account): sync writes per-account rows; `/inventory` + `/topology` + `/eks` render
  for the target account; all-accounts aggregates; EKS access-entry CLI grants read after paste.

## Out of scope / non-goals
- No mutation anywhere (read-only invariant holds; EKS uses View policy).
- No automatic cross-account Access-Entry provisioning (owner chose copy-paste CLI, not Terraform-in-member-account).
- No private-endpoint network plumbing (peering/PrivateLink) — documented as a limitation.
