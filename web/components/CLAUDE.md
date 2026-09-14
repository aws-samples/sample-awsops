# Components Module

## Role
Client components span `ui`, `shell`, `charts`, `chat`, `inventory` (including `metrics/`), `eks`, `diagnosis`, `datasources`, `dx`, `finops`, `graph`, `insights`, `nfm`, `overview`, and `topology`.

## Key Files
- `ui/DataTable.tsx` + `ui/DetailPanel.tsx` — the default list+detail combo. DetailPanel renders the full data the row already holds (plus a handful of type-specific fetching sections: RDS metrics/trends/SG rules, EBS related, live metrics, S3 IAM access) — if the spec (`InvType`) has `sections`, it renders grouped sections; otherwise a flat key list (backward-compat). New inventory types must define `sections`.
- `inventory/metrics/MetricTable.tsx` — a declarative `MetricCol` model (`{value, render?, danger?, facet?, facetValues?, type}`) gets you sort, global search, facet filters, and a "problems only" toggle for free. Per-service tables (Ec2/Rds/Alb/...) are written purely as column definitions. Opt-in props: `facetValues` (multi-value facet — an exact-match on the joined display string drops multi-value rows), `maxRender`+`capKeep` (render-stage row cap — a data-stage cut silently zeroes an exact search), `rowClass` (per-row class hook).
- `inventory/metrics/guides.tsx` + `guides.{en,zh,ja}.tsx` — per-language diagnosis-guide bodies. i18n lockstep — update all four files together.
- `dx/DxTopology.tsx` — Direct Connect topology diagram (React Flow + dagre; follows the topology-page conventions — dynamic ssr:false, colorMode, light/dark color pairs, imperative fitView). Graph/SLA logic lives in the pure `lib/dx-topology.ts`.
- `nfm/FlowHopPath.tsx` — end-to-end hop stepper (local endpoint → traversedConstructs → remote endpoint). Each kind has its own glyph and color — never rely on color alone to identify a kind.
- `eks/NodeCapacityCards.tsx` — node capacity 3-split cards; also exports the shared `StackBar` (named export) reused by `NodeCapacityList` on the nodes fleet page — a deliberate exception to the default-export-per-page convention.
- `eks/NodeDrilldownPanel.tsx` — node drilldown (capacity cards + Pod/ENI sections, with its own live nodes+pods query). Shared by the EKS overview and the `/eks/nodes` fleet page (`FleetKindPage`).
- `chat/MessageList.tsx` + `chat/useChat.ts` — streaming smoothing: throttles markdown-parse input at ~180ms via `useThrottled` (avoids O(n²) full reparse per token) and balances incomplete code fences (MessageList); a typewriter buffer batches deltas and emits proportionally to backlog every 24ms (min 3 chars), flushing immediately on completion (useChat).
- `shell/LanguageProvider.tsx` — the `useI18n()` hook (`t`/`tt`/lang context).
- `shell/Sidebar.tsx` — navigation; where new pages register.
- `shell/ChangelogVersion.tsx` — sidebar footer version chip + changelog modal (`/api/changelog`). **The sidebar's transform becomes the containing block for fixed descendants** — modals rendered inside the sidebar must portal to `body` via `createPortal`.
- `ui/StatCard.tsx` — an alias re-export of `StatTile`. New code should import `StatTile` directly.

## Rules
- i18n carve-out: table COLUMN headers and `InvType` spec labels (column/facet/section names) deliberately stay English in every locale — they are technical identifiers kept in one canonical form. UI prose, buttons, captions, and titles go through `tt()` (Korean source literal).
- Components consumed by pages use `export default`. Shared utility modules (`metrics/shared.tsx`, `guides.*.tsx`, `LanguageProvider.tsx`, etc.) use named exports as an established pattern — do not change this arbitrarily.
- Prefer reusing `ui/` primitives (Badge, StatePill, Card, PageHeader, StatTile, etc.) over adding new ones — don't proliferate primitives.
- User-facing display strings are Korean literals passed through `tt()` (unregistered strings pass through safely, so this is zero-risk).
- Tests are colocated with components as `*.test.tsx` (vitest).
