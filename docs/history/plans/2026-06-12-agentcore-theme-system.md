# AgentCore Theme System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recolor the AWSops v2 web app from the Claude identity (warm cream + terracotta) to the AgentCore identity (cool neutrals + official Bedrock teal `#01A88D`), and add a runtime theme picker with three themes: `teal` (default), `azure`, `teal-console` (dark chrome).

**Architecture:** Convert Tailwind color tokens to reference CSS variables, so a single `<html data-theme>` attribute swaps the whole palette at runtime. Two light themes (teal/azure) are pure CSS swaps; the dark-chrome theme adds a dedicated `chrome` surface token used only by the sidebar/header. A tiny `lib/theme.ts` + `ThemeToggle` + Cmd-K commands drive selection, persisted to `localStorage` with an SSR no-flash inline script. recharts (SVG) gets a fixed AgentCore hex palette (SVG presentation attributes don't accept `var()`).

**Tech Stack:** Next.js 14 (app router, standalone), Tailwind 3.4, TypeScript, vitest (+ jsdom per-file), recharts 3.

**Spec:** `docs/superpowers/specs/2026-06-12-agentcore-theme-system-design.md`

**Conventions:** import alias `@/*` → web root. Tests live next to code (`*.test.ts(x)`), matched by `vitest.config.ts` include globs. Run all commands from `web/`. `make deploy` (web image only) ships it; no terraform/migrate.

**Key decisions locked during planning:**
- `claude` Tailwind token → renamed to `brand`; a temporary `claude` alias token is kept through Tasks 2–8 so existing classes never break, then removed in Task 9 (with a `grep` gate = 0).
- `emerald`/`rose` tokens are **remapped to positive/negative values** (class names kept) — zero usage churn across ~20 files, same visual result (positive=teal, negative=AWS red).
- recharts palette = fixed AgentCore hex in `components/charts/theme.ts` (not `var()`). DOM/CSS chart bits use `--chart-*`.
- Primary buttons use `--brand-action` (teal `#0A6B5A` / azure `#2E6BE6`) for WCAG AA on white; `--brand` (`brand-500`) stays for fills/active-bars/icons.

---

## File Structure

| File | Responsibility | Action |
|--|--|--|
| `web/app/globals.css` | CSS variable source of truth + `[data-theme]` blocks | Modify (rewrite `:root`, add themes) |
| `web/tailwind.config.ts` | Tailwind tokens → `var()`; rename/add tokens | Modify |
| `web/app/layout.tsx` | `<html data-theme>` default + no-flash script | Modify |
| `web/lib/theme.ts` | theme list, persist, apply | Create |
| `web/lib/theme.test.ts` | unit tests for theme.ts | Create |
| `web/components/shell/ThemeToggle.tsx` | sidebar-footer 3-way segment | Create |
| `web/components/shell/Sidebar.tsx` | chrome tokenization + mount ThemeToggle | Modify |
| `web/components/shell/CommandPalette.tsx` | Theme commands in Cmd-K | Modify |
| `web/components/charts/theme.ts` | AgentCore fixed-hex chart palette | Modify |
| `web/components/charts/AreaTrend.tsx` | doc comment only (uses theme.ts) | Modify |
| `web/components/ui/{Button,Badge,Meter,StatePill,StatTile}.tsx` | semantic primitives — rename + a11y | Modify (Task 9) |
| `web/components/ui/components.test.tsx` | assertion updates for renamed classes | Modify (Task 9) |
| `web/components/ui/AwsopsMark.tsx`, `web/app/icon.svg` | brand mark/favicon → teal | Modify (Task 10) |
| `web/app/topology/page.tsx` | hardcoded node tints cleanup | Modify (Task 11) |
| (28 files) `claude-*` classes | scripted rename → `brand-*` | Modify (Task 9) |

---

### Task 1: CSS variables + theme blocks (`globals.css`)

**Files:**
- Modify: `web/app/globals.css` (full `:root` rewrite + 2 new theme blocks)

This task only changes CSS variables. Because Tailwind tokens are still hardcoded hex at this point, **the app's appearance does NOT change yet** — this is a safe, isolated commit.

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `web/app/globals.css` with:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  /* ===== shared cool neutrals (replaces warm ink/paper) ===== */
  --ink-50:#F4F6F8; --ink-100:#E7ECEF; --ink-200:#D3DAE0; --ink-300:#AFBAC3;
  --ink-400:#7D8A96; --ink-500:#5A6873; --ink-600:#3D4852; --ink-700:#2A333B;
  --ink-800:#16202A; --ink-900:#0C141C;
  --paper:#F4F6F8; --paper-muted:#EBEFF2; --white:#FFFFFF;

  /* ===== brand ramp — teal (default; official Bedrock #01A88D) ===== */
  --brand-50:#E6F6F2; --brand-100:#C4EBE3; --brand-200:#8FD9CC; --brand-300:#54C3B0;
  --brand-400:#1FB199; --brand-500:#01A88D; --brand-600:#00876F; --brand-700:#0A6B5A;
  --brand-800:#0C5447; --brand-900:#0A3D34;
  /* accessible action color for buttons/primary — AA on white */
  --brand-action:#0A6B5A; --brand-action-hover:#0C5447;

  /* ===== chrome (sidebar/header) — light ===== */
  --surface-chrome:#FFFFFF; --surface-chrome-muted:#F4F6F8;
  --chrome-fg:var(--ink-800); --chrome-fg-muted:var(--ink-500); --chrome-border:var(--ink-100);
  --chrome-active-bg:var(--brand-50); --chrome-active-fg:var(--brand-700); --chrome-active-border:var(--brand-500);

  /* ===== semantic (shared across themes) ===== */
  --positive:#01A88D; --positive-surface:#E6F6F2; --positive-text:#00715D; --positive-border:#8FD9CC;
  --negative:#D13212; --negative-surface:#FDECE8; --negative-text:#A32A0F; --negative-border:#F5C3B5;
  --warning:#F59E0B; --warning-surface:#FEF3E2; --warning-text:#B26B05; --warning-border:#FAD9A0;

  /* ===== chart palette (DOM/CSS elements; recharts uses charts/theme.ts hex) ===== */
  --chart-1:#01A88D; --chart-2:#528DF8; --chart-3:#7B26FF; --chart-4:#39C2B0; --chart-5:var(--ink-400);
  --chart-grid:var(--ink-100); --chart-axis:var(--ink-400);

  /* ===== aliases — reach for these ===== */
  --surface-page:var(--paper); --surface-sunken:var(--paper-muted); --surface-card:var(--white);
  --text-primary:var(--ink-800); --text-secondary:var(--ink-500);
  --text-muted:var(--ink-400); --text-faint:var(--ink-300); --text-brand:var(--brand-700);
  --border-subtle:var(--ink-100); --border-default:var(--ink-200); --border-brand:var(--brand-200);
  --brand:var(--brand-500); --brand-hover:var(--brand-600); --brand-subtle:var(--brand-50);
  --brand-subtle-border:var(--brand-200); --on-brand:var(--white);
  --positive-alias:var(--positive); --negative-alias:var(--negative);

  /* ===== elevation (cool shadows) ===== */
  --shadow-card:0 1px 2px rgba(16,32,42,.04), 0 4px 16px rgba(16,32,42,.06);
  --shadow-sm:0 1px 2px rgba(16,32,42,.06);
  --shadow-pop:0 6px 24px rgba(16,32,42,.18);
  --shadow-focus:0 0 0 3px rgba(1,168,141,.26);
}

