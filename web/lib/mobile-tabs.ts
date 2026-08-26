// Mobile bottom-tab model (5 tabs). Pure data + active matching — no React.
// The mobile chrome (BottomTabBar / MobileTopBar) consumes this; labels resolve
// via i18n `tkey` like the desktop Sidebar's FIXED list.
import {
  LayoutDashboard, DollarSign, Boxes, MessagesSquare, Menu,
  type LucideIcon,
} from 'lucide-react';
import { inventoryGroups } from '@/lib/inventory-types';

export interface MobileTab {
  tkey: string;
  icon: LucideIcon;
  href?: string;
  action?: 'drawer';
}

// Inventory tab points at the first registered inventory type (fall back to the
// index if the registry is somehow empty).
function firstInventoryHref(): string {
  const g = inventoryGroups();
  const first = g[0]?.types[0];
  return first ? `/inventory/${first}` : '/inventory';
}

export const MOBILE_TABS: MobileTab[] = [
  { tkey: 'nav.overview', icon: LayoutDashboard, href: '/' },
  { tkey: 'nav.cost', icon: DollarSign, href: '/cost' },
  { tkey: 'nav.inventory', icon: Boxes, href: firstInventoryHref() },
  { tkey: 'nav.assistant', icon: MessagesSquare, href: '/assistant' },
  { tkey: 'nav.more', icon: Menu, action: 'drawer' },
];

/**
 * Whether a tab should render as active for the given pathname.
 * - Overview: exact match on '/' only.
 * - Inventory: any '/inventory' or '/inventory/...' path.
 * - Other link tabs: exact href, or href + '/' prefix.
 * - The drawer tab is never active.
 */
export function isTabActive(pathname: string, tab: MobileTab): boolean {
  if (tab.action === 'drawer' || !tab.href) return false;
  if (tab.href === '/') return pathname === '/';
  if (tab.tkey === 'nav.inventory') return pathname.startsWith('/inventory');
  return pathname === tab.href || pathname.startsWith(`${tab.href}/`);
}
