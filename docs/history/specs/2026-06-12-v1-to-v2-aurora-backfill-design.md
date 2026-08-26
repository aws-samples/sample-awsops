# v1 → v2 Aurora Backfill — Design Spec

> **Status:** Draft for review (2026-06-12)
> **Owner:** AWSops v2 migration
> **Branch:** `fix/v2-upgrade-snapshot-id` (worktree `gap-impl-wave1`)

## 요약 (Korean)

v1(`src/`, EC2)이 로컬 디스크에 영속 저장하는 **고가치 이력 4종**(`data/*.json`)을 v2 Aurora의 대응 테이블 4개로 옮기는 **일회성·멱등 백필 스크립트**를 만든다. Steampipe는 라이브 FDW 엔진이라 옮길 영속 데이터가 없고, v2의 라이브 인벤토리 sync(`inventory_resources`, 22종)는 이미 배포돼 있으므로 별개다. 산출물은 **스크립트 + 단위/통합 테스트 + 운영 가이드(런북)**이며, 실제 프로덕션 적재 실행은 범위 밖(도구만 인도). 통합 테스트는 로컬 PG17 컨테이너(sudo docker) + `schema.sql`로 E2E 검증한다.

---

## 1. Context & goal

v1 keeps its durable application state as flat JSON files on the EC2 instance's local disk under `data/`. Steampipe's embedded Postgres in v1 is a **live FDW query engine only** — it holds no durable rows — so "migrate Steampipe data" really means "migrate the v1 `data/*.json` stores." v2 already re-derives live AWS inventory through its own warm-Steampipe-Fargate → `inv-sync` Lambda → Aurora `inventory_resources` path (22 types, deployed), which is a separate, already-built capability and **not** part of this work.

The v2 Aurora baseline schema (`terraform/foundation/data/schema.sql`) already defines the ADR-030 app-state tables that map 1:1 to the v1 JSON stores, and v1 already grew a runtime **dual-write** layer (`src/lib/db/*-writer.ts`) that encodes the exact JSON→Aurora mapping. What is **missing** is a one-time **backfill runner** that reads existing historical v1 JSON and bulk-loads it into Aurora.

**Goal:** a standalone, idempotent Node ESM backfill runner for the four high-value history stores, with unit + integration tests and an operator runbook, suitable to drop into a guide. Running it against production is explicitly out of scope (the deliverable is the tool); the v1 source, if needed, is instance `i-0123456789abcdef0`.

### In scope — 4 high-value stores

| v1 source store | layout | → Aurora table |
|---|---|---|
| `InventorySnapshot` (`src/lib/resource-inventory.ts`) | `data/inventory/[<acct>/]<YYYY-MM-DD>.json` | `inventory_snapshots` |
| `CostSnapshot` (`src/lib/cost-snapshot.ts`) | `data/cost/[<acct>/]<YYYY-MM-DD>.json` | `cost_snapshots` |
| `DiagnosisRecord` (`src/lib/alert-knowledge.ts`) | `data/alert-diagnosis/<YYYY-MM>/<id>.json` | `alert_diagnosis` |
| `ScalingEvent` (`src/lib/event-scaling.ts`) | `data/event-scaling/<id>.json` | `event_scaling_plans` |

### Out of scope (YAGNI)

`config.json` (secrets → Secrets Manager/SSM, no Aurora target), `agentcore-stats.json`, `data/memory/*` (conversations/sessions), `report-schedule.json`, report metadata; multi-account assume-role collection; live inventory sync; **read cutover / flipping the app's source-of-truth**; any UI; deleting v1 data; **executing the backfill against production** (tool only).

## 2. Architecture & files

Mirror the existing `migrate.mjs` / `migrate-core.mjs` split (logic vs. orchestration) for testability.

