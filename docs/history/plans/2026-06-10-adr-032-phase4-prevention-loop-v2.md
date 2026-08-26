# ADR-032 Phase 4 — Proactive Prevention Feedback Loop (v2, flag-gated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]`. This EXTENDS the just-built **ADR-032 incident lifecycle (shipped flag-OFF, `incident_lifecycle_enabled=false`)**. Phase 4 rides the SAME flag (no new flag) — when off it is dark and there are no incidents to analyze. Do NOT touch v1 `src/`. Do NOT enable the lifecycle. Do NOT add any mutating action (recommend-only).

**Goal:** Add the cross-incident **proactive prevention feedback loop** (ADR-032 stage 5 / Phase 4): a periodic analyzer that reads accumulated incident/RCA history, detects **recurring patterns** (e.g. repeated `deployment` failures on the same service), and emits **prevention recommendations with evidence** (observability/testing/code/infra). The existing per-incident `prevention.py` terminal step is KEPT; this adds the cross-incident tier.

**Architecture (v2):** Extends ADR-032, gated by `incident_lifecycle_enabled` (dark/$0 when off — no `prevention_loop` Lambda, no schedule, and zero incidents to analyze). A new always-present `prevention_insights` Aurora table (migration v10) holds the cross-incident tier (the per-incident `prevention_recommendations` table is untouched). A gated `prevention_loop` Lambda on its own gated EventBridge schedule (mirrors the `incident_watchdog` gated-Lambda pattern, `count = local.il`) runs a **deterministic aggregation** over recent incidents (group by `rca.category × primary service`, recurrence ≥ threshold) → idempotent UPSERT (dedup_key UNIQUE) into `prevention_insights` with `source_incident_ids` + `recurrence_count` + evidence. Optional bounded **Haiku narration** (ADR-033 budget) enriches each insight (hypothesis-labelled). Recommend-only — NO mutation. A read-only admin API/UI surfaces the insights, degrade-safe.

**Tech Stack:** Aurora PG17 via pg8000 (`scripts/v2/incident/db.py`) for the Lambda + node-pg (`web/lib/db.ts`) for the read API; Python 3.12 arm64 Lambda; EventBridge schedule; Terraform `count=local.il` gating; Next.js 14 BFF read route; vitest + python ast/unit. Optional narration via `agent_bridge.py` (Haiku 4.5, ap-northeast-2).

**Key contracts (do not break):**
- **`scripts/v2/incident/prevention.py`** — the per-incident terminal SM stage (RCA category → ONE `prevention_recommendations` row). **KEEP it unchanged**; Phase 4 is additive (a separate cross-incident tier + table).
- **`prevention_recommendations`** (migration v5: `id, incident_id UUID NOT NULL FK, category, recommendation, created_at`) — **untouched**. The cross-incident tier uses a NEW `prevention_insights` table (recurring insights have NO single owning incident, so they must not be a nullable-FK row in the per-incident table).
- **`incidents`** (migration v5: `id, status, severity, services[], resources[], rca JSONB{root_cause,category,confidence,markdown}, first_event_at, last_event_at, …`) — read-only input.
- **Gating idiom:** `terraform/foundation/incidents.tf` `local.il = var.incident_lifecycle_enabled ? 1 : 0`; every gated resource `count = local.il`; the `incident_watchdog` Lambda (packaged from `local.inc_src`) on a gated EventBridge `rate(...)` rule is the pattern to mirror. SSM windows live under `/ops/${var.project}/incident/…`.
- **`scripts/v2/incident/db.py`** (pg8000 `connect()`), **`agent_bridge.py`** (optional Haiku narration), the incident-Lambda least-priv role (Aurora secret + KMS + AgentCore invoke + SSM read) — reuse.
- **Recommend-only invariant:** the loop emits recommendations only; it issues NO AWS/k8s/SSM/SFN mutation and never calls `/api/actions`. Incident/RCA text is attacker-derived → defang/isolate before any narration prompt.
- schema_migrations head is **v9** → this is migration **v10** (verify head before writing; use `ON CONFLICT (version) DO NOTHING`).

## File map
**Create:**
- `scripts/v2/incident/prevention_loop.py` — cross-incident analyzer Lambda (deterministic aggregation + idempotent UPSERT + optional narration).
- `scripts/v2/incident/test_prevention_loop.py` — unit tests (aggregation grouping + recurrence threshold + idempotent dedup + recommend-only).
- `web/app/api/incidents/prevention/route.ts` — read-only admin-gated insights list (degrade-safe).
- Tests: `web/app/api/incidents/prevention/route.test.ts`.

