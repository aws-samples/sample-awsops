# Decision Record — DB migration mechanism redesign (collision-free, make-driven)

> 2026-06-11 · `/co-agent:consensus` review · 5/5 cross-family panel (kiro opus/kimi/glm + codex + gemini) **unanimous**. Status: **Accepted**.

## Problem
The v2 schema is a single idempotent `schema.sql` (CREATE IF NOT EXISTS + `INSERT INTO schema_migrations VALUES (N) ON CONFLICT DO NOTHING`), re-applied whole via manual psql. **Sequential integer versions authored on a shared branch collide** — v8/v10 were preempted by concurrent sessions ≥3 times, each needing a manual renumber. `ON CONFLICT DO NOTHING` **silently masks** a duplicate version (two branches ship the same N with different DDL → both tables created, one ledger row → version meaningless; dangerous for ALTER/data migrations). And manual psql drifts from code.

## Decision (unanimous Option C)
**Timestamp/ULID migration files + a thin `make migrate` Node runner.**

1. **Version scheme**: `migrations/<sortable-id>_<name>.sql`, id = a **monotonic sortable ULID** (or UTC-µs timestamp). `schema_migrations.version` → **TEXT** (holds legacy ints "1".."N" and new string ids). Sortable id ⇒ concurrent authoring **cannot collide** (the root fix).
2. **Runner** (`scripts/v2/migrate.mjs`, reuse Node `pg`): `pg_advisory_lock` → **pending-only** (file ids − recorded ids, applied in sorted order, finds ALL gaps not just `>max`) → **per-file transaction with same-transaction stamping** (DDL + ledger INSERT in one BEGIN/COMMIT — else "applied-but-unrecorded" drift) → **plain INSERT (no ON CONFLICT)** so a duplicate id = PK violation = **fail-loud** → **sha256 checksum** per migration (applied-file edited → fail; db-has-unknown-id → warn) → creds from `aurora_secret_arn` + `PGSSLMODE=require`, password via env not argv → `statement_timeout`/`lock_timeout` → `DRY_RUN=1` lists pending. **`-- migrate:no-transaction`** header flag for `CREATE INDEX CONCURRENTLY`.
3. **Fail-loud**: migration SQL files **never** write `schema_migrations`; the runner alone stamps (plain INSERT). Load-time duplicate-id scan aborts before connecting. Checksum mismatch aborts.
4. **`make deploy` runs `make migrate` first** (Makefile `deploy: migrate`) → closes the OSS code↔schema drift gap permanently.
5. **Transition (non-destructive, additive)**: keep the current `schema.sql` as the **baseline** (idempotent, applied once + recorded as a baseline marker). Existing live integer rows v1..vN are **preserved** (column ALTER INTEGER→TEXT casts them). New work (OpenCost v10/v12, concurrent eks/prevention) becomes timestamp files going forward. **The live `ALTER COLUMN version TYPE TEXT` + first `make migrate` is a controller-confirmed step** (deferred — shared DB, concurrent sessions still adding integer migrations); code/runner land first.

## Coordination notes
- A concurrent session is actively adding integer migrations to the shared `schema.sql` (live at v11: v10=prevention_insights, v11=eks_registrations). To minimize merge conflict this change is **additive** — it does NOT restructure/split the existing `schema.sql` or strip its legacy `ON CONFLICT` blocks (those stay as the idempotent baseline); it only adds the `migrations/` dir + runner + Makefile wiring + ledger TEXT support.
- The live `schema_migrations` column ALTER affects all sessions → deferred + controller-confirmed.

## Top pitfalls (panel)
Non-transactional DDL (CONCURRENTLY) → needs the no-transaction flag; stamping in a separate txn → partial-apply drift; hand-written second-resolution ids → prefer generated ULID.
