# Explore range UX — Design (Part 2)

- **Date**: 2026-06-18
- **Branch (work)**: `consensus/prom-schema-explore-ux` (worktree off `feat/v2-architecture-design` @ `4a0d72d`)
- **Status**: Approved design → consensus pipeline (Part 2 only)
- **Scope**: v2 datasource Explore query console UX. Read-only.

## Scope note — Part 1 is owned by a concurrent session

This effort originally had two parts. **Part 1 (schema-aware PromQL generation — per-metric
label/type introspection: `prometheus_metric_meta`/`mimir_metric_meta`, `mergeMetricMeta`,
`selectMetricsForMeta`, lazy cache-back in `generate/route.ts`) is being implemented by a
concurrent session** (uncommitted in the main working tree at the time of writing, design
equivalent to ours: lazy, top-K=8, prometheus/mimir-gated, SSRF-guarded). Re-implementing it
here would duplicate/collide, so **this spec covers Part 2 only.** The multi-AI panel review of
Part 1 (residual findings: ASCII-only NL tokenizer skips pure-Korean queries; `mergeMetricMeta`
is not size-bounded) is handed to that session separately.

## Problem (Part 2)

The Explore "시간 범위 (range)" checkbox is opaque and buggy:
- Toggling it does **not** re-run the query (`run()` reads `range` only on the "실행" click;
  the checkbox `onChange` only sets state) → looks like nothing happens.
- OFF = instant (`/api/v1/query`) → vector → `shape:'table'` → **table only**; ON = range
  (`/api/v1/query_range`, hardcoded `start=now-3600`, `step=60`) → matrix → `shape:'series'` →
  **chart**. Users discover it as a "chart on/off" toggle — the wrong mental model.
- The range window is hardcoded 1h/step60s with no UI.

## Goals

The query-type control is self-explanatory (instant vs a chosen time-range), re-runs on change,
and gives a useful visualization in both modes (a ranked bar for instant, a trend chart for range).

## Non-goals (YAGNI)

- No `topk`-in-range server-semantics change.
- No normalizer change (instant viz derives from the existing `NormalizedResult` rows).
- No new datasource kinds. No AWS-resource mutation (read-only).

## Design

### Range control — `web/components/datasources/ExplorePanel.tsx`

Replace the `range` boolean checkbox with a single **range dropdown** (`범위`), shown only for
`RANGE_KINDS` (prometheus/mimir/loki). Korean labels for codebase consistency:
`즉시 | 5m | 15m | 1h | 6h | 24h` → window seconds `0 | 300 | 900 | 3600 | 21600 | 86400` (owner decision: short duration units read better than Korean 분/시간; `즉시` kept for the instant option)
(`0` = Instant, default).

- Instant (`0`) → instant tool (today's behaviour), request `range: false`.
- A window `w>0` → range tool, request `range: { window: w, step: autoStep(w) }`.
- **Auto step**: `autoStep(w) = max(1, Math.round(w / 250))` (~250 points).
- **Auto re-run**: changing the dropdown re-runs the current query when a query string is present.
  Implemented in the select's `onChange` — it sets the window state and calls `run(w)` with the new
  window as an explicit override. `onChange` fires only on a user dropdown change, never on keystrokes
  or initial render, so this needs no `useEffect`/mounted-ref guard (simpler and equivalent). The
  range `<select>` is disabled while a query is in flight to avoid a concurrent-run result race.

### Query route — `web/app/api/datasources/query/route.ts`

`body.range` is now one of: absent / `false` (instant), `true` (legacy → 1h range, back-compat),
or `{ window: number, step: number }` (new). When an object:
- Validate `window ∈ [60, 86400]` and `step ∈ [1, 86400]` → `400` on violation (before invoke).
- Compute, in the route, `nowSec = Math.floor(Date.now()/1000)`, `start = nowSec - window`,
  `end = nowSec`; pass `{ query, start: String(start), end: String(end), step: String(step) }`
  to the connector's `range` tool (the connector's `_parse_time` passes unix strings through).
- `true` → range tool with no start/step (connector defaults 1h/60s) — exact current behaviour.
- `false`/absent → instant tool — exact current behaviour.

SSRF guard, MAX_QUERY, auth: unchanged.

### Visualization — `ResultView` in `ExplorePanel.tsx`

Thread the selected `kind` into `ResultView` (the panel already has `ds.kind`).
- **Range** result (`shape:'series'`) → AreaTrend (unchanged).
- **Instant** result (`shape:'table'`) **AND `kind ∈ {prometheus, mimir}`** AND the rows carry a
  numeric `value` column (the prom-vector signature `metric/value/timestamp`) AND `rows.length ≤ 30`:
  render a ranked `HBarList` above the table — `data` = rows sorted by `value` desc, `labelKey="metric"`,
  `valueKey="value"`, `title="상위 결과"`. (`HBarList` does NOT sort internally — sort a copy first.)
- All other tables (ClickHouse, Loki/Tempo, prom instant with > 30 rows) → DataTable only
  (no spurious bar on arbitrary `value` columns).

## Error handling
- Out-of-bounds window/step → `400` at the route before any connector invoke.
- The normalizer emits `null` for non-finite samples (NaN/+Inf) — a `null` or **negative** `value`
  row degrades to the table-only path. The bar gate requires `typeof === 'number' && Number.isFinite && >= 0`;
  HBarList is positive-only, so legitimate negative PromQL instant values are shown in the table only (by design).
- Range request density is bounded server-side: `ceil(window/step) ≤ 5000` points (400 otherwise) so a
  direct API caller can't request a huge series; the UI's `autoStep` keeps it ~250.

## Testing
- `web/app/api/datasources/query/route.test.ts`: `{window,step}` → range tool with computed
  `start`/`end`/`step`; window/step bounds → 400; `range:false`/absent → instant; legacy
  `range:true` → range tool (1h default, no start/step).
- `web/components/datasources/ExplorePanel.test.tsx`: dropdown presets render (Korean labels);
  selecting a window posts `{window, step}` with the auto step; Instant posts `range:false`;
  changing the dropdown re-runs an existing query; no re-run on query keystroke / initial mount;
  instant prom/mimir result ≤30 numeric rows → HBarList rendered (desc); >30 rows or ClickHouse
  table → no bar; range result → AreaTrend.

## Rollout
- Read-only UI/route change to an existing shipped feature; no feature flag. `make deploy` (web)
  after merge to `feat/v2` (no Lambda/terraform change). Merge as 0-overlap with the concurrent
  Part 1 (`--no-ff`, after a merge-tree dry-run per the project's concurrent-session discipline).

## Out of scope / follow-ups
- topk-in-range flicker hinting; range start/step manual override UI; Part 1 (separate session).
