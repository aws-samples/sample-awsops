# Plan: v2 Multi-Account Registration — Phase 1 (substrate + bedrock/cost aggregate)

**Date:** 2026-06-18 · **Branch:** `feat/v2-multi-account` (off `feat/v2-architecture-design`)
**Spec:** `docs/superpowers/specs/2026-06-18-v2-multi-account-registration-design.md`
**Base trunk:** `feat/v2-architecture-design`

Cross-account = STS `AssumeRole` of `AWSopsReadOnlyRole` (mirror `agent/lambda/cross_account.py`), NOT v1
CLI profiles. Selector = [each account] + ["All accounts" `__all__`], default host. Admin gate via
`web/lib/admin.ts`. Phase 2 (inventory/topology/eks single-account wiring) is a follow-up, not this plan.

## P2 gate resolution (round 1 → 2)
agy CRITICAL + MAJORs / kiro MAJORs applied: (1) **NO server-side `__all__` fan-out** — single-account API routes; the bedrock/cost CLIENT fans out per enabled account + aggregates (thin-BFF). (2) CFN trusts ONLY the host task role ARN (no account root). (3) **ExternalId REQUIRED** for targets (DB CHECK + API validation); assume-creds cache keyed by `arn|externalId`. (4) POST order = validate → test-assume + **assert GetCallerIdentity.Account === submitted id** → INSERT (500 if INSERT fails; never cache test creds). (5) CE client always `us-east-1`. Rejected/noted: HOST_ACCOUNT_ID already injected (workload.tf:254 — false positive); ExternalId plaintext is acceptable (not a secret); account selection is per-tab localStorage with `?account` precedence (documented in Task 6).

## Security mandates
Read-only target role (`ReadOnlyAccess` only); ExternalId (confused-deputy); ARN-validated assume;
admin-gated mutations; creds cached (50min) not persisted; 12-digit account validation; `__all__`
fan-out concurrency-bounded; no secrets in env, no `0.0.0.0/0`, no `Principal:"*"`.

## Tasks

### Task 1: accounts Aurora migration
**Files:**
- Create: `terraform/foundation/migrations/01KVGR8ER0Y8RX3TG07B9G86C5_accounts.sql`

- [ ] `CREATE TABLE IF NOT EXISTS accounts (account_id text PRIMARY KEY CHECK (account_id ~ '^\d{12}$' OR account_id='self'), alias text NOT NULL, region text NOT NULL DEFAULT 'ap-northeast-2', is_host boolean NOT NULL DEFAULT false, role_name text NOT NULL DEFAULT 'AWSopsReadOnlyRole', external_id text, enabled boolean NOT NULL DEFAULT true, status text NOT NULL DEFAULT 'pending', last_verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT external_id_required_for_target CHECK (is_host OR external_id IS NOT NULL));` (the CHECK enforces ExternalId on every non-host target — confused-deputy guard) + a partial unique index `CREATE UNIQUE INDEX ... ON accounts (is_host) WHERE is_host` (at most one host). Header comment: host row seeded at runtime from HOST_ACCOUNT_ID; written only via admin /api/accounts; **ExternalId is a confused-deputy guard, NOT a secret — stored plaintext so the web layer can pass it to AssumeRole; no encryption-at-rest needed for this threat model**; read-only vs AWS.

### Task 2: web/lib/accounts.ts + tests
**Files:**
- Create: `web/lib/accounts.ts`
- Test: `web/lib/accounts.test.ts`

- [ ] Write `web/lib/accounts.test.ts` FIRST (mock `@/lib/db` getPool): `validateAccountId` accepts 12 digits rejects others; `listAccounts` maps rows; `getAccount(id)`; `getHostAccount` returns the is_host row; `isMultiAccount` true when >1 enabled.
- [ ] Implement `web/lib/accounts.ts`: types `Account`; `listAccounts()/getAccount(id)/validateAccountId(id)/getHostAccount()/isMultiAccount()` via `getPool`. `ensureHostRow()` upserts the host row from `HOST_ACCOUNT_ID`/`currentAccountId()` (idempotent).
- [ ] `cd web && npm run test -- accounts` green; commit this task only.

### Task 3: web/lib/aws-assume.ts + tests
**Files:**
- Create: `web/lib/aws-assume.ts`
- Test: `web/lib/aws-assume.test.ts`

