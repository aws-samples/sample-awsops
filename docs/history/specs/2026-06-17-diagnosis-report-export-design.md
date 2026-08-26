# AI Diagnosis Report — Generation date + DOCX/PDF export

**Date:** 2026-06-17
**Branch:** `feat/diagnosis-export` (worktree off `feat/v2-architecture-design`)
**Status:** Design — approved by owner; pending consensus plan gate
**Builds on:** the deep-tier work (merged `148ddee`).

## Goal
Like v1, the AI diagnosis report must (1) show its **generation date/time**, and (2) be
**exportable to DOCX and PDF** (today only a client-side `.md` blob download exists). Owner chose
**chromium high-fidelity PDF (v1-style)** and **generation at report time** (instant download).

## Decisions (owner)
- PDF: headless **chromium** (high fidelity), generated in the Fargate worker (v2 worker is Python →
  `playwright` chromium, not v1's TS puppeteer).
- DOCX: `python-docx` in the same worker.
- Timing: generated at report time alongside the `.md` and uploaded to S3 (instant download).
- Date: generation timestamp in **KST**, shown in the report header (flows into md/docx/pdf) and the UI.

## Non-goals
- Scheduling / notifications (separate Spec 2). PPTX (v1 legacy) — not ported. No new report content.
- Re-generating exports for old reports (only reports created after ship get docx/pdf).

## Current state
- Worker `report.generate` builds markdown; `handlers._upload_markdown` puts `diagnosis/{id}.md` to S3.
- `web/app/api/diagnosis/[id]/route.ts` reads the `.md` for the UI; `DiagnosisView` renders it and
  offers a single client-side `.md` download. No date in the markdown header.
- Worker image: `python:3.12-slim`, `requirements.txt` = pg8000 + boto3. Fargate task def
  (`workers.tf:346-353`) `cpu=256 / memory=512` ("low on purpose" for the --oom proof).
- Web IAM already scopes `s3:GetObject .../diagnosis/*` (covers `.docx`/`.pdf`).

## Design

### 1. Worker — generate date + docx + pdf (new `diagnosis/exporters.py`)
- `report.build_markdown` prepends a header line: `> 생성 일시: YYYY-MM-DD HH:MM (KST)` (worker stamps
  `datetime.now(ZoneInfo("Asia/Seoul"))`). Flows into all three artifacts.
- New module `scripts/v2/workers/diagnosis/exporters.py`:
  - `to_docx(markdown: str) -> bytes` — `python-docx`; markdown → headings/paragraphs/lists/tables
    (pragmatic converter; title + date header).
  - `to_pdf(markdown: str) -> bytes` — `markdown`→HTML + an A4 CSS template → **playwright chromium**
    → PDF bytes. CJK font (Noto Sans CJK KR) so Korean renders (no □).
- `handlers._report`: after the markdown upload, best-effort generate + upload
  `diagnosis/{id}.docx` and `diagnosis/{id}.pdf`. **Failure is isolated** — a docx/pdf error is
  logged and skipped; the report stays succeeded/partial (md is the source of truth). No new DB
  columns: artifact keys are derived from the report id.

### 2. Worker image (the heavy part — owner-accepted)
- `requirements.txt` += `python-docx`, `markdown`, `playwright` (pinned).
- `Dockerfile`: install Noto CJK fonts + chromium with its system deps
  (`playwright install --with-deps chromium`), arm64. Image grows materially; buildx is slower.
- `workers.tf`: bump the Fargate worker task to **cpu=1024 / memory=4096** (chromium OOMs at 512MB).
  The `--oom` proof still OOM-kills (it allocates until the new ceiling). Update the "low on purpose"
  comment. (Gated under `workers_enabled`; this is a task-def change → `terraform apply`.)

### 3. BFF download — `web/app/api/diagnosis/[id]/download/route.ts` (new)
- `GET /api/diagnosis/{id}/download?format=md|docx|pdf` — auth; look up the report; resolve the S3
  key `diagnosis/{id}.{ext}` (prefix-guarded); return a **presigned GET URL redirect** (or 404 if the
  object is missing). Content types: md=text/markdown, docx=…wordprocessingml.document, pdf=application/pdf.

### 4. UI (`DiagnosisView.tsx`)
- Replace the single MD download with an **export menu**: MD / DOCX / PDF (each hits the download
  route). Enabled when the report is succeeded/partial.
- Show the **generation date** (ko-KR) in the report header and keep it in the report list (uses the
  existing `created_at`).

## Error handling
- docx/pdf generation wrapped in try/except in the worker; on failure log to stderr and continue
  (report not failed; that format simply absent → BFF 404 → UI hides/notifies).
- chromium crash/timeout isolated to the pdf step; does not affect md/docx or report status.
- BFF download: missing object → 404; bad format → 400; non-diagnosis prefix → 404.

## Testing
- Worker (`test_exporters.py`): `to_docx` returns a non-empty zip (DOCX = PK zip magic); `to_pdf`
  returns bytes starting `%PDF`; a forced pdf failure leaves the report succeeded (handlers isolation).
  build_markdown includes the `생성 일시` line.
- BFF (`download/route.test.ts`): format→content/redirect; 404 missing; 400 bad format; auth.
- UI (`DiagnosisView.test.tsx`): export menu lists MD/DOCX/PDF and hits `…/download?format=`; date rendered.
- `to_pdf` chromium tests guard on chromium availability (skip locally if absent; the worker image has it).

## Deploy
- `make workers` (rebuilds the worker image with chromium — slow) + `terraform apply` (worker task
  cpu/memory bump) + `make deploy` (web: download route + UI).
