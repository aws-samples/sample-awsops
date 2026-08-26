# Handoff: AWSops Dashboard — v2 Redesign

## Overview

This package documents a **v2 visual redesign** of the AWSops Cloud Operations
Dashboard. It re-skins the existing Next.js app from its current **dark-navy +
neon-cyan** theme into a **warm "paper + ink" analytics aesthetic** with a single
Claude-orange accent — clean, document-like, data-dense, and calm.

The redesign covers six surfaces: **Login**, the **app shell / sidebar**, the
**Overview dashboard**, **EC2** and **EKS** resource lists, the **Cost Explorer**,
and the **AI Assistant** chat. The remaining 30 pages are not redesigned here but
inherit the same token set, components, and patterns — extend them the same way.

> This is a **theme + layout overhaul**, not a feature change. All existing data,
> routes, API calls, and page logic stay. What changes is the visual layer:
> colors, typography, spacing, component styling, and a few layout refinements.

---

## About the design files

The files in `prototype/` are **design references built in HTML/React (Babel JSX)** —
they show the intended look and behavior. **They are not production code to copy
verbatim.** The task is to **recreate these designs inside the existing AWSops
codebase** (Next.js 14 App Router + Tailwind CSS) using its established patterns
(React components in `src/components/`, Tailwind classes, the existing page files
in `src/app/*/page.tsx`).

To **run the prototype** locally: open `prototype/AWSops v2.html` in a browser (it
is self-contained — the design-system bundle and tokens are bundled under
`prototype/_ds/` and `prototype/app/`). The app opens on the login screen; click
**로그인 →** to enter the dashboard. Toggle the **Tweaks** panel (if your viewer
supports it) to preview the color/density/elevation variations.

## Fidelity

**High-fidelity.** Colors, typography, spacing, radii, shadows, and interactions
are final. Recreate the UI pixel-faithfully using the codebase's existing libraries
(Recharts is already a dependency — use it for charts; the prototype's hand-built
SVG charts are only a visual spec). Match the exact token values below.

---

## The shift, at a glance (current → v2)

| Aspect | Current (v1.7) | v2 redesign |
|---|---|---|
| Mode | Dark | **Light** |
| Page bg | `#0a0e1a` navy | `#FAF9F5` paper |
| Card bg | `#0f1629` | `#FFFFFF` white on paper |
| Primary accent | `#00d4ff` cyan | `#D97757` Claude orange |
| Text | `#e5e7eb` light grey | `#1F1E1D` warm near-black |
| Font (UI) | Inter | **system-ui stack** (San Francisco / Segoe / Pretendard) |
| Font (mono) | JetBrains Mono | system mono (`ui-monospace`) |
| Borders | `#1a2540` navy | `#EDEBE4` warm hairline |
| Shadows | mostly none | soft warm two-stop card shadow |
| Status colors | neon green/red/orange | emerald `#10B981` / rose `#F43F5E` (sparingly) |
| Number style | default | **tabular numerals everywhere compared** |

The neon cyan/green/purple accents are **removed**. Color in v2 is functional:
orange = brand/active/lead-series, emerald = healthy/up, rose = risk/down. Plain
ink carries everything else.

---

## Wiring the tokens into the codebase

The prototype is driven by CSS custom properties (see `tokens/colors.css`,
`tokens/typography.css`, `tokens/spacing.css` — the source of truth). Port them
into the app two ways:

