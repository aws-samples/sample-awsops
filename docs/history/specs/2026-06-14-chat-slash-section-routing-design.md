# Design — Chat: slash-command section targeting (replace the always-on picker)

> **Branch:** `feat/v2-architecture-design` · implement in an isolated worktree (main checkout holds
> a concurrent session's uncommitted OpenCost changes — must not be disturbed).
> Scope: AI Assist (chat) explicit-section UX only. **No backend/routing changes.**

## Problem

AI Assist routes each message to a section gateway. Auto-routing already works and is the default
(ADR-038 classifier; `pinned === null`), **but** a persistent `SectionPicker` button-row sits above
the composer in both `ChatDrawer` and `AssistantClient`, creating the impression that the user must
pick a section first. V1's single agent simply auto-selected the gateway with no such prompt.

**Goal:** keep auto-routing as the silent default; make explicit targeting an *opt-in, per-message*
action via slash commands (skill-like `/cost …`) typed in the composer; remove the always-on picker
row so the chat feels like "just ask" while still allowing precise targeting when wanted.

## Non-goals (YAGNI)
- Sticky/pinned section across messages (per-message only — confirmed).
- Non-section slash commands (`/clear`, `/help`, …).
- Any change to `/api/chat`, `lib/route.ts`, `lib/classifier.ts`, or the routing logic.
- Removing the per-response gateway badge or the `resendWith` misroute-correction flow (both kept).

## Current state (verified)
- `web/components/chat/SectionPicker.tsx` — compass(auto, `pinned=null`) + 9 section buttons; rendered
  by `ChatDrawer.tsx:155` and `AssistantClient.tsx:99`.
- `web/components/chat/useChat.ts` — `pinned`/`setPinned` state (default `null`); `send(text,
  overrideSection?, switchedFrom?)` posts `section: overrideSection ?? pinned` to `/api/chat`
  (null ⇒ auto). `resendWith(sectionKey)` re-sends the last user msg to a different section.
- `web/components/chat/Composer.tsx` — plain input + send button (no slash awareness).
- `web/components/chat/PresetChips.tsx` — shows `sec.presets` when `pinned`, else `AUTO_PRESETS`.
- `web/lib/sections.ts` — `SECTIONS` (keys: `network, container, data, security, cost, monitoring,
  iac, ops, observability`; active: network/data/security/cost/monitoring; inactive: the other 4),
  `sectionByKey`, `AUTO_PRESETS`.
- Backend already accepts `section: null` ⇒ auto; an inactive section ⇒ guidance bubble (ADR-038 §5).

## Behavior model
- **Default (no slash):** message routes via auto (unchanged). The bare `/` is the only new trigger.
- **Explicit (per-message):** a message whose **first token** is `/<sectionKey>` (followed by a space
  or end-of-string) routes that one message to `<sectionKey>`; the token is stripped from the prompt.
  The next message with no slash returns to auto.
- `/auto` (and any leading `/token` that matches no section) ⇒ auto routing; an unmatched `/token` is
  passed through as **literal text** (not an error) so a user typing a real slash isn't blocked.
- A leading `/<sectionKey>` with **no message body** does not send — it sets the pending target chip
  and waits for the user to type the message.
- Inactive sections are selectable (the backend returns the existing guidance bubble).

## Components (small, isolated)
1. **`web/lib/slash.ts`** (pure, unit-tested) — the single source of parsing truth.
   - `SLASH_COMMANDS: { key, label, icon, active }[]` derived from `SECTIONS` + an `auto` entry.
   - `parseSlash(text): { section: string | null; prompt: string }` — matches a leading
     `/<key>(\s+|$)`; on match returns `{ section: key==='auto' ? null : key, prompt: rest }`;
     otherwise `{ section: null, prompt: text }`. Only the leading token; mid-text `/` is literal.
   - `matchCommands(fragment): SlashCommand[]` — prefix-filter for the menu (fragment after `/`).
2. **`web/components/chat/SlashMenu.tsx`** (new, small) — popover list above the composer shown while
   the input is a slash query. Props: `{ query, onSelect, onClose }`. Renders matching commands
   (icon + `/key` + label); inactive ones dimmed with a "준비중" hint. Keyboard: ↑/↓ move, Enter/Tab
   select, Esc close; mouse click selects. ARIA `listbox`/`option`, `aria-activedescendant`; AA contrast.
3. **`web/components/chat/Composer.tsx`** (edit) — owns the menu + chip:
   - When the trimmed input starts with `/` and has no space yet → show `SlashMenu` with the fragment.
   - Selecting a command sets a `target: SlashCommand | null` state, renders a **chip** (icon + label,
     with an ✕ to clear) at the left of the input, and clears the `/frag` text from the field.
   - On send: if a `target` chip is set → `send(text, target.key === 'auto' ? null : target.key)` and
     clear the chip; else `const { section, prompt } = parseSlash(text); send(prompt, section ?? undefined)`.
     (Covers both the menu-selection path and a user who types the full `/cost …` and hits Enter.)
   - Empty body + only a chip/`/key` ⇒ no send.
   - Placeholder hint: `메시지를 입력하세요…  ( / 로 특정 영역 지정 )`.
4. **`useChat.ts`** (edit) — remove `pinned`/`setPinned` (no sticky state). `send`'s `overrideSection`
   param is unchanged and now carries the per-message slash target. `resendWith` unchanged.
5. **Removals** — drop `SectionPicker` import+render from `ChatDrawer.tsx` and `AssistantClient.tsx`;
   delete `SectionPicker.tsx` and its (none separate) test. `PresetChips` now always renders
   `AUTO_PRESETS` (drop the `pinned` prop; keep the component).

## Data flow
Composer (parse `/` or chip) → `chat.send(prompt, sectionOrNull)` → existing `useChat` POST
`/api/chat { section }` → existing classifier/route. **No server changes.** Response stream still
carries the `gateway/method/ranked` meta → `MessageList` badge unchanged.

## Error handling
- Unmatched leading `/token` → treated as literal text (no error, no block).
- Body-less slash → no-op send (chip persists, awaiting text).
- Backend errors / inactive-section guidance → unchanged existing handling.

## Testing
- **`web/lib/slash.test.ts`** — `parseSlash`: `/cost foo`→`{cost,'foo'}`; `/network`→`{network,''}`;
  `/auto x`→`{null,'x'}`; `/bogus x`→`{null,'/bogus x'}` (literal); `hello`→`{null,'hello'}`;
  mid-text `a /cost`→`{null,'a /cost'}`. `matchCommands('co')`→ contains `container`,`cost`.
- **`web/components/chat/Composer.test.tsx`** (jsdom) — typing `/` shows the menu; filtering narrows
  it; selecting `cost` shows a chip and clears the field; Enter calls `onSend` with the `cost` target
  (assert via a spy); a plain message sends with no target; `/data foo`+Enter sends `foo`→`data`.
- Existing chat tests (`MessageList`, `ThreadList`, `route`) must stay green; remove any assertion
  that depended on `SectionPicker`/`pinned` (search first).

## Rollout
Web-only change. `make deploy` (web). No migration, no worker, no terraform.
