# Frontend Reskin F1 Implementation Plan (paper + ink)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. The AUTHORITATIVE design source is **`DESIGN.md`** (repo root) + `colors.css`/`typography.css`/`spacing.css` (exact tokens). Read the cited DESIGN.md section per task and match token values EXACTLY. Implementation spec: `docs/superpowers/specs/2026-06-08-awsops-v2-frontend-redesign-design.md`. Steps use `- [ ]`.

**Goal:** Reskin the v2 `web/` app from dark-navy+cyan inline styles to the handoff's warm paper+ink light theme + Claude-orange, with a Tailwind token layer, a custom component library, a sidebar app-shell, and retrofitted shared table — one deployable wave that transforms every page.

**Tech:** Next.js 14 standalone (web/), Tailwind CSS, lucide-react, custom Tailwind components (NOT shadcn). All build-time → standalone ARM64 Docker safe.

**Invariants:** Keep all component PROP SIGNATURES (StatCard `{label,value,accent}`, DataTable `{columns,rows}`, RefreshButton `{busy,onClick,capturedAt}`) so pages/tests are unaffected. No backend/API/route-logic change. Existing 47 vitest tests stay green.

---

### Task 1 (F1a): Tailwind foundation + tokens

**Files:** Create `web/tailwind.config.ts`, `web/postcss.config.mjs`, `web/app/globals.css`, `web/lib/cn.ts`; Modify `web/app/layout.tsx`, `web/package.json`

Read **DESIGN.md §"Wiring the tokens into the codebase"** — it gives the EXACT `globals.css :root` block and `tailwind.config.ts theme.extend`. Use them verbatim.