### 1) `src/app/globals.css` — replace the `:root` block

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  /* brand (Claude orange) */
  --claude-50:#FBF1EC; --claude-100:#F5DCCF; --claude-200:#EEBFAA;
  --claude-300:#E69F7F; --claude-400:#DF8663; --claude-500:#D97757;
  --claude-600:#B75E40; --claude-700:#8E4830; --claude-800:#653321; --claude-900:#3D1F14;

  /* ink (warm neutral) */
  --ink-50:#F7F6F2; --ink-100:#EDEBE4; --ink-200:#D7D3C7; --ink-300:#B5AFA0;
  --ink-400:#8A8474; --ink-500:#5F5A4D; --ink-600:#3F3B32; --ink-700:#2B2823;
  --ink-800:#1F1E1D; --ink-900:#14130F;

  /* paper surfaces */
  --paper:#FAF9F5; --paper-muted:#F3F1EB; --white:#FFFFFF;

  /* semantic accents */
  --emerald-50:#ECFDF5; --emerald-200:#A7F3D0; --emerald-500:#10B981; --emerald-700:#047857;
  --rose-50:#FFF1F2; --rose-200:#FECDD3; --rose-500:#F43F5E; --rose-700:#BE123C;

  /* aliases — reach for these */
  --surface-page:var(--paper); --surface-sunken:var(--paper-muted); --surface-card:var(--white);
  --text-primary:var(--ink-800); --text-secondary:var(--ink-500);
  --text-muted:var(--ink-400); --text-faint:var(--ink-300); --text-brand:var(--claude-700);
  --border-subtle:var(--ink-100); --border-default:var(--ink-200); --border-brand:var(--claude-200);
  --brand:var(--claude-500); --brand-hover:var(--claude-600); --brand-text:var(--claude-700);
  --brand-subtle:var(--claude-50); --brand-subtle-border:var(--claude-200); --on-brand:var(--white);
  --positive:var(--emerald-500); --positive-surface:var(--emerald-50); --positive-text:var(--emerald-700); --positive-border:var(--emerald-200);
  --negative:var(--rose-500); --negative-surface:var(--rose-50); --negative-text:var(--rose-700); --negative-border:var(--rose-200);

  /* chart palette */
  --chart-1:var(--claude-500); --chart-2:var(--ink-400); --chart-3:var(--ink-800);
  --chart-4:var(--claude-700); --chart-5:var(--claude-200);
  --chart-grid:var(--ink-100); --chart-axis:var(--ink-400);

  /* elevation */
  --shadow-card:0 1px 2px rgba(31,30,29,.04), 0 4px 16px rgba(31,30,29,.06);
  --shadow-sm:0 1px 2px rgba(31,30,29,.06);
  --shadow-pop:0 6px 24px rgba(31,30,29,.18);
  --shadow-focus:0 0 0 3px rgba(217,119,87,.22);
}

body {
  background: var(--surface-page);
  color: var(--text-primary);
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'Pretendard',
               'Helvetica Neue', Arial, sans-serif;
  font-feature-settings: 'cv11','ss01','ss02';
  -webkit-font-smoothing: antialiased;
}

/* tabular numerals — apply wherever numbers are compared/animated */
.tabular { font-variant-numeric: tabular-nums; }

/* page-enter (route change) — keep subtle */
@keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }
.animate-fade-in { animation: fadeIn .2s cubic-bezier(.16,1,.3,1); }

::-webkit-scrollbar { width:10px; height:10px; }
::-webkit-scrollbar-thumb { background:var(--ink-200); border-radius:999px; border:2px solid var(--paper); }
::-webkit-scrollbar-track { background:transparent; }
```

### 2) `tailwind.config.ts` — replace the `theme.extend` block

```ts
theme: {
  extend: {
    colors: {
      paper:  { DEFAULT:'#FAF9F5', muted:'#F3F1EB' },
      ink:    { 50:'#F7F6F2',100:'#EDEBE4',200:'#D7D3C7',300:'#B5AFA0',400:'#8A8474',
                500:'#5F5A4D',600:'#3F3B32',700:'#2B2823',800:'#1F1E1D',900:'#14130F' },
      claude: { 50:'#FBF1EC',100:'#F5DCCF',200:'#EEBFAA',300:'#E69F7F',400:'#DF8663',
                500:'#D97757',600:'#B75E40',700:'#8E4830',800:'#653321',900:'#3D1F14' },
      emerald:{ 50:'#ECFDF5',200:'#A7F3D0',500:'#10B981',700:'#047857' },
      rose:   { 50:'#FFF1F2',200:'#FECDD3',500:'#F43F5E',700:'#BE123C' },
    },
    borderRadius: { sm:'6px', md:'8px', lg:'12px', xl:'16px' },
    boxShadow: {
      card:'0 1px 2px rgba(31,30,29,.04), 0 4px 16px rgba(31,30,29,.06)',
      pop: '0 6px 24px rgba(31,30,29,.18)',
    },
    fontFamily: {
      sans: ['ui-sans-serif','system-ui','-apple-system','Segoe UI','Pretendard','sans-serif'],
      mono: ['ui-monospace','SF Mono','Menlo','Consolas','monospace'],
    },
  },
},
```

After this, the existing `navy.*` / `accent.*` classes can be removed and replaced
per the migration map below.

---

## Design tokens (exact values)

**Colors** — see the two code blocks above. Quick semantic guide:
- **Page** `#FAF9F5` · **sunken/sidebar** `#F3F1EB` · **card** `#FFFFFF`
- **Text**: primary `#1F1E1D`, secondary `#5F5A4D`, muted `#8A8474`, faint `#B5AFA0`
- **Brand**: `#D97757` (hover `#B75E40`, text-on-light `#8E4830`, subtle bg `#FBF1EC`, subtle border `#EEBFAA`)
- **Positive** emerald `#10B981` (bg `#ECFDF5`, text `#047857`) · **Negative** rose `#F43F5E` (bg `#FFF1F2`, text `#BE123C`)
- **Borders**: subtle `#EDEBE4`, default `#D7D3C7`, brand `#EEBFAA`

