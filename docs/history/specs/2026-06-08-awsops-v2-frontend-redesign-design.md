# AWSops v2 — Frontend Modern Redesign (Implementation Spec)

**Status:** Accepted. SUPERSEDES the earlier dark+shadcn draft. **Authoritative design source = `DESIGN.md` (repo root) + `colors.css`/`typography.css`/`spacing.css`** (user-provided high-fidelity handoff). 2026-06-08.

**Goal:** Reskin the v2 web from its current **dark-navy + neon-cyan inline-styled MVP** to the handoff's **warm "paper + ink" light theme + single Claude-orange accent** — clean, document-like, data-dense. Theme + layout overhaul only; all data/routes/APIs/page-logic unchanged.

> The handoff was written generically (references `src/`, `/awsops/login`, "v1.7"); our target is **`web/`** (the v2 thin-BFF), whose current dark `#0a0e1a`+cyan `#00d4ff` IS the "current" state the handoff describes — so it applies 1:1. No `prototype/` folder was provided; build from the DESIGN.md component catalog + exact token values.

## Stack (handoff-driven; reconciles the co-agent panel)
- **Tailwind CSS** — exact `theme.extend` + `globals.css :root` from DESIGN.md §"Wiring the tokens". Build-time → standalone ARM64 Docker safe.
- **Custom components built with Tailwind** per the DESIGN.md **Components catalog** — NOT shadcn/ui. The handoff specs are precise (Card/StatTile/Badge/Button/Input/SegmentedControl/StatePill/Meter/NavItem/AwsopsMark); building them directly is more faithful than theming shadcn. (Supersedes the earlier DD1=shadcn.)
- **lucide-react** for nav + UI icons (handoff explicitly permits the Lucide substitution for its stroke-icon set).
- **recharts** for charts (handoff confirms; co-agent DD3=A) — **deferred to F2** (Overview/Cost trends). F1 is tables + KPI tiles.
- **Sidebar shell** (co-agent DD2) + **incremental rollout** (co-agent DD4).
- Theme is **light-only** (it's the design); no dark toggle. The optional "Tweaks/Variations" (accent swap, density, flat cards) in DESIGN.md §Variations are **out of scope** (orange default only).

## Tokens (exact — from the 3 CSS files / DESIGN.md)
Page `#FAF9F5` · sunken/sidebar `#F3F1EB` · card `#FFFFFF`. Text primary `#1F1E1D` / secondary `#5F5A4D` / muted `#8A8474` / faint `#B5AFA0`. Brand `#D97757` (hover `#B75E40`, text `#8E4830`, subtle bg `#FBF1EC`, subtle border `#EEBFAA`). Positive emerald `#10B981`, negative rose `#F43F5E`. Borders subtle `#EDEBE4` / default `#D7D3C7`. Radii 6/8/12/16. Shadow-card `0 1px 2px rgba(31,30,29,.04),0 4px 16px rgba(31,30,29,.06)`. Font = system-sans stack + system-mono; tabular numerals on compared numbers. Weights 400/500/600 only. Sidebar 256px, page padding 32px, grid gap 16px.

## Screen → v2 page mapping
| DESIGN.md screen | v2 target |
|---|---|
| App shell + sidebar | NEW `components/shell/AppShell` + `Sidebar` (replace `TopNav`); grouped nav = fixed pages (대시보드/AI/AgentCore-ish) + our inventory groups (Compute/Storage&DB/Network/Security/Monitoring) → `/inventory/<type>` + EKS/Jobs/Cost |
| Overview dashboard | `app/page.tsx` → StatTile groups (SectionLabel eyebrows) + (charts F2) |
| EC2 / EKS resource lists | generic `app/inventory/[type]/page.tsx` + `app/eks/page.tsx` → Card-wrapped table + StatePill/Meter, PageHeader, SegmentedControl/search |
| Cost Explorer | `app/cost/page.tsx` → KPI tiles + HBar/charts (F2) |
| AI Assistant | existing `components/chat/ChatDrawer` → restyle messages/cards to paper+ink (F2) |
| Login | **N/A** — v2 auth = Cognito Hosted UI (not an app page). Cognito UI theming is a separate effort (DESIGN.md §1 + the existing Cognito CSS theme noted in commit bd92529); out of this scope. |

## F1 wave (high-leverage, one deployable) — what we build now
1. **F1a Foundation** — add deps (`tailwindcss`,`postcss`,`autoprefixer` dev; `lucide-react`,`tailwind-merge`,`clsx`); `tailwind.config.ts` (handoff `theme.extend` + content globs), `postcss.config.mjs`, `app/globals.css` (handoff `:root` + body + scrollbar + `animate-fade-in`), import in `layout.tsx`; `lib/cn.ts` (clsx+twMerge). **Build gate: `npm run build` clean + Tailwind CSS in `.next/static`.**
2. **F1b Core components** (`components/ui/`) per the catalog: `Card`, `StatTile`, `Badge`, `Button`, `Input`, `SegmentedControl`, `StatePill`, `Meter`, `PageHeader`, `SectionLabel`, `AwsopsMark` (inline SVG: claude-500 rounded tile + white stroked cube). Tailwind classes matching the exact specs (radii/shadow/weights/states).
3. **F1c App shell** — `Sidebar` (256px, `paper-muted` bg + blur, right hairline; lockup AwsopsMark+name+v2 badge; grouped nav with uppercase eyebrows + lucide stroke icons + active=`bg-claude-500 text-white`; footer admin chip + region/online dot) + `AppShell` (flex, sidebar + scrollable main) + Cmd-K command palette (lucide, registry-driven; co-agent DD2). Replace `TopNav` in `layout.tsx`; keep `ChatDrawer`.
4. **F1d Shared-table retrofit** — `DataTable` → unpadded Card + hairline row separators + sticky header (uppercase xs/tracking-wide) + StatePill for state-ish cells + truncation; `RefreshButton` → `Button` secondary + lucide `RotateCw`. Upgrades all 22 inventory pages + EKS/Jobs/Cost at once. Keep prop signatures.
5. **F1e Overview retrofit** — `app/page.tsx` → PageHeader + SectionLabel'd StatTile grid (reuse the same `StatCard`→`StatTile` swap; keep props). 
6. **F1f Deploy + screenshot** — `make deploy`; controller renders locally (or post-deploy) and Playwright-screenshots the new shell + Overview + an inventory page for user review.

## F2+ (later)
recharts on Overview (리소스 추세 area, EC2-type donut, 리소스 분포 bar) + Cost (일별 추이 area, 서비스별 HBar, 구성 donut); ChatDrawer paper+ink restyle (assistant cards, route badges); EC2/EKS page-specific KPI tiles + Meter CPU/mem + namespace/state filters; Cognito Hosted UI theming (login); responsive/mobile sidebar; density/flat variations if wanted.

## Testing
- Unit (vitest): existing 47 stay green (component retrofits keep prop signatures → page/route tests unaffected; registry/nav tests updated if nav moves to Sidebar). jsdom: keep tests at lib/route level; do not render the full shell/portal in tests. Add a `cn()` test.
- Build gate: `npm run build` clean, Tailwind CSS emitted, all routes present.
- Live (controller): `make deploy` → `/api/health` 200 → Playwright screenshots (local render needs no Cognito; the edge auth is at CloudFront, the shell/components render with loading/empty states) → user visual review → iterate → done.

## Rollout
F1 = one deployable wave (foundation + components + shell + table/Overview retrofit) that visually transforms the whole app (every page sits in the new shell; all inventory/EKS/Jobs/Cost share the retrofitted DataTable). F2+ = charts + chat + per-page polish + login. All under `web/`; pure presentation, no Terraform/backend change → `make deploy` only.
