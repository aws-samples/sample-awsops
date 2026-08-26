# Plan — Chat slash-command section targeting

> Spec: `docs/superpowers/specs/2026-06-14-chat-slash-section-routing-design.md`.
> Branch base `feat/v2-architecture-design`; **implement in an isolated worktree** (main checkout
> holds a concurrent session's uncommitted OpenCost changes — must not be touched). Web-only; no
> backend/`/api/chat`/routing change. TDD: failing test → minimal code → refactor; per-task commit.

## Allowed file scope
- `web/lib/slash.ts`, `web/lib/slash.test.ts`
- `web/components/chat/SlashMenu.tsx`
- `web/components/chat/Composer.tsx`, `web/components/chat/Composer.test.tsx`
- `web/components/chat/useChat.ts`
- `web/components/chat/PresetChips.tsx`
- `web/components/chat/ChatDrawer.tsx`, `web/components/chat/AssistantClient.tsx`
- `web/components/chat/SectionPicker.tsx` (delete)

## Out of scope (do NOT touch)
`web/app/api/**`, `web/lib/route.ts`, `web/lib/classifier.ts`, `web/lib/sections.ts` (read-only import),
anything under `web/app/opencost/**`, `CommandPalette.tsx`, `Sidebar.tsx`, `next.config.mjs`.

---

## Tasks

### T1 — `lib/slash.ts` pure parser (+ tests)
- [ ] Failing `web/lib/slash.test.ts`: `parseSlash('/cost foo')→{section:'cost',prompt:'foo'}`;
      `'/network'→{section:'network',prompt:''}`; `'/auto x'→{section:null,prompt:'x'}`;
      `'/bogus x'→{section:null,prompt:'/bogus x'}` (literal passthrough); `'hello'→{null,'hello'}`;
      `'a /cost'→{null,'a /cost'}` (leading-only). `matchCommands('co')` contains `container`+`cost`;
      `matchCommands('')` returns all; results carry `{key,label,icon,active}`.
- [ ] Implement `web/lib/slash.ts`: derive `SLASH_COMMANDS` from `SECTIONS` (import from
      `@/lib/sections`) + an `{key:'auto',label:'자동 라우팅',icon:'🧭',active:true}` entry.
      `parseSlash(text)` matches `/^\/([a-z-]+)(?:\s+([\s\S]*))?$/` against the trimmed-left text;
      if group1 is a known key → `{section: key==='auto'?null:key, prompt:(group2??'').trimStart? rest}`
      (keep the body verbatim minus the command token); else `{section:null, prompt:text}`.
      `matchCommands(frag)` = `SLASH_COMMANDS.filter(c=>c.key.startsWith(frag.toLowerCase()))`.
- [ ] Commit: `feat(chat): slash-command parser (lib/slash)`.

### T2 — `SlashMenu.tsx` popover (covered by Composer test)
- [ ] Implement `web/components/chat/SlashMenu.tsx`: props `{ query: string; onSelect: (c)=>void;
      onClose: ()=>void }`. Renders `matchCommands(query)` as an ARIA `listbox` of `option`s
      (icon + `/key` + label); inactive commands dimmed (`opacity-40`) with a `준비중` suffix.
      Controlled active-index via props is overkill → keep internal `active` index with ↑/↓/Enter/Tab
      select, Esc → `onClose`; mouse hover sets active, click selects. `aria-activedescendant` +
      AA contrast. `export default`. (No standalone test; exercised via Composer.test.)
- [ ] Commit: `feat(chat): SlashMenu popover component`.

### T3 — `Composer.tsx` slash menu + chip + parse-on-send (+ tests)
- [ ] Failing `web/components/chat/Composer.test.tsx` (jsdom): typing `/` renders the menu; typing
      `/co` narrows to container+cost; selecting `cost` clears the field and shows a chip (icon+label
      with a clear ✕); pressing Enter then calls `onSend` with `('<text>', 'cost')`; a plain message
      calls `onSend('hi', undefined)`; typing the full `/data foo` + Enter (no menu pick) calls
      `onSend('foo','data')`; an empty body with only a chip does NOT send.
- [ ] Edit `web/components/chat/Composer.tsx`: change props to `onSend: (text:string, section?:string|null)=>void`.
      Add `target: SlashCommand|null` + menu-open state. Show `SlashMenu` while the input is a
      leading-`/` fragment with no space. On menu select → set `target`, clear the `/frag`. Render a
      chip when `target` set. On send: if `target` → `onSend(text, target.key==='auto'?null:target.key)`,
      clear chip; else `const {section,prompt}=parseSlash(text); onSend(prompt, section)`. Block send
      when the resulting prompt is empty. Placeholder: `메시지를 입력하세요…  ( / 로 특정 영역 지정 )`.
- [ ] Commit: `feat(chat): composer slash menu + per-message section chip`.

### T4 — wire-up: drop the picker + sticky pin
- [ ] Edit `web/components/chat/useChat.ts`: remove `pinned`/`setPinned` state; `send(text,
      overrideSection?, switchedFrom?)` posts `section: overrideSection ?? null`. Keep `resendWith`.
- [ ] Edit `web/components/chat/PresetChips.tsx`: drop the `pinned` prop; always render `AUTO_PRESETS`
      with the generic header; add no new behavior.
- [ ] Edit `web/components/chat/ChatDrawer.tsx` + `web/components/chat/AssistantClient.tsx`: remove the
      `SectionPicker` import + render and the `chat.pinned`/`chat.setPinned` references; pass the new
      `Composer onSend={chat.send}` (already `chat.send`) and `PresetChips` without `pinned`.
- [ ] Delete `web/components/chat/SectionPicker.tsx`.
- [ ] `grep -rn "pinned\|SectionPicker\|setPinned" web/components/chat web/app/assistant` → zero hits.
- [ ] Commit: `refactor(chat): remove always-on SectionPicker; auto-route default + slash targeting`.

### T5 — verification gate
- [ ] `cd web && npx vitest run components/chat lib/slash` green; then full `npx vitest run` green
      (fix any test that referenced the removed `pinned`/`SectionPicker`).
- [ ] `npx tsc --noEmit` adds zero new errors vs the 18-error baseline (source files clean).
- [ ] `npx next build` rc=0.

## P2 gate revisions (codex+gemini consensus — folded in)
- **R1 parseSlash semantics (MAJOR):** do NOT left-trim the input — a leading space means it is NOT a
  command (literal). Match `^\/([a-z][a-z-]*)(?:\s([\s\S]*))?$`: group1=key, the separator is exactly
  ONE whitespace char, group2=body kept **verbatim** (no further trim) so pasted indentation/newlines
  survive. `/costfoo` (no separator) → literal. Tests: `/cost   foo`→`'  foo'`; `/cost\nfoo`→`'foo'`;
  `/cost`→`''`; `'  /cost x'`→literal; `/costfoo`→literal.
- **R2 useChat signature (MAJOR):** `send(prompt, overrideSection?: string | null, switchedFrom?)`;
  body posts `section: overrideSection ?? null`. Composer may pass `null` (explicit auto) with no TS error.
- **R3 Enter ownership (MAJOR):** while the SlashMenu is open it OWNS ArrowUp/ArrowDown/Enter/Tab/Esc —
  `e.preventDefault()` + select/close; Composer must NOT send on an Enter the menu consumed. Implement by
  routing the input's `onKeyDown` to a menu handler first when open, which returns a "handled" flag.
- **R4 empty-body slash → chip (MAJOR):** typing `/network` (no body) + Enter sets the target chip,
  clears the field, and does NOT send; test it. (Selecting from the menu does the same.)
- **R5 a11y wiring + tests (MAJOR):** the **input** carries `role=combobox`, `aria-expanded`,
  `aria-controls`(menu id), `aria-activedescendant`(active option id); each option has a stable id.
  jsdom tests: ArrowDown moves the active option, Enter/Tab selects it, Escape closes,
  `aria-activedescendant` points at an existing option id.
- **R6 orphaned presets (MAJOR→resolved):** `PresetChips` shows `AUTO_PRESETS` only; the per-section
  `presets` arrays in `lib/sections.ts` are intentionally RETAINED as data (no scope creep into that
  read-only file) — documented as currently-unused, available for a future per-section hint.
- **R7 (MINOR):** test names match their assertions; the section key stays `string | null`.

## Rollout
`make deploy` (web). No migration / worker / terraform.