**Typography** (`--font-sans` system stack; `--font-mono` system mono):
| Token | px | Use |
|---|---|---|
| 2xs | 10 | badges, tiny labels |
| xs | 11 | eyebrow labels, table headers, hints |
| sm | 12 | secondary copy, chart subtitles |
| base | 14 | body, nav, table cells |
| md | 15 | product name, emphasised body |
| lg | 18 | card headings |
| xl | 24 | page titles |
| 2xl | 26 | KPI metric values |
| 3xl | 32 | hero single number |
Weights: **400 / 500 / 600 only** (never heavier). Letter-spacing: `-0.01em` on page
titles & KPI numbers; `0.04em` uppercase table headers; `0.12em` eyebrow/product tags.

**Spacing** — 4px grid: 2 / 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64.
Layout: sidebar **256px**, main gutter (page padding) **32px**, KPI/chart grid gap **16px**.

**Radii**: chips/badges/segmented **6px** · buttons/inputs/nav items/tooltips **8px** ·
cards/KPI tiles/charts **12px** · large panels **16px** · pills/dots/avatars **9999px**.

**Shadows**: card `0 1px 2px rgba(31,30,29,.04), 0 4px 16px rgba(31,30,29,.06)` ·
hover pop `0 6px 24px rgba(31,30,29,.18)` · focus ring `0 0 0 3px rgba(217,119,87,.22)`.

**Motion**: 120ms hovers, 200ms route/menu, 320ms slow. Easing `cubic-bezier(.16,1,.3,1)`
(ease-out) or `cubic-bezier(.4,0,.2,1)` (standard). No bounces, no springs.

---

## Migration map (current class → v2)

| Current | v2 replacement |
|---|---|
| `bg-navy-900` (page) | `bg-paper` |
| `bg-navy-800` (card) | `bg-white` + `border border-ink-100` + `shadow-card` |
| `bg-navy-700` (hover) | `hover:bg-ink-100` (quiet) |
| `border-navy-600` | `border-ink-100` (subtle) / `border-ink-200` (default) |
| `text-gray-200/300` | `text-ink-800` (primary) / `text-ink-500` (secondary) |
| `text-accent-cyan` (links/active) | `text-claude-700`; active nav = `bg-claude-500 text-white` |
| `accent-cyan` chart series | `claude-500` lead, `ink-400`/`ink-800` secondary |
| `accent-green` (ok) | `emerald-500` |
| `accent-red` (error) | `rose-500` |
| `accent-orange` (warn) | `claude-500` / `claude-700` text |
| `font-mono` (JetBrains) | keep mono usage, swap stack to system `ui-monospace` |
| neon glow effects | remove — use `shadow-card` + hairline borders instead |

---

## Screens / views

