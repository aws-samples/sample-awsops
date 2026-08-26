# Implementation Plan — v1 → v2 Aurora Backfill

> Spec: `docs/superpowers/specs/2026-06-12-v1-to-v2-aurora-backfill-design.md`
> Strategy: TDD (test-first) + Tidy First (pure logic before I/O). Each task is one local commit.
> Integration-test substrate: local PostgreSQL 17 container via `sudo docker` (daemon active, sudo confirmed).

## Files in scope

- `scripts/v2/backfill-core.mjs` — pure functions (dir/file classification + 4 record→row mappers)
- `scripts/v2/backfill-core.test.mjs` — unit tests (`node --test`)
- `scripts/v2/backfill-v1.mjs` — CLI, creds, connection, orchestration, dry-run, summary
- `scripts/v2/backfill-v1.itest.mjs` — PG17-container integration harness
- `docs/runbooks/v1-to-v2-aurora-backfill.md` — operator runbook

No app/web/terraform changes — the four target tables already exist in `terraform/foundation/data/schema.sql`.

## Tasks

### Task 1: Pure core — directory & file classification (TDD)

**Files:**
- Create: `scripts/v2/backfill-core.mjs`
- Test: `scripts/v2/backfill-core.test.mjs`

- [ ] Write failing `node --test` cases for the classifiers: `classifyAccountLayout(entries)` (multi-account subdirs vs single-account `YYYY-MM-DD.json` for `inventory/` and `cost/`); account normalization `aws`→`aggregate`; `isDateFile(name)` accepts `^\d{4}-\d{2}-\d{2}\.json$` and rejects `.prev_*`/root-aggregate/non-date; `isAlertRecordFile(name)` rejects `summary.json`/`summary-YYYY-MM.json` and month-dir matcher `^\d{4}-\d{2}$`; scaling filter `.json` only.
- [ ] Implement the classifiers in `backfill-core.mjs` (pure — no fs/DB) until green.
- [ ] `node --test scripts/v2/backfill-core.test.mjs` green; commit `feat(v2-backfill): pure dir/file classifiers + tests`.

### Task 2: Pure core — the four record→row mappers (TDD)

**Files:**
- Modify: `scripts/v2/backfill-core.mjs`
- Test: `scripts/v2/backfill-core.test.mjs`

- [ ] Add failing tests (param arrays matching spec §5 SQL): `mapInventory(snapshot, accountId)` fan-out one row per label, `captured_at` fallback `${date}T00:00:00Z`, payload `{date,timestamp}`, empty `resources`→zero rows; `mapCost(snapshot, accountId)` granularity `'SNAPSHOT'`, payload `{monthlyCost,dailyCost,serviceCost,capturedAt}`; `mapAlert(record,{source})` columns + `payload=record`, `source` default `'unknown'`, `fingerprint=null`; `mapScaling(event)` validate status ∈ {planned,analyzing,plan-ready,approved,cancelled} (out-of-set→`{skip,reason}`), null-coalesce `event_end_at`/`owner_email`, `payload=event`.
- [ ] Implement the four mappers until green.
- [ ] `node --test` green; commit `feat(v2-backfill): record→row mappers + tests`.

### Task 3: Runner — CLI, creds resolution, dry-run (no DB)

**Files:**
- Create: `scripts/v2/backfill-v1.mjs`

- [ ] Arg parsing: `--data-dir` (required), `--only`, `--account-id` (default `self`), `--alert-source` (default `unknown`), `--dry-run`/`DRY_RUN=1`, `--dsn`/`BACKFILL_DSN`, `--help`; `die()` on misuse (mirror `migrate.mjs`).
- [ ] Creds resolution order: `--dsn`/`BACKFILL_DSN` → `AURORA_SECRET_ARN`+`AURORA_ENDPOINT` → `terraform output -raw …` (lazy; not called in dry-run).
- [ ] Directory walk (Task-1 classifiers) + per-source parse + **dry-run** path: per-source **would-write / would-skip(reason) / would-error** counts + one **credential-free** sample, **no DB connection**. The DSN/credentials are never printed (redact to `…@host/db`).
- [ ] Verify with a tiny temp fixture tree via `--dry-run`, including a `--only cost` run asserting the other sources are not counted; commit `feat(v2-backfill): CLI + creds + dry-run runner`.

