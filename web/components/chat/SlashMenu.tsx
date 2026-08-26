'use client';
import type { SlashCommand } from '@/lib/slash';

// Presentational only — Composer owns the query, active index, and all keyboard handling (so an
// Enter that picks a command can't also submit the message). We render the list + highlight.
export default function SlashMenu({
  id, commands, activeIndex, onSelect, onHover,
}: {
  id: string;
  commands: SlashCommand[];
  activeIndex: number;
  onSelect: (c: SlashCommand) => void;
  onHover: (i: number) => void;
}) {
  if (commands.length === 0) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="섹션 명령"
      className="absolute bottom-full left-3 right-3 mb-1 max-h-60 overflow-y-auto rounded-lg border border-ink-200 bg-card py-1 shadow-lg"
    >
      {commands.map((c, i) => (
        <li
          key={c.key}
          id={`${id}-opt-${i}`}
          role="option"
          aria-selected={i === activeIndex}
          // mousedown (not click) + preventDefault → selection fires before the input blurs
          onMouseDown={(e) => { e.preventDefault(); onSelect(c); }}
          onMouseEnter={() => onHover(i)}
          className={
            'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] ' +
            (i === activeIndex ? 'bg-brand-50 text-ink-800' : 'text-ink-700') +
            (c.active ? '' : ' opacity-40')
          }
        >
          <span className="w-4 text-center">{c.icon}</span>
          <span className="font-medium text-brand-600">/{c.key}</span>
          <span className="text-ink-500">{c.label}{c.active ? '' : ' · 준비중'}</span>
        </li>
      ))}
    </ul>
  );
}