### 1. Login (`/awsops/login`)
- **Purpose**: secure entry; credentials + SSO.
- **Layout**: full-viewport paper background with two faint Claude-orange radial
  glows (top-left 16%/12%, bottom-right 84%/88%, ~5–7% opacity). Centered column
  **400px** wide. Above the card: AWSops mark (52px) + "AWSops" (xl/600) +
  "Cloud Operations Dashboard" (sm/secondary), center-aligned, 14px gap.
- **Card**: white, radius **16px**, `shadow-card`, padding **28px**, `border-ink-100`,
  16px vertical gap between fields.
  - Header row: "로그인" (lg/600) + a `positive` dot badge "보안 연결".
  - **Email** field (label "이메일" xs/secondary above) — Input, height **42px**, prefilled `admin@awsops.internal`.
  - **Password** field (label "비밀번호") — Input type=password, height 42px.
  - Row: checkbox "로그인 유지" (accent-color claude, checked) ↔ link "비밀번호 찾기" (`text-claude-700`). Both `whitespace-nowrap`.
  - **Primary button** "로그인 →" — solid claude, full-width, size lg (height 42). On submit: 850ms busy state, label → "인증 중…", then route to dashboard.
  - Divider: hairline + center label "또는 SSO로 계속" (2xs/uppercase/muted).
  - **SSO grid** 2×2, 10px gap: GitHub / Google / Okta / Cognito. Each = 40px height, white, `border-ink-100`, radius 8, a 2-char glyph (GH/G/O/C, bold/secondary) + label; hover bg `ink-50`.
- **Footer line** (center, 2xs/muted): `ap-northeast-2 · CloudFront → Lambda@Edge JWT · X-Custom-Secret`.

### 2. App shell + sidebar
- **Layout**: `display:flex; height:100vh`. Sidebar **256px** fixed, main pane fluid
  with independent scroll. Page background = paper + the two faint radial glows
  (toggleable; see Variations).
- **Sidebar**: background `color-mix(in srgb, var(--paper-muted) 60%, transparent)`
  + `backdrop-filter: blur(6px)`, right border `ink-100`, padding `22px 16px 16px`,
  own vertical scroll.
  - **Lockup**: AWSops mark (36px) + "AWSops" (md/600) / "Cloud Operations" (2xs/muted) + a `brand` badge "v2.0".
  - **Nav**: grouped by category with uppercase eyebrow labels (2xs, `tracking-widest`, `text-ink-300`): _(ungrouped)_ 대시보드·AI 어시스턴트·AgentCore; **Compute** EC2·Lambda·ECS·ECR·EKS; **Network & CDN** VPC/Network·CloudFront·WAF·Topology; **Storage & DB** EBS·S3·RDS·DynamoDB·ElastiCache; **Monitoring** Monitoring·CloudWatch·CloudTrail·Cost·Resource Inventory; **Security** IAM·Security·CIS Compliance.
  - **Nav item**: `display:flex; gap:10; padding:7px 10px; radius:8`. Left a 16px stroke icon (1.7px, round caps), then a two-line label (base/500) + hint (2xs, lowercased fragment). Optional right badge (📊 / AI). States: **active** = `bg-claude-500 text-white shadow-sm` (icon white); **hover** = `bg-ink-100 text-ink-800`; **rest** = `text-ink-500`, icon `ink-400`. A `danger` item (Security) tints its icon rose at rest.
  - **Footer**: avatar (30px ink-800 circle "관") + "관리자" / masked email `ad*****@awsops.io` (mono, 2xs) + a logout icon button; below it a region line with an emerald dot: `ap-northeast-2 · 온라인`.

### 3. Overview dashboard (`/awsops`)
- **Page header** (shared): padding `26px 32px 20px`, bottom hairline. Title "대시보드"
  (xl/600) + `positive` dot badge "실시간"; subtitle (base/secondary, max 680px).
  Right slot: "업데이트 01:38:41" (xs/muted/tabular) + SegmentedControl `7d/14d/30d`
  + secondary button "새로고침".