- `scripts/v2/backfill-v1.mjs` — CLI parsing, DB connection, directory walking, orchestration, transactions, summary report.
- `scripts/v2/backfill-core.mjs` — **pure functions**, no DB, no fs side effects: directory/file classification (`classifyInventoryDir`, skip rules) and the four record→row mappers (`mapInventory`, `mapCost`, `mapAlert`, `mapScaling`). This is the unit-tested core and the single source of the JSON→column contract.
- `scripts/v2/backfill-core.test.mjs` — unit tests via the built-in `node --test` runner (no vitest config needed for a repo-root mjs; `web/` keeps vitest for TS).
- `scripts/v2/backfill-v1.itest.mjs` — integration harness: spins a disposable PG17 container, loads `schema.sql`, runs a real backfill against fixtures, asserts, tears down. Skips gracefully when docker is unavailable.
- `docs/runbooks/v1-to-v2-aurora-backfill.md` — bilingual operator runbook (pull `data/` off `i-0123456789abcdef0`, dry-run, run, verify, re-run).

**Module style:** `import pg from 'pg'` (resolved from repo-root `node_modules`, as `migrate.mjs` does). ESM. `set`-free Node, `die()` helper, `--help`.

## 3. CLI & connection

```
node scripts/v2/backfill-v1.mjs --data-dir <path> [options]
```

| Flag / env | Default | Meaning |
|---|---|---|
| `--data-dir <path>` (required) | — | Path to a copy of v1's `data/` directory |
| `--only inventory,cost,alert,scaling` | all 4 | Restrict which sources run |
| `--account-id <id>` | `self` | Account id for the **single-account** inventory/cost layout (files directly under `inventory/`/`cost/` with no account subdir) |
| `--alert-source <s>` | `unknown` | Value for `alert_diagnosis.source` (v1 `DiagnosisRecord` does not store it — see §5.3) |
| `--dry-run` / `DRY_RUN=1` | off | Parse + validate + count rows that *would* be written + sample; **no DB connection** |
| `--dsn <url>` / `BACKFILL_DSN` | — | Direct Postgres connection string (used by the integration test against the container; bypasses Secrets Manager) |

**Credential resolution order** (for non-dry, non-`--dsn` runs):
1. `--dsn` / `BACKFILL_DSN` (explicit) →
2. `AURORA_SECRET_ARN` + `AURORA_ENDPOINT` env (Secrets Manager) →
3. `terraform -chdir=terraform/foundation output -raw aurora_secret_arn` / `aurora_endpoint` → Secrets Manager (the `migrate.mjs` path).