- [ ] Write `web/lib/aws-assume.test.ts` FIRST (mock `@aws-sdk/client-sts` + `@/lib/accounts`): host/empty accountId → `credsForAccount` returns null (no assume); a 12-digit non-host → AssumeRole called with the `AWSopsReadOnlyRole` ARN AND its required `ExternalId`; a target account missing ExternalId → error (never a silent unscoped assume); second call within TTL hits the cache (one AssumeRole call); **rotating the ExternalId busts the cache** (different key); malformed ARN/id rejected.
- [ ] Implement `web/lib/aws-assume.ts`: `credsForAccount(accountId)` (null for host/empty; else look up the account → STS AssumeRole with its **required ExternalId**, ARN-validate, 50-min cache **keyed by `arn + '|' + externalId`** so an ExternalId rotation invalidates); `assumedClient(accountId, Ctor, cfg?)` builds the SDK client with assumed creds or defaults. Host detection via `HOST_ACCOUNT_ID`. Never persists creds (in-memory cache only).
- [ ] `cd web && npm run test -- aws-assume` green; commit this task only.

### Task 4: /api/accounts CRUD + tests
**Files:**
- Create: `web/app/api/accounts/route.ts`
- Test: `web/app/api/accounts/route.test.ts`

- [ ] Write `route.test.ts` FIRST (mock `@/lib/admin` isAdmin, `@/lib/accounts`, `@/lib/aws-assume`, `@/lib/auth`): GET list (auth); POST non-admin → 403; POST invalid id → 400; POST missing externalId → 400; POST where test-assume's GetCallerIdentity.Account ≠ submitted id → 400 (no insert); POST valid → insert with status='verified'; DELETE host row → 400; DELETE target → ok.
- [ ] Implement `web/app/api/accounts/route.ts`: `verifyUser`; `GET` listAccounts; `POST`/`DELETE` require `isAdmin` (web/lib/admin.ts) else 403. **POST order (per P2 gate): (1) validate 12-digit id + REQUIRED externalId + alias/region; (2) test-assume via aws-assume + STS GetCallerIdentity and ASSERT `GetCallerIdentity.Account === submitted account_id` (anti-spoof) else 400; (3) INSERT with status='verified', last_verified_at=now() — if INSERT fails return 500 (do NOT report verified without a row); never cache the throwaway test-assume creds.** Bounded body read (`readJsonBounded` if present). Host row protected from DELETE.
- [ ] `cd web && npm run test -- api/accounts` green; commit this task only.

### Task 5: /accounts admin UI page
**Files:**
- Create: `web/app/accounts/page.tsx`

- [ ] Admin-only page: account list (alias / id / region / enabled / status badge), add form (id, alias, region, externalId), remove + re-verify buttons → `/api/accounts`. An onboarding guide panel linking the target-account CFN (Task 7) with copy-paste deploy steps. Non-admin → gated message. Follow existing page chrome (PageHeader, Card, Badge, DataTable).
- [ ] `cd web && npm run build` green; commit this task only.

### Task 6: global account selector + context
**Files:**
- Create: `web/lib/account-context.ts`
- Create: `web/components/shell/AccountSelector.tsx`
- Test: `web/lib/account-context.test.ts`
- Modify: `web/components/shell/AppShell.tsx`
- Modify: `web/components/shell/Sidebar.tsx`

- [ ] Write `account-context.test.ts` FIRST: `useActiveAccount` reads/writes localStorage; default = host/'self'; `accountParam(id)` → `''` for host, `?account=<id>` / `?account=__all__` else.
- [ ] Implement `web/lib/account-context.ts` (client hook + helpers) + `AccountSelector.tsx` (dropdown: accounts from `/api/accounts` + "All accounts"; persists selection; emits an `awsops:accountchange` event). Mount the selector in `AppShell.tsx`/`Sidebar.tsx` (only render when `isMultiAccount`).
- [ ] `cd web && npm run test -- account-context` + `npm run build` green; commit this task only.

### Task 7: target-account CFN template + onboarding doc
**Files:**
- Create: `infra/cfn/awsops-target-account-role.yaml`
- Create: `docs/runbooks/onboard-target-account.md`

