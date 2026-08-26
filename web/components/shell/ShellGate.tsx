'use client';
import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import AppShell from '@/components/shell/AppShell';
import CommandPalette from '@/components/shell/CommandPalette';
import ChatDrawer from '@/components/chat/ChatDrawer';

/**
 * ShellGate — mounts the app chrome (sidebar + Cmd-K palette + chat drawer) on every
 * route EXCEPT `/login`, which renders bare so the sign-in screen owns the full viewport.
 */
export default function ShellGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/login') return <>{children}</>;
  return (
    <>
      <AppShell>{children}</AppShell>
      <CommandPalette />
      <ChatDrawer />
    </>
  );
}
