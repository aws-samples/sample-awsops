# Plan — Explore range UX (Part 2)

Spec: `docs/superpowers/specs/2026-06-18-prom-schema-explore-ux-design.md`
Branch: `consensus/prom-schema-explore-ux` (worktree off `feat/v2-architecture-design` @ `4a0d72d`)

Part 1 (schema-aware generation) is owned by a concurrent session — OUT OF SCOPE here.
TDD throughout: failing test first, minimal code to green, refactor. One commit per task,
explicit paths only. Read-only; no AWS-resource mutation. Panel findings already folded in
(range:false back-compat, step upper bound, dropdown-change-only re-run, bar gated to prom/mimir
vector, HBarList prop mapping, Korean labels).

**Test commands**
- web scoped: `npm --prefix web exec vitest run <file>`
- web all: `npm --prefix web run test`

---

### Task 1: Query route — `{window, step}` range args + validation + back-compat

**Files:**
- Modify: `web/app/api/datasources/query/route.ts`
- Test: `web/app/api/datasources/query/route.test.ts`

- [ ] Failing test: body `range: {window, step}` (range-capable kind) → range tool invoked with
      args `{query, start, end, step}` where `end - start === window` and `step` is passed through
      as a string; `window` outside `[60,86400]` or `step` outside `[1,86400]` → `400` (no invoke).
- [ ] Failing test: `range:false` and absent range → instant tool; legacy `range:true` → range
      tool with NO `start`/`step` args (connector 1h/60s default) — exact current behaviour preserved.
- [ ] Implement: parse `body.range` into instant | legacy-true | `{window,step}`; validate bounds;
      compute `nowSec/start/end` with `Date.now()`; pass string args to the range tool. Green; refactor.

### Task 2: ExplorePanel — range dropdown + auto re-run

**Files:**
- Modify: `web/components/datasources/ExplorePanel.tsx`
- Test: `web/components/datasources/ExplorePanel.test.tsx`
- Test: `web/app/integrations/datasources/[id]/page.test.tsx`

- [ ] Failing test: a range-capable kind renders a `범위` dropdown with Korean presets
      `즉시 | 5m | 15m | 1h | 6h | 24h` (default 즉시); selecting `5m` posts
      `range: {window: 300, step: max(1, round(300/250))}`; `즉시` posts `range: false`; a
      non-range kind (tempo/clickhouse) renders no control.
- [ ] Failing test: changing the dropdown re-runs an existing query (one extra POST); editing the
      query text does NOT auto-run; no auto-run on initial mount.
- [ ] Implement: replace the checkbox with a `<select>` holding the window seconds; `autoStep`
      helper; `run()` sends `range:false` (instant) or `{window,step}`; `useEffect` keyed on the
      window value only + mounted-ref guard to re-run when a query is present. Green; refactor.

### Task 3: Instant ranked bar chart (reuse `HBarList`, gated to prom/mimir vector)

**Files:**
- Modify: `web/components/datasources/ExplorePanel.tsx`
- Test: `web/components/datasources/ExplorePanel.test.tsx`
- Modify: `web/components/charts/HBarList.tsx`

- [ ] Failing test: an instant prom/mimir result (`shape:'table'`, rows with numeric `value`,
      ≤30 rows) renders an `HBarList` (desc by value, `labelKey="metric"`, `valueKey="value"`)
      above the DataTable; >30 rows → no bar; a ClickHouse `shape:'table'` with a `value` column →
      no bar; a range result (`shape:'series'`) → AreaTrend unchanged.
- [ ] Implement: thread `kind` into `ResultView`; gate the bar on
      `kind ∈ {prometheus,mimir} && shape==='table' && rows≤30 && every value numeric`; sort a
      COPY of rows desc by `value` before passing to `HBarList`. Green; refactor.