This adds the env/DSN fallback so the runner works from any host that reaches Aurora (e.g. the mgmt-vpc host, which can reach Aurora:5432) without terraform state. Connection uses `pg.Client` with `statement_timeout` and a per-run `pg_advisory_lock` keyed by a **fixed large 64-bit constant** (distinct from `migrate.mjs`'s key) to serialize concurrent runs.

**Secret hygiene & TLS** (panel: codex/gemini/kiro): the runner **never prints the DSN or resolved credentials** in the summary, sample, or error output (redact to `…@host/db`). TLS defaults to `rejectUnauthorized: false` to match `migrate.mjs` (documented trade-off — accepts any cert; acceptable for a one-time operator-run tool); an operator may supply the RDS CA bundle via `PGSSLROOTCERT` for full verification. The runbook prioritizes the Secrets Manager path over `--dsn` for any non-test use.

## 4. Source readers (layouts + skip rules)

All readers tolerate both single-account and multi-account v1 layouts and skip non-data files.

- **inventory** — walk `<data-dir>/inventory/`:
  - multi-account: subdirectory per account → `<acct>/<YYYY-MM-DD>.json`
  - single-account: `<YYYY-MM-DD>.json` directly in `inventory/` → account = `--account-id`
  - map account `aws` → `aggregate` (mirrors the writer; keeps the Steampipe aggregator key off the 12-digit namespace)
  - **skip:** `.prev_*.json`, any root aggregate file, and anything not matching `^\d{4}-\d{2}-\d{2}\.json$`
- **cost** — `<data-dir>/cost/` with the identical dual layout and skip rules.
- **alert** — walk `<data-dir>/alert-diagnosis/<YYYY-MM>/*.json`; each is a `DiagnosisRecord`. **skip:** `summary.json` inside month dirs and top-level `summary-<YYYY-MM>.json`.
- **scaling** — `<data-dir>/event-scaling/*.json`; each is a `ScalingEvent`; `.json` only.

## 5. Mappers & SQL (derived verbatim from the dual-write writers)

The four mappers reproduce the column/payload contract of the existing writers so there is **zero parity drift**. Source of truth cited per row.

### 5.1 `inventory_snapshots` — DELETE-day + per-label INSERT (one txn/file)
Source: `src/lib/db/inventory-writer.ts`. One v1 file (`{date, timestamp, resources:{label→count}}`) fans out to N rows.
```sql
DELETE FROM inventory_snapshots WHERE account_id=$1 AND captured_at>=$2 AND captured_at<$3;
INSERT INTO inventory_snapshots (account_id, captured_at, resource_type, resource_count, payload)
  VALUES ($1, $cap, $label, $count, $payload::jsonb);   -- repeated per label
```
- `captured_at` = `snapshot.timestamp` (fallback `${snapshot.date}T00:00:00Z` if absent). **The DELETE day-bounds are computed from the *resolved* `captured_at` (post-fallback)** so a missing `timestamp` still clears the correct day (a fallback applied only to the INSERT would leave the DELETE matching an Invalid Date and clear nothing) — unit-fixtured.
- `payload` = `{ date, timestamp }`. Idempotent: re-running replaces that (account, day).

### 5.2 `cost_snapshots` — UPSERT
Source: `src/lib/db/cost-writer.ts`.
```sql
INSERT INTO cost_snapshots (account_id, period_start, period_end, granularity, payload)
  VALUES ($1, $date, $date, 'SNAPSHOT', $payload::jsonb)
  ON CONFLICT (account_id, period_start, period_end, granularity) DO UPDATE SET payload = EXCLUDED.payload;
```
- `period_start = period_end = snapshot.date`; `granularity = 'SNAPSHOT'` (the writer's sentinel).
- `payload` = `{ monthlyCost, dailyCost, serviceCost, capturedAt: snapshot.timestamp }`.

### 5.3 `alert_diagnosis` — INSERT … ON CONFLICT (incident_id) DO NOTHING
Source: `src/lib/db/alert-diagnosis-writer.ts`. The writer takes a runtime `Incident + DiagnosisResult`, but v1 **stores** the already-merged `DiagnosisRecord`, so this mapper is **backfill-specific**:
```sql
INSERT INTO alert_diagnosis (incident_id, occurred_at, severity, source, services, resources, fingerprint, payload)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
  ON CONFLICT (incident_id) DO NOTHING;
```
- `incident_id` = `record.incidentId`; `occurred_at` = `record.timestamp`; `severity` = `record.severity`.
- `services` = `record.affectedServices`; `resources` = `record.affectedResources` (TEXT[]).
- `payload` = the whole `DiagnosisRecord` (its shape already matches the writer's `buildPayload`).
- **Known fidelity gaps** (documented, accepted): `source` is not in `DiagnosisRecord` → `--alert-source` (default `'unknown'`); `fingerprint` is not in `DiagnosisRecord` → `NULL` (column is nullable; GIN/partial indexes tolerate it).

### 5.4 `event_scaling_plans` — UPSERT (plan_id)
Source: `src/lib/db/event-scaling-writer.ts`.
```sql
INSERT INTO event_scaling_plans (plan_id, event_name, event_start_at, event_end_at, status, owner_email, payload)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  ON CONFLICT (plan_id) DO UPDATE SET event_name=EXCLUDED.event_name, event_start_at=EXCLUDED.event_start_at,
    event_end_at=EXCLUDED.event_end_at, status=EXCLUDED.status, owner_email=EXCLUDED.owner_email, payload=EXCLUDED.payload;
```
- `plan_id`=`event.eventId`, `event_name`=`event.name`, `event_start_at`=`event.eventStart`, `event_end_at`=`event.eventEnd ?? NULL`, `owner_email`=`event.createdBy ?? NULL`, `payload`=the whole event.
- `status` must be in the schema CHECK set (`planned|analyzing|plan-ready|approved|cancelled`); v1 `EventStatus` matches exactly. A file that would violate a CHECK or NOT NULL constraint — `status` outside the set, or missing `eventId`/`event_name`/`eventStart` — is **skipped + reported** (never aborts the run). (Generalizes beyond `status`; symmetry noted by the panel.)

## 6. Idempotency, transactions, dry-run, errors

- **Idempotent by construction** — re-running yields the same end state: inventory DELETE-day+INSERT, cost/scaling UPSERT, alert INSERT…ON CONFLICT DO NOTHING (the first-imported alert payload is preserved on rerun — asserted in the integration test).
- **Per-file transaction + per-file try/catch** — the run continues past a single bad file. **"errored" ≠ "skipped":** an *errored* file is a parse/SQL failure (counts toward the non-zero exit); a *skipped* file is an intentional non-write (summary/`.prev_` files, out-of-set/invalid scaling record, empty `resources`) and is **not** an error. (A run-wide abort on one bad historical file would be operator-hostile.)
- **Implementable counts** (panel codex MAJOR): pg `rowCount` cannot distinguish insert from update on an UPSERT, so the UPSERT sources (cost/scaling) use `... RETURNING (xmax = 0) AS inserted` to split inserted vs updated; alert `ON CONFLICT DO NOTHING` returns the inserted row (0 rows ⇒ conflict-skipped); inventory reports deleted + inserted.
- **Summary report** at exit, per source: files scanned / skipped (with reason) / inserted / updated / conflict-skipped / errored — **with the DSN and credentials redacted** everywhere. **Non-zero exit iff any file *errored*** (skips do not trip it), so CI/guide runs fail loudly only on real failures.
- **`--dry-run`** parses + validates + prints per-source **would-write / would-skip (reason) / would-error** counts + a (credential-free) sample row, with **no DB connection** (doubles as offline validation).
- A single `pg_advisory_lock` (fixed 64-bit key) wraps the whole run.

## 7. Testing

### 7.1 Unit — `scripts/v2/backfill-core.test.mjs` (`node --test`, no DB, no docker)
Pure-function coverage of `backfill-core.mjs`:
- directory/file classification: single vs multi-account, `aws`→`aggregate`, skip `.prev_*`, skip `summary*`, reject non-date filenames.
- each mapper produces the exact columns/params the §5 SQL expects (fixtures with representative records, incl. missing `timestamp`, empty `resources`, out-of-set scaling `status`, missing alert `source`/`fingerprint`).

### 7.2 Integration — `scripts/v2/backfill-v1.itest.mjs` (real PG17, faithful to Aurora)
Substrate chosen: **local PostgreSQL 17 container** (same engine + identical `schema.sql` DDL → identical JSONB / `ON CONFLICT` / `TEXT[]` / advisory-lock behaviour as Aurora; free, fast, repeatable, guide-friendly).

Flow:
1. `sudo docker run -d --rm -p 127.0.0.1:<rand>:5432 -e POSTGRES_PASSWORD=<random-generated-at-runtime> -e POSTGRES_DB=awsops postgres:17` — bound to `127.0.0.1` only, **password generated at runtime (never hard-coded/committed)**, passed onward via `BACKFILL_DSN`. Skip the test with a clear message if docker is unreachable. **Teardown trap on `EXIT`, `SIGINT`, `SIGTERM`** so a Ctrl-C never orphans the container.
2. Wait healthy, then load `terraform/foundation/data/schema.sql` (psql or `docker exec`).
3. Build a fixture `data/` tree exercising every reader path + edge case (multi-account dir, single-account, `aws`→aggregate, corrupt file, skipped `summary`/`.prev_`, out-of-set status).
4. Assertions are split so the corrupt-file's non-zero exit doesn't fail the suite (panel codex MAJOR):
   - **(a) clean-fixtures run** (no corrupt file) → expect **exit 0**; assert per-table counts, inventory **fan-out** (N labels → N rows), a JSONB payload spot-check; run **twice** → identical counts (idempotency), **the alert payload is unchanged on the second run** (DO NOTHING preserves the first import), **and the second run's summary reports cost/scaling/alert rows as *updated*/*conflict-skipped*, not *inserted*** — locking in the `RETURNING (xmax=0)` count logic from the MAJOR-(b) fix.
   - **(b) corrupt-fixture run** → expect **non-zero exit**; assert the good rows still loaded and the corrupt record was **not** loaded; the skipped (`summary`/`.prev_`/out-of-set) files counted as *skipped*, not *errored*.
   - **(c) `--only cost` run** → assert only `cost_snapshots` changed and the other three tables were untouched (covers the otherwise-untested `--only`).
5. Tear down the container via the trap.

### 7.3 Acceptance criteria
- `node --test scripts/v2/backfill-core.test.mjs` green.
- `node scripts/v2/backfill-v1.itest.mjs` green end-to-end against PG17, including the idempotent re-run.
- `--dry-run` against the fixtures prints correct per-source counts with no DB connection.
- Lint/style consistent with `scripts/v2/*.mjs`.

## 8. Guide / runbook deliverable

`docs/runbooks/v1-to-v2-aurora-backfill.md` (bilingual, per `docs/` convention), covering:
1. **Prerequisites** — host with network reach to Aurora:5432; creds via `terraform output` or `AURORA_SECRET_ARN`/`AURORA_ENDPOINT`; `node` + repo `pg`.
2. **Pull v1 data** — copy `data/` off `i-0123456789abcdef0` (SSM Run Command / `aws ssm start-session` + `tar`), into a local `--data-dir`. (Read-only on the v1 box.)
3. **Dry-run** — `node scripts/v2/backfill-v1.mjs --data-dir ./v1-data --dry-run` and read the counts.
4. **Run** — drop `--dry-run`; capture the summary report.
5. **Verify** — `SELECT count(*)` per table + a spot-check query; re-run to confirm idempotency.
6. **Notes / fidelity gaps:**
   - alert `source` = `--alert-source` default (`unknown`), and `fingerprint = NULL` → backfilled alert rows are **excluded from the `fingerprint` partial index**, i.e. invisible to fingerprint-based dedup/search (historical incidents won't surface there).
   - **`--account-id` must match the id the v1 dual-write used** for those days; otherwise backfilled rows fork onto a different `account_id` than any live-written rows and the same-(account,day) idempotent-replace guarantee only holds within one id. (Optional pre-run `SELECT DISTINCT account_id` check.)
   - no read-cutover (the app's source-of-truth is unchanged), no v1 source deletion. **Never echo the DSN/credentials** in logs.

The `backfill-v1.mjs` header carries a concise usage block so the script reads well when embedded in the guide.

## 9. References

- Target DDL: `terraform/foundation/data/schema.sql:21` (inventory_snapshots), `:39` (cost_snapshots), `:104` (alert_diagnosis), `:132` (event_scaling_plans).
- Mapping source (writers): `src/lib/db/inventory-writer.ts`, `cost-writer.ts`, `alert-diagnosis-writer.ts`, `event-scaling-writer.ts`.
- Source shapes: `src/lib/resource-inventory.ts:45` (`InventorySnapshot`), `cost-snapshot.ts:14` (`CostSnapshot`), `alert-knowledge.ts:11` (`DiagnosisRecord`), `event-scaling.ts:13` (`EventStatus`).
- Conventions: `scripts/v2/migrate.mjs` (creds, advisory lock, `pg`, `DRY_RUN`, `die`).
- Decisions: ADR-030 (Aurora app-state, 7 tables), ADR-037 (v2 foundation; flag-gated inventory sync).
