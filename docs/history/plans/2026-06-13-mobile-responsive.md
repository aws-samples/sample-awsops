# Mobile Responsive UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each task is implemented by a fresh subagent that reads the spec + the named files' CURRENT code, then edits. Steps use `- [ ]`.

**Goal:** Make AWSops v2 web responsive at a single `lg` (1024px) breakpoint — below `lg`: mobile chrome (top bar + bottom tab bar + hamburger drawer reusing the sidebar) + key-page treatments (table→card, chat fullscreen, KPI grid reflow, detail sheet); at `lg+`: desktop unchanged.

**Spec (authoritative):** `docs/superpowers/specs/2026-06-13-mobile-responsive-design.md` — every task MUST follow it.

**Architecture:** Responsive via Tailwind `lg:` classes (CSS, no JS breakpoint); only the drawer open/close is client state in AppShell. Mobile chrome uses the existing `chrome` theme tokens (so console theme's dark chrome applies on mobile too). Default theme is `cobalt`.

**Tech stack:** Next.js 14 app router, Tailwind 3.4, lucide-react, recharts, vitest. Branch `feat/v2-architecture-design`. Run from `web/`. Ship via `make deploy` (web image; no terraform).

**Conventions:** import alias `@/*`; client components `'use client'`; i18n via `useI18n`/LanguageProvider (`lib/i18n.ts`, ko default); tests next to code, matched by `vitest.config.ts`. Chrome tokens: `bg-chrome`, `bg-chrome-muted`, `text-chrome-fg`, `text-chrome-fg-muted`, `border-chrome-border`, `bg-chrome-active`, `text-chrome-active-fg`.

---

### Task M1: viewport + mobile tab model (TDD where logic exists)
**Files:** Modify `web/app/layout.tsx`; Create `web/lib/mobile-tabs.ts` (+ `web/lib/mobile-tabs.test.ts`).
- [ ] `layout.tsx`: add Next 14 `export const viewport = { width: 'device-width', initialScale: 1 };` (alongside `metadata`).
- [ ] `lib/mobile-tabs.ts`: export `MOBILE_TABS` = 5 entries: `{ tkey, icon, href }` for Overview(`/`), Cost(`/cost`), Inventory(first inventory type href via `inventoryGroups()[0].types[0]` → `/inventory/<t>`, fall back `/inventory` if none), Assistant(`/assistant`), and a `{ tkey, icon, action:'drawer' }` More entry. Plus `isTabActive(pathname, tab): boolean` (exact for `/`, prefix-match for others; Inventory tab active for any `/inventory/...`). Reuse lucide icons already imported in Sidebar.
- [ ] `lib/mobile-tabs.test.ts` (TDD): isTabActive — `/` → Overview only; `/cost` → Cost; `/inventory/ec2` → Inventory; `/assistant` → Assistant; `/eks` → none of the 5 (drawer territory).
- [ ] Add i18n keys for the tabs/topbar (`nav.*` likely already exist for overview/cost/assistant; add any missing like `nav.more`) in `lib/i18n.ts` (ko+en parity).
- [ ] `npm test -- mobile-tabs` green; `npm run build` green. Commit.

### Task M2: extract shared sidebar nav
**Files:** Modify `web/components/shell/Sidebar.tsx` (extract its nav body so the drawer can reuse it).
- [ ] Refactor so the nav content (lockup + FIXED links + inventory groups + footer) is reusable by both the desktop `<aside>` and the mobile drawer. Options: (a) add an optional `onNavigate?: () => void` prop that NavItems call on click (for drawer close) + keep the `<aside>` wrapper as the desktop shell; (b) extract a `SidebarNav` inner component that both render. Pick whichever is least disruptive; desktop Sidebar MUST render identically. Chrome tokens already in place (from the theme work) — keep them.
- [ ] `npm run build` green; desktop sidebar visually unchanged. Commit.

### Task M3: MobileNav drawer
**Files:** Create `web/components/shell/MobileNav.tsx` (client).
- [ ] Slide-in left drawer: `fixed inset-0 z-40` with dim backdrop (`bg-ink-900/40`, click closes) + panel `bg-chrome-muted` with `translate-x` open/close transition. Props: `{ open: boolean; onClose: () => void }`. Render the shared sidebar nav (Task M2) inside; pass `onNavigate={onClose}` so tapping a link closes the drawer. Include LanguageToggle/UserIdentity/ThemeToggle in the drawer footer. `lg:hidden` (never shows on desktop). Esc closes; lock body scroll while open.
- [ ] `npm run build` green. Commit.

### Task M4: MobileTopBar
**Files:** Create `web/components/shell/MobileTopBar.tsx` (client).
- [ ] `lg:hidden sticky top-0 z-30 bg-chrome border-b border-chrome-border`. Left: ☰ button (`aria-label`, calls `onMenu`). Center/left: `AwsopsMark` (size ~26) + current page title (derive from pathname via the nav/tab labels; fallback "AWSops"). Right: 🔍 search button that opens the Cmd-K palette — reuse the existing global ⌘K mechanism (dispatch the same `keydown`/event `CommandPalette` listens to, or lift its open state; read `CommandPalette.tsx` to see how it toggles and trigger that path WITHOUT duplicating the palette). Props `{ onMenu: () => void }`.
- [ ] `npm run build` green. Commit.

### Task M5: BottomTabBar
**Files:** Create `web/components/shell/BottomTabBar.tsx` (client).
- [ ] `lg:hidden fixed bottom-0 inset-x-0 z-30 bg-chrome border-t border-chrome-border` + `pb-[env(safe-area-inset-bottom)]`. Render `MOBILE_TABS` (Task M1): icon + tiny label; active (via `isTabActive(usePathname(), tab)`) → `text-chrome-active-fg` else `text-chrome-fg-muted`. Link tabs use `next/link`; the `action:'drawer'` More tab calls `onMore`. Props `{ onMore: () => void }`.
- [ ] `npm run build` green. Commit.

### Task M6: AppShell responsive wiring
**Files:** Modify `web/components/shell/AppShell.tsx`.
- [ ] Make it `'use client'`, hold `const [navOpen, setNavOpen] = useState(false)`. Render:
  - Desktop sidebar: `<Sidebar />` wrapped so it's `hidden lg:flex` (add the class without breaking its internal layout — wrap in a `div className="hidden lg:flex"` or pass a className).
  - `<MobileTopBar onMenu={() => setNavOpen(true)} />`
  - `<main className="flex-1 overflow-y-auto animate-fade-in pb-16 lg:pb-0">{children}</main>`
  - `<BottomTabBar onMore={() => setNavOpen(true)} />`
  - `<MobileNav open={navOpen} onClose={() => setNavOpen(false)} />`
  - Keep the outer `flex h-screen` for desktop; ensure mobile (topbar above, content, bottombar fixed) lays out correctly (the fixed top/bottom bars + scrollable main). Verify no double sidebar.
- [ ] `npm run build` green; desktop unchanged, mobile chrome appears `<lg`. Commit.

### Task M7: DataTable mobile card mode
**Files:** Modify `web/components/ui/DataTable.tsx`.
- [ ] Below `lg`: render rows as a card list (`grid grid-cols-1 sm:grid-cols-2 gap-2 lg:hidden`), each card = the primary/first column (title, keep any link) + a status cell if present (StatePill/Badge) + the next 2–3 columns as `label: value`. At `lg+`: the existing `<table>` (`hidden lg:table` or wrap table in `hidden lg:block`). Keep sort/filter controls visible in both. Preserve all existing props/behavior; read the current DataTable API (columns shape, render fns) and reuse it for the cards (don't fork logic).
- [ ] Update/extend `components/ui/*.test` only if existing assertions break; add a light card-mode render assertion if feasible. `npm test` green; `npm run build` green. Commit.

### Task M8: ChatDrawer fullscreen below lg
**Files:** Modify `web/components/chat/ChatDrawer.tsx`.
- [ ] Below `lg`: the drawer renders fullscreen (`inset-0`, ignore the resizable width + hide the drag handle; show a clear close button). At `lg+`: existing right-docked resizable behavior unchanged (width/maximize localStorage only applies `lg+`). Read the current ChatDrawer to wire the responsive branch via classes (prefer CSS `lg:` over JS where possible; if width is inline-styled, guard it to `lg+` via a matchMedia or a `lg`-only style). Keep `/assistant` page untouched (already full-page).
- [ ] `npm test` green (chat tests preserved); `npm run build` green. Commit.

### Task M9: dashboard grid reflow + padding
**Files:** Modify the KPI/stat grids on `web/app/page.tsx` (Overview), `web/app/cost/page.tsx`, `web/app/bedrock/page.tsx` (and any obvious `grid-cols-4/5` dashboard rows).
- [ ] Change fixed `grid-cols-4`/`grid-cols-5` KPI rows to responsive `grid-cols-2 lg:grid-cols-4` (or `...lg:grid-cols-5`). Stack 2-up chart rows to 1-col `<lg`. Reduce page horizontal padding `<lg` (e.g. `px-4 lg:px-8`) where a page hard-codes `px-8`. Keep desktop layout identical. Only touch dashboard grid/padding — no logic.
- [ ] `npm run build` green. Commit.

### Task M10: detail panel → fullscreen sheet below lg
**Files:** Identify + modify the inventory/resource detail panel component (search `components/ui` / inventory pages for a right-docked DetailPanel; e.g. `DetailPanel.tsx`).
- [ ] If a right-docked detail/drill-down panel exists, make it a fullscreen sheet `<lg` (`inset-0` or bottom-sheet, close button, backdrop) while keeping the desktop docked panel `lg+`. If no such panel exists (detail is inline/separate route), note that and skip — record in the commit message.
- [ ] `npm run build` green; `npm test` green. Commit.

### Task M11: full verification
**Files:** none.
- [ ] `npm test 2>&1 | tail` — all green. `npm run build` — green.
- [ ] Manual/Playwright at 390×844: top bar + bottom tabs + drawer open/close; Overview KPI 2-col; an inventory page shows cards `<lg`; chat opens fullscreen; switch to console theme → mobile chrome dark; desktop (≥lg) unchanged. Capture a couple screenshots if Playwright MCP available.

---

## Self-Review (author)
- Spec coverage: viewport(M1), tabs(M1/M5), drawer(M3), top bar(M4), responsive shell(M6), table→card(M7), chat fullscreen(M8), grid reflow(M9), detail sheet(M10), chrome-token reuse (M3/M4/M5 use chrome tokens). ✓
- No-placeholder caveat: tasks reference the spec + name files; implementer subagents read CURRENT code (DataTable/ChatDrawer/CommandPalette APIs) rather than transcribing here — appropriate for autonomous subagent execution. The two genuine unknowns (Inventory tab exact href; detail-panel existence) are handled with explicit fallbacks (M1, M10).
- Desktop safety: every task asserts "desktop unchanged" + build green; single `lg` breakpoint.