**Modify:**
- `terraform/foundation/data/schema.sql` — append migration v10 (`prevention_insights` table + index).
- `terraform/foundation/incidents.tf` — gated `prevention_loop` Lambda + gated EventBridge schedule + permission + the window/threshold SSM params (all `count=local.il`).
- `web/app/eks/[cluster]/page.tsx` is NOT touched; if a UI surface is wanted, add a minimal read-only section on an existing incidents/ops page or a new `web/app/incidents/page.tsx` (optional Task 4b — keep minimal).

## Out of scope (state explicitly)
- Auto-applying / auto-remediating recommendations (recommend-only; execution would route through ADR-029/036, separately gated).
- Learned/auto-tuned prevention models or an accuracy feedback loop (ADR-035 H3b is the accuracy-audit seam; not here).
- Enabling `incident_lifecycle_enabled` (operator action).
- ADR-031 Phase 3/4, ADR-035 H3a-full.
- Backfilling the per-incident `prevention_recommendations` tier (unchanged).

---

## Task 1 — Migration v10: `prevention_insights` table (cross-incident tier; always-present, inert when off)

**Files:** Modify `terraform/foundation/data/schema.sql`

- [ ] **Step 1:** Confirm the current head is v9 (`grep -nE "VALUES \\([0-9]+, '" terraform/foundation/data/schema.sql | tail -1`). If a concurrent session already took v10, use the next free integer and note it. Then append (post-COMMIT idempotent block, v6/v7 style, after the v9 block):

```sql

-- ============================================================================
-- ADR-032 Phase 4 (migration v10): cross-incident proactive-prevention tier.
-- The per-incident prevention_recommendations table (v5) is UNCHANGED. Recurring
-- insights span multiple incidents (no single owner), so they live here.
-- Always-present + inert when the lifecycle flag is off (no incidents ⇒ no rows).
-- ============================================================================
CREATE TABLE IF NOT EXISTS prevention_insights (
  id                  BIGSERIAL PRIMARY KEY,
  dedup_key           TEXT NOT NULL UNIQUE,                 -- sha256(category + scope_ref): idempotent UPSERT key
  category            TEXT NOT NULL,                        -- observability|testing|code|infra
  scope_ref           TEXT NOT NULL,                        -- "<rca.category>::<service|resource>"
  recommendation      TEXT NOT NULL,                        -- deterministic base recommendation
  narration           TEXT,                                 -- optional Haiku enrichment (hypothesis; nullable)
  llm_model           TEXT,
  recurrence_count    INT NOT NULL DEFAULT 1,
  source_incident_ids JSONB NOT NULL DEFAULT '[]'::jsonb,   -- evidence: the incidents that recurred
  evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {services[], severities[], window_days}
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','addressed','dismissed')),
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prevention_insights_open ON prevention_insights (last_seen_at DESC) WHERE status = 'open';

INSERT INTO schema_migrations (version, description)
VALUES (10, 'ADR-032 Phase 4: prevention_insights (cross-incident recurring tier; idempotent dedup_key; inert when off)')
ON CONFLICT (version) DO NOTHING;
```

- [ ] **Step 2:** Verify: `python3 -c "..."` not needed — visually confirm 1 CREATE TABLE + 1 index + 1 schema_migrations insert, balanced. Do NOT run psql (controller Task 6).
- [ ] **Step 3: Commit** — `git add terraform/foundation/data/schema.sql && git commit -m "feat(v2-adr032-p4): migration v10 — prevention_insights (cross-incident recurring tier, idempotent dedup; inert when off)"`

---

## Task 2 — `prevention_loop.py`: cross-incident analyzer (deterministic core + idempotent UPSERT)

**Files:** Create `scripts/v2/incident/prevention_loop.py`, `scripts/v2/incident/test_prevention_loop.py`

- [ ] **Step 1: Write the failing test** (`test_prevention_loop.py`):