/* ===== azure theme: brand ramp + chart lead + focus ring ===== */
[data-theme="azure"] {
  --brand-50:#EAF1FE; --brand-100:#D2E2FD; --brand-200:#A9C7FB; --brand-300:#7FA9F9;
  --brand-400:#5E96F8; --brand-500:#528DF8; --brand-600:#2E6BE6; --brand-700:#1F54C2;
  --brand-800:#1B4196; --brand-900:#15306B;
  --brand-action:#2E6BE6; --brand-action-hover:#1F54C2;
  --chart-1:#528DF8; --chart-2:#01A88D; --chart-3:#7B26FF; --chart-4:#39C2B0;
  --shadow-focus:0 0 0 3px rgba(82,141,248,.26);
}

/* ===== teal-console theme: brand stays teal (inherited), chrome goes dark ===== */
[data-theme="teal-console"] {
  --surface-chrome:#22332F; --surface-chrome-muted:#1B2A27; --chrome-fg:#FFFFFF;
  --chrome-fg-muted:#9DB3AD; --chrome-border:#2A3D38;
  --chrome-active-bg:#26403A; --chrome-active-fg:#FFFFFF; --chrome-active-border:var(--brand-500);
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

- [ ] **Step 2: Verify the build compiles**

Run: `cd web && npm run build 2>&1 | tail -20`
Expected: build succeeds ("✓ Compiled" / route list). The app still looks Claude-orange (Tailwind tokens unchanged) — that's expected at this step.

- [ ] **Step 3: Commit**

```bash
cd web && git add app/globals.css
git commit -m "style(theme): define AgentCore CSS variables + teal/azure/console theme blocks"
```

---

### Task 2: Tailwind tokens → CSS variables (`tailwind.config.ts`)

**Files:**
- Modify: `web/tailwind.config.ts`

This is the **flip**: after this commit the whole app renders AgentCore teal + cool neutrals. `bg-claude-*` keeps working (temporary `claude` alias → brand vars). `emerald`/`rose` now render teal/red (semantic remap).

- [ ] **Step 1: Replace the `colors` and `boxShadow` blocks**

Replace the `colors: { … }` block (lines ~7–19) with:

```ts
      colors: {
        paper: { DEFAULT: 'var(--paper)', muted: 'var(--paper-muted)' },
        ink: {
          50: 'var(--ink-50)', 100: 'var(--ink-100)', 200: 'var(--ink-200)', 300: 'var(--ink-300)',
          400: 'var(--ink-400)', 500: 'var(--ink-500)', 600: 'var(--ink-600)', 700: 'var(--ink-700)',
          800: 'var(--ink-800)', 900: 'var(--ink-900)',
        },
        brand: {
          50: 'var(--brand-50)', 100: 'var(--brand-100)', 200: 'var(--brand-200)', 300: 'var(--brand-300)',
          400: 'var(--brand-400)', 500: 'var(--brand-500)', 600: 'var(--brand-600)', 700: 'var(--brand-700)',
          800: 'var(--brand-800)', 900: 'var(--brand-900)',
          action: 'var(--brand-action)', 'action-hover': 'var(--brand-action-hover)',
        },
        // TEMP alias so existing `*-claude-N` classes keep working — removed in Task 9
        claude: {
          50: 'var(--brand-50)', 100: 'var(--brand-100)', 200: 'var(--brand-200)', 300: 'var(--brand-300)',
          400: 'var(--brand-400)', 500: 'var(--brand-500)', 600: 'var(--brand-600)', 700: 'var(--brand-700)',
          800: 'var(--brand-800)', 900: 'var(--brand-900)',
        },
        chrome: {
          DEFAULT: 'var(--surface-chrome)', muted: 'var(--surface-chrome-muted)',
          fg: 'var(--chrome-fg)', 'fg-muted': 'var(--chrome-fg-muted)', border: 'var(--chrome-border)',
          active: 'var(--chrome-active-bg)', 'active-fg': 'var(--chrome-active-fg)', 'active-border': 'var(--chrome-active-border)',
        },
        positive: { DEFAULT: 'var(--positive)', surface: 'var(--positive-surface)', text: 'var(--positive-text)', border: 'var(--positive-border)' },
        negative: { DEFAULT: 'var(--negative)', surface: 'var(--negative-surface)', text: 'var(--negative-text)', border: 'var(--negative-border)' },
        warning:  { DEFAULT: 'var(--warning)',  surface: 'var(--warning-surface)',  text: 'var(--warning-text)',  border: 'var(--warning-border)' },
        // emerald/rose kept as semantic aliases (existing usages) — every shade maps to the
        // nearest positive/negative var so no class breaks regardless of which shade is used.
        emerald: {
          50: 'var(--positive-surface)', 100: 'var(--positive-surface)', 200: 'var(--positive-border)', 300: 'var(--positive-border)',
          400: 'var(--positive)', 500: 'var(--positive)', 600: 'var(--positive-text)', 700: 'var(--positive-text)',
          800: 'var(--positive-text)', 900: 'var(--positive-text)',
        },
        rose: {
          50: 'var(--negative-surface)', 100: 'var(--negative-surface)', 200: 'var(--negative-border)', 300: 'var(--negative-border)',
          400: 'var(--negative)', 500: 'var(--negative)', 600: 'var(--negative-text)', 700: 'var(--negative-text)',
          800: 'var(--negative-text)', 900: 'var(--negative-text)',
        },
      },
```

Replace the `boxShadow: { … }` block (lines ~21–26) with:

```ts
      boxShadow: {
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
        sm: 'var(--shadow-sm)',
        focus: 'var(--shadow-focus)',
      },
```

Leave `borderRadius`, `fontFamily`, `keyframes`, `animation` unchanged.

- [ ] **Step 2: Build and verify it compiles**

Run: `cd web && npm run build 2>&1 | tail -20`
Expected: build succeeds.

- [ ] **Step 3: Visual sanity check (dev server)**

Run: `cd web && npm run dev` (then open the app, or use Playwright MCP to screenshot `/`).
Expected: sidebar/active nav/buttons are **teal**, background is cool light gray (not cream). Badges: positive=teal, negative=red. Stop the dev server after checking.

- [ ] **Step 4: Run existing tests (should still pass — class names unchanged)**

Run: `cd web && npm test 2>&1 | tail -20`
Expected: PASS. `components.test.tsx` still asserts `bg-claude-500`/`bg-emerald-50`/`bg-rose-50` — all still present as class strings.

- [ ] **Step 5: Commit**

```bash
cd web && git add tailwind.config.ts
git commit -m "style(theme): map Tailwind tokens to CSS variables (app flips to AgentCore teal)"
```

---

### Task 3: `<html data-theme>` default + SSR no-flash script (`layout.tsx`)

**Files:**
- Modify: `web/app/layout.tsx`

- [ ] **Step 1: Add the default attribute + inline script**

Replace lines 10–12 (the `<html>`/`<body>` opening) with:

```tsx
    <html lang="ko" data-theme="teal" suppressHydrationWarning>
      <head>
        {/* No-flash: set data-theme from localStorage before first paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('awsops-theme');if(t==='teal'||t==='azure'||t==='teal-console'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();",
          }}
        />
      </head>
      <body className="min-h-screen bg-paper text-ink-800 font-sans antialiased">
```

(The closing `</html>` and the rest stay the same.)

- [ ] **Step 2: Build**

Run: `cd web && npm run build 2>&1 | tail -10`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
cd web && git add app/layout.tsx
git commit -m "feat(theme): default data-theme=teal + SSR no-flash theme init"
```

---

### Task 4: Theme model (`lib/theme.ts`) — TDD

**Files:**
- Create: `web/lib/theme.ts`
- Create: `web/lib/theme.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/lib/theme.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  THEMES, DEFAULT_THEME, THEME_LABELS, isTheme,
  getStoredTheme, setStoredTheme, applyTheme, STORAGE_KEY,
} from './theme';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme model', () => {
  it('exposes the three themes and a teal default', () => {
    expect(THEMES).toEqual(['teal', 'azure', 'teal-console']);
    expect(DEFAULT_THEME).toBe('teal');
    expect(THEME_LABELS['teal-console']).toBe('Console');
  });

  it('isTheme validates membership', () => {
    expect(isTheme('azure')).toBe(true);
    expect(isTheme('nope')).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });

  it('getStoredTheme returns default when unset or invalid', () => {
    expect(getStoredTheme()).toBe('teal');
    localStorage.setItem(STORAGE_KEY, 'bogus');
    expect(getStoredTheme()).toBe('teal');
  });

  it('setStoredTheme + getStoredTheme round-trips', () => {
    setStoredTheme('azure');
    expect(getStoredTheme()).toBe('azure');
  });

  it('applyTheme sets the data-theme attribute on <html>', () => {
    applyTheme('teal-console');
    expect(document.documentElement.getAttribute('data-theme')).toBe('teal-console');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npm test -- theme.test 2>&1 | tail -20`
Expected: FAIL — cannot resolve `./theme` (module not found).

- [ ] **Step 3: Write the implementation**

Create `web/lib/theme.ts`:

```ts
export const THEMES = ['teal', 'azure', 'teal-console'] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = 'teal';
export const STORAGE_KEY = 'awsops-theme';

export const THEME_LABELS: Record<Theme, string> = {
  teal: 'Teal',
  azure: 'Azure',
  'teal-console': 'Console',
};

export function isTheme(v: unknown): v is Theme {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function setStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore (private mode / SSR) */
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test -- theme.test 2>&1 | tail -20`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd web && git add lib/theme.ts lib/theme.test.ts
git commit -m "feat(theme): theme model (list/persist/apply) with tests"
```

---

### Task 5: ThemeToggle component + sidebar footer mount

**Files:**
- Create: `web/components/shell/ThemeToggle.tsx`
- Modify: `web/components/shell/Sidebar.tsx` (footer, lines ~144–151)

- [ ] **Step 1: Create the ThemeToggle**

Create `web/components/shell/ThemeToggle.tsx`:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { THEMES, THEME_LABELS, getStoredTheme, setStoredTheme, applyTheme, type Theme } from '@/lib/theme';
import { cn } from '@/lib/cn';

/**
 * ThemeToggle — 3-way segmented control (Teal / Azure / Console) in the sidebar
 * footer. Reads the stored theme on mount, writes + applies on change.
 * Uses chrome tokens so it reads correctly on both light and dark chrome.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('teal');

  useEffect(() => {
    setTheme(getStoredTheme());
  }, []);

  function pick(t: Theme) {
    setTheme(t);
    setStoredTheme(t);
    applyTheme(t);
  }

  return (
    <div className="mt-2 flex gap-1 rounded-md border border-chrome-border p-0.5" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => pick(t)}
          aria-pressed={theme === t}
          className={cn(
            'flex-1 rounded px-1.5 py-1 text-[11px] font-semibold transition-colors',
            theme === t
              ? 'bg-chrome-active text-chrome-active-fg'
              : 'text-chrome-fg-muted hover:text-chrome-fg',
          )}
        >
          {THEME_LABELS[t]}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Mount it in the sidebar footer**

In `web/components/shell/Sidebar.tsx`, add the import after line 19 (`import UserIdentity …`):

```tsx
import ThemeToggle from '@/components/shell/ThemeToggle';
```

Then replace the Footer block (lines ~144–151) with:

```tsx
      {/* Footer */}
      <div className="mt-4 border-t border-chrome-border pt-3">
        <UserIdentity />
        <div className="mt-2 flex items-center gap-1.5 px-0.5 text-[11px] text-chrome-fg-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-positive" />
          <span>{t('sidebar.statusLine', { status: t('sidebar.online') })}</span>
        </div>
        <ThemeToggle />
      </div>
```

(Note: this swaps the footer's `border-ink-100`→`border-chrome-border`, `text-ink-400`→`text-chrome-fg-muted`, and the status dot `bg-emerald-500`→`bg-positive`. Full chrome tokenization of the rest of the sidebar happens in Task 6.)

- [ ] **Step 3: Build + manual check**

Run: `cd web && npm run build 2>&1 | tail -10`
Expected: build succeeds. Run dev server; the sidebar footer shows a Teal/Azure/Console segment; clicking swaps the app palette live and persists across reload (no flash).

- [ ] **Step 4: Commit**

```bash
cd web && git add components/shell/ThemeToggle.tsx components/shell/Sidebar.tsx
git commit -m "feat(theme): sidebar theme picker (Teal/Azure/Console) + persistence"
```

---

### Task 6: Chrome tokenization (enables console dark chrome)

**Files:**
- Modify: `web/components/shell/Sidebar.tsx` (NavItem lines ~66–82; aside line ~90–92; lockup lines ~93–101; SectionLabel line ~119)

Currently the sidebar uses `bg-paper-muted`/`text-ink-*`/`border-ink-*`/`bg-claude-500` which are light-only. Switch them to `chrome` tokens so the `teal-console` theme renders a dark sidebar while light themes stay white/gray.

- [ ] **Step 1: Update NavItem**

Replace the `NavItem` `className` (lines ~70–80) with:

```tsx
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] font-medium no-underline transition-colors duration-[120ms]',
        active
          ? 'bg-chrome-active text-chrome-active-fg shadow-sm'
          : 'text-chrome-fg-muted hover:bg-chrome-active/40 hover:text-chrome-fg',
        className,
      )}
    >
      <Icon size={16} strokeWidth={1.7} className={cn('shrink-0', active ? 'text-chrome-active-fg' : 'text-chrome-fg-muted')} />
