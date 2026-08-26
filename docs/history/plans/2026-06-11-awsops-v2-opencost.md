# AWSops v2 — OpenCost (read-only config generator) Implementation Plan

> Decision record: `docs/reviews/2026-06-11-opencost-readonly-and-eks-coordination-consensus.md`. Recon: 6-agent `opencost-recon`.
> **Read-only**: AWSops never writes to a cluster/AWS. It saves config to its own Aurora, **generates** a downloadable install bundle the user runs out-of-band, and **reads** install-status via presigned-STS. Mirrors ADR-035; refines ADR-029's OpenCost stance.
> Branch `feat/v2-opencost` (off integrated feat/v2 + Wave-1). All work TDD, one commit/task, `web` vitest green after each.

## Scope discipline (consensus Decision 2)
- **NEW files only.** Do NOT edit the shared surfaces: `web/app/api/eks/route.ts`, `web/lib/aws.ts` `ClusterInfo`, `web/lib/eks-incluster.ts` (import its exports read-only; do not modify).
- **Allow-list = `ONBOARDED_EKS_CLUSTERS` env now**, isolated in ONE wrapper (`opencost-allowlist.ts`) → **1-line swap to `eks-registry.isAllowed` at merge** once the EKS-page lands.
- **Sanctioned shared touches** (additive only): `schema.sql` tail-append (migration) + a 1-line nav entry in `Sidebar.tsx`/`CommandPalette.tsx`/`i18n.ts`.
- **Migration version**: worktree schema.sql is at v9 → this block is the next sequential. **CONTROLLER reconciles at apply**: `SELECT max(version)+1` against LIVE Aurora and renumber if the concurrent ADR-032 P4 (v10) / EKS-page already took it (`ON CONFLICT (version) DO NOTHING`; never let a collision silently mask).