```python
import hashlib
import importlib
import sys
import types
import unittest

# Stub db so the module imports without pg8000/network.
db_stub = types.ModuleType("db")
db_stub.connect = lambda: None
sys.modules["db"] = db_stub
pl = importlib.import_module("prevention_loop")


class AggregateTest(unittest.TestCase):
    def _inc(self, iid, cat, svc, sev="warning"):
        return {"id": iid, "rca": {"category": cat}, "services": [svc], "severity": sev}

    def test_groups_by_category_and_service_with_threshold(self):
        incs = [
            self._inc("a", "deployment", "svc-foo"),
            self._inc("b", "deployment", "svc-foo"),
            self._inc("c", "deployment", "svc-bar"),  # only 1 → below threshold 2
            self._inc("d", "capacity", "svc-foo"),     # only 1
        ]
        insights = pl.aggregate(incs, threshold=2, window_days=30)
        # only deployment::svc-foo recurs (2x)
        self.assertEqual(len(insights), 1)
        ins = insights[0]
        self.assertEqual(ins["scope_ref"], "deployment::svc-foo")
        self.assertEqual(ins["recurrence_count"], 2)
        self.assertEqual(sorted(ins["source_incident_ids"]), ["a", "b"])
        self.assertEqual(ins["category"], "testing")  # deployment → testing (per the map)
        self.assertEqual(ins["dedup_key"], hashlib.sha256(b"deployment::svc-foo").hexdigest()[:40])

    def test_recommend_only_no_mutation_symbols(self):
        src = open(pl.__file__).read()
        for bad in ["create_ops_item", "start_execution", "put_parameter", "delete_", "runTask", "/api/actions", "kubectl"]:
            self.assertNotIn(bad, src, f"prevention_loop must be recommend-only (found {bad})")

    def test_unknown_category_degrades(self):
        insights = pl.aggregate([self._inc("a", None, "svc-x"), self._inc("b", "", "svc-x")], threshold=2, window_days=30)
        self.assertEqual(len(insights), 1)
        self.assertEqual(insights[0]["scope_ref"], "unknown::svc-x")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run → FAIL** (`cd scripts/v2/incident && python3 -m pytest test_prevention_loop.py -q` → module/attr missing).

- [ ] **Step 3: Implement** `scripts/v2/incident/prevention_loop.py`:

```python
"""AWSops v2 ADR-032 Phase 4 — cross-incident proactive-prevention feedback loop.

Periodic (gated EventBridge) Lambda. Reads recent incident/RCA history, detects RECURRING
patterns (rca.category x primary service over a window, recurrence >= threshold), and UPSERTs
one prevention_insight per recurring pattern (idempotent on dedup_key). Recommend-only: it
emits recommendations, NEVER any AWS/k8s/SSM/SFN mutation. Inert when the lifecycle is off
(no incidents => no insights). Optional bounded Haiku narration enriches each insight.
"""
import hashlib
import json
import os

import db

PROJECT = os.environ.get("PROJECT", "awsops-v2")
DEFAULT_WINDOW_DAYS = int(os.environ.get("PREVENTION_WINDOW_DAYS", "30"))
DEFAULT_THRESHOLD = int(os.environ.get("PREVENTION_RECURRENCE_THRESHOLD", "2"))

# rca.category -> (prevention category, base recommendation template). Mirrors prevention.py.
_MAP = {
    "deployment": ("testing", "Recurring deployment-related incidents on {svc}: add a pre-deploy canary + automatic rollback gate."),
    "capacity": ("infra", "Recurring capacity incidents on {svc}: add a proactive scaling alarm / headroom buffer."),
    "configuration": ("code", "Recurring configuration incidents on {svc}: add config-validation to CI for the changed parameters."),
    "dependency": ("observability", "Recurring dependency incidents on {svc}: add a dependency health probe + alert for the upstream."),
    "security": ("observability", "Recurring security signals on {svc}: add a detective control / alert."),
    "infrastructure": ("infra", "Recurring infrastructure incidents on {svc}: add a health alarm for the affected component."),
    "unknown": ("observability", "Recurring incidents on {svc} with missing triage signals: add observability for the gap."),
}


def _scope_ref(category, svc):
    return f"{category or 'unknown'}::{svc or 'unknown'}"


def _dedup_key(scope_ref):
    return hashlib.sha256(scope_ref.encode()).hexdigest()[:40]