```

- [ ] **Step 2: Update the aside, lockup, and section label**

- Line ~90–92 (`<aside …>`): change `border-ink-100 bg-paper-muted/60` → `border-chrome-border bg-chrome-muted`.
- Line ~97 (product name): `text-ink-800` → `text-chrome-fg`.
- Line ~98 (tagline): `text-ink-400` → `text-chrome-fg-muted`.
- Line ~119 (`<SectionLabel … text-ink-400>`): `text-ink-400` → `text-chrome-fg-muted`.

- [ ] **Step 3: Build + verify all three themes**

Run: `cd web && npm run build 2>&1 | tail -10`
Expected: build succeeds. In dev: Teal/Azure = white sidebar + colored active; **Console = dark navy-teal sidebar** + white text + teal active border; main content stays light in all three.

- [ ] **Step 4: Commit**

```bash
cd web && git add components/shell/Sidebar.tsx
git commit -m "feat(theme): tokenize sidebar chrome surfaces (enables dark console theme)"
```

---

### Task 7: Theme commands in Cmd-K (`CommandPalette.tsx`)

**Files:**
- Modify: `web/components/shell/CommandPalette.tsx`

- [ ] **Step 1: Extend the command model + add theme actions**

Replace the `Cmd` interface and `buildCommands` (lines 10–26) with:

```tsx
import { THEMES, THEME_LABELS, setStoredTheme, applyTheme, type Theme } from '@/lib/theme';

