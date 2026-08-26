# AI Diagnosis — Deep Tier (15-section, selectable Sonnet/Opus)

**Date:** 2026-06-16
**Branch:** `feat/diagnosis-deep-tier` (worktree off `feat/v2-architecture-design`)
**Status:** Design — pending consensus plan gate
**Scope:** Spec 1 of 2. (Spec 2 = scheduled auto-diagnosis + SNS/Slack notifications + settings UI — separate cycle.)

## Goal

Activate the `deep` diagnosis tier. Today `light`/`mid`/`deep` are a *type* (`DiagnosisTier`) but the
BFF forces every request to `mid` (`web/app/api/diagnosis/route.ts:30`) and the worker renders one
fixed 9-section catalog regardless of tier. Deep tier should produce a **richer 15-section** read-only
report, same automatic-report shape as v1, with a **per-run model choice: Sonnet 4.6 (default) or
Opus 4.8** (Sonnet is enough for most runs; Opus for heavier analysis).

## Non-goals / Out of scope (Spec 2)

- Scheduling / EventBridge-driven auto runs.
- SNS email / Slack notifications, settings UI, subscription management.
- New AWS data sources or new IAM data-plane scopes (deep reuses the **existing** collectors).
- Changing `light`/`mid` behavior — they stay byte-for-byte as today.
- True SSE push for progress — the existing 3s polling of the `progress` column is unchanged.

## Current state (grounding)

- **Catalog:** `scripts/v2/workers/diagnosis/sections.py` — `SECTIONS` (8 base sections) +
  `INTENDED_VS_ACTUAL_SECTION` appended by `report.generate` → 9 total for every tier today.
- **Model:** `report.py` uses a single `MODEL_ID` env (`us.anthropic.claude-sonnet-4-6`),
  `max_tokens=1500`, regardless of tier. `_bedrock_render` invokes from `BEDROCK_REGION` (us-east-1).
- **Tier today only** labels the markdown title and the idempotency key — it does **not** change the
  catalog or model.
- **BFF:** `route.ts:30` → `const tier = body?.tier === 'light' ? 'light' : 'mid'` (deep dropped).
- **UI:** `web/components/diagnosis/DiagnosisView.tsx` posts `{ tier }`; progress shown by polling
  `GET /api/diagnosis/{id}` every 3s reading the `progress` JSONB column (`ProgressPanel`).
- **Worker:** Fargate `report` job (`handlers._report`) → `report.generate(conn, account, tier, ...)`.

## Design

### 1. Tier → (catalog, model, max_tokens) mapping (`report.py`)

Introduce an explicit resolver instead of the implicit single catalog/model:

```
TIER_CATALOG = { "light": SECTIONS, "mid": SECTIONS, "deep": DEEP_SECTIONS }   # +intended appended
TIER_MAX_TOKENS = { "light": 1500, "mid": 1500, "deep": 2200 }
```

- `light`/`mid` keep `SECTIONS` (current behavior, unchanged).
- `deep` uses `DEEP_SECTIONS`.
- Model resolution: a new `model` argument (`"sonnet"` | `"opus"`), default `"sonnet"`. Only `deep`
  may select `"opus"`; for `light`/`mid` the resolver pins `"sonnet"`. Model **ids come from env**
  (no hardcoded Bedrock profile strings in logic):
  - `DIAGNOSIS_MODEL_SONNET` (default `us.anthropic.claude-sonnet-4-6`) — current `DIAGNOSIS_MODEL_ID`
    kept as a back-compat alias.
  - `DIAGNOSIS_MODEL_OPUS` (default `us.anthropic.claude-opus-4-8` — **exact Bedrock inference-profile
    id verified at implementation** via the `claude-api` skill / `bedrock list-inference-profiles`).
- `generate(conn, account, tier="mid", model="sonnet", report_id=None, on_progress=None)` resolves
  catalog + model id + max_tokens once and threads them to `render_section` / `_bedrock_render`.
- `_bedrock_render(prompt, ctx, model_id, max_tokens)` — model_id and max_tokens become parameters
  (today they are module constants).

### 2. DEEP_SECTIONS catalog (`sections.py`) — 14 + intended = 15

The existing 8 base sections **plus 6 deep-only sections**, all consuming **already-collected
sources** (no new collectors, no new IAM):

