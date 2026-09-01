'use client';
import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import AppShell from '@/components/shell/AppShell';
import CommandPalette from '@/components/shell/CommandPalette';
import ChatDrawer from '@/components/chat/ChatDrawer';

/**
 * ShellGate — mounts the app chrome (sidebar + Cmd-K palette + chat drawer) on every
 * route EXCEPT the bare routes: `/login` (the sign-in screen owns the viewport) and
 * `/ai-diagnosis/report` (the L179 print view — the shell would print its chrome AND clip
 * the body inside AppShell's h-screen overflow container, breaking per-section page breaks).
 */
const BARE_ROUTES = new Set(['/login', '/ai-diagnosis/report']);

export default function ShellGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (BARE_ROUTES.has(pathname)) return <>{children}</>;
  return (
    <>
      <AppShell>{children}</AppShell>
      <CommandPalette />
      <ChatDrawer />
    </>
  );
}