interface Cmd { label: string; hint: string; href?: string; theme?: Theme }

// All navigable destinations: fixed pages + the 22 inventory types + theme actions.
function buildCommands(): Cmd[] {
  const fixed: Cmd[] = [
    { href: '/', label: 'Overview', hint: '대시보드' },
    { href: '/eks', label: 'EKS', hint: '파드' },
    { href: '/jobs', label: 'Jobs', hint: '비동기 작업' },
    { href: '/cost', label: 'Cost', hint: 'Cost Explorer' },
    { href: '/bedrock', label: 'Bedrock', hint: '토큰 비용' },
    { href: '/opencost', label: 'OpenCost', hint: 'K8s 비용' },
  ];
  const inv: Cmd[] = inventoryGroups().flatMap((g) =>
    g.types.map((t) => ({ href: `/inventory/${t}`, label: INVENTORY_TYPES[t].label, hint: g.group })),
  );
  const themes: Cmd[] = THEMES.map((t) => ({ label: `Theme: ${THEME_LABELS[t]}`, hint: '테마', theme: t }));
  return [...fixed, ...inv, ...themes];
}
```

- [ ] **Step 2: Make selection handle either nav or theme**

Replace the `go` callback (lines 50–56) with:

```tsx
  const go = useCallback(
    (cmd: Cmd) => {
      close();
      if (cmd.theme) {
        setStoredTheme(cmd.theme);
        applyTheme(cmd.theme);
        return;
      }
      if (cmd.href) router.push(cmd.href);
    },
    [close, router],
  );