- **Body** padding 32px, vertical stack, gap 24 (18 in compact).
  - Three KPI groups, each preceded by an eyebrow **SectionLabel**: "COMPUTE & CONTAINERS", "NETWORK & STORAGE", "SECURITY · MONITORING · COST". Each group = `grid-cols-5 gap-4` of **StatTile**.
    - Compute: EC2 **25** (accent, ↑4.2%, "25 running · 0 stopped"), Lambda 22, AgentCore "8 GW", ECR 3, EKS 8.
    - Network: S3 Buckets 29 (warn, "1 public · 28 private"), VPC 5, RDS 2, DynamoDB 20, ElastiCache 4.
    - Security: Security Issues **9** (danger), IAM Users 2, CW Alarms 0, CIS 54.1% (↓2.3%), Monthly Cost $7,240 (↓40%).
  - **Active-warnings card** (title "활성 경고 (3)", unpadded body): 3 equal columns split by hairlines, each a colored dot (rose/claude/ink) + text.
  - **Row** `grid 1.6fr / 1fr`: "리소스 추세" area chart (K8s pods = orange lead, EC2 = ink line, 14d) + legend; "EC2 인스턴스 타입" donut (150px) + legend list.
  - **Full-width** "리소스 분포" vertical bar chart (K8s Pods bar emphasized).
  - **Row** `grid 1fr / 1.6fr`: "K8s 파드 상태" donut (Running/Pending/Failed) + legend; "최근 K8s 이벤트" feed — rows with a `negative|neutral` mono event-type badge, `ns/object` (mono, truncating), message (xs/secondary), age (xs/faint/right). Risk rows get `bg-claude-50`.

### 4. EC2 (`/awsops/ec2`)
- Header "EC2" + "실시간"; right = SegmentedControl `전체/실행/중지` + search Input (magnifier icon).
- 4 KPI tiles (총 인스턴스 25 accent · 실행 중 24 · 평균 CPU 17% · 시간당 비용 $3.42).
- **Table** in an unpadded Card. Columns: 이름/ID (name 500 + mono id faint) · 타입 (mono/secondary) · 상태 (**StatePill**) · AZ · 사설 IP (mono) · CPU · 메모리. CPU/Mem cells = inline **Meter** (56px track, fill colored by threshold: ≥75 rose, ≥50 claude, else emerald + right % label). Stopped rows show "—" for IP/CPU/Mem. Row separators = top hairline; filters narrow rows live.

### 5. EKS — pods (`/awsops/eks`)
- Header "EKS — 파드" + subtitle (cluster `eksworkshop`, k8s 1.33, 105 pods); right = search.
- 4 KPI tiles (총 파드 105 accent · Running 101 · Pending 3 warn · 비정상 1 danger).
- **Namespace filter**: pill row (`all` + distinct namespaces); active pill = solid claude.
- **Table**: 파드 (mono) · 네임스페이스 · 노드 (mono) · 상태 (StatePill) · 재시작 (colored by count) · CPU · 메모리 · Age. A `CrashLoopBackOff` row gets `bg-rose-50`.

### 6. Cost Explorer (`/awsops/cost`)
- Header "Cost Explorer" (no live badge) + `brand` dot badge "Cost Explorer API" + SegmentedControl `7d/30d/MTD` + secondary "PDF 내보내기".
- 4 KPI tiles (이번 달 누적 $7,240.45 accent ↓40% · 예상 청구액 $13,580 · 전월 대비 −$4,789 · Savings Plan 62%).
- **"일별 비용 추이"** area chart (30d, $ y-axis) with a `일별/월별` SegmentedControl in the card's right slot.
- **Row** `grid 1.5fr / 1fr`: "서비스별 비용" = **HBar** list (label / track / `$amount`); "비용 구성" = donut (170px) + 2-col legend with % .
- **"서비스 상세"** table: 서비스 (colored dot + name) · 비용 (claude/tabular) · 점유율 · 추세 (↑rose / ↓emerald).

