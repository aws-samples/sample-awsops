// Slash-command section targeting for AI Assist. Auto-routing is the default; a leading `/<section>`
// (skill-like) targets ONE message to a section gateway. Pure + framework-free → unit-tested.
import { SECTIONS } from '@/lib/sections';

export interface SlashCommand {
  key: string;
  label: string;
  icon: string;
  active: boolean;
}

// `auto` first (explicit "let the classifier decide"), then one command per section.
export const SLASH_COMMANDS: SlashCommand[] = [
  { key: 'auto', label: '자동 라우팅', icon: '🧭', active: true },
  ...SECTIONS.map((s) => ({ key: s.key, label: s.label, icon: s.icon, active: s.active })),
];

const KEYS = new Set(SLASH_COMMANDS.map((c) => c.key));
// Leading `/<key>` only — NO left-trim (a leading space ⇒ literal text, not a command). The
// separator is exactly ONE whitespace char; everything after it is the body, kept verbatim so
// pasted indentation/newlines survive.
const RE = /^\/([a-z][a-z-]*)(?:\s([\s\S]*))?$/;

export function parseSlash(text: string): { section: string | null; prompt: string } {
  const m = RE.exec(text);
  if (m && KEYS.has(m[1])) {
    const key = m[1];
    const body = m[2] ?? '';
    return { section: key === 'auto' ? null : key, prompt: body };
  }
  return { section: null, prompt: text };
}

// Prefix filter for the `/` autocomplete menu (fragment = text after the leading slash).
export function matchCommands(fragment: string): SlashCommand[] {
  const f = fragment.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.key.startsWith(f));
}