```

In `onListKey` (line ~89–90), change `if (sel) go(sel.href);` → `if (sel) go(sel);`.
In the list `<button>` (line ~126), change `onClick={() => go(c.href)}` → `onClick={() => go(c)}`.
Change the `key` and active classes that referenced `c.href`: the `<li key={c.href}>` (line 122) → `<li key={c.label}>` (theme cmds have no href). Active highlight class `bg-claude-500` is handled by the Task 9 rename.

- [ ] **Step 3: Build + manual check**

Run: `cd web && npm run build 2>&1 | tail -10`
Expected: build succeeds. ⌘K → type "Theme" → 3 entries; selecting one swaps + persists the theme.

- [ ] **Step 4: Commit**

```bash
cd web && git add components/shell/CommandPalette.tsx
git commit -m "feat(theme): Cmd-K theme commands (Teal/Azure/Console)"
```

---

### Task 8: Chart palette → AgentCore fixed hex (`charts/theme.ts`)

**Files:**
- Modify: `web/components/charts/theme.ts`
- Modify: `web/components/charts/AreaTrend.tsx` (doc comment only)

recharts renders colors as SVG presentation attributes, which do **not** accept `var()`. So the chart palette stays as concrete hex — updated from Claude orange to the AgentCore palette (teal lead, azure, violet, light-teal, ink). This palette is the same in all themes (consistent multi-series data viz).

- [ ] **Step 1: Replace `theme.ts` contents**

Replace the whole of `web/components/charts/theme.ts` with:

```ts
/**
 * Chart theme — AgentCore palette (Bedrock teal lead). recharts renders colors
 * as SVG attributes, which don't accept CSS var(), so these are concrete hex
 * and identical across themes. DOM/CSS chart bits use the --chart-* variables.
 * lead = teal #01A88D; series cycle teal / azure / violet / light-teal / ink-400;
 * grid dotted in ink-100; axes/labels ink-400; tooltip = dark inverse (ink-800).
 */