### 7. AI Assistant (`/awsops/ai`)
- Full-height flex column: shared header ("AI 어시스턴트" + `brand` dot badge "Claude Sonnet 4.6") → scrollable thread → composer.
- **Thread** centered, max 860px, gap 22. **User message**: right-aligned bubble, `bg-ink-800 text-paper`, radius 12, max 78%. **Assistant message**: 34px square avatar (white card + AWSops mark) + a white Card (radius 12, `shadow-card`, padding 20/22) containing rich blocks:
  - `h` heading with emerald status dot · `sub` section subhead · `table` (label/value grid, value rendered as a mono chip when it matches an ID/URL/number pattern) · `access` rows (negative "주의" / neutral "꺼짐" badge + text) · `note` callout (`bg-claude-50`, 3px claude left bar) · `text` paragraph.
  - **Footer** (top hairline): `brand` mono route badge (e.g. "AgentCore → Container Gateway (24 tools)"), model (mono), elapsed (faint/tabular), right-aligned "복사" with copy icon; then a "Tools:" row of mono chips + a `Queried: …` line.
- **Thinking state**: avatar + pulsing "질문을 분류하고 게이트웨이를 호출하는 중…".
- **Composer**: suggestion chips (pill buttons) that send on click; an input row = rounded white field (radius 12, `shadow-sm`) with a primary "전송 →" button. Enter submits. New user message appends, ~1100ms later a templated assistant reply appends and the thread auto-scrolls to bottom.

---

## Components catalog

Build these as reusable React components in `src/components/` (TypeScript). Exact
styling is in `prototype/_ds/` (the design-system source) and `prototype/app/`.

| Component | Spec |
|---|---|
| **Card** | white surface, `border-ink-100`, radius 12, `shadow-card`. Optional header: title (base/600) + subtitle (sm/secondary) + right slot; `padded` flag (set false for tables). |
| **StatTile** (KPI) | white card, radius 12, `shadow-card`. Eyebrow label (xs/uppercase/muted) → value (2xl/600/tabular) → trend pill (↑emerald / ↓rose) + hint. Variants: `accent` (claude border + faint AWSops-mark watermark top-right at 7% opacity), `danger` (rose border + rose value), `warn` (claude-700 value). Hover (when clickable): lift 2px + `shadow-pop`. |
| **Badge** | pill, 2xs/600, radius full. Tones: neutral / brand / positive / negative / inverse. Variants: soft (tinted) / solid / outline. `dot` adds a leading status dot; `mono` for event types. |
| **Button** | primary (solid claude, white text), secondary (white, `border-ink-100`, hovers to solid claude), ghost (transparent, tints ink-100), danger (rose). Sizes sm/md/lg (30/36/42px). Radius 8. Press = translateY(.5px). |
| **Input** | white, `border-ink-100`, radius 8, optional left icon. Focus = `border-claude-500` + focus ring `shadow-focus`. Sizes sm/md (30/36px). |
| **SegmentedControl** | pill group on white track + hairline border, radius 8, 2px padding. Active segment = solid claude + white, `shadow-sm`. Options can be strings or `{value,label}`. Used for ranges and tab toggles. |
| **StatePill** | Badge mapping for resource states: running/Running→positive, stopped→neutral, Pending→brand, CrashLoopBackOff/Failed→negative. |
| **Meter** | 56px track (`bg-ink-100`, radius full) + fill colored by threshold + right % label. |
| **Sidebar NavItem** | see shell spec. |
| **Charts** | Use **Recharts** (already a dependency). Series colors: lead = `claude-500`, secondary = `ink-400`, tertiary/total = `ink-800`; area fill = orange→transparent vertical gradient (`#D97757` 0.30 → 0.02); grid lines dotted `2 4` in `ink-100`; axes/labels `ink-400`. The prototype's SVG charts in `prototype/app/charts.jsx` define exact geometry/colors. |
| **AwsopsMark** | brand glyph: a claude-500 rounded-square tile (radius 10/40) with a white stroked cube + base accent. Inline SVG in `prototype/app/sidebar.jsx`. Use for the lockup, login, KPI watermark, and AI avatar. |
| **Nav stroke icons** | ~24 inline 1.7px-stroke icons (24×24 viewBox) for nav. Source in `prototype/app/sidebar.jsx` (`ICONS` map). Or swap to **Lucide** (`lucide-react`) — same geometric round-cap style (flagged substitution). |