def aggregate(incidents, threshold=DEFAULT_THRESHOLD, window_days=DEFAULT_WINDOW_DAYS):
    """Pure: group incidents by (rca.category, primary service) and return one insight dict per
    group whose recurrence >= threshold. No I/O. source_incident_ids is the evidence."""
    groups = {}
    for inc in incidents:
        cat = (inc.get("rca") or {}).get("category") or "unknown"
        svcs = inc.get("services") or []
        svc = svcs[0] if svcs else "unknown"
        key = _scope_ref(cat, svc)
        g = groups.setdefault(key, {"rca_cat": cat, "svc": svc, "ids": [], "severities": set(), "services": set()})
        g["ids"].append(inc["id"])
        if inc.get("severity"):
            g["severities"].add(inc["severity"])
        for s in svcs:
            g["services"].add(s)
    out = []
    for scope_ref, g in groups.items():
        if len(g["ids"]) < threshold:
            continue
        prev_cat, tmpl = _MAP.get(g["rca_cat"], _MAP["unknown"])
        out.append({
            "dedup_key": _dedup_key(scope_ref),
            "category": prev_cat,
            "scope_ref": scope_ref,
            "recommendation": tmpl.format(svc=g["svc"]),
            "recurrence_count": len(g["ids"]),
            "source_incident_ids": sorted(g["ids"]),
            "evidence": {"services": sorted(g["services"]), "severities": sorted(g["severities"]), "window_days": window_days},
        })
    return out


def _upsert(conn, ins):
    """Idempotent UPSERT on dedup_key: re-runs update recurrence/evidence/last_seen, no duplicate."""
    conn.run(
        "INSERT INTO prevention_insights (dedup_key, category, scope_ref, recommendation, "
        "recurrence_count, source_incident_ids, evidence) "
        "VALUES (:k,:c,:s,:r,:n,CAST(:ids AS JSONB),CAST(:ev AS JSONB)) "
        "ON CONFLICT (dedup_key) DO UPDATE SET "
        "recurrence_count = EXCLUDED.recurrence_count, source_incident_ids = EXCLUDED.source_incident_ids, "
        "evidence = EXCLUDED.evidence, recommendation = EXCLUDED.recommendation, last_seen_at = now()",
        k=ins["dedup_key"], c=ins["category"], s=ins["scope_ref"], r=ins["recommendation"],
        n=ins["recurrence_count"], ids=json.dumps(ins["source_incident_ids"]), ev=json.dumps(ins["evidence"]))


def lambda_handler(_event, _ctx):
    """Gated EventBridge target. Reads recent incidents w/ RCA, aggregates, UPSERTs insights.
    Recommend-only. Inert when no incidents. Never raises into the schedule (best-effort)."""
    window = DEFAULT_WINDOW_DAYS
    threshold = DEFAULT_THRESHOLD
    conn = db.connect()
    try:
        rows = conn.run(
            "SELECT id::text, rca, services, severity FROM incidents "
            "WHERE rca IS NOT NULL AND last_event_at > now() - (:w || ' days')::interval", w=str(window))
        incidents = [
            {"id": r[0], "rca": (r[1] if isinstance(r[1], dict) else (json.loads(r[1]) if r[1] else {})),
             "services": list(r[2] or []), "severity": r[3]}
            for r in (rows or [])
        ]
        insights = aggregate(incidents, threshold=threshold, window_days=window)
        for ins in insights:
            _upsert(conn, ins)
        return {"analyzed": len(incidents), "insights_upserted": len(insights)}
    finally:
        conn.close()
```

- [ ] **Step 4: Run → PASS** (`cd scripts/v2/incident && python3 -m pytest test_prevention_loop.py -q` → 3 passed; `python3 -c "import ast;ast.parse(open('prevention_loop.py').read());print('ok')"`).
- [ ] **Step 5: Commit** — `git add scripts/v2/incident/prevention_loop.py scripts/v2/incident/test_prevention_loop.py && git commit -m "feat(v2-adr032-p4): cross-incident prevention loop — deterministic recurrence aggregation + idempotent UPSERT (recommend-only)"`

> Note: Haiku narration is intentionally NOT wired in this task (deterministic core ships first; an optional follow-up can enrich `narration` via `agent_bridge.py` under the ADR-033 budget). Keep the loop deterministic + bounded.

---

## Task 3 — `incidents.tf`: gated `prevention_loop` Lambda + EventBridge schedule + SSM params

**Files:** Modify `terraform/foundation/incidents.tf`

- [ ] **Step 1:** Add the gated archive (mirror the `incident_watchdog` packaging from `local.inc_src`), Lambda, EventBridge `rate` rule, permission, and the window/threshold SSM params — all `count = local.il`. Reuse the existing incident-Lambda role (Aurora+KMS+SSM). Example shape (match the file's existing locals/role names):

```hcl
# ADR-032 Phase 4: cross-incident prevention feedback loop (gated; rate(24h)).
resource "aws_ssm_parameter" "incident_prevention_window_days" {
  count = local.il
  name  = "/ops/${var.project}/incident/prevention-window-days"
  type  = "String"
  value = "30"
  lifecycle { ignore_changes = [value] }
}
resource "aws_ssm_parameter" "incident_prevention_threshold" {
  count = local.il
  name  = "/ops/${var.project}/incident/prevention-recurrence-threshold"
  type  = "String"
  value = "2"
  lifecycle { ignore_changes = [value] }
}