export const CHART = {
  lead: '#01A88D', // brand teal (chart-1)
  leadStrong: '#00715D', // deep teal
  secondary: '#528DF8', // azure (chart-2)
  total: '#16202A', // ink-800
  grid: '#E7ECEF', // ink-100
  axis: '#7D8A96', // ink-400
  paper: '#F4F6F8',
} as const;

/** Donut/series palette: teal, azure, violet, light-teal, ink-400. */
export const PALETTE = ['#01A88D', '#528DF8', '#7B26FF', '#39C2B0', '#7D8A96'] as const;

export const AXIS_TICK = { fill: CHART.axis, fontSize: 11 } as const;

/** Dark inverse tooltip — ink-800 bg, paper text, radius 8. */
export const TOOLTIP_STYLES = {
  contentStyle: {
    background: CHART.total,
    border: 'none',
    borderRadius: 8,
    boxShadow: '0 6px 24px rgba(16,32,42,.18)',
    padding: '8px 10px',
  },
  labelStyle: { color: CHART.paper, fontSize: 11, marginBottom: 2 },
  itemStyle: { color: CHART.paper, fontSize: 12 },
} as const;
```

- [ ] **Step 2: Fix the stale AreaTrend doc comment**

In `web/components/charts/AreaTrend.tsx`, replace the comment block (lines 28–32) with:

```tsx
/**
 * AreaTrend — teal gradient area over a dotted ink-100 grid.
 * Lead series teal (#01A88D), fill = vertical gradient 0.30 → 0.02,
 * axes/labels ink-400, dark inverse tooltip. AgentCore chart palette.
 */
```

- [ ] **Step 3: Build + visual check of a charted page**

Run: `cd web && npm run build 2>&1 | tail -10`
Expected: build succeeds. In dev, open `/` and `/cost`: area/bars/donut render teal-led AgentCore colors; tooltip is dark.

- [ ] **Step 4: Commit**

```bash
cd web && git add components/charts/theme.ts components/charts/AreaTrend.tsx
git commit -m "style(theme): AgentCore chart palette (teal lead) for recharts"
```

---

### Task 9: Rename `claude`→`brand`, a11y action buttons, remove temp alias

**Files:**
- Modify (scripted): all `*.tsx`/`*.ts` under `web/app` and `web/components` using `*-claude-N` classes (28 files)
- Modify (manual a11y): `web/components/ui/Button.tsx`
- Modify (assertions): `web/components/ui/components.test.tsx`
- Modify: `web/tailwind.config.ts` (remove temp `claude` token)

- [ ] **Step 1: Scripted class rename (claude → brand)**

Run from `web/`:

```bash
cd web
grep -rlE "(bg|text|border|ring|from|to|via|fill|stroke|divide|outline|decoration|accent|caret|placeholder|shadow)-claude-[0-9]+" app components --include="*.tsx" --include="*.ts" \
  | xargs perl -pi -e 's/\b(bg|text|border|ring|from|to|via|fill|stroke|divide|outline|decoration|accent|caret|placeholder|shadow)-claude-([0-9]{2,3})\b/$1-brand-$2/g'
