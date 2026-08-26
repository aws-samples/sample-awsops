# AI Diagnosis v2 — Plan 2: Intent Engine (intended-vs-actual) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Add the consultant differentiator on top of Plan 1 — a versioned **ArchitectureIntent** of operator-confirmed invariants, a **deterministic invariant engine** that compares intended-vs-actual, a **Phase-1 "propose & confirm"** admin flow, **drift findings** woven into the report, and **report diff vs the previous run**.

**Architecture:** The LLM only *proposes* candidate invariants against a **fixed predicate schema**; an admin **promotes** them; a pure-Python evaluator runs promoted invariants against live state (Plan 1 collectors: inventory, service_map edges, posture) and yields pass/fail **verdicts**. Only verdicts (never raw untrusted text) reach Bedrock. Reports link `parent_report_id` for regression diff. All read-only.

**Tech Stack:** Plan 1 stack (Python `pg8000`/`boto3` worker, Next.js BFF, vitest/pytest). Builds on Plan 1's `diagnosis_reports`, `scripts/v2/workers/diagnosis/`, `web/lib/diagnosis.ts`, `/ai-diagnosis`.

**Source of truth:** spec `docs/superpowers/specs/2026-06-11-ai-diagnosis-v2-design.md` §4.0, §4.2-KB, §6, §8R3 (consensus-locked, 3 design + 2 plan rounds).