| # | key | title | sources |
|---|-----|-------|---------|
| 1–8 | (the existing 8 `SECTIONS`) | — | — |
| 9 | `identity_access` | IAM & 자격 증명 심층 | posture, inventory |
| 10 | `data_protection` | 데이터 보호 & 암호화 | inventory, posture |
| 11 | `network_exposure` | 네트워크 보안 / 노출 | inventory, service_map |
| 12 | `reliability_ha` | 신뢰성 & 고가용성 | inventory, cw_metrics |
| 13 | `observability_coverage` | 관측성 & 알람 커버리지 | cw_metrics, inventory |
| 14 | `cost_optimization` | 비용 최적화 심층 | cost, inventory, cw_metrics |
| 15 | `intended_vs_actual` | Intended vs Actual (always appended) | intended_vs_actual |

Each new section follows the existing prompt convention: Korean-first, read-only framing, evidence
required, **no auto-change / mutation suggestions**, "데이터에만 근거". A section whose sources are all
degraded still renders (the LLM is told the source is unavailable) — same degrade-safe contract as
mid; it never aborts the report.

### 3. BFF (`web/app/api/diagnosis/route.ts`)

- Un-gate deep: `const tier = ['light','mid','deep'].includes(body?.tier) ? body.tier : 'mid'`.
- Model: `const model = tier === 'deep' && body?.model === 'opus' ? 'opus' : 'sonnet'`.
- Idempotency key includes model: `report:${email}:${tier}:${model}:${hour}`.
- `createReport(tier, email, model)`; `enqueueJob('report', { account, tier, model, requested_by, report_id })`.

### 4. Persistence (`web/lib/diagnosis.ts` + migration)

- Add nullable `model text` column to `diagnosis_reports` (default NULL → treated as `sonnet`).
  Migration as `terraform/foundation/migrations/<ULID>_diagnosis_model_column.sql` (ULID-named,
  **not** a `schema.sql` append — per project migration rule).
- `createReport` writes `model`; `listReports`/`getReport` select it; `DiagnosisReport` type +`model`.
- Parent-report diff lineage (`parent_report_id`) stays keyed on **same tier** (unchanged); model is
  display metadata, not a lineage key.

### 5. UI (`web/components/diagnosis/DiagnosisView.tsx`)

- Tier selector gains **Deep (15섹션)**.
- When `deep` is selected, show a Sonnet / Opus radio (default **Sonnet**), with a short cost note
  ("Opus: 더 깊은 분석, 비용↑"). POST body includes `model` only for deep.
- Report list/header shows tier and, for deep, the model (`deep · Opus`).

### 6. Worker IAM (verify, widen only if needed)

The Fargate worker bedrock policy is scoped to the Claude FMs + `us.*` cross-region inference
profiles (`terraform/foundation/workers.tf`). Implementation **verifies** the Opus 4.8 profile is
covered; if the resource list is enumerated rather than wildcarded, add the Opus profile ARN. No
new actions — `bedrock:InvokeModel` only.

## Error handling

- Unknown/blocked model (e.g. Opus selected but tier≠deep) → resolver pins sonnet (never errors).
- Opus latency: deep keeps the per-section `DIAGNOSIS_BEDROCK_READ_TIMEOUT_S` (90s) read timeout;
  on timeout a section degrades and the report finishes `partial` (existing behavior), never "running".
- Bedrock `AccessDenied`/`ValidationException` on the Opus profile (IAM/profile gap) → that section
  degrades with the error in notes; report is `partial`, not a hard crash. (Same `_classify` path.)
- New sections reuse existing collectors → no new collector failure modes.

## Testing (TDD)

Python (`scripts/v2/workers/diagnosis/test_report.py`):
- `deep` tier renders **15** sections (catalog length + intended); `mid` still renders 9.
- `model="opus"` on deep → `invoke_model` called with the Opus model id (monkeypatch the client,
  assert `modelId`); `model="opus"` on mid → still Sonnet id (resolver pins).
- `max_tokens` is tier-aware (deep=2200) in the request body.
- Degrade-safe: a deep-only section with all sources degraded still appears in output.

Web (vitest):
- `route.test.ts`: deep is no longer coerced to mid; `model:'opus'` honored only for deep; idempotency
  key includes model.
- `DiagnosisView.test.tsx`: deep option present; Sonnet/Opus radio appears for deep; POST carries model.

Full suites green: `scripts/v2/workers` pytest + `web` vitest.

## Deployment

- DB migration runs via `make deploy` (migrate-first) on live Aurora.
- New worker image: `make workers` (deep catalog + model resolver live on next report job — task def
  uses `:worker-latest`).
- Web image: `make deploy`.
- No `terraform apply` unless the IAM verify (§6) finds the Opus profile uncovered.

## Governance

Read-only throughout — deep is *more analysis*, not more capability. No AWS-resource mutation, no
autonomy, no external write. Outside the 2026-06-11 reversal's frozen scope. No new feature flag
needed (it extends the existing on-demand, admin-reachable report). Opus cost surfaced in the UI.
