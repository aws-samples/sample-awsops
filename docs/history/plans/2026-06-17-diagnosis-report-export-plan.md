# Plan — AI Diagnosis report: generation date + DOCX/PDF export

> Spec: `docs/superpowers/specs/2026-06-17-diagnosis-report-export-design.md`.
> Branch base `9d88ba4` (worktree `feat/diagnosis-export`). TDD: failing test → minimal code →
> refactor; **per-task commit**. Read-only feature (export of an existing read-only report).
> Owner decisions: chromium high-fidelity PDF + generation at report time.

## Allowed file scope
- `scripts/v2/workers/diagnosis/report.py`
- `scripts/v2/workers/diagnosis/test_report.py`
- `scripts/v2/workers/diagnosis/exporters.py`
- `scripts/v2/workers/diagnosis/test_exporters.py`
- `scripts/v2/workers/handlers.py`
- `scripts/v2/workers/requirements.txt`
- `scripts/v2/workers/Dockerfile`
- `terraform/foundation/workers.tf`
- `web/app/api/diagnosis/[id]/download/route.ts`
- `web/app/api/diagnosis/[id]/download/route.test.ts`
- `web/components/diagnosis/DiagnosisView.tsx`
- `web/components/diagnosis/DiagnosisView.test.tsx`

## Out of scope
Scheduling/notifications, PPTX, `db.py`, the BFF `[id]/route.ts` (markdown read stays), any
diagnosis collectors/sections, the deep-tier resolver. No DB columns (artifact keys derive from id).

---

## Tasks

### Task 1: Generation date in the markdown header
- Modify: `scripts/v2/workers/diagnosis/report.py`
- Test: `scripts/v2/workers/diagnosis/test_report.py`
- [ ] Failing test: `report.build_markdown([], "123456789012", "mid")` output contains `생성 일시:`.
- [ ] Implement: in `build_markdown`, prepend a header line
      `> 생성 일시: {now} (KST)` where `now = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d %H:%M")`
      (fixed +9 offset — no `tzdata` dependency). Import `datetime, timezone, timedelta`.
- [ ] Run `python3 -m pytest scripts/v2/workers/diagnosis/ -q` (green).
- [ ] Commit: `feat(diagnosis): generation date (KST) in report header`.

### Task 2: Export deps in requirements
- Modify: `scripts/v2/workers/requirements.txt`
- [ ] Add `python-docx==1.1.2`, `markdown==3.7`, `playwright==1.49.1` (pinned). Locally
      `pip install --user python-docx markdown` so the docx tests can import (playwright/chromium is
      image-only; the pdf test guards on availability).
- [ ] Commit: `build(workers): docx/markdown/playwright deps for report export`.

### Task 3: `exporters.to_docx`
- Create: `scripts/v2/workers/diagnosis/exporters.py`
- Test: `scripts/v2/workers/diagnosis/test_exporters.py`
- [ ] Failing test: `exporters.to_docx("# 제목\n\n본문\n\n- a\n- b")` returns `bytes` starting with
      `PK\x03\x04` (DOCX = zip) and len > 0.
- [ ] Implement `to_docx(markdown)`: `python-docx` Document; pragmatic markdown→docx (h1-h3 →
      headings, `- ` → list items, blank-line-separated paragraphs, `| … |` rows → table); return
      `doc.save` to a `BytesIO` → `.getvalue()`.
- [ ] Run pytest (green).
- [ ] Commit: `feat(diagnosis): exporters.to_docx (markdown→DOCX)`.

### Task 4: `exporters.to_pdf` (chromium)
- Modify: `scripts/v2/workers/diagnosis/exporters.py`
- Test: `scripts/v2/workers/diagnosis/test_exporters.py`
- [ ] **[P2-MAJOR]** Import playwright **lazily inside `to_pdf`** (`from playwright.sync_api import
      sync_playwright`), NOT at module top — else `import exporters` fails locally and breaks the
      `to_docx` tests.
- [ ] Failing test (chromium-guarded): `pytest.importorskip("playwright")` + try/except that
      `pytest.skip`s if chromium isn't installed; otherwise assert `to_pdf("# t\n\n본문")` returns
      bytes starting with `%PDF`.
- [ ] Implement `to_pdf(markdown)`: `markdown.markdown(md, extensions=["tables","fenced_code"])` →
      wrap in an A4 HTML template (UTF-8, print CSS). **[P2-MINOR] CSS uses the system font only**
      (`font-family: 'Noto Sans CJK KR', sans-serif;`) — **no external `@import`/Google-Fonts** (the
      worker is in a private subnet; an external font URL would hang). Launch chromium with
      **`args=["--no-sandbox","--disable-setuid-sandbox"]`** (**[P2-MAJOR]** Fargate blocks the user-ns
      sandbox → chromium crashes without this); `new_page(java_script_enabled=False)`
      (**[P2-MINOR]** static render of LLM-generated HTML — no script execution); `set_content(html,
      wait_until="load")` → `page.pdf(format="A4", print_background=True)` → bytes.