```

- [ ] **Step 2: Make primary buttons WCAG-AA (use `brand-action`)**

In `web/components/ui/Button.tsx`, the `VARIANT` map (now using `brand` after Step 1) — replace it with:

```tsx
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-brand-action text-white hover:bg-brand-action-hover',
  secondary: 'bg-white border border-ink-100 text-ink-800 hover:bg-brand-action hover:text-white hover:border-brand-action',
  ghost: 'bg-transparent text-ink-600 hover:bg-ink-100 hover:text-ink-800',
  danger: 'bg-negative text-white hover:bg-negative/90',
};
```

(`brand-action` = teal #0A6B5A / azure #2E6BE6 → AA on white. `danger` moves off `rose-*` to the `negative` token.)

- [ ] **Step 3: Update test assertions to the renamed classes**

In `web/components/ui/components.test.tsx`:
- Line 21: `expect(...).toContain('bg-claude-500');` → `expect(...).toContain('bg-brand-action');`
- Line 70 (StatePill Pending → brand): `toContain('bg-claude-50')` → `toContain('bg-brand-50')`
- Line 88 (Meter [50,75)): `toContain('bg-claude-500')` → `toContain('bg-brand-500')`

(The `bg-emerald-*` / `bg-rose-*` assertions on lines 39–42, 60, 65, 75, 82, 93, 122 stay as-is — those token names are intentionally kept as semantic aliases.)

- [ ] **Step 4: Remove the temporary `claude` alias token**

In `web/tailwind.config.ts`, delete the entire `claude: { … }` block added in Task 2 (the one commented "TEMP alias … removed in Task 9").

- [ ] **Step 5: Grep gate — no `claude` classes remain**

Run: `cd web && grep -rnE "(bg|text|border|ring|from|to|via|fill|stroke|divide|outline|decoration|accent|caret|placeholder|shadow)-claude-[0-9]+" app components --include="*.tsx" --include="*.ts"`
Expected: **no output** (exit 1). If any remain, fix them by hand and re-run.

- [ ] **Step 6: Build + test**

Run: `cd web && npm run build 2>&1 | tail -10 && npm test 2>&1 | tail -20`
Expected: build succeeds; all tests PASS.

- [ ] **Step 7: Commit**

```bash
cd web && git add app components tailwind.config.ts
git commit -m "refactor(theme): rename claude->brand tokens; AA action buttons; drop temp alias"
```

---

### Task 10: Brand mark + favicon → teal (`AwsopsMark.tsx`, `icon.svg`)

**Files:**
- Modify: `web/components/ui/AwsopsMark.tsx` (lines 21, 3–8 comment)
- Modify: `web/app/icon.svg`

- [ ] **Step 1: Recolor the mark tile**

In `web/components/ui/AwsopsMark.tsx`:
- Line 21: `<rect width="40" height="40" rx="10" fill="#D97757" />` → `fill="#01A88D"`.
- Update the doc comment (lines 3–8) to say "teal #01A88D rounded-square tile" instead of "claude-500 … orange tile". (Wording only; keep "white nodes/edges, haloed AI node".)

- [ ] **Step 2: Recolor the favicon**

Inspect `web/app/icon.svg`, then replace its orange tile fill with teal:

```bash
cd web && grep -o "#D97757" app/icon.svg && perl -pi -e 's/#D97757/#01A88D/g' app/icon.svg
```

If `app/icon.svg` uses a different orange hex (e.g. `#d97757` lowercase or another shade), replace that exact value with `#01A88D` instead. Verify: `grep -i "01A88D" app/icon.svg` returns a match and no `D97757` remains.

- [ ] **Step 3: Build + test (StatTile accent watermark test still passes)**

Run: `cd web && npm run build 2>&1 | tail -10 && npm test -- components.test 2>&1 | tail -10`
Expected: build + tests PASS (the `accent variant renders the AwsopsMark watermark` test only checks for an `<svg>`).

- [ ] **Step 4: Commit**

```bash
cd web && git add components/ui/AwsopsMark.tsx app/icon.svg
git commit -m "style(theme): recolor brand mark + favicon to AgentCore teal"
```

---

### Task 11: Clean up remaining hardcoded hex (`topology`)

**Files:**
- Modify: `web/app/topology/page.tsx` (lines 20, 71)

