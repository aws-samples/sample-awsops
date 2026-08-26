# Plan — AI Diagnosis: 관측 가능한 진행 + 절대 안 멈춤 (V1 패리티 복원)

> **Base branch:** `feat/v2-architecture-design` · **Implement in an isolated git worktree** (the
> main checkout has a concurrent session's uncommitted OpenCost changes — must not be disturbed).
> **Scope = 기둥 A (progress) + 기둥 B (never-stuck).** 기둥 C (alarms / drift-guard / mem / `make release`)
> is a **gated follow-on**, documented at the end, NOT implemented here.

## Problem (evidence-backed RCA)

`https://awsops-v2.example.com/ai-diagnosis` shows "진단중" forever. Confirmed root cause:

1. **PRIMARY (stale worker image):** the deployed `awsops-v2-worker:worker-latest` image was last
   pushed **2026-06-03**; the `report` handler was added **2026-06-11** (`fd43e26`). The live
   Fargate worker therefore runs code without the handler → `fargate_worker.py:29`
   `handlers.REGISTRY[job["type"]]` → `KeyError: 'report'` on **every** diagnosis run. Confirmed in
   `/ecs/awsops-v2-worker` logs for the 06-13 and 06-14 runs; SFN `awsops-v2-workers` shows the
   06-12/06-13/06-14 executions all FAILED. (Fixed operationally by `make workers` — out of this plan's code scope.)
2. **SECONDARY (the reason it looks "stuck" not "failed") — V1 capabilities V2 dropped:**
   - The `KeyError` fires in `fargate_worker.py` **before** `_report`'s inner `try/finish_report(failed)`,
     so `diagnosis_reports` never leaves `'running'`.
   - `reaper.py` and `status_updater.py` reconcile only `worker_jobs`, **never** `diagnosis_reports`
     (grep-confirmed). V1 had a 30-min stale guard (`src/app/api/report/route.ts:137`); V2 lost it.
   - V2 has **no per-section progress** (`report.py:135` renders all sections in one list-comp then
     writes once); V1 streamed `progress{current,total,currentSection}` so the UI showed live
     section-by-section status and a stall was visible.
   - `DiagnosisView` polls 100×3s then **silently** gives up; the row stays `'running'` so on reload
     it shows "진단중" again — failure masquerades as in-progress.

**Goal:** restore V1's observable-progress UX and guarantee a report can never be stuck in
`'running'` — any worker failure (KeyError, OOM, DB-connect, hard kill, idle) surfaces as `failed`.

## Constraints / conventions (verified)

- Migrations are ULID files under `terraform/foundation/migrations/` applied by
  `scripts/v2/migrate.mjs` (advisory-locked, version-stamped); `make deploy` runs `migrate` first.
  `diagnosis_reports` lives in `migrations/01KTVGKN…_diagnosis_reports.sql` (has `updated_at` +
  `touch_updated_at()` BEFORE-UPDATE trigger → any UPDATE advances `updated_at` = heartbeat).
- Worker is Python (pg8000 via `scripts/v2/workers/db.py` `conn.run`), arm64, **CMD** entrypoint.
  Read-only AWS only (post-2026-06-11 reversal posture). No new IAM needed.
- BFF is `web/` node-pg (`web/lib/diagnosis.ts` `COLS`), root path, `export default`, standalone build.
- Worker tests: `pytest` under `scripts/v2/workers/diagnosis/`. Web tests: `vitest`.
- Per-task commit, explicit paths. TDD: failing test → minimal code → refactor.

## Out of scope (do NOT touch)
- Any `web/app/opencost/**`, `web/components/shell/CommandPalette.tsx`, `web/components/shell/Sidebar.tsx`,
  `web/next.config.mjs` (concurrent session's uncommitted work).
- 기둥 C items (see follow-on section).

---

## Tasks (기둥 A + B)

### A1 — Migration: add `progress` to `diagnosis_reports`
- [ ] Create `terraform/foundation/migrations/<ULID>_diagnosis_progress.sql` (generate a fresh
      monotonic ULID > existing ids; `-- since: <next app version>` header; do NOT INSERT
      schema_migrations — runner stamps it):
      `ALTER TABLE diagnosis_reports ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;`
      (`progress` shape: `{ "current": int, "total": int, "section": "<title>", "phase": "collect|render|assemble" }`).
- [ ] Verify idempotent / forward-only: `DRY_RUN=1 node scripts/v2/migrate.mjs --status` parses it; re-run is a no-op.
- [ ] Commit: `feat(db): add progress jsonb to diagnosis_reports (AI diagnosis live progress)`.

### A2 — Worker DB: `update_progress` writer
- [ ] Failing test in `scripts/v2/workers/diagnosis/test_report.py` (or `test_db.py`): `update_progress`
      writes the `progress` jsonb and (via trigger) advances `updated_at`.
- [ ] Add `update_progress(conn, report_id, current, total, section, phase)` to
      `scripts/v2/workers/diagnosis/db.py` — single `UPDATE diagnosis_reports SET progress = :p WHERE id = :id`
      (pg8000 `conn.run`, JSON-encode the dict). Guard `report_id is None` → no-op (older enqueue fallback).
- [ ] Commit: `feat(worker): diagnosis db.update_progress`.

### A3 — `report.generate()` emits per-section progress + per-section idle timeout
- [ ] Failing test (`test_report.py`): `generate(..., on_progress=cb)` invokes `cb(current,total,title,phase)`
      monotonically (1..N) across the section catalog; a stubbed slow/idle Bedrock call raises a
      timeout (no infinite hang). Mock `_bedrock_render`.
- [ ] Refactor `generate()` (`scripts/v2/workers/diagnosis/report.py:114`): replace the
      `rendered = [render_section(sec, collected) for sec in catalog]` list-comp with an explicit loop
      that calls `on_progress(i+1, len(catalog), sec["title"], "render")` before each `render_section`.
      Add an optional `on_progress=None` param (no-op default → existing callers unaffected). Emit a
      `phase="collect"` progress before source collection and `phase="assemble"` before final markdown.
- [ ] Add a per-section Bedrock **idle/read timeout** in `_bedrock_render` (botocore
      `Config(read_timeout=…, connect_timeout=…)`) so one section can't hang the whole job (V1 parity).
      Raise on timeout → caught by `_report`'s except → `finish_report(failed)`.
      **[gate/gemini MINOR] Keep the existing `region_name=BEDROCK_REGION` (us-east-1, report.py:51-52)
      on the bedrock-runtime client — the us.* inference profile requires a US region; do NOT switch
      to the deployment AWS_REGION (would make the new read_timeout fire prematurely / ValidationException).**
- [ ] Commit: `feat(worker): per-section progress callback + bedrock idle timeout in report.generate`.

### A4 — `_report` wires the progress callback
- [ ] Failing test (`test_report.py` or a `handlers` test): `_report` passes an `on_progress` that calls
      `ddb.update_progress(conn, report_id, …)`; assert progress rows written during a mocked generate.
- [ ] `scripts/v2/workers/handlers.py` `_report`: build `on_progress = lambda c,t,s,p: ddb.update_progress(conn, report_id, c, t, s, p)`
      and pass to `rpt.generate(conn, account, tier, report_id=report_id, on_progress=on_progress)`.
- [ ] Commit: `feat(worker): _report streams section progress to diagnosis_reports`.

### A5 — BFF surfaces `progress`
- [ ] Failing test (`web` vitest): `lib/diagnosis` `COLS`/`DiagnosisReport` includes `progress`; the
      `/api/diagnosis/[id]` response carries `report.progress`.
- [ ] `web/lib/diagnosis.ts`: add `progress` to `COLS` and the `DiagnosisReport` interface
      (`progress: { current?: number; total?: number; section?: string; phase?: string }`). `/api/diagnosis/[id]`
      already returns the full `report` → progress flows through automatically; add an assertion test only.
- [ ] Commit: `feat(web): expose diagnosis progress in BFF report payload`.

### A6 — `DiagnosisView` live progress + explicit failed/stale UI (kills infinite "진단중")
- [ ] Failing test `web/components/diagnosis/DiagnosisView.test.tsx`: (a) while polling, a running report
      with `progress{current:3,total:9,section:'네트워크'}` renders a progress indicator
      ("3/9 · 네트워크") not a bare "진단중"; (b) a `failed` report renders the error + a retry affordance;
      (c) when polling exhausts without terminal status, a timeout/“오래 걸림” state is shown (not silent).
- [ ] Update `DiagnosisView.tsx`: render `active`/top-report `progress` as a bar + current-section label
      while `status==='running'`; render `failed` with `report.error`; on poll-exhaust show an explicit
      stalled state with a re-poll/refresh action. Keep `export default`. WCAG-AA contrast on new states.
- [ ] Commit: `feat(web): live section progress + explicit failed/stalled states in DiagnosisView`.

### B1 — `fargate_worker.py` fail-loud guard (never crash before write-back)
- [ ] Failing test `scripts/v2/workers/test_fargate_worker.py`: an unknown `job["type"]` does NOT raise an
      unguarded `KeyError`; instead the job is finished `failed` with a clear error, and if
      `payload.report_id` is set the report is marked `failed` too. (Mock `db`/`handlers`.)
- [ ] Edit `scripts/v2/workers/fargate_worker.py:main`:
      **[gate/gemini MAJOR] FIRST extract `payload = job["payload"] if isinstance(...) else {}` and
      `report_id = payload.get("report_id")` BEFORE the `REGISTRY` lookup** — so the `except` block can
      still mark the report failed even when the lookup itself throws (the original `KeyError: 'report'`
      crashed before any write-back path). Then guard `handlers.REGISTRY.get(job["type"])` → on miss,
      `db.finish_job(failed, error="unknown job type")` + best-effort
      `diagnosis db.finish_report(report_id, 'failed', error=…)` when `report_id`; exit non-zero.
      Wrap the handler dispatch in a top-level `try` that, on any exception, marks the report `failed`
      via the pre-captured `report_id` before re-raising (so a crash inside the handler can't orphan it).
- [ ] Commit: `fix(worker): fail-loud on unknown job type / handler crash; never orphan diagnosis_reports`.

### B2 — `reaper.py` reconciles `diagnosis_reports` (V1 30-min stale guard, V2 edition)
- [ ] Failing test `scripts/v2/workers/test_reaper.py`: reaper marks a `diagnosis_reports` row `failed` when
      (a) its `worker_job_id` job is `failed`, OR (b) it's `running` with `updated_at` older than
      `RUNNING_STALE_MIN`; and it does NOT touch a fresh running row that is still emitting progress
      (recent `updated_at`).
- [ ] Edit `scripts/v2/workers/reaper.py:lambda_handler`: after the `worker_jobs` reconciliation, add
      `UPDATE diagnosis_reports SET status='failed', error='reaped: worker failed or stale'
       WHERE status='running' AND (worker_job_id IN (SELECT job_id FROM worker_jobs WHERE status='failed')
       OR updated_at < now() - make_interval(mins => :m)) RETURNING id` (m=`RUNNING_STALE_MIN`).
      Add `reaped_reports` to the output dict. Use `make_interval` (C12), pg8000 `conn.run`.
- [ ] Commit: `fix(worker): reaper reconciles stale/failed diagnosis_reports (no eternal running)`.

### Z — Verification (gate before done)
- [ ] `cd scripts/v2/workers && python -m pytest diagnosis/ test_*.py` green.
- [ ] `cd web && npx vitest run components/diagnosis lib/diagnosis` green; `npm run build` clean (standalone).
- [ ] `node scripts/v2/migrate.mjs --status` lists the new migration as pending; DRY_RUN apply parses.
- [ ] Manual reasoning trace: every worker exit path (success / handler-exception / unknown-type /
      OOM-kill / DB-connect-fail / idle-timeout) ends with `diagnosis_reports` in a terminal status
      (directly or via reaper) — no path leaves it `running` indefinitely.

---

## Deploy (after merge — operator/controller, NOT in code scope)
1. `make migrate` (applies A1; ULID, advisory-locked).
2. `make workers` (rebuild+push arm64 worker image WITH the report handler — **this alone unblocks the live page**).
3. `make deploy` (web: progress + failed UI).
4. One-time: reconcile the existing stuck rows (`UPDATE diagnosis_reports SET status='failed',
   error='pre-fix stale' WHERE status='running'`) so the page clears — controller runs via `!`.

## 기둥 C — gated follow-on (separate plan / PRs, NOT here)
- **C1 Observability:** CloudWatch alarm on SFN `awsops-v2-workers` `ExecutionsFailed > 0` (+ optional
  diagnosis-stuck metric) → SNS. Terraform under `workers.tf`, flag-gated.
- **C2 Producer/consumer contract + drift guard:** test that every job `type` the BFF enqueues ∈ worker
  `REGISTRY`; bake git-sha into web+worker images, expose via `/api/health`, assert deployed==HEAD in a
  release smoke. Prevents half-deployed features (the PRIMARY root cause).
- **C3 Capacity:** raise worker task mem from 512 MiB (or add an OOM/duration CloudWatch metric).
- **C4 Deploy ergonomics:** `make release` = migrate + workers + web (so the worker image can't be forgotten).
