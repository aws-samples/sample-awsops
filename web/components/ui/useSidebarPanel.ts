'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

const MIN_WIDTH = 192, DEFAULT_WIDTH = 256, MAX_WIDTH = 384;

/** Browser-local layout preferences shared by the assistant and diagnosis sidebars. */
export function useSidebarPanel(storagePrefix: string) {
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidthState] = useState(DEFAULT_WIDTH);
  const widthRef = useRef(DEFAULT_WIDTH);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);

  useEffect(() => {
    try {
      const savedWidth = Number(localStorage.getItem(`${storagePrefix}_width`));
      if (Number.isFinite(savedWidth) && savedWidth > 0) {
        const restored = Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, savedWidth)));
        widthRef.current = restored;
        setWidthState(restored);
      }
      setCollapsed(localStorage.getItem(`${storagePrefix}_collapsed`) === '1');
    } catch { /* Optional preferences must not prevent using the page. */ }
  }, [storagePrefix]);

  function setWidth(value: number, persist = false) {
    const next = Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value)));
    widthRef.current = next;
    setWidthState(next);
    if (persist) {
      try { localStorage.setItem(`${storagePrefix}_width`, String(next)); } catch {}
    }
  }

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(`${storagePrefix}_collapsed`, next ? '1' : '0'); } catch {}
  }

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, width: widthRef.current };
  }

  function moveResize(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (start?.pointerId === event.pointerId) setWidth(start.width + event.clientX - start.x);
  }

  function finishResize(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setWidth(widthRef.current, true);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const next = event.key === 'ArrowLeft' ? widthRef.current - 16
      : event.key === 'ArrowRight' ? widthRef.current + 16
      : event.key === 'Home' ? MIN_WIDTH
      : event.key === 'End' ? MAX_WIDTH : null;
    if (next === null) return;
    event.preventDefault();
    setWidth(next, true);
  }

  return {
    width, collapsed, toggle, minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH,
    resetWidth: () => setWidth(DEFAULT_WIDTH, true),
    resizeProps: {
      onPointerDown: startResize, onPointerMove: moveResize,
      onPointerUp: finishResize, onPointerCancel: finishResize,
      onLostPointerCapture: finishResize, onKeyDown: resizeWithKeyboard,
    },
  };
}

export type SidebarPanel = ReturnType<typeof useSidebarPanel>;