### Task 4: Runner — Aurora write path (advisory lock, per-file txn, idempotent SQL, summary)

**Files:**
- Modify: `scripts/v2/backfill-v1.mjs`

- [ ] `pg.Client` connect (`statement_timeout`, TLS `rejectUnauthorized:false` per `migrate.mjs`; honor `PGSSLROOTCERT` if set); `pg_advisory_lock` on a fixed 64-bit key around the run; `finally` unlock + `end`.
- [ ] Per source/file: BEGIN → execute spec §5 SQL from the Task-2 mapper output → COMMIT; on parse/SQL **error** ROLLBACK + record (errored) + continue; intentional non-writes are **skipped** (not errored). Inventory DELETE-day (bounds from resolved `captured_at`) + per-label INSERT; cost/scaling UPSERT with `RETURNING (xmax=0) AS inserted`; alert INSERT … ON CONFLICT DO NOTHING (RETURNING ⇒ inserted vs conflict-skip).
- [ ] Summary report (scanned/skipped+reason/inserted/updated/conflict-skip/errored), **DSN/creds redacted**; **non-zero exit iff any file *errored*** (skips don't trip it).
- [ ] Commit `feat(v2-backfill): Aurora write path + idempotent SQL + summary`.

### Task 5: Integration test — PG17 container E2E + idempotency

**Files:**
- Create: `scripts/v2/backfill-v1.itest.mjs`

- [ ] Harness: start `postgres:17` via `sudo docker run -d --rm -p 127.0.0.1:<rand>:5432 -e POSTGRES_PASSWORD=<random> -e POSTGRES_DB=awsops` (pw generated at runtime, passed via `BACKFILL_DSN`, never committed); skip with a clear message if docker unreachable; **teardown trap on EXIT/SIGINT/SIGTERM**.
- [ ] Load `terraform/foundation/data/schema.sql`; build a fixture `data/` tree covering every reader path + edge cases (multi-account, single-account, `aws`→aggregate, corrupt JSON, skipped `summary`/`.prev_`, out-of-set scaling status).
- [ ] **(a) clean run** → exit 0; assert per-table counts, inventory fan-out, JSONB spot-check, **idempotency** (twice → identical counts) + **alert payload unchanged on rerun** + **2nd-run summary shows updated/conflict-skipped not inserted** (verifies the RETURNING xmax=0 logic). **(b) corrupt run** → **non-zero exit**, good rows loaded, corrupt not loaded, skips counted as skipped not errored. **(c) `--only cost` run** → only `cost_snapshots` changed.
- [ ] `node scripts/v2/backfill-v1.itest.mjs` green; commit `test(v2-backfill): PG17-container E2E + idempotency`.

### Task 6: Operator runbook

**Files:**
- Create: `docs/runbooks/v1-to-v2-aurora-backfill.md`

- [ ] Bilingual runbook: prerequisites; pull `data/` off `i-0123456789abcdef0` (SSM Run Command / session + tar, read-only); dry-run; run (creds via terraform output or env, **never echo DSN**); verification queries; idempotent re-run; fidelity notes — alert `source` default + `fingerprint=NULL` ⇒ **excluded from the fingerprint partial index** (invisible to fingerprint dedup); **`--account-id` must match the id v1 dual-write used** (else rows fork; optional pre-run distinct-account check); no read-cutover, no source deletion.
- [ ] Commit `docs(v2-backfill): operator runbook`.

## Acceptance criteria

- `node --test scripts/v2/backfill-core.test.mjs` green (Tasks 1–2).
- `node scripts/v2/backfill-v1.itest.mjs` green E2E incl. idempotent re-run (Task 5).
- `--dry-run` prints correct per-source counts with no DB connection (Task 3).
- Mapping SQL columns match `src/lib/db/*-writer.ts` (parity); style consistent with `scripts/v2/*.mjs`.
- No changes outside the files-in-scope list.

## Out of scope (YAGNI)

config.json / agentcore stats / conversations / report schedule; multi-account assume-role collection; live inventory sync; read cutover; UI; production execution; v1 data deletion.