- [ ] **Step 1: deps** — `cd /home/atomoh/awsops/web && npm install -D tailwindcss@^3.4 postcss autoprefixer && npm install lucide-react clsx tailwind-merge`
- [ ] **Step 2: `web/postcss.config.mjs`**
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```
- [ ] **Step 3: `web/tailwind.config.ts`** — `content: ['./app/**/*.{ts,tsx}','./components/**/*.{ts,tsx}']`, `theme.extend` = the exact block from DESIGN.md (colors paper/ink/claude/emerald/rose, borderRadius sm/md/lg/xl, boxShadow card/pop, fontFamily sans/mono). Add `boxShadow.focus`, `boxShadow.sm` from the spacing tokens; add `keyframes fadeIn` + `animation['fade-in']`.
- [ ] **Step 4: `web/app/globals.css`** — `@tailwind base/components/utilities;` + the exact `:root {…}` token block from DESIGN.md + the `body{…}`, `.tabular`, `@keyframes fadeIn`/`.animate-fade-in`, and `::-webkit-scrollbar` rules from DESIGN.md.
- [ ] **Step 5: `web/lib/cn.ts`** — `import {clsx} from 'clsx'; import {twMerge} from 'tailwind-merge'; export const cn=(...a)=>twMerge(clsx(a));` + a vitest `web/lib/cn.test.ts` (merges classes; later class wins).
- [ ] **Step 6: `web/app/layout.tsx`** — `import './globals.css';` at top. Remove the inline `<body style={…dark…}>`; set `<body className="min-h-screen bg-paper text-ink-800 font-sans antialiased">`. (Shell wiring is Task 3; for now keep `<TopNav/>{children}<ChatDrawer/>` so it still builds.)
- [ ] **Step 7: build gate** — `cd /home/atomoh/awsops/web && npm run test && npm run build`. Expected: tests green (47 + cn), build clean, and `ls .next/static/css/*.css` shows a Tailwind CSS file. If no CSS emitted, the content globs are wrong.
- [ ] **Step 8: Commit** — `git add web/tailwind.config.ts web/postcss.config.mjs web/app/globals.css web/lib/cn.ts web/lib/cn.test.ts web/app/layout.tsx web/package.json web/package-lock.json && git commit -m "feat(v2-fe-f1): Tailwind + paper-ink tokens foundation (globals.css :root + tailwind.config from DESIGN.md) + cn util + lucide"`

---

### Task 2 (F1b): Core component library

**Files:** Create under `web/components/ui/`: `Card.tsx`, `StatTile.tsx`, `Badge.tsx`, `Button.tsx`, `Input.tsx`, `SegmentedControl.tsx`, `StatePill.tsx`, `Meter.tsx`, `PageHeader.tsx`, `SectionLabel.tsx`, `AwsopsMark.tsx`. Test: `web/components/ui/components.test.tsx`

Read **DESIGN.md §"Components catalog"** + §"Design tokens" for exact specs. All use Tailwind classes + the tokens. All `export default`. Use `cn()` for conditional classes. Match: Card = `bg-white border border-ink-100 rounded-lg shadow-card`; Button primary = `bg-claude-500 text-white rounded-md` (sizes 30/36/42px), secondary = `bg-white border-ink-100 hover:bg-claude-500 hover:text-white`; Badge = pill `rounded-full text-[10px] font-semibold` with tone variants (neutral/brand/positive/negative/inverse, soft/solid/outline, optional leading dot); StatePill = Badge mapping (running→positive, stopped→neutral, Pending→brand, Failed/CrashLoopBackOff→negative); Meter = 56px `bg-ink-100 rounded-full` track + threshold fill (≥75 rose, ≥50 claude, else emerald) + right % label; SegmentedControl = pill group on white track, active = `bg-claude-500 text-white shadow-sm`; PageHeader = title (text-xl/600) + optional live dot Badge + subtitle + right slot, bottom hairline, padding per spec; SectionLabel = uppercase eyebrow (text-[11px] tracking-[0.04em] text-ink-400).

- [ ] **Step 1: StatTile contract (prop-compatible with the old StatCard)** — accept BOTH the old `{label,value,accent?}` AND optional new `{eyebrow?,trend?,hint?,variant?:'accent'|'danger'|'warn'}`. Render: white Card, eyebrow=label (xs/uppercase/muted), value (text-2xl/600/tabular), optional trend pill + hint. `variant='accent'` → claude border + faint AwsopsMark watermark; `danger` → rose border+value; `warn` → claude-700 value. (Existing Overview passes `{label,value,accent}` — must keep working.)
- [ ] **Step 2: AwsopsMark** — inline SVG per DESIGN.md (claude-500 rounded-square tile radius 10/40 + white stroked cube). Props `{size?:number}`.
- [ ] **Step 3: write `components.test.tsx`** — render each component with @testing-library/react (add devDep `@testing-library/react` + `@testing-library/jest-dom` if not present; vitest jsdom env). Assert: Button renders children + variant class; Badge renders tone; StatePill maps 'running'→positive styling; Meter clamps + colors by threshold; StatTile renders label+value (old props). Keep tests shallow (no portals).
- [ ] **Step 4: implement all components**, run `cd web && npx vitest run components/ui/components.test.tsx` → green.
- [ ] **Step 5: build** — `npm run build` clean.
- [ ] **Step 6: Commit** — `git add web/components/ui web/package.json web/package-lock.json && git commit -m "feat(v2-fe-f1): core component library (Card/StatTile/Badge/Button/Input/SegmentedControl/StatePill/Meter/PageHeader/SectionLabel/AwsopsMark) per DESIGN.md catalog"`

---

### Task 3 (F1c): App shell — Sidebar + Cmd-K, replace TopNav

**Files:** Create `web/components/shell/Sidebar.tsx`, `web/components/shell/AppShell.tsx`, `web/components/shell/CommandPalette.tsx`; Modify `web/app/layout.tsx`; Delete `web/components/shell/TopNav.tsx`

Read **DESIGN.md §"2. App shell + sidebar"** for exact sidebar styling.

- [ ] **Step 1: Sidebar** (`'use client'`) — 256px, bg `paper-muted`/60% + `backdrop-blur`, right `border-ink-100`, padding `22px 16px 16px`, own scroll. Lockup: `<AwsopsMark size={36}/>` + "AWSops" (text-md/600) / "Cloud Operations" (2xs/muted) + a brand Badge "v2.0". Nav: fixed top items (Overview `/`→LayoutDashboard, EKS `/eks`→Box, Jobs `/jobs`→Activity, Cost `/cost`→DollarSign) then the inventory groups from `inventoryGroups()` (`@/lib/inventory-types`), each group an uppercase eyebrow (SectionLabel) + its types → `/inventory/<type>` with a per-group lucide icon (Compute→Server, Storage & DB→Database, Network→Network, Security→ShieldCheck, Monitoring→Activity). NavItem: `flex gap-2.5 px-2.5 py-[7px] rounded-md`; active (`usePathname` ===, inventory parent via startsWith) = `bg-claude-500 text-white shadow-sm`; hover = `bg-ink-100 text-ink-800`; rest = `text-ink-500` icon `text-ink-400`. Footer: 30px ink-800 avatar "관" + "관리자" / masked mono email + region line w/ emerald dot "ap-northeast-2 · 온라인".
- [ ] **Step 2: AppShell** — `<div className="flex h-screen"><Sidebar/><main className="flex-1 overflow-y-auto animate-fade-in">{children}</main></div>`.
- [ ] **Step 3: CommandPalette** (`'use client'`) — ⌘K/Ctrl-K global keydown opens a centered overlay (white Card `shadow-pop`, max 520px) with an Input + a filtered list of all fixed pages + 22 inventory types (from the registry); arrow/enter or click → `router.push`. (Plain React + a controlled list; no extra dep — or add `cmdk` if cleaner.) Esc closes.
- [ ] **Step 4: layout.tsx** — replace `<TopNav/>{children}` with `<AppShell>{children}</AppShell>`, keep `<ChatDrawer/>`, add `<CommandPalette/>`. `git rm web/components/shell/TopNav.tsx`. Update/keep any TopNav test (the inventory-types nav test may need to target Sidebar now, or assert `inventoryGroups()` directly — keep it green).
- [ ] **Step 5: build + test** — `cd web && npm run test && npm run build` green; `/inventory/[type]` etc. present.
- [ ] **Step 6: Commit** — `git add web/components/shell web/app/layout.tsx && git rm web/components/shell/TopNav.tsx; git commit -m "feat(v2-fe-f1): app shell — paper-ink Sidebar (256px, grouped nav, lockup, footer) + AppShell + Cmd-K palette; replaces TopNav"`

---

### Task 4 (F1d): Retrofit shared table + refresh button

**Files:** Modify `web/components/ui/DataTable.tsx`, `web/components/ui/RefreshButton.tsx`

Read **DESIGN.md §"4. EC2"** + §"Components catalog" (Card unpadded, StatePill, table styling).

- [ ] **Step 1: DataTable** — keep props `{columns:{key,label}[]; rows:Record<string,unknown>[]}`. Render inside an unpadded `<Card>`: a `<table className="w-full text-[14px]">`; `<thead>` sticky, header cells `text-[11px] uppercase tracking-[0.04em] text-ink-400 text-left py-2.5 px-3 border-b border-ink-100`; rows `border-t border-ink-100`, cells `py-2.5 px-3 text-ink-800`, hover `bg-ink-50`. Boolean cell → small Badge (true=positive soft, false=neutral). A cell whose key is `state`/`status`/`instance_state`/`cache_cluster_status`/`state_value` → `<StatePill value={String(v)}/>`. Long strings: `max-w-[280px] truncate` + `title`. Empty state: a muted centered "데이터 없음" row (keep existing empty behavior).
- [ ] **Step 2: RefreshButton** — keep props `{busy,onClick,capturedAt?}`. Render `<Button variant="secondary" size="sm">` with a lucide `<RotateCw className={busy?'animate-spin':''}/>` + label (busy "수집 중…" else "Refresh"); next to it the muted "업데이트 …" timestamp with stale (>30m) → `text-claude-700`.
- [ ] **Step 3: build + test** — `cd web && npm run test && npm run build` green.
- [ ] **Step 4: Commit** — `git add web/components/ui/DataTable.tsx web/components/ui/RefreshButton.tsx && git commit -m "feat(v2-fe-f1): retrofit DataTable (Card table, sticky header, StatePill/Badge cells) + RefreshButton (Button + spin icon) — upgrades all 22 inventory + EKS/Jobs/Cost"`

---

### Task 5 (F1e): Retrofit Overview

**Files:** Modify `web/app/page.tsx`

Read **DESIGN.md §"3. Overview dashboard"**.

- [ ] **Step 1:** Replace the inline `<main>`/`<h1>`/StatCard usage with `<PageHeader title="대시보드" live subtitle="…">` + the StatCard→StatTile swap (StatTile already prop-compatible). Group the existing 5 cards under a `<SectionLabel>` row (e.g. "운영 요약") in a `grid grid-cols-2 md:grid-cols-5 gap-4`. Keep the same data (`/api/overview` fetch + the jobs/clusterCount/mtdCost fields). Loading/error styled with tokens (`text-ink-400` / `text-rose-500`). (Charts deferred to F2.)
- [ ] **Step 2: build** — `cd web && npm run build` clean.
- [ ] **Step 3: Commit** — `git add web/app/page.tsx && git commit -m "feat(v2-fe-f1): Overview retrofit — PageHeader + SectionLabel + StatTile grid (paper-ink)"`

---

### Task 6 (F1f): Deploy + screenshot (CONTROLLER)
- [ ] **Step 1:** `cd web && npm run test && npm run build` final gate (all green).
- [ ] **Step 2:** `make deploy` → services-stable → `/api/health` 200.
- [ ] **Step 3:** Playwright: render the deployed site (or a local `next start`) and screenshot the new shell + Overview + one `/inventory/<type>` page; share with the user for visual review. (Edge auth is at CloudFront; if the live page redirects to Cognito, render against a local `npm run start` build instead — the shell/components render with loading/empty states without Aurora.)
- [ ] **Step 4:** Report + iterate on screenshot feedback. No commit (deploy only).

---

## Self-Review
- Coverage: tokens (T1), components (T2), shell/sidebar/Cmd-K (T3 = co-agent DD2), table retrofit upgrading all pages (T4), Overview (T5), deploy+screenshot (T6 = chosen review loop). Charts/chat/login = F2 (documented).
- Prop-compat invariant repeated in T2/T4/T5 so pages+tests stay green.
- Exact tokens/config come from DESIGN.md verbatim (no guessing); implementers read DESIGN.md per task.
- No backend/Terraform change — `make deploy` only.
