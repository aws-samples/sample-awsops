'use client';
import { useEffect, useRef, useState, useCallback } from 'react';

// Shared right-panel resize affordance — extracted from ChatDrawer's proven pattern
// (drag the left edge, persist on release, clamp to viewport). Default expectation
// after the chat redesign: every right-docked panel is user-resizable.

export interface ResizablePanel {
  width: number;
  /** Attach to a left-edge grip's onMouseDown. */
  startResize: (e: React.MouseEvent) => void;
}

export function useResizablePanel(storageKey: string, defaultWidth: number, minWidth = 380): ResizablePanel {
  const [width, setWidth] = useState(defaultWidth);
  const widthRef = useRef(defaultWidth);
  widthRef.current = width;

  // Restore a persisted width once on mount, clamped to the current viewport
  // (a width saved on a wider screen must not overflow a narrow one).
  useEffect(() => {
    try {
      const w = Number(localStorage.getItem(storageKey));
      if (w >= minWidth) setWidth(Math.min(w, Math.max(minWidth, window.innerWidth - 60)));
    } catch { /* storage unavailable — keep default */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(Math.max(window.innerWidth - ev.clientX, minWidth), Math.max(minWidth, window.innerWidth - 60));
      setWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      try { localStorage.setItem(storageKey, String(Math.round(widthRef.current))); } catch { /* best-effort */ }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.userSelect = 'none';
  }, [storageKey, minWidth]);

  return { width, startResize };
}

// Coordinator for every right-docked panel ↔ the globally-mounted chat (ChatDrawer).
// A panel publishes its live width to the root `--detail-panel-w` var while open so the
// chat FAB/drawer offset left and never overlap it; 0 when closed/unmounted returns the
// chat to the right edge. Single producer per page (panels are mutually exclusive), so
// last-mounted wins cleanly. Use this from ANY right-docked aside, resizable or fixed.
export function usePublishDockedWidth(open: boolean, width: number) {
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--detail-panel-w', open ? `${width}px` : '0px');
    return () => { root.style.setProperty('--detail-panel-w', '0px'); };
  }, [open, width]);
}

/** The grip element's shared classes (left-edge, col-resize cursor, hover accent). */
export const RESIZE_GRIP_CLASS = 'group absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize';
export const RESIZE_GRIP_BAR_CLASS = 'absolute left-0 top-0 h-full w-px bg-ink-100 transition-colors group-hover:w-0.5 group-hover:bg-claude-400';