data "archive_file" "prevention_loop" {
  count       = local.il
  type        = "zip"
  output_path = "${path.module}/.build/prevention_loop.zip"
  source_dir  = local.inc_src   # packages prevention_loop.py + db.py (same dir as the other incident Lambdas)
}

resource "aws_lambda_function" "prevention_loop" {
  count            = local.il
  function_name    = "${var.project}-prevention-loop"
  role             = aws_iam_role.incident_lambda[0].arn   # reuse the incident-Lambda least-priv role
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "prevention_loop.lambda_handler"
  timeout          = 120
  filename         = data.archive_file.prevention_loop[0].output_path
  source_code_hash = data.archive_file.prevention_loop[0].output_base64sha256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]  # match the layer ref the other incident Lambdas use
  environment {
    variables = {
      PROJECT                          = var.project
      AURORA_SECRET_ARN                = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
      AURORA_ENDPOINT                  = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE                  = aws_rds_cluster.aurora.database_name
      PREVENTION_WINDOW_DAYS           = "30"
      PREVENTION_RECURRENCE_THRESHOLD  = "2"
    }
  }
  vpc_config {
    subnet_ids         = local.private_subnet_ids   # match the other incident Lambdas' vpc_config refs
    security_group_ids = [aws_security_group.service.id]
  }
}

