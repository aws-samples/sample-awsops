# AI Diagnosis report metadata — auto title + tags + edit + soft delete

**Date:** 2026-06-17
**Branch:** `feat/diagnosis-report-meta` (worktree off `feat/v2-architecture-design`)
**Status:** Design — approved by owner; pending consensus plan gate
**Builds on:** deep-tier (`148ddee`) + export (`b206ff4`).

## Goal
Make the diagnosis report list legible and manageable:
1. **Auto title** — an LLM-generated one-line title that conveys the single key insight, so the list
   is scannable (today rows read `#id · tier · model · status · date`, no title).
2. **Editable title** — owner/admin can rename.
3. **Tags** — auto-suggested at generation + manually editable.
4. **Soft delete** — hide a report from the list (recoverable; S3 retained).

## Decisions (owner)
- Auto title: **LLM one-liner** (cheap call in the worker). Tags: **auto-suggest + manual**.
- Delete: **soft** (`deleted_at`, hidden from the list; S3 artifacts retained).
- Edit/delete permission: **owner (`requested_by`) OR admin**; everyone else read-only.

## Non-goals
- Hard delete / S3 cleanup, tag taxonomy/autocomplete across reports, full-text search, retitling
  old reports retroactively (only reports generated after ship get an auto title/tags).

## Current state
- `diagnosis_reports`: id, worker_job_id, parent_report_id, tier, status, requested_by, sources_used,
  summary, artifact_uri, error, created_at, updated_at, progress, model. **No title/tags/deleted_at.**
- Worker `report.generate` → (md, summary, sources_used); `handlers._report` calls
  `db.finish_report(status, sources_used, summary, artifact_uri, error)`.
- BFF: `/api/diagnosis` (GET list via `listReports`, POST create), `/api/diagnosis/[id]` (GET only),
  `/api/diagnosis/[id]/download`. `web/lib/admin.ts:isAdmin(user)` exists (Cognito group ∪ SSM emails).
- `DiagnosisView.tsx` renders the list + the opened report (markdown, export menu, date).

## Design

### 1. Schema — migration `01KVACJV5S0PAGFXTZFMYFQA93_diagnosis_metadata.sql`
`ALTER TABLE diagnosis_reports ADD COLUMN IF NOT EXISTS title text, ADD COLUMN IF NOT EXISTS tags
text[] NOT NULL DEFAULT '{}', ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`
- `deleted_at` is orthogonal to `status` (soft-delete a report in any terminal state). Idempotent.

### 2. Worker — auto title + suggested tags (one LLM call, isolated)
- New `report.make_title_and_tags(md) -> {"title": str, "tags": [str]}`: a single Bedrock call
  (reuses the `_bedrock_render` infra / `BEDROCK_REGION`) over the already-redacted markdown, prompting
  for a Korean one-line key-insight title (≤ ~40 chars, the single most important point) + 3–5 short
  tags, returned as JSON. Model from `DIAGNOSIS_TITLE_MODEL` (default = the existing Sonnet id — the
  call is tiny; overridable to Haiku). Robust JSON parse (strip code fences); on any failure return
  `{"title": None, "tags": []}`.
- `handlers._report`: after `generate`, best-effort `make_title_and_tags(md)` and pass `title`/`tags`
  to `finish_report`. **Failure-isolated** — a title/tag error never fails the report (md/summary still
  finalize). `db.finish_report` gains optional `title`/`tags` params (writes them when provided).

### 3. `web/lib/diagnosis.ts`
- `DiagnosisReport` += `title: string | null`, `tags: string[]`, `deleted_at: string | null`.
  `REPORT_COLS` += `title, tags, deleted_at`.
- `listReports` adds `WHERE deleted_at IS NULL`; `getReport` returns the new fields + `requested_by`.
- New `updateReportMeta(id, { title?, tags? })` (UPDATE title/tags), `softDeleteReport(id)`
  (`SET deleted_at = now() WHERE id=$1 AND deleted_at IS NULL`).
- `canMutateReport(user, report)` = `isAdmin(user) || report.requested_by === (user.email ?? user.sub)`.

### 4. BFF — `web/app/api/diagnosis/[id]/route.ts` (+ PATCH, DELETE)
- **PATCH** `{title?, tags?}`: auth → `getReport` (404) → `canMutateReport` (403) → validate (title
  ≤ 200 chars; tags: array, ≤ 10 items, each ≤ 40 chars, trimmed/de-duped) → `updateReportMeta` → 200.
- **DELETE**: auth → `getReport` (404) → `canMutateReport` (403) → `softDeleteReport` → 200.
- The GET response (and the list route) include a per-report **`can_edit: boolean`** (BFF computes
  `isAdmin` once + compares `requested_by`) so the UI shows controls without a separate `/api/me`.

### 5. UI — `DiagnosisView.tsx`
- **List**: show `title` as the primary line (fallback to `#id · tier` when null); meta
  (tier·model·status·date) demoted to a secondary muted line. Each row gets a delete (trash) control
  when `can_edit`, with a confirm → DELETE → reload list.
- **Opened report header**: inline-editable title (pencil → input → save = PATCH) + tag chips
  (add/remove → PATCH) when `can_edit`; read-only otherwise.

## Error handling
- Title/tag LLM call isolated in the worker (logged, skipped; report unaffected).
- PATCH/DELETE fail-closed: unauthenticated → 401, not owner/admin → 403, missing → 404, invalid body
  → 400. Soft delete is idempotent (re-delete is a no-op).
- Malformed LLM JSON → title null / tags empty (no crash).

## Testing
- Worker: `make_title_and_tags` parses JSON (incl. fenced) → {title, tags}; bad output → null/[];
  `_report` isolation (title failure ⇒ report still succeeded); `finish_report` writes title/tags.
- lib: `listReports` filters `deleted_at IS NULL`; `updateReportMeta`/`softDeleteReport` SQL;
  `canMutateReport` (owner true, admin true, stranger false).
- BFF: PATCH/DELETE 200 for owner+admin, 403 for stranger, 401 unauth, 404 missing, 400 invalid;
  `can_edit` present in GET/list.
- UI: title shown (+fallback); edit title → PATCH; add/remove tag → PATCH; delete (confirm) → DELETE;
  controls hidden when `can_edit` false.

## Deploy
- DB migration via `make deploy` (migrate-first). New worker image (`make workers`) for the
  title/tags generation. Web image (`make deploy`) for the routes + UI. No `terraform apply`.
