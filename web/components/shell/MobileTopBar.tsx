'use client';
import { usePathname } from 'next/navigation';
import { Menu, Search } from 'lucide-react';
import AwsopsMark from '@/components/ui/AwsopsMark';
import { INVENTORY_TYPES } from '@/lib/inventory-types';
import { useI18n } from '@/components/shell/LanguageProvider';

// Route → i18n key for the page title (mirrors the desktop Sidebar's FIXED list).
// Inventory routes resolve via the registry; everything else falls back to "AWSops".
const ROUTE_TKEY: Record<string, string> = {
  '/': 'nav.overview',
  '/ai-diagnosis': 'nav.aiDiagnosis',
  '/assistant': 'nav.assistant',
  '/jobs': 'nav.jobs',
  '/cost': 'nav.cost',
  '/bedrock': 'nav.bedrock',
  '/topology': 'nav.topology',
  '/security': 'nav.security',
  '/compliance': 'nav.compliance',
  '/customization': 'nav.customAgents',
  '/eks': 'nav.eks',
};

// Routes whose label is a literal (no i18n key in lib/i18n.ts).
// (OpenCost moved per-cluster onto the EKS detail page — no longer a standalone route.)
const ROUTE_LITERAL: Record<string, string> = {};

/**
 * Open the global Cmd-K palette by replaying the exact keydown CommandPalette
 * listens for (metaKey + 'k' on window) — no palette duplication, no lifted state.
 */
function openCommandPalette() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
}

export default function MobileTopBar({ onMenu }: { onMenu: () => void }) {
  const path = usePathname();
  const { t } = useI18n();

  let title = 'AWSops';
  const invMatch = path.match(/^\/inventory\/([^/]+)/);
  if (invMatch && INVENTORY_TYPES[invMatch[1]]) {
    title = INVENTORY_TYPES[invMatch[1]].label;
  } else {
    // Longest-prefix match so e.g. /eks/<cluster> resolves to the EKS label.
    const match = (r: string) => (r === '/' ? path === '/' : path === r || path.startsWith(`${r}/`));
    const tkey = Object.keys(ROUTE_TKEY).filter(match).sort((a, b) => b.length - a.length)[0];
    const litKey = Object.keys(ROUTE_LITERAL).filter(match).sort((a, b) => b.length - a.length)[0];
    if (tkey) title = t(ROUTE_TKEY[tkey]);
    else if (litKey) title = ROUTE_LITERAL[litKey];
  }

  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-chrome-border bg-chrome px-3 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] lg:hidden">
      <button
        type="button"
        onClick={onMenu}
        aria-label={t('nav.more')}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-chrome-fg-muted transition-colors hover:bg-chrome-active/40 hover:text-chrome-fg"
      >
        <Menu size={20} strokeWidth={1.8} />
      </button>
      <AwsopsMark size={26} />
      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-chrome-fg">{title}</span>
      <button
        type="button"
        onClick={openCommandPalette}
        aria-label={t('palette.aria')}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-chrome-fg-muted transition-colors hover:bg-chrome-active/40 hover:text-chrome-fg"
      >
        <Search size={20} strokeWidth={1.8} />
      </button>
    </header>
  );
}