- [ ] CFN: `AWSopsReadOnlyRole` with AssumeRolePolicyDocument trusting **ONLY the host web task role ARN** (`Principal: { AWS: <HostTaskRoleArn> }` — do NOT trust the host account root: least-privilege, per P2 gate), `Condition: { StringEquals: { sts:ExternalId: <param> } }`, ManagedPolicyArns `arn:aws:iam::aws:policy/ReadOnlyAccess`. Parameters: HostTaskRoleArn, ExternalId (required). Outputs the role ARN.
- [ ] Runbook: how to deploy the CFN in a target account, find the ExternalId, then register via /accounts. Bilingual.
- [ ] commit this task only.

### Task 8: host IAM — web task role sts:AssumeRole
**Files:**
- Modify: `terraform/foundation/workload.tf`

- [ ] Add a new `aws_iam_role_policy` on the web task role (`aws_iam_role.task`): `Action: ["sts:AssumeRole"]`, `Resource: "arn:aws:iam::*:role/AWSopsReadOnlyRole"` (read-only assume; target accounts are dynamic so scope by role NAME, not account — acceptable per P2 gate). NOTE: `HOST_ACCOUNT_ID` is ALREADY injected into the web container (workload.tf:254) — no env change needed.
- [ ] `terraform -chdir=terraform/foundation fmt` + `validate` green; commit this task only.

### Task 9: bedrock multi-account aggregate
**Files:**
- Modify: `web/lib/metrics.ts`
- Modify: `web/app/api/bedrock-metrics/route.ts`
- Modify: `web/app/bedrock/page.tsx`
- Test: `web/app/api/bedrock-metrics/route.test.ts`

- [ ] Write/extend `route.test.ts` FIRST (mock aws-assume): `?account=<id>` → metrics for that account via `assumedClient`; no/`self` param → host (own creds). **The route is SINGLE-account only — NO server-side `__all__` fan-out** (thin-BFF: N×AssumeRole+CloudWatch inline would risk ALB 504; per the P2 gate the fan-out moves to the client).
- [ ] `bedrockModelMetrics(range, accountId?)` builds its CloudWatch client via `assumedClient(accountId, CloudWatchClient)` (null/host → default creds). Route reads `?account` (rejects `__all__` → 400 or treats as host). `bedrock/page.tsx`: when "All accounts" is selected, the CLIENT fetches `/api/bedrock-metrics?account=<id>` per enabled account in parallel (bounded ~6) and aggregates per-model + totalCost in the browser; single account → one fetch.
- [ ] `cd web && npm run test -- bedrock` + `npm run build` green; commit this task only.

### Task 10: cost multi-account aggregate
**Files:**
- Modify: `web/lib/aws.ts`
- Modify: `web/app/api/cost/route.ts`
- Test: `web/app/api/cost/route.test.ts`
- Modify: `web/app/cost/page.tsx`

- [ ] Write/extend `route.test.ts` FIRST: `?account=<id>` → that account's cost via assumedClient; no/`self` → host. **SINGLE-account route — no server-side `__all__` fan-out** (client aggregates, same as Task 9).
- [ ] Cost fns (`getMtdCost`/`getCostTrend`/…) accept an optional `accountId` and build the Cost Explorer client via `assumedClient(accountId, CostExplorerClient, { region: 'us-east-1' })` — **CE is global → ALWAYS region us-east-1 regardless of the account's region; account scoping comes from the assumed role, not the region** (matches cross_account.py). `cost/route.ts` reads `?account` (default host). `cost/page.tsx`: "All accounts" → client fetches per enabled account in parallel + aggregates totals/byService in the browser.
- [ ] `cd web && npm run test -- api/cost` + `npm run build` green; commit this task only.

## Verification
`cd web && npm run test` (vitest) + `npm run build` green; `terraform -chdir=terraform/foundation validate` green.
**Post-deploy integration smoke (manual, after terraform apply + make deploy):** deploy the target CFN in a real test account with a test ExternalId → register via `/accounts` (expect status=verified) → `GET /api/bedrock-metrics?account=<id>` and `GET /api/cost?account=<id>` return that account's data → "All accounts" in the selector shows the client-aggregated total. Note: account selection is per-tab (localStorage); the `?account` URL param takes precedence on load (documented in Task 6).

## Out of scope / follow-up (Phase 2)
inventory / topology / eks pages read `?account` via `assumedClient` (mechanical repeat). Done after
Phase 1 verifies + deploys (terraform apply for the host IAM + make deploy).
