'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MOBILE_TABS, isTabActive, type MobileTab } from '@/lib/mobile-tabs';
import { useI18n } from '@/components/shell/LanguageProvider';
import { cn } from '@/lib/cn';

/**
 * BottomTabBar — fixed 5-tab nav on <lg (lg:hidden). Link tabs use next/link;
 * the `action:'drawer'` More tab calls onMore. Active state via isTabActive on
 * the current pathname. Honors iOS safe-area inset at the bottom.
 */
export default function BottomTabBar({ onMore }: { onMore: () => void }) {
  const path = usePathname();
  const { t } = useI18n();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-chrome-border bg-chrome pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] lg:hidden">
      {MOBILE_TABS.map((tab) => {
        const active = isTabActive(path, tab);
        const Icon = tab.icon;
        const label = t(tab.tkey);
        const inner = (
          <span
            className={cn(
              'flex w-full flex-col items-center justify-center gap-0.5 px-1 py-2 text-[10px] font-medium transition-colors',
              active ? 'text-chrome-active-fg' : 'text-chrome-fg-muted',
            )}
          >
            <Icon size={20} strokeWidth={1.8} />
            <span className="truncate">{label}</span>
          </span>
        );

        if (tab.action === 'drawer' || !tab.href) {
          return (
            <button
              key={tab.tkey}
              type="button"
              onClick={onMore}
              aria-label={label}
              className="flex flex-1"
            >
              {inner}
            </button>
          );
        }
        return (
          <Link
            key={tab.tkey}
            href={tab.href}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            className="flex flex-1 no-underline"
          >
            {inner}
          </Link>
        );
      })}
    </nav>
  );
}

// Re-export for callers that want the tab shape alongside the component.
export type { MobileTab };
