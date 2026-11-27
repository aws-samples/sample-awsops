'use client';
import { useEffect, useRef } from 'react';

/** Mobile overlays keep keyboard focus inside and restore the opener on close. */
export function useModalFocus<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const container = useRef<T>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const panel = container.current;
    if (!open || !panel) return;
    const desktop = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1024px)') : null;
    if (desktop?.matches) { close.current(); return; }
    const opener = document.activeElement;
    const targets = () => [...panel.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')]
      .filter(el => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0);
    const first = () => (targets()[0] ?? panel).focus();
    first();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const elements = targets(), head = elements[0], tail = elements.at(-1);
      if (!head || !panel.contains(document.activeElement)) { event.preventDefault(); first(); }
      else if (event.shiftKey && (document.activeElement === head || document.activeElement === panel)) {
        event.preventDefault(); tail?.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault(); head.focus();
      }
    };
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target)) first();
    };
    const resize = () => { if (desktop?.matches) close.current(); };
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', focusin);
    desktop?.addEventListener('change', resize);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', focusin);
      desktop?.removeEventListener('change', resize);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);
  return container;
}
