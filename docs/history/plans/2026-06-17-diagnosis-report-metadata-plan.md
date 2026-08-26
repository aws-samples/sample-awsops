# Plan — AI Diagnosis report metadata (title/tags/edit/soft-delete)

> Spec: `docs/superpowers/specs/2026-06-17-diagnosis-report-metadata-design.md`.
> Branch base `af76c89` (worktree `feat/diagnosis-report-meta`). TDD: failing test → minimal code →
> refactor; **per-task commit**. Read-only feature (metadata on read-only reports). Owner decisions:
> LLM one-line title + auto-suggest tags, soft delete, owner-or-admin edit/delete.

## Allowed file scope
- `terraform/foundation/migrations/01KVACJV5S0PAGFXTZFMYFQA93_diagnosis_metadata.sql`
- `scripts/v2/workers/diagnosis/report.py`
- `scripts/v2/workers/diagnosis/db.py`
- `scripts/v2/workers/handlers.py`
- `scripts/v2/workers/diagnosis/test_report.py`
- `web/lib/diagnosis.ts`
- `web/lib/diagnosis.test.ts`
- `web/app/api/diagnosis/[id]/route.ts`
- `web/app/api/diagnosis/[id]/route.test.ts`
- `web/app/api/diagnosis/route.ts`
- `web/app/api/diagnosis/route.test.ts`
- `web/components/diagnosis/DiagnosisView.tsx`
- `web/components/diagnosis/DiagnosisView.test.tsx`

## Out of scope
Hard delete / S3 cleanup, tag autocomplete/taxonomy, search, `download/route.ts`, the diagnosis
collectors/sections, deep-tier resolver, scheduling/notifications.

---

## Tasks

### Task 1: Migration — title / tags / deleted_at
- Create: `terraform/foundation/migrations/01KVACJV5S0PAGFXTZFMYFQA93_diagnosis_metadata.sql`
- [ ] Idempotent: `ALTER TABLE diagnosis_reports ADD COLUMN IF NOT EXISTS title text, ADD COLUMN IF
      NOT EXISTS tags text[] NOT NULL DEFAULT '{}', ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`
      with a header comment (soft-delete orthogonal to status; read-only posture). Do NOT INSERT into
      schema_migrations (the runner stamps it).
- [ ] Commit: `feat(diagnosis): migration — report title/tags/deleted_at`.

### Task 2: web/lib — fields, soft-delete filter, mutators, permission
- Modify: `web/lib/diagnosis.ts`
- Test: `web/lib/diagnosis.test.ts`
- [ ] Failing tests: `listReports`, `getReport`, `reportForIdempotencyKey`, and `createReport`'s
      parent-lineage subquery all contain `deleted_at IS NULL`; `updateReportMeta(7,{tags:['a']})` does
      NOT clobber title (partial); `softDeleteReport(7)` sets `deleted_at = now()` `WHERE ... deleted_at
      IS NULL`; `canMutateReport` → owner true, stranger false (mock `isAdmin`).