- [ ] Run pytest (green or skipped where chromium absent).
- [ ] Commit: `feat(diagnosis): exporters.to_pdf (markdown→HTML→chromium PDF, sandboxless+JS-off)`.

### Task 5: Worker image — chromium + CJK fonts
- Modify: `scripts/v2/workers/Dockerfile`
- [ ] After `pip install -r requirements.txt`, install Noto CJK fonts
      (`apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk && rm -rf /var/lib/apt/lists/*`)
      and chromium with deps (`python -m playwright install --with-deps chromium`). Keep arm64.
- [ ] `docker`/buildx is run at deploy time (`make workers`); no local build here. Sanity:
      `python -c "import docx, markdown"` resolves locally (deps installed in Task 2).
- [ ] Commit: `build(workers): chromium + Noto CJK in worker image for PDF export`.

### Task 6: handlers — generate + upload docx/pdf (isolated)
- Modify: `scripts/v2/workers/handlers.py`
- Test: `scripts/v2/workers/diagnosis/test_report.py`
- [ ] Failing test: monkeypatch `exporters.to_pdf` to raise; assert `_report` still returns a
      succeeded result (pdf failure isolated) and that `to_docx`/`to_pdf` + S3 puts are attempted
      for `diagnosis/{id}.docx` / `.pdf`.
- [ ] Implement: after the markdown S3 upload in `_report`, best-effort
      `_upload_bytes(exporters.to_docx(md), f"diagnosis/{report_id}.docx", "application/…wordprocessingml.document")`
      and same for pdf (`application/pdf`); each wrapped in try/except that logs to stderr and
      continues (md is source of truth; report status unchanged).
- [ ] Run pytest (green).
- [ ] Commit: `feat(diagnosis): worker uploads DOCX+PDF alongside the report markdown`.

### Task 7: Fargate worker task memory (chromium headroom)
- Modify: `terraform/foundation/workers.tf`
- [ ] Bump the worker task def `cpu = "1024"`, `memory = "4096"` (chromium OOMs at 512MB); update the
      "low on purpose" comment to note the `--oom` proof still OOM-kills at the higher ceiling. No new
      actions/resources; stays `workers_enabled`-gated.
- [ ] `terraform -chdir=terraform/foundation fmt -check` (or `validate`) passes.
- [ ] **[P2-MINOR]** Note for post-deploy: after `terraform apply`, the `--oom` proof (noop-heavy
      `--oom`) still OOM-kills at 4096MB (infinite alloc) → reaper/status_updater path unchanged;
      verify once post-deploy.
- [ ] Commit: `chore(workers): bump Fargate worker to 1024/4096 for chromium PDF`.

### Task 8: BFF download route
- Create: `web/app/api/diagnosis/[id]/download/route.ts`
- Test: `web/app/api/diagnosis/[id]/download/route.test.ts`
- [ ] **[P2-MAJOR/MINOR] Proxy the bytes, do NOT presign** — avoids a new `@aws-sdk/s3-request-presigner`
      dep (keeps `web/package.json` out of scope) AND gives a clean 404 instead of S3's `NoSuchKey` XML.
      Matches the existing `[id]/route.ts` GetObject pattern.
- [ ] Failing tests: `GET …/download?format=docx` → 200 with
      `Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document` +
      `Content-Disposition: attachment; filename="awsops-diagnosis-{id}.docx"`; `format=pdf` →
      `application/pdf`; `format=md` → `text/markdown`; missing object (S3 throws) → 404; bad `format`
      → 400; unauthenticated → 401.
- [ ] Implement: auth via `verifyUser`; validate `format∈{md,docx,pdf}` (else 400); `getReport(id)`
      (404 if absent); `GetObjectCommand` on `diagnosis/${id}.${ext}` (prefix-guarded, region from
      env) → stream/Buffer body to the response with the content-type + attachment disposition; on a
      thrown S3 error (`NoSuchKey`) return 404. Uses the existing `@aws-sdk/client-s3` only.
- [ ] Run `npm --prefix web test -- download` (green).
- [ ] Commit: `feat(diagnosis): BFF report download proxy route (md/docx/pdf)`.

### Task 9: UI — export menu + generation date
- Modify: `web/components/diagnosis/DiagnosisView.tsx`
- Test: `web/components/diagnosis/DiagnosisView.test.tsx`
- [ ] Failing tests: an export control lists MD / DOCX / PDF, each linking
      `/api/diagnosis/{id}/download?format=…`; the report header shows the generation date (ko-KR from
      `created_at`).
- [ ] Implement: replace the single `.md` download with an export menu (3 formats → the download
      route); render `created_at` (ko-KR) in the report header (and keep it in the list). Match
      paper/ink/brand styling + AA contrast.
- [ ] **[P2-MAJOR]** Use a safe date formatter — existing tests mock `created_at:'t'`; guard with
      `const d=new Date(ds); return isNaN(d.getTime()) ? ds : d.toLocaleString('ko-KR')` so an
      unparseable value falls back to the raw string (no "Invalid Date").
- [ ] Run `npm --prefix web test -- DiagnosisView` (green).
- [ ] Commit: `feat(diagnosis): report export menu (MD/DOCX/PDF) + generation date`.
