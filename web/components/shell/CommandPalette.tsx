'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { INVENTORY_TYPES, inventoryGroups, overviewGroups } from '@/lib/inventory-types';
import Input from '@/components/ui/Input';
import { useI18n } from '@/components/shell/LanguageProvider';
import { cn } from '@/lib/cn';
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
    { href: '/integrations', label: 'Integrations', hint: '데이터소스 · 커넥터 · 스킬' },
    { href: '/security', label: 'Security', hint: '보안 점검' },
    { href: '/compliance', label: 'Compliance', hint: 'CIS 벤치마크' },
  ];
  // Group overview destinations (non-singleton groups). Unique labels so they don't
  // collide with the fixed feature links' React keys (`key={c.label}`).
  const overviews: Cmd[] = overviewGroups().map((g) => ({ href: g.href!, label: `${g.group} — overview`, hint: 'Group overview' }));
  const inv: Cmd[] = inventoryGroups().flatMap((g) =>
    g.types.map((t) => ({ href: `/inventory/${t}`, label: INVENTORY_TYPES[t].label, hint: g.group })),
  );
  const themes: Cmd[] = THEMES.map((t) => ({ label: `Theme: ${THEME_LABELS[t]}`, hint: '테마', theme: t }));
  return [...fixed, ...overviews, ...inv, ...themes];
}

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const commands = useMemo(buildCommands, []);
  const { t } = useI18n();

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q) || (c.href?.toLowerCase().includes(q) ?? false),
    );
  }, [commands, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActive(0);
  }, []);

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

  // Global ⌘K / Ctrl-K toggle.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reset highlight when the filter changes.
  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = results[active];
      if (sel) go(sel);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-ink-900/30 px-4 pt-[18vh]"
      onMouseDown={close}
      role="presentation"
    >
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-lg border border-ink-100 bg-card shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onListKey}
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.aria')}
      >
        <div className="border-b border-ink-100 p-2.5">
          <Input
            autoFocus
            icon={<Search size={16} strokeWidth={1.7} />}
            placeholder={t('palette.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <ul className="max-h-[320px] overflow-y-auto py-1">
          {results.length === 0 ? (
            <li className="px-4 py-6 text-center text-[13px] text-ink-400">{t('palette.noResults')}</li>
          ) : (
            results.map((c, i) => (
              <li key={c.label}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(c)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-[13px] transition-colors',
                    i === active ? 'bg-brand-500 text-white' : 'text-ink-800 hover:bg-ink-50',
                  )}
                >
                  <span className="font-medium">{c.label}</span>
                  <span className={cn('text-[11px]', i === active ? 'text-white/80' : 'text-ink-400')}>{c.hint}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