**Depends on:** Plan 1 (PR #37) merged. Base this work off `origin/feat/v2-architecture-design` after #37 lands.

**Scope guard:**
- IN: `architecture_intent` table, predicate schema + deterministic evaluator, candidate-proposal (LLM, schema-bound, never activates), admin promote/confirm API + UI panel, Heuristic-Risk flag, drift findings in report, report diff vs `parent_report_id`, intent staleness via topology fingerprint.
- OUT (fast-follow): full narrative/SLA/ownership consultant interview, delta re-interview automation, managed Bedrock KB, deep/Opus-15, live external-obs adapter, DOCX/PPTX/PDF, scheduling.
- **Read-only mandate:** no AWS mutation; intent authoring is admin-gated; operator/interview free-text is **untrusted** (fenced, never instructions); the LLM never activates an invariant.

---

## Predicate schema (the anti-fabrication contract)

A promoted invariant is a **structured, machine-evaluable** record — NOT free-form text or LLM-generated code. Fixed enum of predicate kinds (extensible later):

```
Invariant = {
  id, kind, target, params, severity, provenance, status, topology_fingerprint, created_by, created_at
}
kind ∈ {
  "no_public_ingress",        # target=resource_type/arn; fail if a public/0.0.0.0/0 ingress edge exists
  "private_only",             # target=resource_type (e.g. rds); fail if reachable from internet
  "expected_edge",            # params={from,to}; fail if a required service-map edge is ABSENT
  "forbidden_edge",           # params={from,to}; fail if a service-map edge EXISTS
  "encryption_required",      # target=resource_type; fail if any instance unencrypted
  "max_error_rate",           # params={edge, threshold}; fail if service-map edge error_rate > threshold
}
status ∈ { "draft", "active" }       # only 'active' (admin-promoted) invariants are evaluated
provenance ∈ { "ai_proposed", "human_authored" }
severity ∈ { "info", "warning", "critical" }
```
The evaluator is a pure function `evaluate(invariant, actual) -> verdict{passed, observed, severity}`. Adding a `kind` = adding one deterministic evaluator branch + tests. The LLM may only emit candidates whose `kind` is in this enum with schema-valid `params`; anything else is rejected at the API boundary.

---

## File Structure

**Create:**
- `scripts/v2/workers/diagnosis/invariants.py` — predicate enum + `evaluate_all(invariants, actual)` (pure, deterministic)
- `scripts/v2/workers/diagnosis/test_invariants.py` — pytest
- `scripts/v2/workers/diagnosis/propose.py` — LLM candidate proposal (schema-bound; validates+drops non-conforming)
- `web/lib/intent.ts` — `architecture_intent` CRUD + predicate validation (BFF)
- `web/lib/intent.test.ts`
- `web/lib/diff.ts` — report-vs-parent diff (pure)
- `web/lib/diff.test.ts`
- `web/app/api/diagnosis/intent/route.ts` — GET (list intents) + POST (admin: promote/edit/reject a candidate) + a `?action=propose` path
- `web/app/api/diagnosis/intent/route.test.ts`
- `web/components/diagnosis/IntentPanel.tsx` — admin "propose & confirm" UI (drift-risk ordered, per-item accept, Heuristic-Risk badge)

**Modify:**
- `terraform/foundation/data/schema.sql` — `architecture_intent` table (migration v13)
- `scripts/v2/workers/diagnosis/report.py` — evaluate active invariants → inject **drift findings** (verdict-only) into sections; compute report diff vs parent
- `scripts/v2/workers/diagnosis/sections.py` — add an `intended_vs_actual` section consuming the verdicts
- `web/lib/diagnosis.ts` — set `parent_report_id` to the previous succeeded report on create; expose `summary.diff`
- `web/components/diagnosis/DiagnosisView.tsx` — surface drift findings + diff badges; mount `IntentPanel` (admin)
- `web/components/shell/Sidebar.tsx` — (no change; `/ai-diagnosis` already present from Plan 1)

---

## Milestone 1 — ArchitectureIntent schema

### Task 1: `architecture_intent` table

**Files:** Modify `terraform/foundation/data/schema.sql` (append before end, idempotent).

- [ ] **Step 1: DDL** (use migration version `max(version)+1` — after Plan 1's v12 + EKS v10/v11, expect **13**; confirm with `SELECT max(version)`):

```sql
-- architecture_intent — operator-confirmed "intended" model (the should-be). One ACTIVE
-- row per (kind,target,params-hash); drafts may coexist. JSONB doc + topology fingerprint
-- so a confirmed invariant auto-flags stale when the live topology diverges (§8R3).
CREATE TABLE IF NOT EXISTS architecture_intent (
  id                  BIGSERIAL    PRIMARY KEY,
  kind                TEXT         NOT NULL,
  target              TEXT,
  params              JSONB        NOT NULL DEFAULT '{}'::jsonb,
  severity            TEXT         NOT NULL DEFAULT 'warning'
                        CHECK (severity IN ('info','warning','critical')),
  status              TEXT         NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','rejected')),
  provenance          TEXT         NOT NULL DEFAULT 'ai_proposed'
                        CHECK (provenance IN ('ai_proposed','human_authored')),
  topology_fingerprint TEXT,
  created_by          TEXT         NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_validated_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_intent_active
  ON architecture_intent (kind, target, md5(params::text)) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_intent_status ON architecture_intent(status);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_arch_intent_touch') THEN
    CREATE TRIGGER trg_arch_intent_touch BEFORE UPDATE ON architecture_intent
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;
INSERT INTO schema_migrations (version, description)
  VALUES (13, 'architecture_intent — confirmed invariants (AI Diagnosis Plan 2)')
  ON CONFLICT (version) DO NOTHING;
```

- [ ] **Step 2: Verify** `psql ... -f schema.sql && psql ... -c "\d architecture_intent"` (controller-applied; locally validate syntax). **Step 3: Commit** `feat(schema): architecture_intent table (AI Diagnosis Plan 2)`.

---

## Milestone 2 — Deterministic invariant engine

### Task 2: `invariants.py` evaluator

**Files:** Create `scripts/v2/workers/diagnosis/invariants.py` + `test_invariants.py`. FLAT-import convention (per Plan 1: package under `scripts/v2/workers/diagnosis/`, `conftest.py` already on sys.path).

- [ ] **Step 1: Failing test** (`test_invariants.py`)

```python
from diagnosis import invariants as inv

ACTUAL = {
    "service_map": {"edges": [
        {"from": "internet", "to": "rds-prod", "calls": 5, "error_rate": 0.0},
        {"from": "api", "to": "rds-prod", "calls": 900, "error_rate": 0.12},
    ]},
    "inventory": {"by_type": {"rds": 2, "s3": 5}},
}

def test_private_only_fails_on_internet_edge():
    v = {"id": 1, "kind": "private_only", "target": "rds-prod", "params": {}, "severity": "critical"}
    out = inv.evaluate_all([v], ACTUAL)
    assert out[0]["passed"] is False and out[0]["severity"] == "critical"
    assert "internet" in out[0]["observed"]

def test_max_error_rate_trips():
    v = {"id": 2, "kind": "max_error_rate", "params": {"from": "api", "to": "rds-prod", "threshold": 0.05}, "severity": "warning"}
    out = inv.evaluate_all([v], ACTUAL)
    assert out[0]["passed"] is False

def test_unknown_kind_is_skipped_not_crash():
    out = inv.evaluate_all([{"id": 3, "kind": "bogus", "params": {}}], ACTUAL)
    assert out[0]["passed"] is None and "unsupported" in out[0]["observed"].lower()
```

- [ ] **Step 2: Run → FAIL** `python3 -m pytest scripts/v2/workers/diagnosis/test_invariants.py -v`

- [ ] **Step 3: Implement** (`invariants.py`)

```python
"""Deterministic intended-vs-actual evaluator. PURE — no LLM, no AWS. The LLM never calls this;
it only runs admin-promoted invariants against the Plan-1 'actual' collector output. A verdict
(passed True/False/None + observed string + severity) is the ONLY thing handed to the report LLM."""

def _edges(actual):
    return (actual.get("service_map") or {}).get("edges", [])

def _verdict(v, passed, observed):
    return {"id": v.get("id"), "kind": v["kind"], "target": v.get("target"),
            "severity": v.get("severity", "warning"), "passed": passed, "observed": observed}

def _private_only(v, actual):
    bad = [e for e in _edges(actual) if e.get("to") == v.get("target") and e.get("from") == "internet"]
    return _verdict(v, not bad, f"internet→{v.get('target')} edges: {len(bad)}" if bad else "no internet ingress")

def _forbidden_edge(v, actual):
    f, t = v["params"].get("from"), v["params"].get("to")
    hit = [e for e in _edges(actual) if e.get("from") == f and e.get("to") == t]
    return _verdict(v, not hit, f"forbidden edge {f}→{t} present" if hit else f"{f}→{t} absent (ok)")

def _expected_edge(v, actual):
    f, t = v["params"].get("from"), v["params"].get("to")
    hit = [e for e in _edges(actual) if e.get("from") == f and e.get("to") == t]
    return _verdict(v, bool(hit), f"expected edge {f}→{t} present" if hit else f"MISSING expected edge {f}→{t}")

def _max_error_rate(v, actual):
    f, t, thr = v["params"].get("from"), v["params"].get("to"), float(v["params"].get("threshold", 0.05))
    over = [e for e in _edges(actual) if e.get("from") == f and e.get("to") == t and (e.get("error_rate") or 0) > thr]
    return _verdict(v, not over, f"{f}→{t} error_rate {over[0]['error_rate']} > {thr}" if over else f"under {thr}")

_EVALUATORS = {
    "private_only": _private_only, "no_public_ingress": _private_only,
    "forbidden_edge": _forbidden_edge, "expected_edge": _expected_edge,
    "max_error_rate": _max_error_rate,
}

def evaluate_all(invariants, actual):
    out = []
    for v in invariants:
        fn = _EVALUATORS.get(v.get("kind"))
        if not fn:
            out.append(_verdict(v, None, f"unsupported kind: {v.get('kind')}")); continue
        try:
            out.append(fn(v, actual))
        except Exception as e:  # noqa: BLE001 — a bad invariant must not crash a report
            out.append(_verdict(v, None, f"eval error: {e}"))
    return out
```

- [ ] **Step 4: Run → PASS. Step 5: Commit** `feat(worker): deterministic invariant evaluator (intended-vs-actual)`.

### Task 3: `propose.py` — schema-bound LLM candidate proposal

**Files:** Create `scripts/v2/workers/diagnosis/propose.py` + tests.

The LLM is asked to emit ONLY candidates of the fixed `kind` enum from the auto-topology; `propose()` **validates each against the schema and DROPS non-conforming ones** (anti-fabrication). It also sets a `heuristic_risk` flag when a candidate merely reflects current state that *looks* like a misconfig (e.g., proposing `private_only` for an RDS that is *currently* internet-reachable → confirming it would codify a bug).

- [ ] **Step 1: Failing test** — `validate_candidate` drops unknown kinds / bad params; `flag_heuristic_risk` marks a `private_only` whose target currently HAS an internet edge.

```python
from diagnosis import propose

def test_validate_drops_unknown_kind():
    assert propose.validate_candidate({"kind": "rm -rf", "params": {}}) is None

def test_validate_keeps_wellformed():
    c = propose.validate_candidate({"kind": "expected_edge", "params": {"from": "api", "to": "rds"}, "severity": "warning"})
    assert c["kind"] == "expected_edge"

def test_heuristic_risk_on_current_misconfig():
    actual = {"service_map": {"edges": [{"from": "internet", "to": "rds", "error_rate": 0}]}}
    c = {"kind": "private_only", "target": "rds", "params": {}}
    assert propose.flag_heuristic_risk(c, actual) is True
```

- [ ] **Step 2-4:** Implement `validate_candidate` (enum check + per-kind required-params check; return None on fail), `flag_heuristic_risk` (re-use `invariants.evaluate_all([c], actual)` — if it would FAIL right now, confirming it codifies current reality → risky), and `propose(actual, model)` (Bedrock call instructed to output a JSON array of candidates of the allowed kinds; parse, `validate_candidate` each, attach `heuristic_risk`, `provenance='ai_proposed'`, `status='draft'`; drop invalid). Reuse `report._bedrock_render`/`_redact`. **Commit** `feat(worker): schema-bound invariant proposal (LLM proposes, never activates)`.

---

## Milestone 3 — BFF: intent CRUD + promote (admin) + diff

### Task 4: `web/lib/intent.ts` + predicate validation

**Files:** Create `web/lib/intent.ts` + test. Exports: `listIntents(status?)`, `proposeCandidates()` (calls a worker/agent or returns drafts), `promoteIntent(id, edits, admin)` (draft→active, provenance stays/upgrades, admin-gated at the route), `rejectIntent(id)`, and `validatePredicate(candidate)` (mirror of the Python enum/param check — the BFF re-validates before insert). Active-promotion requires the predicate to be schema-valid; `md5(params)` uniqueness enforced by the table.

- [ ] TDD: test `validatePredicate` rejects unknown kind + missing params; `promoteIntent` flips status to 'active' only for valid predicates. Mock `./db`. **Commit** `feat(web): architecture_intent CRUD + predicate validation`.

### Task 5: `web/lib/diff.ts` — report-vs-parent regression diff

**Files:** Create `web/lib/diff.ts` + test. Pure function `diffReports(current, parent)` over the `summary` JSONB (sources_used, drift verdicts, posture counts) → `{ regressions: [...], improvements: [...], unchanged }`. A regression = an invariant that PASSED in parent and FAILS now, or a posture severity that increased.

- [ ] TDD: `diffReports` flags a `critical` drift that newly fails; flags a posture count increase; returns empty for identical inputs. **Commit** `feat(web): report-vs-parent regression diff (pure)`.

### Task 6: `/api/diagnosis/intent` route (admin-gated)

**Files:** Create `web/app/api/diagnosis/intent/route.ts` + test. `GET` (auth) lists intents; `POST` (auth + **`isAdmin`** from `@/lib/admin`) handles `{action: 'promote'|'reject'|'edit', id, edits}` and `{action:'propose'}`. Reuse the Plan-1 admin-gate idiom (mirror `web/app/api/incidents/route.ts`). **Per-item accept only; no bulk "accept all" for `critical`/security kinds** (§8R3). All operator-supplied text stored as data; never echoed into a prompt as instructions.

- [ ] TDD: 403 for non-admin POST; promote flips a draft to active; propose returns drafts; bulk critical-accept rejected. **Commit** `feat(web): admin-gated intent promote/reject/propose API`.

---

## Milestone 4 — Phase-2 wiring (report) + Phase-1 UI

### Task 7: report integrates drift findings + diff

**Files:** Modify `scripts/v2/workers/diagnosis/report.py` + `sections.py`.

- [ ] In `report.generate`: after `collect_all`, load **active** invariants (via `ddb`/a new `intent` read in worker `db`), run `invariants.evaluate_all(active, collected_actual)`, attach the verdicts to a new `intended_vs_actual` section (verdict-only into the prompt — never raw edge text), and put `{drift: [...failed verdicts...]}` into `summary`. Compute `summary.diff` vs the parent report's summary (read parent by `parent_report_id`). Add `sections.py` entry `intended_vs_actual` (sources: the verdicts). **TDD** with a FakeConn returning canned active invariants + canned collected actual → assert failed verdicts surface and never leak raw text as instructions. **Commit** `feat(worker): weave intended-vs-actual drift + report diff into the report`.

### Task 8: `diagnosis.ts` sets parent + DiagnosisView surfaces drift/diff; IntentPanel

**Files:** Modify `web/lib/diagnosis.ts` (on `createReport`, set `parent_report_id` = id of the most-recent `succeeded` report of the same tier), modify `DiagnosisView.tsx` (drift badges + diff summary in the viewer), create `IntentPanel.tsx` (admin: lists draft candidates **ordered by drift-risk** — critical/public-ingress first — with per-item Accept/Edit/Reject and a **"⚠ Heuristic Risk: currently violates — confirm only if intended"** badge; calls `/api/diagnosis/intent`).

- [ ] TDD: `createReport` links the latest succeeded same-tier report as parent (vitest, mock db). IntentPanel renders Heuristic-Risk badge + disables bulk-accept for critical (component test). **Commit** `feat(web): parent-linking + drift/diff in viewer + admin IntentPanel`.

---

## Milestone 5 — Verify

### Task 9: Verification + handoff
- [ ] `python3 -m pytest scripts/v2/workers/diagnosis/ -v` (Plan 1 + Plan 2 worker tests green)
- [ ] `cd web && npx vitest run && npm run build` (green)
- [ ] `terraform -chdir=terraform/foundation validate` (after `init -backend=false`)
- [ ] Push branch + PR. **Controller:** `terraform apply` (v13 `architecture_intent`) + `make workers` + `make deploy`.
- [ ] E2E (post-deploy, admin): open `/ai-diagnosis` → IntentPanel → propose → confirm a `private_only` invariant → run a `mid` report → confirm the report shows an intended-vs-actual section + (on a 2nd run) a diff-vs-previous.

## Self-Review
- **Spec coverage:** §4.0 Phase-1 propose&confirm (T3,T6,T8), §4.2-KB invariants as deterministic checks (T2), §6 intended-vs-actual + diff (T5,T7), §8R3 anti-fabrication (schema-bound propose, admin promote, no bulk-accept), Heuristic-Risk (T3,T8), staleness fingerprint (T1 column; enforcement = fast-follow). ✓
- **Anti-fabrication:** LLM only proposes schema-valid candidates (`validate_candidate` drops the rest); only admin-promoted `active` rows are evaluated; evaluation is pure Python; verdict-only to the LLM. ✓
- **Read-only:** no AWS mutation; intent authoring admin-gated; untrusted text never an instruction. ✓
- **Placeholder scan:** none — every task has code or a precise TDD spec. **Type consistency:** verdict shape `{id,kind,target,severity,passed,observed}` consistent across invariants.py/report.py/diff.ts; predicate `kind` enum consistent across invariants.py/propose.py/intent.ts.

## Deferred to fast-follow (explicit, not silent)
Full narrative/SLA/ownership interview; automated drift-triggered delta re-interview; managed Bedrock KB + retrieval; deep/Opus-15 sections; live external-obs (Datadog/OTel) adapter; DOCX/PPTX/PDF; scheduling. Staleness *enforcement* (auto-expire on fingerprint divergence) beyond storing the column.
