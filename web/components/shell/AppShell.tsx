'use client';
import { useState, type ReactNode } from 'react';
import Sidebar from './Sidebar';
import MobileTopBar from './MobileTopBar';
import BottomTabBar from './BottomTabBar';
import MobileNav from './MobileNav';

/**
 * AppShell — responsive layout at a single `lg` (1024px) breakpoint.
 *
 * Desktop (≥lg): fixed 256px Sidebar (`hidden lg:flex`) + fluid scrolling main.
 * Mobile (<lg): sticky MobileTopBar above a scrolling main, a fixed BottomTabBar
 * below, and a slide-in MobileNav drawer (hamburger / More). Show/hide is pure
 * CSS (`lg:hidden` / `hidden lg:flex`); only the drawer open/close is client
 * state, so there is never a double sidebar at any width.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="flex h-screen flex-col lg:flex-row">
      {/* Desktop sidebar — hidden below lg. */}
      <Sidebar className="hidden lg:flex" />

      {/* Mobile top bar — hidden at lg+. */}
      <MobileTopBar onMenu={() => setNavOpen(true)} />

      <main className="flex-1 overflow-y-auto animate-fade-in pb-[calc(4rem+env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] lg:pb-0">{children}</main>

      {/* Mobile bottom tabs + drawer — hidden at lg+. */}
      <BottomTabBar onMore={() => setNavOpen(true)} />
      <MobileNav open={navOpen} onClose={() => setNavOpen(false)} />
    </div>
  );
}
