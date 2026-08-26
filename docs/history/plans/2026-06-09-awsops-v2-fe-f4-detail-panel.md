# Frontend F4 — Row-click Detail Side Panel

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps `- [ ]`.

**Why:** v2 inventory tables (and the P3-D EKS drill-in) show only the registry's display columns and rows aren't clickable — so unlike v1 (`/awsops/ec2`), clicking a resource shows no detail. But we already store the **full Steampipe/K8s row in `inventory_resources.data`** (the page maps `{resource_id, region, ...data}`), so a click can reveal every field with **no extra fetch**. F4 adds a generic **row-click → slide-in detail panel** to the shared DataTable, lighting up all 22 inventory types + the EKS in-cluster tables at once.

**Out of scope (separate metrics feature):** v1's "평균 CPU / 시간당 비용" KPI cards need CloudWatch GetMetricData + EC2 pricing — a future metrics integration, not this PR. F4 is the detail panel.

**Invariants:** reuse F1 tokens/components; DataTable stays backward-compatible (onRowClick optional → existing non-clickable tables unchanged); existing 97 tests stay green; no backend/API change (data already loaded).

---

### Task 1: `DetailPanel` component + DataTable `onRowClick`

**Files:** Create `web/components/ui/DetailPanel.tsx`; Modify `web/components/ui/DataTable.tsx`. Test: `web/components/ui/detailpanel.test.tsx`

- [ ] **Step 1: DataTable `onRowClick`** — add optional prop `onRowClick?: (row: Record<string, unknown>) => void`. When set: each `<tr>` gets `onClick={() => onRowClick(row)}` + `cursor-pointer` (keep `hover:bg-ink-50`); also pass through which row is `selected` (optional `selectedKey?: string` + a `getRowKey?` — OR simplest: highlight via an optional `activeRow` compare on `resource_id`/first column). Keep it minimal: `onRowClick` + a `cursor-pointer` when present. No change when `onRowClick` is undefined (backward-compatible — existing tables unaffected). Keep sorting + isValidElement intact.
- [ ] **Step 2: `DetailPanel.tsx`** (`'use client'`) — a right slide-in panel (fixed, `w-[420px]`, `bg-white border-l border-ink-100 shadow-pop`, full height, `z-50`, overlay behind at `bg-ink-900/20`), props `{ title?: string; data: Record<string, unknown> | null; onClose: () => void }`. Renders when `data` is non-null. Header: title (the resource id) + a close `×` button (lucide `X`). Body (`overflow-y-auto`): a definition list of **every** `data` entry — key (mono, `text-ink-500`, snake_case as-is) → value rendered: boolean → `<Badge>`; null/'' → muted `—`; object/array → `<pre>` pretty JSON (`text-[11px]`, wrapped, `bg-ink-50 rounded`); long string → wrapped/selectable. Close on `×`, overlay click, and `Escape` (keydown). Use F1 tokens.
- [ ] **Step 3: test** (`detailpanel.test.tsx`, jsdom) — renders title + a few key/value rows from a mock object (string, boolean→badge, nested object→pre); returns null when `data` is null; calls `onClose` on the close button. (Shallow; no portal.)
- [ ] **Step 4:** `cd web && npx vitest run components/ui/detailpanel.test.tsx` green; `npm run build` clean.
- [ ] **Step 5: Commit** — `git add web/components/ui/DetailPanel.tsx web/components/ui/DataTable.tsx web/components/ui/detailpanel.test.tsx && git commit -m "feat(v2-fe-f4): DetailPanel (right slide-in, full key/value of a row) + DataTable onRowClick (clickable rows, backward-compatible)"`

---

### Task 2: wire into inventory + EKS pages

**Files:** Modify `web/app/inventory/[type]/page.tsx`, `web/app/eks/[cluster]/page.tsx`

- [ ] **Step 1: inventory page** — add `const [selected, setSelected] = useState<Record<string,unknown>|null>(null)`; pass `onRowClick={setSelected}` to the `<DataTable>`; render `<DetailPanel title={selected?.resource_id as string} data={selected} onClose={() => setSelected(null)} />`. The row already carries the full `{resource_id, region, ...data}` (so the panel shows every Steampipe field) — no fetch. Keep KPI tiles + donut + filters as-is.
- [ ] **Step 2: EKS drill-in page** — same wiring: `selected` state + `onRowClick` on the in-cluster `<DataTable>` + `<DetailPanel>` (the normalized row is what's shown — acceptable; the full raw object is a later enhancement if wanted).
- [ ] **Step 3: build + test** — `cd web && npm run test && npm run build` green; both pages compile.
- [ ] **Step 4: Commit** — `git add web/app/inventory web/app/eks && git commit -m "feat(v2-fe-f4): row-click detail panel on inventory pages + EKS drill-in — full resource fields from the loaded row (no extra fetch)"`

---

### Task 3: Deploy + screenshot (CONTROLLER)
- [ ] `cd web && npm run test && npm run build` final gate.
- [ ] `make deploy` → `/api/health` 200.
- [ ] Temp preview (`/preview-inv` with mock EC2 rows + the panel open) → Playwright screenshot showing the table + an open detail panel; cleanup. Share.

---

## Self-Review
- Fixes #2 (no detail on click) generically for all 22 inventory types + EKS tables, using data already loaded (no API change).
- DataTable change is opt-in (onRowClick optional) → backward-compatible; tests stay green.
- #1 (more cards = avg CPU / hourly cost) is explicitly a separate CloudWatch-metrics feature, noted not faked.
