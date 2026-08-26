# Plan — AI Diagnosis Deep Tier (15-section, Sonnet/Opus selectable)

> Spec: `docs/superpowers/specs/2026-06-16-diagnosis-deep-tier-design.md`.
> Branch base `23f1e00` (worktree `feat/diagnosis-deep-tier`, off `feat/v2-architecture-design`).
> TDD: failing test → minimal code → refactor; **per-task commit** (explicit paths only).
> Read-only throughout; reuses existing collectors (no new AWS sources / data-plane IAM).
> `light`/`mid` behavior MUST stay byte-for-byte unchanged.

## Allowed file scope
- `scripts/v2/workers/diagnosis/report.py`
- `scripts/v2/workers/diagnosis/sections.py`
- `scripts/v2/workers/diagnosis/test_report.py`
- `scripts/v2/workers/diagnosis/test_intended_vs_actual.py`  *(P2 gate: its 2-arg `_bedrock_render` mocks must become variadic)*
- `scripts/v2/workers/handlers.py`
- `terraform/foundation/migrations/01KV84E4WB8S4NV0W1EENXZSPQ_diagnosis_model_column.sql`
- `terraform/foundation/workers.tf`
- `web/lib/diagnosis.ts`
- `web/lib/diagnosis.test.ts`  *(P2 gate: existing createReport assertion)*
- `web/app/api/diagnosis/route.ts`
- `web/app/api/diagnosis/route.test.ts`
- `web/components/diagnosis/DiagnosisView.tsx`
- `web/components/diagnosis/DiagnosisView.test.tsx`

> **P2 plan-gate (2026-06-16, agy panel + Claude chair; codex engine-404 / kiro timeout = no usable
> findings → single-opinion + chair verification).** Fixes folded in below: (C) existing 2-arg
> `_bedrock_render` mocks in `test_intended_vs_actual.py` break under the new arity → make them
> variadic (Task 1); (M) existing `route.test.ts` assertions (`createReport('mid','u@x.io')`,
> key `report:…:mid:`) and the deep→mid coercion test break → update them (Task 6); (M) `web/lib/
> diagnosis.test.ts` `createReport('mid','u@x.io')` assertion → update (Task 5); (m) put `model`
> LAST in `generate()` (Task 3); (info) worker IAM already covers `inference-profile/us.anthropic.*`
> → Task 8 is verify-only, no terraform edit expected.

## Out of scope (do NOT touch)
Scheduling/EventBridge, SNS/Slack notifications, settings UI, any `scripts/v2/workers/diagnosis/db.py`
status semantics, `sources.py` collectors, anything under `web/app/api/jobs/**`, `web/lib/jobs.ts`,
the concurrent sessions' untracked files (`scripts/v2/workers/remediation_*`, `action_catalog.py`).

---

## Tasks

### Task 1: Parameterize `_bedrock_render` (Tidy First, behavior-preserving)
- Modify: `scripts/v2/workers/diagnosis/report.py`
- Test: `scripts/v2/workers/diagnosis/test_report.py`
- Test: `scripts/v2/workers/diagnosis/test_intended_vs_actual.py`
- [ ] **[P2-CRITICAL]** Make the existing `_bedrock_render` mocks variadic so they survive the new
      arity: in `test_intended_vs_actual.py` change `def fake_bedrock(prompt, ctx)` → `(*a, **k)`
      (read `prompt` from `a[0]`) and `lambda p, c: "본문"` → `lambda *a, **k: "본문"`.
- [ ] Failing test: monkeypatch the `bedrock-runtime` client; assert `render_section` invokes with the
      Sonnet `MODEL_ID` and `max_tokens=1500` today (locks current behavior before refactor).
- [ ] Refactor `_bedrock_render(prompt, context_json)` → `_bedrock_render(prompt, context_json, model_id, max_tokens)`.
      Thread `model_id`/`max_tokens` from `render_section(section, collected, model_id, max_tokens)`
      and from `generate(...)` (resolve once at top, default to current `MODEL_ID`/1500). No behavior
      change for existing callers.
- [ ] Run `python3 -m pytest scripts/v2/workers/diagnosis/ -q` (green — incl. test_intended_vs_actual).
- [ ] Commit: `refactor(diagnosis): thread model_id+max_tokens through render (no behavior change)`.

