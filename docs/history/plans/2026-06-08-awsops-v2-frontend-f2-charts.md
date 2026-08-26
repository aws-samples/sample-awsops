# Frontend F2 — Charts & Rich Dashboard Views

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Design source: **`DESIGN.md`** §"Components catalog → Charts" (recharts styling) + §3 (Overview) + §6 (Cost Explorer). Builds on F1 (Tailwind tokens + component lib + shell, all DEPLOYED). Steps `- [ ]`.

**Why:** F1 deferred charts → the app is list-heavy and shows less than v1. F2 adds the **graph views**: a rich Overview dashboard + a rich Cost page, using recharts (co-agent DD3=A), fed by the data we already have — **Aurora inventory (22 types) counts/distribution + worker_jobs status + Cost Explorer (MTD by-service + daily trend)**.

**Adaptation note:** DESIGN.md §3's K8s pod/event charts need in-cluster EKS data (P3-D, not built yet) — F2 substitutes our real data: resource distribution (inventory counts), category breakdown, jobs status, cost trend/by-service. K8s-specific charts come with P3-D.

**Chart theming (DESIGN.md §Charts — match exactly):** lead series `claude-500 #D97757`, secondary `ink-400 #8A8474`, tertiary/total `ink-800 #1F1E1D`; area fill = vertical gradient `#D97757` 0.30→0.02; grid dotted `2 4` in `ink-100 #EDEBE4`; axes/labels `ink-400`; donut palette = claude-500/ink-400/ink-800/claude-700/claude-200; tooltip = dark inverse (`ink-800` bg, `paper` text). Tabular numerals on values.

**Invariants:** presentation only (one new read API + one cost extension; no Terraform/backend infra change). Existing tests stay green. recharts components are `'use client'`.

---

### Task 1 (F2a): recharts + chart wrapper components

**Files:** Create `web/components/charts/{AreaTrend,BarDistribution,DonutBreakdown,HBarList}.tsx`; Modify `web/package.json`. Test: `web/components/charts/charts.test.tsx`

- [ ] **Step 1: dep** — `cd /home/atomoh/awsops/web && npm install recharts`
- [ ] **Step 2:** Build 4 `'use client'` components, each wrapped in the F1 `<Card>` (title + optional right slot via Card header), using recharts + the chart theme above. Read DESIGN.md §Charts for exact colors.
  - `AreaTrend({ title, data, xKey, yKey, valuePrefix? })` — `<ResponsiveContainer height={240}><AreaChart>`: claude gradient area, dotted `CartesianGrid strokeDasharray="2 4"` ink-100, `XAxis/YAxis` ink-400 tick, dark tooltip. y formatter supports `$`.
  - `BarDistribution({ title, data, xKey, yKey })` — vertical `BarChart`, bars `claude-500` (optionally emphasize the max bar with `claude-700`), dotted grid, dark tooltip.
  - `DonutBreakdown({ title, data, nameKey, valueKey })` — `PieChart` `innerRadius=55 outerRadius=80`, palette cycling claude-500/ink-400/ink-800/claude-700/claude-200, `Legend` (or a side legend list), center total label.
  - `HBarList({ title, data, labelKey, valueKey, valuePrefix? })` — NOT recharts; a simple flex list (label / `bg-ink-100` track with `bg-claude-500` fill proportional to max / right `$amount` tabular). Matches DESIGN.md §6 "서비스별 비용".
- [ ] **Step 3: test** (`charts.test.tsx`, jsdom) — render each with small mock data; assert the title + that it mounts without throwing. (recharts needs a sized container in jsdom — wrap in a fixed-size div or mock ResponsiveContainer; keep assertions shallow: title text present, no throw.)
- [ ] **Step 4:** `cd web && npx vitest run components/charts/charts.test.tsx` green; `npm run build` clean.
- [ ] **Step 5: Commit** — `git add web/components/charts web/package.json web/package-lock.json && git commit -m "feat(v2-fe-f2): recharts chart components (AreaTrend/BarDistribution/DonutBreakdown/HBarList) themed per DESIGN.md"`

---

### Task 2 (F2b): aggregation data — inventory summary + cost trend

**Files:** Modify `web/lib/aws.ts`, `web/app/api/cost/route.ts`; Create `web/app/api/inventory/summary/route.ts`. Tests: extend/add route tests.

