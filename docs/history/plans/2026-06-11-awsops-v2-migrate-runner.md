# AWSops v2 — `make migrate` runner (collision-free migrations) Implementation Plan

> Decision record: `docs/reviews/2026-06-11-migration-mechanism-consensus.md` (5/5 unanimous Option C).
> **Additive + non-destructive**: keeps `schema.sql` as the baseline; adds `migrations/` + runner + Makefile wiring. **Live `ALTER version TYPE TEXT` + first run are a deferred controller step.** Branch `feat/v2-migrations` (off published feat/v2).

## Goal
Make DB version bumps collision-free forever: sortable-id (ULID/UTC-µs) migration files + a `make migrate` runner that applies pending-only, in one transaction per file, fail-loud on duplicate/checksum drift, and runs before `make deploy`.

## Conventions
- Pure logic (id parse/sort, pending-diff, checksum, dup-validate) in `scripts/v2/migrate-core.mjs` — unit-tested by web vitest via relative import. pg/CLI side in `scripts/v2/migrate.mjs`.
- New migration SQL files **never** touch `schema_migrations` (the runner stamps). Legacy `schema.sql` baseline blocks are left as-is (idempotent).
- Runner creds: `terraform output -raw aurora_secret_arn` → Secrets Manager → user/pass; endpoint from `terraform output`; `PGSSLMODE=require`; password via env only.

---

### Task 1: `scripts/v2/migrate-core.mjs` — pure runner core + tests

**Files:**
- Create: `scripts/v2/migrate-core.mjs`
- Test: `web/lib/migrate-core.test.ts`

- [ ] **Step 1 (RED):** `web/lib/migrate-core.test.ts` imports **`../../scripts/v2/migrate-core.mjs`** (P2 fix: `web/lib/` → `..`=web → `../..`=worktree root → `../../scripts/...`; `../../../` escapes the worktree). Test: `parseMigrationFile('01J9Z8XK3P7QF2VN6T0BC4D5EH_opencost_config.sql')→{id:'01J9…EH', name:'opencost_config'}`; **validateId** rejects non-ULID (`'01J0'`, `'abc'`) — accept only a 26-char Crockford ULID `/^[0-9A-HJKMNP-TV-Z]{26}$/i` (P2 fix: no short/manual ids); `sortIds` (lexical — note: legacy ints live only in the ledger as *applied*, never as `migrations/` files, so cross-ordering with ULIDs never affects the apply path); `computePending(fileIds, appliedIds)` = fileIds − appliedIds, ULID-sorted (finds ALL gaps, not just >max); `sha256(text)` on **LF-normalized** text (`text.replace(/\r\n/g,'\n')` — P2 fix: avoid git CRLF drift), stable; `findDuplicateIds(files)` flags dup id; `hasNoTxnFlag('-- migrate:no-transaction\n…')`→true.
- [ ] **Step 2 (GREEN):** `scripts/v2/migrate-core.mjs` exports those pure fns (no pg, no fs side-effects — fs reads passed in). `sha256` normalizes CRLF→LF first.
- [ ] **Step 3 (commit):** `cd web && npx vitest run lib/migrate-core.test.ts` green. Commit both.

### Task 2: `scripts/v2/migrate.mjs` — pg/CLI runner

**Files:**
- Create: `scripts/v2/migrate.mjs`