- [ ] **[P2-MAJOR] Honor soft-delete everywhere** (the constant is named **`COLS`**, not REPORT_COLS):
      `COLS` += `title, tags, deleted_at`; add `AND deleted_at IS NULL` to `listReports`, `getReport`
      (so a deleted report → 404 on GET/download/PATCH/DELETE), the `createReport` parent subquery
      (don't pick a deleted parent), and `reportForIdempotencyKey` (re-run after delete starts fresh).
- [ ] `DiagnosisReport` += `title: string|null`, `tags: string[]`, `deleted_at: string|null`,
      `can_edit?: boolean` (**[P2-MINOR]** TS build needs these declared).
- [ ] `updateReportMeta(id, {title?, tags?})` — **partial**: only set columns that were provided (don't
      overwrite title when only tags sent). `softDeleteReport(id)`. `canMutateReport(user, report)` =
      `(await isAdmin(user)) || report.requested_by === (user.email ?? user.sub)` (import from `@/lib/admin`).
- [ ] Run `npm --prefix web test -- lib/diagnosis` (green).
- [ ] Commit: `feat(diagnosis): report title/tags/deleted_at + soft-delete filters + mutators (lib)`.

### Task 3: Worker — auto title + suggested tags (isolated) + finish_report
- Modify: `scripts/v2/workers/diagnosis/report.py`
- Modify: `scripts/v2/workers/diagnosis/db.py`
- Modify: `scripts/v2/workers/handlers.py`
- Test: `scripts/v2/workers/diagnosis/test_report.py`
- [ ] Failing tests: `report.make_title_and_tags` parses a fenced-JSON model reply
      (monkeypatch `_bedrock_render` → ```json {"title":"핵심","tags":["보안","비용"]}```) → {title,tags};
      malformed reply → {title:None, tags:[]}. `db.finish_report(..., title=, tags=)` includes them in
      the UPDATE. `_report`: a `make_title_and_tags` exception leaves the report succeeded (isolation).
- [ ] Implement `make_title_and_tags(md)` in report.py: `_bedrock_render(TITLE_PROMPT, md,
      _TITLE_MODEL, 300)` where `_TITLE_MODEL = os.environ.get("DIAGNOSIS_TITLE_MODEL", _MODEL_SONNET)`;
      TITLE_PROMPT asks for a Korean ≤40-char single-key-insight title + 3–5 short tags as JSON.
      **[P2-MINOR] Robust parse**: take the substring from the first `{` to the last `}` before
      `json.loads` (tolerates ```json fences / filler). Clamp title (≤200 store, prompt asks ≤40) +
      tags (≤10, ≤40 each, non-empty strings); on ANY error return `{"title": None, "tags": []}`.
- [ ] **[P2-MINOR] `db.finish_report` conditional SET** — gains optional `title=None, tags=None` and
      appends `title=:t2` / `tags=:tg` to the UPDATE **only when each is not None** (the failure path
      `finish_report(status="failed", error=...)` passes neither → must not clobber/NULL them). Keep
      the `WHERE id=:id AND status='running'` guard.
- [ ] `handlers._report`: after `generate`, `meta = report.make_title_and_tags(md)` wrapped in
      try/except (log + `{title:None,tags:[]}` on failure), pass `title=meta["title"], tags=meta["tags"]`
      to `finish_report`.
- [ ] Run `python3 -m pytest scripts/v2/workers/diagnosis/ -q` (green).
- [ ] Commit: `feat(diagnosis): worker auto-title + suggested tags (isolated)`.

### Task 4: BFF `[id]` — PATCH + DELETE + can_edit on GET
- Modify: `web/app/api/diagnosis/[id]/route.ts`
- Test: `web/app/api/diagnosis/[id]/route.test.ts`
- [ ] Failing tests: PATCH `{title,tags}` as owner → 200 + `updateReportMeta` called; as admin → 200;
      as stranger → 403; unauth → 401; missing report → 404; invalid (title > 200 / tags not array /
      tag too long) → 400. DELETE as owner/admin → 200 + `softDeleteReport`; stranger → 403. GET
      response includes `can_edit`.
- [ ] Implement PATCH + DELETE: `verifyUser` (401) → id NaN guard (400) → `getReport` (404, now also
      filters deleted) → `canMutateReport` (403, **server-side is the real gate; `can_edit` is only a UI
      hint**) → PATCH validates+clamps body (title ≤200; tags = string[], ≤10, each ≤40, trimmed,
      control-chars stripped) then `updateReportMeta`; DELETE `softDeleteReport`. Extend GET to add
      `can_edit = await canMutateReport(user, report)`.
- [ ] Run `npm --prefix web test -- "[id]/route"` (green).
- [ ] Commit: `feat(diagnosis): BFF report PATCH/DELETE (owner|admin) + can_edit`.

### Task 5: BFF list — per-report can_edit
- Modify: `web/app/api/diagnosis/route.ts`
- Test: `web/app/api/diagnosis/route.test.ts`
- [ ] Failing test: GET `/api/diagnosis` returns reports each carrying `can_edit` (owner/admin true,
      else false) — compute `isAdmin(user)` once, map `requested_by === user`.
- [ ] Implement: in the GET handler, **call `isAdmin(user)` ONCE** (it's async + SSM-backed), then map
      `can_edit = admin || r.requested_by === (user.email ?? user.sub)` per report (no per-row isAdmin).
      Keep the POST path unchanged.
- [ ] Run `npm --prefix web test -- "diagnosis/route"` (green).
- [ ] Commit: `feat(diagnosis): list route attaches can_edit per report`.

### Task 6: UI — title (list + editable header), tags, delete
- Modify: `web/components/diagnosis/DiagnosisView.tsx`
- Test: `web/components/diagnosis/DiagnosisView.test.tsx`
- [ ] Failing tests: a report with a title shows the title as the list's primary line (null → `#id`
      fallback); when `can_edit`, a delete control appears and (after confirm) POSTs DELETE then
      reloads; the opened header shows an editable title (save → PATCH) + tag chips (add/remove →
      PATCH); when `can_edit` is false, no edit/delete controls render.
- [ ] Implement: list primary = `r.title || '#'+r.id …`; per-row delete (trash, `can_edit`) with a
      confirm; opened header inline title edit + tag chips, gated on `view`/row `can_edit`; PATCH/DELETE
      via `fetch`. Match paper/ink/brand + AA contrast. (`ReportRow`/view types gain title/tags/can_edit.)
- [ ] **[P2-CRITICAL] No stored XSS**: render title + tags as **plain JSX text** (React auto-escapes) —
      never `dangerouslySetInnerHTML`, and never inject them into the markdown/`ReportMarkdown`. Add a
      test that a title containing `<script>` renders as escaped text.
- [ ] Run `npm --prefix web test -- DiagnosisView` (green).
- [ ] Commit: `feat(diagnosis): report title/tags/delete UI`.