## Conventions
- thin-BFF: logic in `web/lib` pure/data fns; routes orchestrate. Root `/api/*` fetch. `verifyUser` (read) / `isAdmin` (write, ADR-031: cognito group OR SSM email, fail-closed). `force-dynamic`.
- Pure fns inject params (no `process.env`/`Date.now`/`Math.random`) — determinism is load-bearing (ADR-035 reproducibility).
- vitest: `lib/**/*.test.ts` node env; `app/**/*.test.ts`; components jsdom pragma.
- v1 helm ground truth: `scripts/07-setup-opencost.sh:83-104` — repo `opencost https://opencost.github.io/opencost-helm-chart`, chart `opencost/opencost`, ns `opencost`; curated keys `opencost.exporter.defaultClusterId`, `opencost.exporter.aws.service_account_region`, `opencost.prometheus.internal.serviceName=prometheus-server`, `.namespaceName=opencost`, `.port=80`. Use the idempotent `helm upgrade --install … --create-namespace` form (not v1's install/upgrade branch).

---

### Task 1: `web/lib/opencost.ts` — pure render (values.yaml + install.sh)

**Files:**
- Create: `web/lib/opencost.ts`
- Test: `web/lib/opencost.test.ts`

- [ ] **Step 1 (RED):** `web/lib/opencost.test.ts`: `renderValuesYaml(cfg)` determinism (twice → `toBe` identical) + **stable key order**, curated keys present with correct dotted nesting + injected `defaultClusterId`/region, free-form `override` merges and wins; `renderInstallSh({cluster,region,chartVersion})` contains exact `aws eks update-kubeconfig --name <cluster> --region <region>`, repo URL, `helm upgrade --install opencost opencost/opencost -n opencost --create-namespace -f values.yaml`, `set -euo pipefail`; **chartVersion optional (P2 gate fix)**: when `chartVersion` is non-empty → `--version <X>` present; when empty/undefined → `--version` **absent** (v1 `07-setup-opencost.sh` installs latest; pinning is opt-in for reproducibility) — assert BOTH branches; **shell-injection**: a cluster/region with a metachar throws (conservative regex); **no-secret**: assert the install.sh contains NO token/presigned URL (it's `update-kubeconfig` + helm only).
- [ ] **Step 2 (GREEN):** `web/lib/opencost.ts` — `interface OpencostCuratedValues` + `interface OpencostConfig {chartVersion?: string; values; override?}` (chartVersion **optional**); `DEFAULT_CHART_VERSION = ''` (empty = latest, matching v1; one-line comment: "pin a specific opencost-helm-chart version here for reproducible bundles — recommended"), `DEFAULT_CURATED_VALUES` const (bedrock.MODEL_PRICING style); `renderValuesYaml` (hand-built YAML, **stable/sorted key order**, NO yaml dep); `renderInstallSh` (accepts region as param — do NOT read env here; emits `--version` only when chartVersion non-empty; never embeds any token/presigned URL); `assertSafeName(s)` (`/^[A-Za-z0-9._-]+$/`, throw on violation). Ported-from-v1 header (cite `scripts/07-setup-opencost.sh` + ADR-035).
- [ ] **Step 3 (commit):** `cd web && npx vitest run lib/opencost.test.ts` green. `git add web/lib/opencost.ts web/lib/opencost.test.ts && git commit -m "feat(v2-opencost): pure values.yaml + install.sh render (read-only, shell-injection-guarded)"`

---

### Task 2: `web/lib/opencost-allowlist.ts` — isolated allow-list (isAllowed swap-point)

**Files:**
- Create: `web/lib/opencost-allowlist.ts`
- Test: `web/lib/opencost-allowlist.test.ts`

- [ ] **Step 1 (RED+GREEN):** test + impl `isClusterOnboarded(cluster: string): boolean` = `(process.env.ONBOARDED_EKS_CLUSTERS||'').split(',').filter(Boolean).includes(cluster)` (mirror `incluster/route.ts:10`). One-line JSDoc: "THE swap-point — replace body with `eks-registry.isAllowed(cluster)` once the EKS-page lands." Tests: membership, empty/whitespace env, absent.
- [ ] **Step 2 (commit):** vitest green. `git add web/lib/opencost-allowlist.ts web/lib/opencost-allowlist.test.ts && git commit -m "feat(v2-opencost): isolated cluster allow-list (env now; eks-registry.isAllowed swap-point)"`

---

### Task 3: Aurora `opencost_config` + `web/lib/opencost-config.ts`

**Files:**
- Modify: `terraform/foundation/data/schema.sql`
- Create: `web/lib/opencost-config.ts`
- Test: `web/lib/opencost-config.test.ts`

- [ ] **Step 1 (migration):** APPEND-ONLY at schema.sql tail (after the current last `-- ===` block): `CREATE TABLE IF NOT EXISTS opencost_config (cluster TEXT PRIMARY KEY, chart_version TEXT, config JSONB NOT NULL DEFAULT '{}'::jsonb, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());` + `INSERT INTO schema_migrations (version, description) VALUES (<N>, 'opencost_config: read-only OpenCost install config') ON CONFLICT (version) DO NOTHING;`. **The version `<N>` is PROVISIONAL (file is at v9 → 10)** — ⚠️ **P2 gate fix**: ADR-032 P4 `prevention_insights` already holds v10 on its branch and `ON CONFLICT DO NOTHING` would **silently mask** a duplicate. So Task 7 Step 1 **MUST** reconcile against the LIVE `schema_migrations` (`SELECT max(version)`) and renumber `<N>` to live-max+1 **before** psql; the migration is **not considered applied** until the `schema_migrations` row is confirmed present at the chosen `<N>` (fail loud, never assume the masked-conflict case).
- [ ] **Step 2 (RED):** `web/lib/opencost-config.test.ts` (mirror `agent-space.test.ts`): `vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }))` + `vi.mock('@/lib/catalog', () => ({ writeAudit }))`. Cases: `getOpencostConfig` → null when `AURORA_ENDPOINT` unset (no query) / row mapping / null on missing row; `upsertOpencostConfig` → ON CONFLICT UPSERT SQL + params + `writeAudit` called; degrade to null/false on query throw.
- [ ] **Step 3 (GREEN):** `web/lib/opencost-config.ts` (mirror `agent-space.ts`): `getOpencostConfig(cluster): Promise<OpenCostConfigRow|null>` (`if (!process.env.AURORA_ENDPOINT) return null`), `upsertOpencostConfig({cluster, chartVersion, config, updatedBy}): Promise<boolean>` (INSERT … ON CONFLICT (cluster) DO UPDATE + `writeAudit({actor, action:'opencost.config.upsert', objectType:'opencost_config', objectId:cluster})`), degrade-safe (catch → null/false, never throw).
- [ ] **Step 4 (commit):** vitest green. `git add terraform/foundation/data/schema.sql web/lib/opencost-config.ts web/lib/opencost-config.test.ts && git commit -m "feat(v2-opencost): opencost_config Aurora table + degrade-safe store (migration tail-append, controller reconciles version)"`

---

### Task 4: `web/lib/opencost-status.ts` — read-only install detection (reuse eks-incluster)

**Files:**
- Create: `web/lib/opencost-status.ts`
- Test: `web/lib/opencost-status.test.ts`

- [ ] **Step 1 (RED):** `web/lib/opencost-status.test.ts`: `vi.mock('@/lib/eks-incluster')` (do NOT modify that module). `pickOpencostDeployment(rows)` pure: finds a `DeploymentRow` named `opencost` in ns `opencost`. `detectOpencostInstall(cluster)`: installed=true when present; **403/any error → degrade `{installed:false, reason:'unreachable'}` (NOT throw)**; not-found → `{installed:false}`.
- [ ] **Step 2 (GREEN):** `web/lib/opencost-status.ts` — import `{ listInCluster }` read-only from `@/lib/eks-incluster`; `detectOpencostInstall(cluster)` calls `listInCluster(cluster, 'deployments')`, runs `pickOpencostDeployment`, returns `{installed, ready, deployment|null, reason?}`; wrap in try/catch → degraded result on any error (403 = entry revoked).
- [ ] **Step 3 (commit):** vitest green; confirm `eks-incluster.test.ts` unchanged (no edit to that file). `git add web/lib/opencost-status.ts web/lib/opencost-status.test.ts && git commit -m "feat(v2-opencost): read-only install-status via eks-incluster presigned-STS (403-degrade)"`

---

### Task 5: BFF routes — config GET/PUT + status + bundle

**Files:**
- Create: `web/app/api/opencost/[cluster]/route.ts`
- Create: `web/app/api/opencost/[cluster]/status/route.ts`
- Create: `web/app/api/opencost/[cluster]/bundle/route.ts`
- Test: `web/app/api/opencost/[cluster]/route.test.ts`
- Test: `web/app/api/opencost/[cluster]/status/route.test.ts`
- Test: `web/app/api/opencost/[cluster]/bundle/route.test.ts`

- [ ] **Step 1 (RED):** three route tests (mirror `customization/route.test.ts` + `incluster/route.test.ts` + `cost/route.test.ts`): mock `@/lib/auth`, `@/lib/admin`, `@/lib/opencost-allowlist`, `@/lib/opencost-config`, `@/lib/opencost-status`, `@/lib/opencost`. Assert — **config route**: GET 401 unauth / 404 not-onboarded / 200 config (or defaults when null); PUT 401 / 403 non-admin / 404 not-onboarded / 200 upsert→`upsertOpencostConfig` called / 503 when store unavailable. **status route**: 401 / 404 / 200 installed / **the load-bearing case: in-cluster 403 → 200 `{installed:false}` (NOT 500)**. **bundle route**: 401 / 404 / 200 body contains values.yaml curated keys + install.sh lines (`update-kubeconfig`, `helm upgrade --install`).
- [ ] **Step 2 (GREEN):** implement the 3 routes. All: `dynamic='force-dynamic'`, `verifyUser`→401, `isClusterOnboarded`→404. config PUT: `isAdmin`→403 then `upsertOpencostConfig`→503 if false. status: `detectOpencostInstall` (already degrades). bundle: load `getOpencostConfig` (or defaults), `renderValuesYaml`+`renderInstallSh` (region = `process.env.AWS_REGION||'ap-northeast-2'`, passed in), return `{ valuesYaml, installSh }` JSON (page offers download).
- [ ] **Step 3 (commit):** `cd web && npx vitest run app/api/opencost` green + full `npx vitest run` regression. Commit the 6 files.

---

### Task 6: `/opencost` page + nav (sanctioned additive appends)

**Files:**
- Create: `web/app/opencost/page.tsx`
- Modify: `web/components/shell/Sidebar.tsx`
- Modify: `web/components/shell/CommandPalette.tsx`
- Modify: `web/lib/i18n.ts`
- Test: `web/app/opencost/opencost-page.test.tsx`

- [ ] **Step 1:** READ first: `web/app/cost/page.tsx`, `web/app/customization/page.tsx` (admin-gated client page + fetch/degrade patterns), `web/components/ui/{Card,Badge,Input,PageHeader,SegmentedControl,DataTable}.tsx`.
- [ ] **Step 2:** `web/app/opencost/page.tsx` (`'use client'`): cluster picker (`fetch('/api/eks')` → clusters), **install-status badge** (`/api/opencost/[cluster]/status` → installed/not/degraded), curated-values + chart-version + free-form override editor, **Save** (`PUT /api/opencost/[cluster]`; 403→"관리자 전용", 503→"저장소 미설정"), **Download** values.yaml + install.sh (`/api/opencost/[cluster]/bundle` → Blob download + clipboard copy). Root `/api/*` only.
- [ ] **Step 3 (nav — additive):** `Sidebar.tsx` — **add the icon to the existing `lucide-react` import line** (e.g. `PiggyBank` or `Coins`) THEN append `{ href:'/opencost', tkey:'nav.opencost', icon: PiggyBank }` to FIXED; `CommandPalette.tsx` append `{ href:'/opencost', label:'OpenCost', hint:'K8s 비용' }` to fixed; `i18n.ts` add `nav.opencost` to **both** ko + en (the `i18n.test.ts` keyset-parity test must stay green — adding to only one side fails it).
- [ ] **Step 4 (commit):** `web/app/opencost/opencost-page.test.tsx` (jsdom, fetch-mock): status badge renders, save calls PUT, download builds bundle. `cd web && npx vitest run` green + `npx next build` succeeds (new page + i18n parity). Commit the 5 files.

---

### Task 7: ops — migration apply + deploy (CONTROLLER)

**Files:**
- Modify: `terraform/foundation/data/schema.sql` (applied only — committed in Task 3)

- [ ] **Step 1 (version reconcile):** in-VPC psql (master `awsops_admin` + `PGSSLMODE=require`, **after user approval**): `SELECT max(version) FROM schema_migrations;` → if `opencost_config`'s file version collides, renumber the schema.sql block to live-max+1 (commit the fix) before applying. Then apply the block; confirm the row.
- [ ] **Step 2:** `make deploy` → smoke `/api/health` 200. **No `terraform apply`** (no IaC change — env/IAM unchanged; OpenCost reuses existing eks read perms).
- [ ] **Step 3 (browser):** `/opencost` → pick an onboarded cluster → status badge → edit+save config → download values.yaml + install.sh → verify the bundle contains the cluster/region + helm commands.

## Done criteria
- All tasks committed; `cd web && npx vitest run` green; `npx next build` succeeds.
- No edit to `web/app/api/eks/route.ts`, `web/lib/aws.ts` ClusterInfo, or `web/lib/eks-incluster.ts`. No cluster/AWS write. No new npm dep.
- Migration version reconciled against LIVE Aurora (no silently-masked collision).
- Final cumulative diff passes the P4 multi-model gate; PR into `feat/v2-architecture-design` (does not auto-merge).

## P2 gate record
Panel: opus (MINOR/NIT), glm (`[]` + full 5-dimension verification), gemini (MINOR/NIT), kimi (findings); codex unavailable (backend "Engine not found"/timeout). Verified CRITICAL/MAJOR resolved in this revision:
- **Chart version** (kimi MAJOR vs gemini NIT — *divergent*): v1 installs **latest** (no `--version`); gemini wanted a pin for reproducibility. **Resolved**: `chartVersion` optional, `DEFAULT_CHART_VERSION=''` (latest, v1-parity) with pinning as a 1-line opt-in; `renderInstallSh` emits `--version` only when set; test asserts both branches.
- **Migration v10 silent-mask** (kimi/gemini): Task 3 version is provisional; Task 7 MUST reconcile to live-max+1 and confirm the row (fail loud) — `ON CONFLICT DO NOTHING` must not mask a collision.
- **Bundle secret leak** (kimi): non-issue as designed (install.sh = `update-kubeconfig` + helm only); added an explicit no-token assertion + render guard.
- **Sidebar icon import** (kimi): made the lucide import explicit in Task 6.
- **Dismissed**: kimi "Next.js `[cluster]/route.ts` conflicts with sub-routes" — **incorrect**; `[cluster]/route.ts` + `[cluster]/status/route.ts` are valid coexisting App Router paths (repo already nests `eks/[cluster]/incluster` + `/k8sgpt`). Stable YAML key order + i18n ko/en parity were already in the plan.
- **Verdict: P2 PASSED at rev2** — no real CRITICAL/MAJOR remains; chair verified each against the repo.
