# Account Region Scope Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working app-wide account and region selector with multi-select/all semantics and account-region CRUD support.

**Architecture:** Keep account trust in the existing `accounts` table and add `account_regions` helpers/API for enabled regional scan targets. Replace the sidebar `AccountSelector` with a client `ScopeSelector` backed by structured localStorage state while preserving the existing account-only helpers for pages not yet migrated.

**Tech Stack:** Next.js 14 app router, React client components, Vitest, node-pg, Aurora schema migrations.

---

## File Structure

- Modify `web/lib/account-context.ts`: add structured scope state, query serialization helpers, and compatibility wrappers for the old account-only API.
- Modify `web/lib/account-context.test.ts`: test scope defaults, persistence, events, and query serialization.
- Create `web/lib/account-regions.ts`: Aurora helpers for enabled account regions.
- Create `web/lib/account-regions.test.ts`: test region validation, row mapping, and host/registration seeding calls.
- Create `web/app/api/accounts/regions/route.ts`: authenticated/admin-gated account-region CRUD.
- Create `web/app/api/accounts/regions/route.test.ts`: test GET, POST, DELETE auth and validation behavior.
- Modify `web/app/api/accounts/route.ts`: seed the submitted initial region when registering an account.
- Modify `web/app/api/accounts/route.test.ts`: assert account registration also writes the initial region.
- Create `web/components/shell/ScopeSelector.tsx`: compact account/region/global selector UI.
- Create `web/components/shell/ScopeSelector.test.tsx`: render and interaction tests for all/multi-select behavior.
- Modify `web/components/shell/Sidebar.tsx`: replace `AccountSelector` import/render with `ScopeSelector`.
- Modify `web/components/shell/Sidebar.test.tsx`: lock the new selector import/render contract.
- Modify `terraform/foundation/data/schema.sql`: add `account_regions`.
- Create `terraform/foundation/migrations/<ulid>_account_regions.sql`: additive migration.

## Tasks

### Task 1: Scope State

- [ ] Write failing tests in `web/lib/account-context.test.ts` for `getActiveScope`, `setActiveScope`, `scopeParams`, and old account compatibility.
- [ ] Run `npm test -- lib/account-context.test.ts --run` and confirm failures.
- [ ] Implement structured scope helpers in `web/lib/account-context.ts`.
- [ ] Re-run the targeted test and confirm pass.

### Task 2: Account Region Helpers And API

- [ ] Write failing helper tests in `web/lib/account-regions.test.ts`.
- [ ] Write failing route tests in `web/app/api/accounts/regions/route.test.ts`.
- [ ] Implement `web/lib/account-regions.ts`.
- [ ] Implement `web/app/api/accounts/regions/route.ts`.
- [ ] Re-run targeted account region tests and confirm pass.

### Task 3: Account Registration Seeds Initial Region

- [ ] Extend `web/app/api/accounts/route.test.ts` to expect an `account_regions` upsert after account registration.
- [ ] Run targeted test and confirm failure.
- [ ] Modify `web/app/api/accounts/route.ts` to call the helper after account insert.
- [ ] Re-run targeted accounts route tests and confirm pass.

### Task 4: Scope Selector UI

- [ ] Write failing tests in `web/components/shell/ScopeSelector.test.tsx` for all accounts, multiple regions, and global toggle.
- [ ] Run targeted test and confirm failure.
- [ ] Implement `web/components/shell/ScopeSelector.tsx`.
- [ ] Replace `AccountSelector` with `ScopeSelector` in `web/components/shell/Sidebar.tsx`.
- [ ] Update `Sidebar.test.tsx` source contract.
- [ ] Re-run targeted shell tests and confirm pass.

### Task 5: Schema

- [ ] Add additive `account_regions` schema to `terraform/foundation/data/schema.sql`.
- [ ] Add additive migration SQL under `terraform/foundation/migrations/`.
- [ ] Verify no remediation/mutation flags are changed.

### Task 6: Verification And PR Update

- [ ] Run targeted tests changed by this plan.
- [ ] Run `cd web && npm test -- --run`.
- [ ] Run `cd web && npm run build`.
- [ ] Commit implementation changes.
- [ ] Push `codex/account-region-scope-selector` to update PR #108.
