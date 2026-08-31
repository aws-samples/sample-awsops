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
type T = (key: string, params?: Record<string, string | number>) => string;

// All navigable destinations: fixed pages + the inventory types + theme actions.
function buildCommands(t: T): Cmd[] {
  const fixed: Cmd[] = [
    { href: '/', label: t('nav.overview'), hint: t('palette.dashboard') },
    { href: '/eks', label: t('nav.eks'), hint: t('palette.pods') },
    { href: '/jobs', label: t('nav.jobs'), hint: t('palette.asyncJobs') },
    { href: '/cost', label: t('nav.cost'), hint: 'Cost Explorer' },
    { href: '/bedrock', label: t('nav.bedrock'), hint: t('palette.tokenCost') },
    { href: '/integrations', label: t('nav.integrations'), hint: t('palette.integrationHint') },
    { href: '/security', label: t('nav.security'), hint: t('palette.securityReview') },
    { href: '/compliance', label: t('nav.compliance'), hint: t('palette.cisBenchmark') },
  ];
  // Group overview destinations (non-singleton groups). Unique labels so they don't
  // collide with the fixed feature links' React keys (`key={c.label}`).
  const overviews: Cmd[] = overviewGroups().map((g) => ({ href: g.href!, label: `${t(g.labelKey)} — ${t('palette.groupOverview')}`, hint: t('palette.groupOverview') }));
  const inv: Cmd[] = inventoryGroups().flatMap((g) =>
    g.types.map((type) => ({ href: `/inventory/${type}`, label: INVENTORY_TYPES[type].label, hint: g.group })),
  );
  const themes: Cmd[] = THEMES.map((theme) => ({ label: `${t('palette.theme')}: ${THEME_LABELS[theme]}`, hint: t('palette.theme'), theme }));
  return [...fixed, ...overviews, ...inv, ...themes];
}

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const { t } = useI18n();
  const commands = useMemo(() => buildCommands(t), [t]);

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
      className="fixed inset-0 z-[100] flex items-start justify-center bg-ink-900/30 pb-[env(safe-area-inset-bottom)] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[calc(18vh+env(safe-area-inset-top))]"
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
