'use client';
import { useEffect } from 'react';
import Sidebar from './Sidebar';
import { cn } from '@/lib/cn';

/**
 * MobileNav — slide-in left drawer that hosts the desktop Sidebar on <lg.
 * Backdrop click / Esc / tapping any nav link (via Sidebar's `onNavigate`)
 * all close it. Body scroll is locked while open. Never renders on desktop
 * (`lg:hidden`); the desktop sidebar is rendered directly by AppShell.
 */
export default function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Esc to close.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock body scroll while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div
      className={cn('fixed inset-0 z-40 lg:hidden', open ? '' : 'pointer-events-none')}
      aria-hidden={!open}
    >
      {/* Dim backdrop — click closes. */}
      <div
        className={cn(
          'absolute inset-0 bg-ink-900/40 transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0',
        )}
        onClick={onClose}
        role="presentation"
      />
      {/* Sliding panel reusing the desktop Sidebar. */}
      <div
        className={cn(
          'absolute inset-y-0 left-0 w-64 max-w-[85%] bg-chrome-muted shadow-pop transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        role="dialog"
        aria-modal="true"
      >
        {/* persist=false: the always-mounted desktop Sidebar owns the shared
            localStorage key; this drawer instance reads but never writes it. */}
        <Sidebar onNavigate={onClose} persist={false} className="w-full max-w-none border-r-0" />
      </div>
    </div>
  );
}
