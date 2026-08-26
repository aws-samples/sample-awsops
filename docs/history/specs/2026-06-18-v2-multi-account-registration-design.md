# Spec: v2 Multi-Account Registration (v1-style) + global account selector

**Date:** 2026-06-18
**Branch:** `feat/v2-multi-account` (worktree off `feat/v2-architecture-design`)
**Status:** Approved design (brainstorming) → consensus plan/implement

## Goal
Bring v1's multi-account model to v2: register multiple AWS accounts, a **global account selector**,
and make all major pages query the selected account. Cross-account reads use **STS AssumeRole of
`AWSopsReadOnlyRole`** (v2 SDK/Fargate — NOT v1's CLI profiles), mirroring `agent/lambda/cross_account.py`.

## Why
v2 web is single-account today (`web/lib/account.ts currentAccountId()` = host only; no accounts
registry; no web cross-account assume). The agent/chat layer already assumes `AWSopsReadOnlyRole`
cross-account; the web tier must do the same. Trigger: `/bedrock` (and cost) should show all connected
accounts; the Overview "AI 분석" card stays awsops-only (separate, already correct).

## Selection model (approved)
Global selector = **[each account] + ["All accounts" (`__all__`)]**, default = **host account**.
- cost / bedrock → on `__all__`, **fan out across enabled accounts and aggregate**.
- inventory / topology / eks → **single account**; on `__all__`, fall back to the host account.

## Components

### 1. Data — `accounts` table (Aurora, ULID migration)
`account_id` (12-digit, PK), `alias`, `region`, `is_host` (bool), `role_name` (default `AWSopsReadOnlyRole`),
`external_id` (nullable), `enabled` (bool, default true), `status` (`pending|verified|error`),
`last_verified_at`, `created_at`. The host row is seeded from `HOST_ACCOUNT_ID` (no assume for host).
`web/lib/accounts.ts`: `listAccounts/getAccount/validateAccountId(/^\d{12}$/)/getHostAccount/isMultiAccount`
(node-pg via `getPool`).

### 2. Cross-account assume — `web/lib/aws-assume.ts`
`credsForAccount(accountId)` → `null` for host/empty (use the task role's own creds), else STS
`AssumeRoleCommand` on `arn:aws:iam::<id>:role/<role_name>` with `ExternalId` (when set), ARN-validated,
**50-min temp-cred cache** (mirror `cross_account.py`). `assumedClient(accountId, Ctor, cfg?)` builds an
SDK client with those creds (or default). Never stores creds; never throws into request flow on a miss
(returns a clear error).

### 3. API — `/api/accounts` (admin-gated)
`web/lib/admin.ts` (Cognito `ADMIN_GROUP` OR SSM allowlist; ADR-023 v2). `GET` list; `POST` add
(12-digit validate → **test-assume**: assume + `sts:GetCallerIdentity` → `status=verified|error` → insert);
`DELETE` remove (host row protected); optional `POST ?action=verify` re-test. Bounded body read.

### 4. UI — `/accounts` page (admin-only)
List (alias / id / region / status badge), add form (id, alias, region, externalId), remove, re-verify.
An **onboarding guide panel**: the target-account CFN template + deploy steps. Non-admins are gated out.

### 5. Global selector + account context
Shell header selector listing accounts + "All accounts". Selection persisted in `localStorage` and sent
to BFF routes as `?account=<id>` (`__all__` for all). `web/lib/account-context.ts` (client hook) +
BFF routes read `?account` (default host). Mirrors v1's `accountId` query param.

### 6. Page wiring
Consumers read `accountId` from `?account` and build their AWS client via `assumedClient`:
- **cost / bedrock**: `__all__` → fan out over enabled accounts, aggregate; single → that account.
- **inventory / topology / eks**: single account; `__all__` → host fallback.

### 7. Target-account role — CFN template
`infra/cfn/awsops-target-account-role.yaml`: `AWSopsReadOnlyRole`, trust = the host web task role ARN
(+ host account root), `Condition` on `sts:ExternalId`, managed `ReadOnlyAccess` only (ADR-041 read-only).
`/accounts` shows it with deploy instructions.

### 8. Host IAM — `workload.tf`
Web ECS task role gets `sts:AssumeRole` on `arn:aws:iam::*:role/AWSopsReadOnlyRole` (read-only assume;
target accounts are dynamic so scope by role name, not account).

### 9. Security
ExternalId (confused-deputy), ARN validation, admin-gate on all mutations, **read-only** target role,
creds cached not persisted, 12-digit account validation, `__all__` fan-out bounded (cap concurrency),
no secrets in env, no `0.0.0.0/0` / `Principal:"*"`.

### 10. Testing
`accounts.ts` (pg mock), `aws-assume` (STS mock: host→null, cache hit, ARN reject), `/api/accounts`
(admin gate 403, validation, test-assume verified/error, host-protect), selector/context, per-page
`?account` threading + `__all__` aggregate/fallback.

## Decomposition / phasing
- **Phase 1 (this plan): substrate + aggregate pages** — accounts table, accounts.ts, aws-assume, API,
  /accounts UI, selector+context, CFN, host IAM, **bedrock + cost** multi-account.
- **Phase 2 (follow-up): single-account page wiring** — inventory / topology / eks read `?account` via
  assumedClient. Mechanical repeat of the established pattern; tracked, done after Phase 1 verifies.

## Non-goals
- No write to target accounts (read-only). No per-department RBAC changes (ADR-023 admin gate reused).
- No change to the Overview awsops-only card (already correct).
