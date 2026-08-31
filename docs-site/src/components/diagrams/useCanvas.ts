import { useRef, useEffect, useCallback } from 'react';

export interface CanvasSize {
  width: number;
  height: number;
}

export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  frame: number;
  mouse: { x: number; y: number };
  dpr: number;
}

type DrawFn = (dc: DrawContext) => void;

/**
 * Common Canvas hook for interactive diagrams.
 * Handles: responsive resize, HiDPI scaling, animation loop, mouse tracking, SSR guard.
 */
export function useCanvas(draw: DrawFn, height = 500) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: -1, y: -1 });
  const frameRef = useRef(0);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    mouseRef.current = {
      x: (e.clientX - rect.left) * dpr,
      y: (e.clientY - rect.top) * dpr,
    };
  }, []);

  const handleMouseLeave = useCallback(() => {
    mouseRef.current = { x: -1, y: -1 };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    // Reassigning canvas.width/height clears the bitmap even when the value
    // is unchanged, so skip when the size didn't actually change — otherwise
    // every ResizeObserver firing (mount, sidebar toggle, orientation change)
    // wipes the canvas with nothing scheduled to redraw it under
    // reduced-motion (no rAF loop running).
    function resize() {
      const parent = canvas.parentElement;
      if (!parent) return false;
      const w = parent.clientWidth;
      const h = height;
      const targetW = w * dpr;
      const targetH = h * dpr;
      if (canvas.width === targetW && canvas.height === targetH) return false;
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      return true;
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function drawFrame() {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      draw({
        ctx,
        width: w,
        height: h,
        frame: frameRef.current++,
        mouse: mouseRef.current,
        dpr,
      });
    }

    resize();

    const ro = new ResizeObserver(() => {
      if (resize() && reduceMotion) drawFrame();
    });
    ro.observe(canvas.parentElement!);

    let animId: number;
    function animate() {
      drawFrame();
      if (!reduceMotion) {
        animId = requestAnimationFrame(animate);
      }
    }
    // Reduced motion: draw exactly one static frame instead of a permanent rAF loop.
    animId = requestAnimationFrame(animate);

    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', handleMouseLeave);

    // With no rAF loop running under reduced-motion, hover state would
    // otherwise never repaint — redraw once per pointer event instead.
    function redrawOnPointerActivity() {
      if (reduceMotion) drawFrame();
    }
    canvas.addEventListener('mousemove', redrawOnPointerActivity);
    canvas.addEventListener('mouseleave', redrawOnPointerActivity);

    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      canvas.removeEventListener('mousemove', redrawOnPointerActivity);
      canvas.removeEventListener('mouseleave', redrawOnPointerActivity);
    };
  }, [draw, height, handleMouseMove, handleMouseLeave]);

  return canvasRef;
}

/** AWSops theme colors */
export const THEME = {
  bg: '#0a0e1a',
  card: '#0f1629',
  border: '#1a2540',
  cyan: '#00d4ff',
  green: '#00ff88',
  purple: '#a855f7',
  orange: '#f59e0b',
  red: '#ef4444',
  text: '#e2e8f0',
  muted: '#64748b',
  dim: '#334155',
};

/** Draw a rounded rect */
export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Check if mouse is inside a rect */
export function isHover(
  mx: number, my: number,
  x: number, y: number, w: number, h: number,
): boolean {
  return mx >= x && mx <= x + w && my >= y && my <= y + h;
}

/** Wrapper style matching Screenshot component */
export const canvasWrapperStyle: React.CSSProperties = {
  borderRadius: 8,
  overflow: 'hidden',
  boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
  marginBottom: '1.5rem',
  position: 'relative',
};