The topology node tints are pastel category colors. Shift them to cool-tinted AgentCore-family pastels and the node border to a neutral token-ish gray so they sit on the new cool surfaces.

- [ ] **Step 1: Update the TINT map (line 20) and node border (line 71)**

Replace line 20:

```tsx
  vpc: '#E6EEFE', subnet: '#E6F6F2', ec2: '#FEF3E2', rds: '#F1E9FF', alb: '#FDECE8',
```

(azure-tint / teal-tint / amber-tint / violet-tint / red-tint — same hue families as the chart/semantic palette.)

On line 71, change the node border `'1px solid #c7c7c7'` → `'1px solid #D3DAE0'` (ink-200).

- [ ] **Step 2: Confirm no other stray brand-orange hex remains app-wide**

Run: `cd web && grep -rniE "#D97757|#FAF9F5|#F3F1EB|#B75E40|#8E4830" app components --include="*.tsx" --include="*.ts"`
Expected: **no output**. (charts/theme.ts already updated in Task 8.) Fix any stragglers by replacing with the matching token/hex.

- [ ] **Step 3: Build**

Run: `cd web && npm run build 2>&1 | tail -10`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
cd web && git add app/topology/page.tsx
git commit -m "style(theme): cool-tint topology node colors + neutral borders"
```

---

### Task 12: Full verification + deploy

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `cd web && npm test 2>&1 | tail -25`
Expected: ALL tests PASS (theme.test + components.test + any others).

- [ ] **Step 2: Production build**

Run: `cd web && npm run build 2>&1 | tail -25`
Expected: build succeeds, no type errors.

- [ ] **Step 3: Final grep gates**

Run:
```bash
cd web
echo "claude classes (want 0):"; grep -rcE "claude-[0-9]" app components --include="*.tsx" --include="*.ts" | grep -v ':0' || echo "  clean"
echo "warm hex (want 0):"; grep -rniE "#D97757|#FAF9F5|#F3F1EB" app components --include="*.tsx" --include="*.ts" || echo "  clean"
```
Expected: both clean.

- [ ] **Step 4: Manual three-theme verification (Playwright MCP or dev server)**

Start dev (`npm run dev`) and for each theme (Teal default, then switch to Azure, then Console) screenshot `/` and `/cost`. Confirm:
- Teal: cool light, teal accents, teal active nav, AA-legible primary button.
- Azure: brand swaps to azure (incl. chart lead), neutrals unchanged.
- Console: dark navy-teal sidebar/header, light content, teal active border.
- No flash on reload (no-flash script); selection persists across reload.
- Badges/pills: positive=teal, negative=AWS red, warning=amber.

- [ ] **Step 5: Deploy (web image only)**

Run: `make deploy`
(What it does: ECR login → arm64 buildx build & push of the `web` image → ECS force-new-deployment → wait stable → smoke `GET /api/health`. No terraform apply, no DB migrate.)
Expected: deployment reaches steady state; health smoke returns 200. Verify the live site at `https://awsops-v2.example.com` shows the teal theme and the picker works.

---

## Self-Review

**1. Spec coverage:**
- §1 token→var + claude→brand → Tasks 2, 9. ✓
- §2 cool neutrals + 3 theme blocks (brand/chrome/chart) → Task 1. ✓
- §3 WCAG (text=brand-700, buttons=brand-action) → Task 1 (`--brand-action`, `--text-brand`), Task 9 Step 2. ✓
- §4 theme mechanism (lib/theme, no-flash, sidebar picker, Cmd-K) → Tasks 3,4,5,7. ✓
- §5 charts → Task 8. Deviation: fixed hex instead of var (recharts SVG limitation) — documented in plan header + Task 8. ✓
- §6 cleanup (claude rename, emerald/rose, hardcoded hex) → Tasks 9 (rename), 2 (emerald/rose remapped — deviation: token-value remap instead of usage-rename, documented), 11 (hardcoded). ✓
- §7 mark/favicon → Task 10. ✓
- Chrome tokenization for console → Task 6. ✓

**2. Placeholder scan:** No TBD/TODO. icon.svg edit gives a concrete hex find/replace with a fallback instruction (exact value confirmed at task time). All code steps show full code.

**3. Type consistency:** `Theme`, `THEMES`, `THEME_LABELS`, `getStoredTheme`, `setStoredTheme`, `applyTheme`, `STORAGE_KEY`, `isTheme`, `DEFAULT_THEME` — defined in Task 4, consumed identically in Tasks 5 (ThemeToggle) and 7 (CommandPalette). `Cmd` interface extended with optional `theme?: Theme` and `href?` — `go(cmd: Cmd)` handles both; all call sites updated (Task 7 Steps 2). Tailwind tokens `brand`, `brand.action`, `chrome.*`, `positive/negative/warning` defined in Task 2, used in Tasks 5/6/9. No naming drift found.