- [ ] **Step 1:** runner reads **`terraform/foundation/migrations/*.sql`** (P2 fix: absolute-from-repo-root dir, NOT bare `migrations/`); **load-time `findDuplicateIds` → abort** before connecting. Creds via `terraform output -raw aurora_secret_arn` → `aws secretsmanager get-secret-value` (mirror `scripts/13-deploy-aurora.sh:load_pg_env`), endpoint from `terraform output`, `PGSSLMODE=require`, password via env only. Connect (Node `pg` Client).
- [ ] **Step 2 (bootstrap, gated):** `pg_advisory_lock(<const>)`. Detect `schema_migrations.version` type via `information_schema.columns`. If **INTEGER and ULID-id migrations are pending** → abort: "bootstrap required: `make migrate BOOTSTRAP=1` (controller-confirmed; run during a coordinated quiet window — concurrent sessions still INSERT integer rows)". `BOOTSTRAP=1` (idempotent, only if currently INTEGER) → `ALTER TABLE schema_migrations ALTER COLUMN version TYPE TEXT USING version::text` **+ `ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`** (P2 fix: the checksum column doesn't exist yet) + insert a `baseline` marker row, then continue.
- [ ] **Step 3:** `computePending` (recorded = `SELECT version FROM schema_migrations`). For each pending file in ULID order, **issue SEPARATE `client.query()` calls on one client** (P2 fix: node-pg's extended/parameterized protocol can't run a multi-statement string): `client.query('BEGIN')` → `client.query(ddl)` (simple query, no params) → `client.query('INSERT INTO schema_migrations(version, applied_at, description, checksum) VALUES ($1, now(), $2, $3)', [id, name, checksum])` (parameterized, **plain INSERT — duplicate id → PK violation → fail-loud**, `ON CONFLICT` forbidden) → `client.query('COMMIT')`; on error `client.query('ROLLBACK')` + rethrow. `-- migrate:no-transaction` files → run the ddl in autocommit (no BEGIN/COMMIT), then stamp separately. On applied-file checksum mismatch (LF-normalized) → abort. `SET statement_timeout`/`lock_timeout` per session. `DRY_RUN=1` → print pending + SQL, no exec/lock. `pg_advisory_unlock` in `finally`.
- [ ] **Step 4 (commit):** `node --check scripts/v2/migrate.mjs` passes. (The pg/lock/txn path is integration — validated by `node --check` + a documented `DRY_RUN=1` invocation + the deferred Task-5 controller live run; no test DB for unit-level integration.) Commit.

### Task 3: `migrations/` dir + README convention

**Files:**
- Create: `terraform/foundation/migrations/README.md`
- Create: `terraform/foundation/migrations/.gitkeep`

- [ ] **Step 1:** README: id scheme (ULID, `node -e "console.log(require('ulid').ulid())"` or a date+rand helper), `<id>_<snake_name>.sql`, no `schema_migrations` writes in files, `-- migrate:no-transaction` flag usage, "never edit an applied migration (checksum)". `.gitkeep` so the dir ships empty.
- [ ] **Step 2 (commit):** commit.

### Task 4: Makefile — `migrate` target + `deploy: migrate`

**Files:**
- Modify: `Makefile`

- [ ] **Step 1:** add `.PHONY: migrate` + `migrate: ## Apply pending DB migrations (idempotent, fail-loud, advisory-locked)` → `@node scripts/v2/migrate.mjs`. Wire `deploy: migrate` (deploy depends on migrate) so `make deploy` applies pending migrations before rolling ECS. Keep `make deploy`'s existing recipe.
- [ ] **Step 2 (commit):** `make -n deploy` shows migrate runs first. Commit.

### Task 5 (CONTROLLER, deferred): live transition + first migration

**Files:** (none committed here — runtime ops)

- [ ] **Step 1:** coordinate with the concurrent session (shared `schema_migrations`). When agreed: `make migrate BOOTSTRAP=1` on live (advisory-locked `ALTER version TYPE TEXT` + baseline marker; preserves v1..vN integer rows).
- [ ] **Step 2:** first real migration = OpenCost `opencost_config` (and any future) authored as `migrations/<ulid>_opencost_config.sql`; OpenCost PR #32 drops its `schema.sql` v10 block in favor of this. `make migrate` applies it (live max+1 reconcile is now automatic — no integer to pick).
- [ ] **Step 3:** verify `schema_migrations` shows legacy ints + the new string id; `make deploy` runs migrate→deploy cleanly.

## P2 gate record
5/5 panel; real bugs caught + fixed in rev2: (1) test import path `../../../`→`../../` (3 models); (2) **node-pg can't multi-statement a parameterized query** → separate `client.query()` calls (gemini); (3) **no `checksum` column** → bootstrap `ADD COLUMN checksum TEXT` (4 models); (4) runner reads `terraform/foundation/migrations/` not `migrations/` (codex); (5) **CRLF checksum drift** → LF-normalize (gemini); (6) ID validation = full ULID, fixtures fixed (codex). Clarified/acknowledged: legacy ints are applied-only (never pending → ordering irrelevant; kimi/glm); pg-wrapper integration via `node --check`+dry-run+deferred live run (kimi); bootstrap ALTER during coordinated quiet window (glm). **Verdict: P2 PASSED at rev2.**

## Done criteria (this PR)
- `migrate-core` unit tests green; `node --check scripts/v2/migrate.mjs` passes; `make -n deploy` runs `migrate` first.
- Additive only — `schema.sql` baseline + concurrent integer blocks untouched; no live ALTER performed in this PR.
- Decision record committed; P4 gate clean; PR into `feat/v2-architecture-design` (no auto-merge).
