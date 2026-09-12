# DB migrations (`make migrate`)

Collision-free, fail-loud DB migrations applied by `scripts/v2/migrate.mjs` (run via `make migrate`,
and automatically before `make deploy`). Decision record: `docs/reviews/2026-06-11-migration-mechanism-consensus.md`.

## Why this exists
The legacy single `schema.sql` used sequential integer versions (`v8`, `v9`, …) + `INSERT … ON CONFLICT
DO NOTHING`. Concurrent branches kept **preempting the same integer** (manual renumber every time) and the
`ON CONFLICT` **silently masked** duplicates. This directory replaces that for all NEW migrations.

## Authoring a migration
1. Generate a **ULID** id (sortable, collision-proof across concurrent branches):
   ```
   node -e "import('ulid').then(m=>console.log(m.ulid()))"   # or any ULID generator
   ```
2. Create `terraform/foundation/migrations/<ULID>_<snake_name>.sql`, e.g.
   `01J9Z8XK3P7QF2VN6T0BC4D5EH_opencost_config.sql`.
3. Put **only DDL/data** in the file. **Do NOT** write `schema_migrations` — the runner stamps it
   (version + sha256 checksum) in the same transaction. Do NOT use `ON CONFLICT DO NOTHING` on the ledger.
4. Non-transactional statements (`CREATE INDEX CONCURRENTLY`, some `ALTER TYPE … ADD VALUE`) — put
   `-- migrate:no-transaction` as the first line; the runner runs that file in autocommit.
5. Declare the release with a `-- since: <semver>` header (e.g. `-- since: 2.1.0`) — the version the
   migration is introduced in. Recorded in the `app_version` ledger column at apply. Optional: with no
   header the runner stamps the deploying app's version (`web/package.json`) instead.

## Rules
- **Never edit an applied migration** — the runner stores a sha256 (LF-normalized) and aborts on drift.
- One migration = one logical change. Additive-forward preferred; destructive ops need a deliberate review.
- IDs must be unique ULIDs — the runner aborts before connecting if two files share an id.

## Apply
- `make migrate` — apply pending (advisory-locked, pending-only, fail-loud, version-stamped). `make deploy` runs it first.
- `make migrate-status` — offline summary: the deploying app version + each migration's declared release. No DB.
- `DRY_RUN=1 make migrate` — list pending + SQL, no exec. `DRY_RUN=1 OFFLINE=1` — no DB connection.
- `BOOTSTRAP=1 make migrate` — **one-time, controller-confirmed**: migrates the legacy `schema_migrations.version`
  INTEGER→TEXT + adds the `checksum` + `app_version` columns + a `baseline` marker. Run during a coordinated quiet
  window (concurrent sessions may still INSERT integer rows). Legacy integer rows (v1..vN) are preserved as applied;
  the baseline `schema.sql` stays as the one-time bootstrap of those tables.

## Release versioning & upgrades
### Fresh private CI initialization / 신규 CI 초기화

The one-off migration task sets `INITIALIZE_EMPTY_DB=1`. Under the same advisory
lock, `initialize-db.mjs` applies the frozen baseline only when no ledger and no
user objects exist. Baseline DDL, TEXT ledger conversion, metadata columns and
the baseline checksum commit atomically; all pending ULIDs then run normally.
An occupied database without a ledger is rejected. An existing ledger skips
baseline replay; legacy INTEGER ledgers still require the explicit `BOOTSTRAP=1`
procedure above. TLS-verified credentials are read at runtime from Secrets Manager.
Existing staged dev stacks migrate before the full foundation saved-plan apply.
Fresh core bootstrap has no existing app and keeps web desired count zero;
existing stacks without a migration template fail an explicit prerequisite check.

CI task의 `INITIALIZE_EMPTY_DB=1`은 ledger와 사용자 객체가 모두 없는 DB에서만
baseline을 적용합니다. 동일 advisory lock 안에서 baseline·TEXT ledger·checksum을
원자적으로 기록하고 ULID를 적용합니다. 기존 DB/ledger는 재초기화하지 않으며
INTEGER ledger는 기존 명시적 BOOTSTRAP 절차를 따릅니다. 기존 stack은 migration
후 전체 저장 plan을 적용하고, 신규 bootstrap만 web count 0으로 시작합니다.

### Cumulative upgrades / 누적 업그레이드

Migrations are **cumulative**, not version-pair scripts. The `schema_migrations` ledger records which
migration IDs are applied; `make migrate` applies whatever the live DB is *missing*, in ULID (chronological)
order — regardless of which release you started from. So you never author a "2.0.1 → 2.1.5" script:

```
git fetch --tags && git checkout v2.1.5
make migrate-status          # see what 2.1.5 ships + each migration's release
bash scripts/v2/upgrade.sh   # PREVIEW (no writes); then CONFIRM=go bash scripts/v2/upgrade.sh
```

`upgrade.sh` is the safe wrapper for **any** release upgrade: RDS snapshot → `make migrate` (auto-runs the
one-time legacy bootstrap if the ledger is still INTEGER) → idempotency check → `make deploy`. Upgrading
from 2.0.0, 2.0.9, or 2.1.4 to 2.1.5 is the *same* command — the ledger computes the exact delta.

Each applied row carries `app_version` (the migration's `-- since:` release, else the deploying app's
`web/package.json` version), so the ledger answers "which release introduced this / what schema am I on".
List a release's DB changes in `CHANGELOG.md` from the migrations whose `-- since:` matches that version.
