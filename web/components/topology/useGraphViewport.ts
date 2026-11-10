'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactFlowInstance } from '@xyflow/react';

/** Refit async/resized canvases, retaining the mounted Flow instance. */
export default function useGraphViewport(nodes: readonly unknown[], edges: readonly unknown[], maxZoom = 1) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<ReactFlowInstance | null>(null);
  const frame = useRef(0);
  const [vertical, setVertical] = useState(false);
  const fit = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      void instance.current?.fitView({ padding: 0.16, minZoom: 0.05, maxZoom });
    });
  }, [maxZoom]);
  const onInit = useCallback((flow: ReactFlowInstance) => { instance.current = flow; fit(); }, [fit]);
  useEffect(() => {
    fit();
    return () => cancelAnimationFrame(frame.current);
  }, [nodes, edges, fit, vertical]);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const width = container.current?.clientWidth ?? 0;
      if (width > 0) setVertical(width < 640);
      fit();
    });
    if (container.current) observer.observe(container.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current); };
  }, [fit, nodes, edges]);
  return { container, onInit, vertical };
}