- [ ] **Step 1: `getCostTrend()` in `lib/aws.ts`** — DAILY GetCostAndUsage for the last 30 days (`Granularity:'DAILY'`, `Metrics:['UnblendedCost']`, no GroupBy) → `{ date: string; amount: number }[]` from `ResultsByTime[].{TimePeriod.Start, Total.UnblendedCost.Amount}`. Export. (Reuse `ceClient()`.) Extend `CostBreakdown` consumers: change `/api/cost` to return `{ ...getMtdCost(), trend: await getCostTrend() }` (degrade trend to `[]` on error so the page still shows by-service).
- [ ] **Step 2: `web/app/api/inventory/summary/route.ts`** — `verifyUser`-gated GET. Query Aurora: `SELECT resource_type, count(*)::int AS n FROM inventory_resources WHERE account_id='self' GROUP BY resource_type`. Map each type → its category via the `INVENTORY_TYPES[type].group` registry (import `@/lib/inventory-types`). Return `{ byType: {type,label,count}[] (desc), byCategory: {group,count}[], total }`. `export const dynamic='force-dynamic'`. Return 500 on db error (it's the page's primary data).
- [ ] **Step 3:** Add a vitest route test for `/api/inventory/summary` mirroring the existing inventory route test pattern (401 unauth; 200 returns byType/byCategory with mocked pool). Keep the cost route test green (mock getCostTrend too).
- [ ] **Step 4:** `cd web && npm run test` green; `npm run build` clean.
- [ ] **Step 5: Commit** — `git add web/lib/aws.ts web/app/api/cost/route.ts web/app/api/inventory/summary && git commit -m "feat(v2-fe-f2): data — getCostTrend (daily) + /api/inventory/summary (Aurora counts per type/category) for charts"`

---

### Task 3 (F2c): rich Overview dashboard

**Files:** Modify `web/app/page.tsx`

Read DESIGN.md §3. Adapt to our data. Keep `/api/overview` fetch; ADD a `/api/inventory/summary` fetch (and use the existing `/api/cost` for the trend).

- [ ] **Step 1:** Layout (PageHeader already there): three KPI `SectionLabel` groups of `StatTile` driven by the summary counts —
  - **COMPUTE & CONTAINERS**: EC2, Lambda, ECS, ECR, EKS clusters (from summary.byType + overview.clusterCount).
  - **STORAGE & NETWORK**: S3, EBS, RDS, DynamoDB, VPC.
  - **SECURITY · OPS · COST**: IAM roles, Security Groups, Jobs(succeeded/failed pill), CloudWatch alarms, Monthly cost (`$mtdCost`, accent).
  Then a charts row:
  - `<BarDistribution title="리소스 분포" data={summary.byType (top ~12)} xKey="label" yKey="count"/>` (full-width or 1.6fr).
  - `<DonutBreakdown title="카테고리별 리소스" data={summary.byCategory} nameKey="group" valueKey="count"/>` (1fr).
  - A second row: `<DonutBreakdown title="작업 상태" data={jobs as {name,value}}/>` + `<AreaTrend title="일별 비용 추이" data={cost.trend} xKey="date" yKey="amount" valuePrefix="$"/>` (degrade gracefully if trend empty → show a "비용 데이터 없음" note in the card).
- [ ] **Step 2:** Each fetch degrades independently (summary failure → show tiles' "—" + skip its charts; cost/clusters already optional). Keep loading/error styled with tokens.
- [ ] **Step 3:** `npm run build` clean.
- [ ] **Step 4: Commit** — `git add web/app/page.tsx && git commit -m "feat(v2-fe-f2): rich Overview — 3 KPI groups + resource distribution bar + category/jobs donuts + cost trend area"`

---

### Task 4 (F2d): rich Cost page

**Files:** Modify `web/app/cost/page.tsx`

Read DESIGN.md §6. Use `/api/cost` (`{total, currency, byService[], trend[]}`).

- [ ] **Step 1:** PageHeader "Cost Explorer" + brand dot Badge "Cost Explorer API". KPI tiles: 이번 달 누적 (`$total`, accent), 서비스 수, 최대 서비스 ($byService[0]). Then:
  - `<AreaTrend title="일별 비용 추이" data={trend} xKey="date" yKey="amount" valuePrefix="$"/>` (full-width).
  - Row `1.5fr/1fr`: `<HBarList title="서비스별 비용" data={byService} labelKey="service" valueKey="amount" valuePrefix="$"/>` + `<DonutBreakdown title="비용 구성" data={byService (top 6 + 기타)} nameKey="service" valueKey="amount"/>`.
  - A `<DataTable>` "서비스 상세": columns service / amount(`$`, tabular) / share(%). (Compute share client-side from total.)
- [ ] **Step 2:** Keep existing fetch/auth; degrade if trend empty (hide the area card or show note). `npm run build` clean.
- [ ] **Step 3: Commit** — `git add web/app/cost/page.tsx && git commit -m "feat(v2-fe-f2): rich Cost page — daily trend area + service HBar + composition donut + detail table"`

---

### Task 5 (F2e): Deploy + screenshot (CONTROLLER)
- [ ] `cd web && npm run test && npm run build` final gate.
- [ ] `make deploy` → `/api/health` 200.
- [ ] Local `next start -p 3100` + Playwright screenshot Overview + Cost (note: local shows 401 without auth — charts need data; so instead, if feasible, screenshot is best taken against a render WITH data. Acceptable fallback: screenshot the shell+chart-empty states. Prefer: confirm charts render by a quick local mock OR just deploy and ask the user to view live.) Share + report.

---

## Self-Review
- Addresses the feedback (more graphs) with real data: inventory distribution (bar/donut), jobs (donut), cost (area/HBar/donut/table).
- recharts themed per DESIGN.md; `'use client'`; build-safe.
- One new read API (`/api/inventory/summary`) + one cost extension (trend); no infra change; tests stay green.
- K8s pod/event charts (DESIGN.md §3) explicitly deferred to P3-D (no in-cluster data yet) — noted, not silently dropped.
