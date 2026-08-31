'use client';
import { useState, useEffect, useRef } from 'react';
import { ArrowUp, X } from 'lucide-react';
import { parseSlash, matchCommands, SLASH_COMMANDS, type SlashCommand } from '@/lib/slash';
import { useI18n } from '@/components/shell/LanguageProvider';
import SlashMenu from './SlashMenu';

const MENU_ID = 'slash-menu';

// Auto-routing is the default — just type. A leading `/<section>` (skill-like) targets ONE message;
// the `/` autocomplete menu makes the sections discoverable. Picking a command pins a per-message
// chip; the next message with no slash returns to auto.
export default function Composer({
  disabled, onSend, seed,
}: {
  disabled: boolean;
  onSend: (text: string, section?: string | null) => void;
  // external seed (e.g. "ask AI about this resource" from the topology) — fills the field for
  // the user to review/edit before sending. `n` bumps to re-seed the same text.
  seed?: { text: string; n: number };
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [target, setTarget] = useState<SlashCommand | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (seed?.text) { setTarget(null); setText(seed.text); inputRef.current?.focus(); }
  }, [seed?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-grow the textarea with its content, capped at ~5 lines (then it scrolls).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  // Menu shows while the field is a bare leading-slash fragment (no space yet) and no chip is set.
  const menuOpen = !target && /^\/[a-z-]*$/.test(text);
  const commands = menuOpen ? matchCommands(text.slice(1)) : [];
  const activeIdx = commands.length ? Math.min(active, commands.length - 1) : 0;

  function pick(c: SlashCommand) {
    setTarget(c);
    setText('');
    setActive(0);
  }

  function submit() {
    if (disabled) return;
    if (target) {
      const body = text.trim();
      if (!body) return; // chip set but no body yet → wait (R4)
      onSend(body, target.key === 'auto' ? null : target.key);
      setText(''); setTarget(null);
      return;
    }
    const { section, prompt } = parseSlash(text);
    if (section && !prompt.trim()) {
      // a bare "/network " typed directly (menu already closed by the space) → set the chip, wait
      const cmd = SLASH_COMMANDS.find((c) => c.key === section);
      if (cmd) { setTarget(cmd); setText(''); return; }
    }
    if (!prompt.trim()) return;
    onSend(prompt, section);
    setText('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen && commands.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (Math.min(i, commands.length - 1) + 1) % commands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (Math.min(i, commands.length - 1) - 1 + commands.length) % commands.length); return; }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pick(commands[activeIdx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setText(''); return; }
    }
    // Enter sends; Shift+Enter falls through to the textarea's default (inserts a newline).
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  }

  return (
    <div className="relative border-t border-ink-100 px-3 py-3">
      <div className="flex items-end gap-2">
        {target && (
          <span className="flex shrink-0 items-center gap-1 rounded-md border border-brand-300 bg-brand-50 px-2 py-1 text-[12px] font-medium text-brand-700">
            <span>{target.icon}</span>{target.label}
            <button
              type="button"
              aria-label={t('chat.untarget')}
              onClick={() => setTarget(null)}
              className="ml-0.5 text-brand-500 hover:text-brand-700"
            >
              <X size={13} strokeWidth={2.5} />
            </button>
          </span>
        )}
        <textarea
          ref={inputRef}
          value={text}
          rows={1}
          onChange={(e) => { setText(e.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          placeholder={target ? t('chat.targetPlaceholder', { target: target.label }) : t('chat.placeholder')}
          disabled={disabled}
          role="combobox"
          aria-expanded={menuOpen}
          aria-controls={MENU_ID}
          aria-autocomplete="list"
          aria-activedescendant={menuOpen && commands.length ? `${MENU_ID}-opt-${activeIdx}` : undefined}
          className="max-h-[140px] min-h-9 flex-1 resize-none overflow-y-auto rounded-lg border border-ink-200 bg-card px-3 py-2 text-[13px] leading-snug text-ink-800 placeholder:text-ink-400 outline-none transition-shadow focus:border-brand-300 focus:shadow-focus disabled:opacity-60"
        />
        <button
          onClick={submit}
          disabled={disabled}
          aria-label={t('chat.send')}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500 text-white transition-colors hover:bg-brand-600 disabled:opacity-40"
        >
          <ArrowUp size={17} strokeWidth={2.4} />
        </button>
      </div>
      {menuOpen && (
        <SlashMenu id={MENU_ID} commands={commands} activeIndex={activeIdx} onSelect={pick} onHover={setActive} />
      )}
    </div>
  );
}