### Task 2: DEEP_SECTIONS catalog (6 deep-only sections)
- Modify: `scripts/v2/workers/diagnosis/sections.py`
- Test: `scripts/v2/workers/diagnosis/test_report.py`
- [ ] Failing test: `len(sections.DEEP_SECTIONS) == 14`; keys unique; each entry has
      `key/title/sources/prompt`; every source ∈ known collector keys
      (`{inventory,cw_metrics,cost,service_map,posture,what_changed}`); `SECTIONS` unchanged (8).
- [ ] Implement `DEEP_SECTIONS = SECTIONS + [ ...6 new... ]` in `sections.py`:
      `identity_access`(posture,inventory), `data_protection`(inventory,posture),
      `network_exposure`(inventory,service_map), `reliability_ha`(inventory,cw_metrics),
      `observability_coverage`(cw_metrics,inventory), `cost_optimization`(cost,inventory,cw_metrics).
      Korean-first read-only prompts, evidence-required, **no mutation/auto-change suggestions**.
- [ ] Run pytest (green).
- [ ] Commit: `feat(diagnosis): deep-tier 6-section extension (DEEP_SECTIONS)`.

### Task 3: Tier→catalog/model/tokens resolver + `model` arg (worker)
- Modify: `scripts/v2/workers/diagnosis/report.py`
- Modify: `scripts/v2/workers/handlers.py`
- Test: `scripts/v2/workers/diagnosis/test_report.py`
- [ ] Consult the `claude-api` skill / `aws bedrock list-inference-profiles` to confirm the exact
      Opus 4.8 Bedrock inference-profile id; set `DIAGNOSIS_MODEL_OPUS` default accordingly
      (`us.anthropic.claude-opus-4-8` unless the lookup says otherwise).
- [ ] Failing tests: `generate(tier="deep")` renders **15** sections (14 + intended); `tier="mid"`
      still **9**. `generate(tier="deep", model="opus")` → `invoke_model` called with the Opus id;
      `generate(tier="mid", model="opus")` → still Sonnet id (resolver pins non-deep to sonnet).
      Deep request body uses `max_tokens=2200`.
- [ ] Implement in `report.py`: `TIER_CATALOG={light:SECTIONS,mid:SECTIONS,deep:DEEP_SECTIONS}`,
      `TIER_MAX_TOKENS={light:1500,mid:1500,deep:2200}`, `_MODEL_SONNET=os.environ.get("DIAGNOSIS_MODEL_SONNET", os.environ.get("DIAGNOSIS_MODEL_ID","us.anthropic.claude-sonnet-4-6"))`,
      `_MODEL_OPUS=os.environ.get("DIAGNOSIS_MODEL_OPUS","us.anthropic.claude-opus-4-8")`.
      `generate(conn, account, tier="mid", report_id=None, on_progress=None, model="sonnet")`
      (**[P2-MINOR] `model` LAST** so existing positional callers/keyword callers are unaffected):
      resolve `catalog=TIER_CATALOG.get(tier,SECTIONS)`, `model_id = _MODEL_OPUS if (tier=="deep" and model=="opus") else _MODEL_SONNET`,
      `max_tokens=TIER_MAX_TOKENS.get(tier,1500)`; `total=len(catalog)+1`.
- [ ] Implement in `handlers.py`: `_report` reads `model = payload.get("model","sonnet")` and passes
      it to `rpt.generate(..., model=model)`.
- [ ] Run pytest (green).
- [ ] Commit: `feat(diagnosis): tier→catalog/model/tokens resolver + deep model selection`.

### Task 4: DB migration — `model` column on `diagnosis_reports`
- Create: `terraform/foundation/migrations/01KV84E4WB8S4NV0W1EENXZSPQ_diagnosis_model_column.sql`
- [ ] Write idempotent migration: `ALTER TABLE diagnosis_reports ADD COLUMN IF NOT EXISTS model text;`
      with a comment (deep-tier model: sonnet|opus; NULL → sonnet). Read-only posture note.
- [ ] Commit: `feat(diagnosis): migration — diagnosis_reports.model column`.

