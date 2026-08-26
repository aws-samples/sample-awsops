# Frontend F3 — Per-Page Inventory Components (KPI cards + chart + filters)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Design source `DESIGN.md` §4 (EC2) + §5 (EKS). Builds on F1 (tokens/components/shell) + F2 (recharts). Steps `- [ ]`.

**Why:** The generic `/inventory/[type]` page currently renders ONLY a table — no KPI cards, no distribution chart, no filters (user feedback: "EC2 → list만 나오고 위에 카드들이 안 나옴"). ALSO it still has old dark inline styles for its chrome (`#e6eefb` h1 on the paper bg → poor contrast). F3 makes every inventory page a v1-style mini-dashboard: **PageHeader + KPI tiles + distribution donut + search/state filters + table** — generic, registry-driven, so all 22 types get it.

**Approach:** All derived CLIENT-SIDE from the rows the page already fetches (no new API). Per-type behavior comes from two optional registry fields. Reuse F1 components (`PageHeader`, `StatTile`, `SegmentedControl`, `Input`, `Card`) + F2 chart (`DonutBreakdown`).

**Invariants:** no new API/backend; reuse existing components (no re-invention); paper+ink tokens only (fix the dark-chrome bug); existing tests stay green.

---

### Task 1: registry — add `stateKey` + `distKey` per type

**Files:** Modify `web/lib/inventory-types.ts`, `web/lib/inventory-types.test.ts`

Add two OPTIONAL fields to `InvType`: `stateKey?: string` (the column holding a lifecycle state — drives state KPI tiles + the state filter) and `distKey?: string` (the column to chart a distribution donut by). Set per type (data columns are the `data` JSONB keys = the existing `columns[].key` values):

```
ec2:            stateKey:'instance_state', distKey:'instance_type'
lambda:         stateKey:'state',          distKey:'runtime'
ecs_cluster:    stateKey:'status',         distKey:'status'
ecr:            distKey:'image_tag_mutability'
s3:             distKey:'region'
ebs_volume:     stateKey:'state',          distKey:'volume_type'
rds:            stateKey:'status',         distKey:'engine'
dynamodb:       stateKey:'table_status',   distKey:'billing_mode'
vpc:            stateKey:'state',          distKey:'region'
subnet:         distKey:'availability_zone'
security_group: distKey:'vpc_id'
iam_role:       (none)
iam_user:       distKey:'mfa_enabled'
cloudfront:     stateKey:'status',         distKey:'price_class'
alb:            stateKey:'state_code',     distKey:'scheme'
nlb:            stateKey:'state_code',     distKey:'scheme'
elasticache:    stateKey:'cache_cluster_status', distKey:'engine'
opensearch:     distKey:'engine_version'
msk:            stateKey:'state',          distKey:'cluster_type'
waf:            distKey:'scope'
cloudwatch_alarm: stateKey:'state_value',  distKey:'namespace'
cloudtrail:     distKey:'home_region'
```

- [ ] **Step 1: update test** — extend `inventory-types.test.ts`: assert `stateKey`/`distKey` (when present) reference a key that is either a column key, `'resource_id'`, `'region'`, or a known data field (loose check: non-empty string); assert ec2.stateKey==='instance_state' and ec2.distKey==='instance_type'. Keep the 22-types + groups assertions.
- [ ] **Step 2: implement** the two fields on `InvType` + populate per the table above.
- [ ] **Step 3:** `cd web && npx vitest run lib/inventory-types.test.ts` green.
- [ ] **Step 4: Commit** — `git add web/lib/inventory-types.ts web/lib/inventory-types.test.ts && git commit -m "feat(v2-fe-f3): registry stateKey/distKey per type (drives per-page KPI tiles + distribution chart + state filter)"`

---

### Task 2: generic page — PageHeader + KPI tiles + distribution + filters

**Files:** Modify `web/app/inventory/[type]/page.tsx`

Rewrite the page (keep the fetch/refresh/shaping logic) to a mini-dashboard. Reuse `@/components/ui/{PageHeader,StatTile,SegmentedControl,Input,Card}` + `@/components/charts/DonutBreakdown` + `@/components/ui/RefreshButton`/`DataTable`.

- [ ] **Step 1: chrome (fix dark-bug)** — replace the inline-dark `<main>/<h1>/error/loading` with `<PageHeader title={spec.label} subtitle?=…>` + a `px-8 py-8` body using tokens (`text-ink-400` loading, `text-rose-600` error). Unknown-type message uses tokens too. RefreshButton stays (in the header right slot or below title).
- [ ] **Step 2: KPI tiles** (derive from `rows`):
  - Always: `총 ${spec.label}` = `rows.length` (StatTile, accent).
  - If `spec.stateKey`: compute counts grouped by that column's value; render up to 4 StatTiles for the top state values (e.g., EC2 → running 50, stopped 2). Color a "healthy"-ish value (running/available/active/ACTIVE/OK) with default and a bad-ish value (stopped/failed/CrashLoopBackOff/ALARM/impaired) with `variant="danger"`. Generic: just show the top state values as tiles; mark known-bad states danger.
  - Lay out in `grid grid-cols-2 md:grid-cols-5 gap-4`.
- [ ] **Step 3: distribution donut** — if `spec.distKey`: compute `[{name, value}]` = counts of `row[distKey]` (top 6 + `기타`), render `<DonutBreakdown title={\`${distLabel} 분포\`} data=… nameKey="name" valueKey="value"/>` in a row beside the table OR above it (`grid lg:grid-cols-[1fr_2fr]` with the donut left, table right; if no distKey, table full-width). Use the column's label for the title where available.
- [ ] **Step 4: filters** (client-side, narrow the displayed rows live):
  - A search `<Input>` (icon optional) — filter rows where ANY cell value (stringified) includes the query (case-insensitive).
  - If `spec.stateKey`: a `<SegmentedControl>` of `['전체', ...distinct state values]` — selecting filters rows to that state. Active default `전체`.
  - Apply both filters to the rows passed to `<DataTable>` AND to the KPI/dist computations? KPIs/dist should reflect the FULL set (not filtered) — compute KPIs/dist from all rows; filter only the table. (So the cards show totals, the table narrows.)
- [ ] **Step 5: build** — `cd web && npm run build` clean; `npm run test` green (page has no unit test; the lib test from T1 + existing suite must pass).
- [ ] **Step 6: Commit** — `git add web/app/inventory/\[type\]/page.tsx && git commit -m "feat(v2-fe-f3): generic inventory page mini-dashboard — PageHeader + KPI tiles (total+state) + distribution donut + search/state filters (paper-ink; fixes dark-chrome contrast)"`

---

### Task 3: Deploy + screenshot (CONTROLLER)
- [ ] `cd web && npm run test && npm run build` final gate.
- [ ] `make deploy` → `/api/health` 200.
- [ ] Temp preview: render `/inventory/ec2` (and maybe `/inventory/rds`) with mock rows (real-ish: EC2 instances with instance_state/instance_type) via a throwaway preview page, Playwright-screenshot to show KPI tiles + donut + filters + table, then remove the preview. (Same pattern as F2; live is auth-gated.) Share + report.

---

## Self-Review
- Addresses the feedback: every inventory page now has KPI cards (total+state) + a distribution donut + filters above the table, generic via the registry — fixes "list만 나옴".
- Also fixes the F1-miss dark-chrome contrast bug on this page.
- No new backend/API; all client-side from existing rows; reuses F1/F2 components; tests stay green.
- KPIs/dist computed from FULL rows; filters narrow only the table.