---

## Interactions & behavior

- **Login → dashboard**: submit shows 850ms busy ("인증 중…") then enters the shell. SSO buttons do the same. Logout (sidebar) returns to login.
- **Routing**: sidebar click swaps the main page; main pane replays a 200ms fade-in (`animate-fade-in`). In the real app this is just route navigation between `src/app/*` pages — keep the fade subtle/optional.
- **Tables**: search + tab/namespace filters narrow rows live (client-side). Hover does not need a row highlight beyond the existing pattern; risk rows keep their tinted bg.
- **Hover**: cards/tiles lift 2px + `shadow-pop` only where the tile is actionable; buttons darken one step; nav items tint; links underline or shift to `text-ink-800`.
- **Focus**: 3px claude ring at ~22% (`shadow-focus`) with offset — keep visible for inputs and keyboard nav.
- **AI chat**: Enter or "전송 →" appends the user message, shows the thinking state, then appends a templated assistant reply after ~1100ms; thread auto-scrolls. Suggestion chips send their text.
- **Reduced motion**: gate the fade/pulse on `@media (prefers-reduced-motion: no-preference)`.

## State management

Per-page client state only (mirrors the prototype): selected range (`7d/14d/30d`),
active tab/filter, search query, namespace, chart granularity (`daily/monthly`), AI
thread array + draft + thinking flag, and the app-level auth flag + current route.
Wire data to the existing AWSops APIs (`/api/steampipe`, `/api/ai`, etc.) — the
prototype uses static mock data (`prototype/app/data.js`) purely for layout.

## Variations (optional theming)

The prototype exposes four toggles via a Tweaks panel — implement as a settings/
theme layer only if useful:
- **Accent color** — claude orange (default) / blue `#2A6FDB` / emerald `#1F8A5B` / violet `#7A5AE0`. Each remaps `--brand*`, `--chart-1`, `--border-brand`. (Default = orange; the others are exploration options, **not** required.)
- **Density** — regular / compact (table cell padding 13px→9px, section gaps 24→18).
- **Card style** — soft (shadow) / flat (border only, `--shadow-card: none`).
- **Background grain** on/off · **KPI watermark** on/off.

## Assets

- **AWSops mark** — inline SVG, no external file needed (in `sidebar.jsx`). Do not
  recolor outside the accent system.
- **Icons** — inline stroke set in `sidebar.jsx`, or use `lucide-react`.
- **Fonts** — none to ship; system stack by design. (If you want pixel-identical
  cross-machine rendering, wire Inter/Pretendard + IBM Plex Mono via `next/font`.)
- No photography, no neon glows, no emoji in prose (nav badges 📊/AI are the only
  permitted glyphs, matching the source dashboard).

## Files (in this bundle)

```
design_handoff_awsops_v2/
├── README.md                     ← this document
├── tokens/                       ← exact token source (colors/typography/spacing)
│   ├── colors.css
│   ├── typography.css
│   └── spacing.css
└── prototype/                    ← runnable design reference
    ├── AWSops v2.html            ← open this in a browser
    ├── _ds/                      ← bundled design-system (components + tokens + fonts)
    └── app/
        ├── data.js               ← mock data (layout only)
        ├── charts.jsx            ← exact chart geometry/colors
        ├── common.jsx            ← PageHeader, StatTile, Legend, StatePill
        ├── sidebar.jsx           ← shell, nav, AwsopsMark, icon set
        ├── login.jsx             ← login screen
        ├── pages-overview.jsx    ← dashboard
        ├── pages-resources.jsx   ← EC2 / EKS tables + placeholder
        ├── pages-cost.jsx        ← Cost Explorer
        ├── pages-ai.jsx          ← AI Assistant chat
        └── app.jsx               ← shell wiring + theming variations
```

> Recreate these in `src/components/` + `src/app/*/page.tsx` using Tailwind + the
> tokens above. The HTML/JSX here is a **reference**, not code to ship as-is.