### Task 5: Web lib — `model` in create/select + type
- Modify: `web/lib/diagnosis.ts`
- Test: `web/lib/diagnosis.test.ts`
- [ ] `DiagnosisReport` type gains `model: string | null`. `REPORT_COLS` includes `model`.
      `createReport(tier, requestedBy, model='sonnet')` inserts `model` (3rd param **optional**, default
      `'sonnet'` → the existing 2-arg call site stays valid). `listReports`/`getReport` map the column.
      Keep `parent_report_id` lineage on same-tier (unchanged).
- [ ] **[P2-MAJOR]** Update `web/lib/diagnosis.test.ts`: the `createReport('mid','u@x.io')` test still
      passes (model defaults); add an assertion that the INSERT binds `model` and that a 3-arg call
      `createReport('deep','u@x.io','opus')` persists `'opus'`.
- [ ] Run `npm --prefix web test -- diagnosis` (green).
- [ ] Commit: `feat(diagnosis): persist+select report model (lib)`.

### Task 6: BFF route — un-gate deep + model param
- Modify: `web/app/api/diagnosis/route.ts`
- Test: `web/app/api/diagnosis/route.test.ts`
- [ ] **[P2-MAJOR]** Update the existing tests broken by the new arity/key: the passing `mid` test's
      `expect(createReport).toHaveBeenCalledWith('mid','u@x.io')` → `('mid','u@x.io','sonnet')` and the
      idempotency-key matcher `report:u@x.io:mid:` → `report:u@x.io:mid:sonnet:`; repurpose the
      `coerces an unknown/deep tier to mid` test to a truly-unknown tier (e.g. `{tier:'bogus'}` →
      `createReport('bogus'→'mid', …, 'sonnet')`).
- [ ] Failing tests: POST `{tier:'deep'}` stays `deep` (not coerced to mid); `{tier:'deep',model:'opus'}`
      → job payload + createReport carry `model:'opus'`; `{tier:'mid',model:'opus'}` → `model:'sonnet'`
      (resolver pins); idempotency key includes model (`report:<email>:<tier>:<model>:<hour>`).
- [ ] Implement: `const tier = ['light','mid','deep'].includes(body?.tier) ? body.tier : 'mid'`;
      `const model = tier==='deep' && body?.model==='opus' ? 'opus' : 'sonnet'`; thread into key,
      `createReport(tier, email, model)`, `enqueueJob('report', { account, tier, model, requested_by, report_id })`.
- [ ] Run `npm --prefix web test -- route.test` (green).
- [ ] Commit: `feat(diagnosis): BFF un-gate deep + model selection`.

### Task 7: UI — deep option + Sonnet/Opus radio
- Modify: `web/components/diagnosis/DiagnosisView.tsx`
- Test: `web/components/diagnosis/DiagnosisView.test.tsx`
- [ ] Failing tests: a `deep (15섹션)` tier option exists; selecting deep reveals a Sonnet/Opus radio
      (default Sonnet); POST body includes `model` only for deep; list/header shows `deep · Opus`.
- [ ] Implement: add deep to the tier control; conditional model radio with cost note
      ("Opus: 더 깊은 분석, 비용↑"); include `model` in the POST body for deep; render model in the
      report meta. Match existing paper/ink/brand styling + AA contrast.
- [ ] Run `npm --prefix web test -- DiagnosisView` (green).
- [ ] Commit: `feat(diagnosis): deep tier UI + model selector`.

### Task 8: Worker IAM — verify Opus inference-profile coverage (verify-only)
- Modify: `terraform/foundation/workers.tf`
- [ ] **[P2-INFO — verify-only, no edit expected]** The P2 gate confirmed the Fargate worker + worker
      Lambda bedrock policies already grant `bedrock:InvokeModel` on `arn:aws:bedrock:*:*:inference-profile/us.anthropic.*`,
      which covers `us.anthropic.claude-opus-4-8`. Re-confirm by reading `workers.tf`; only if the
      wildcard is absent/narrowed, add the Opus profile ARN (action stays `bedrock:InvokeModel`; no
      new actions, no `*` principal). Otherwise make NO change.
- [ ] If unchanged, record the verification in the Task 7 commit / final report (no empty commit).