resource "aws_cloudwatch_event_rule" "prevention_loop" {
  count               = local.il
  name                = "${var.project}-prevention-loop"
  schedule_expression = "rate(24 hours)"
}
resource "aws_cloudwatch_event_target" "prevention_loop" {
  count = local.il
  rule  = aws_cloudwatch_event_rule.prevention_loop[0].name
  arn   = aws_lambda_function.prevention_loop[0].arn
}
resource "aws_lambda_permission" "prevention_loop_events" {
  count         = local.il
  statement_id  = "AllowEventBridgePreventionLoop"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.prevention_loop[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.prevention_loop[0].arn
}
```

**IMPORTANT:** read the existing `incidents.tf` first and match the EXACT names it uses for: the incident-Lambda role (`aws_iam_role.incident_lambda` or similar), the pg8000 layer, `local.inc_src`, the private-subnet + service-SG references, and the Aurora secret/env wiring on `incident_watchdog`. Copy the watchdog's vpc_config/role/layer/env block verbatim and only change the function name/handler/schedule. Do NOT invent resource names.

- [ ] **Step 2:** `terraform -chdir=terraform/foundation fmt` + `validate` (Success). `terraform -chdir=terraform/foundation plan -input=false` (with `incident_lifecycle_enabled=false`) → **No changes** (all `count=0`). Do NOT apply.
- [ ] **Step 3: Commit** — `git add terraform/foundation/incidents.tf && git commit -m "feat(v2-adr032-p4): gated prevention_loop Lambda + rate(24h) EventBridge + window/threshold SSM (count=local.il; No-changes when off)"`

---

## Task 4 — Read-only prevention insights API (admin-gated, degrade-safe)

**Files:** Create `web/app/api/incidents/prevention/route.ts`, `web/app/api/incidents/prevention/route.test.ts`

- [ ] **Step 1: Test** — assert: 401 unauthenticated; 403 non-admin (reuse `isAdmin`); 200 + `{insights:[]}` when Aurora unconfigured/empty (degrade-safe); 200 + rows when present. Mock `verifyUser`/`isAdmin`/`getPool` per the `web/app/api/customization/route.test.ts` pattern.

- [ ] **Step 2: Implement** `web/app/api/incidents/prevention/route.ts`:

```typescript
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
function json(o: unknown, s: number) { return new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } }); }

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return json({ error: 'admin access required' }, 403);
  if (!process.env.AURORA_ENDPOINT) return json({ insights: [] }, 200); // degrade-safe
  try {
    const { rows } = await getPool().query(
      `SELECT id, category, scope_ref, recommendation, narration, recurrence_count,
              source_incident_ids, evidence, status, last_seen_at
       FROM prevention_insights WHERE status = 'open' ORDER BY last_seen_at DESC LIMIT 200`,
    );
    return json({ insights: rows }, 200);
  } catch {
    return json({ insights: [] }, 200); // never 5xx the panel
  }
}
```

- [ ] **Step 3:** `cd web && npx vitest run app/api/incidents/prevention/route.test.ts` → PASS. `npm run build` green.
- [ ] **Step 4: Commit** — `git add web/app/api/incidents/prevention/route.ts web/app/api/incidents/prevention/route.test.ts && git commit -m "feat(v2-adr032-p4): read-only prevention-insights API (admin-gated, degrade-safe)"`

> Optional Task 4b (UI panel): a minimal read-only list on a new `web/app/incidents/page.tsx` or an existing ops page. Keep it minimal; the API is the substrate. Skip if it bloats scope.

---

## Task 5 — Full gate

**Files:** none (verification)

- [ ] **Step 1:** `cd web && npm run test` + `npm run build` green.
- [ ] **Step 2:** `cd scripts/v2/incident && python3 -m pytest test_prevention_loop.py -q` green; `python3 -c "import ast;ast.parse(open('prevention_loop.py').read())"`.
- [ ] **Step 3:** `terraform -chdir=terraform/foundation plan -input=false` → **No changes** (incident_lifecycle_enabled=false ⇒ all Phase-4 infra count=0).
- [ ] **Step 4: Commit** any test-only adjustments.

---

## Task 6 (CONTROLLER) — apply migration v10, prove dark/$0 when off

> Controller (shared infra). No `-auto-approve`; plan-visible. Phase 4 rides `incident_lifecycle_enabled` (false) ⇒ no gated infra is created.

- [ ] **Step 1:** `terraform -chdir=terraform/foundation plan -input=false` → **No changes** (prove $0; the `prevention_loop` Lambda/schedule/SSM are count=0). No apply needed (no TF infra when off).
- [ ] **Step 2:** Apply migration v10 (in-VPC psql, idempotent `schema.sql`): creates `prevention_insights` (empty). Verify `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1;` → 10; `SELECT count(*) FROM prevention_insights;` → 0 (no incidents ⇒ inert).
- [ ] **Step 3:** Confirm `aws lambda get-function --function-name awsops-v2-prevention-loop` → ResourceNotFound (gated off, correct) and `aws events list-rules --name-prefix awsops-v2-prevention-loop` → empty.
- [ ] **Step 4:** Report GREEN: migration v10 applied, prevention_insights=0, prevention_loop Lambda/rule absent (dark), plan No-changes.

---

## Self-Review
- **Cross-incident analysis:** `aggregate()` groups by `rca.category × primary service`, recurrence ≥ threshold → one insight per recurring pattern with `source_incident_ids` evidence (Task 2). ✅ Distinct from the kept per-incident `prevention.py` skeleton.
- **Idempotency:** `dedup_key UNIQUE` + `ON CONFLICT DO UPDATE` ⇒ re-runs update (recurrence/evidence/last_seen), never duplicate (Task 1+2; tested). ✅
- **Recommend-only:** `prevention_loop.py` has no mutation calls; a test asserts the absence of `create_ops_item`/`start_execution`/`put_parameter`/`/api/actions`/`kubectl`/`runTask`. ✅
- **Dark/$0 when off:** all TF gated `count=local.il`; migration v10 is data-only + inert (no incidents ⇒ no insights); plan No-changes proven in Task 5/6. ✅
- **Backward-compat:** per-incident `prevention_recommendations` + `prevention.py` untouched; new table + new gated Lambda only. ✅
- **Placeholder scan:** real SQL/Python/TS in every step; the one explicit "read incidents.tf to match exact names" note in Task 3 is a fidelity instruction, not a placeholder.
- **Migration:** v10 (head v9 verified; ON CONFLICT DO NOTHING for concurrent-session safety).
- **Out of scope** stated (auto-apply, learned models, enabling lifecycle, narration deferred).
