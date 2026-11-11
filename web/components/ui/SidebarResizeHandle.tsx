'use client';
import type { SidebarPanel } from './useSidebarPanel';

export default function SidebarResizeHandle({ panel, controls, label, hint }: {
  panel: SidebarPanel; controls: string; label: string; hint: string;
}) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={panel.minWidth}
      aria-valuemax={panel.maxWidth}
      aria-valuenow={panel.width}
      tabIndex={0}
      title={hint}
      {...panel.resizeProps}
      onDoubleClick={panel.resetWidth}
      className="group absolute inset-y-0 -right-1 z-10 hidden w-2 touch-none cursor-col-resize select-none justify-center outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:flex"
    >
      <span className="w-0.5 bg-transparent transition-colors group-hover:bg-brand-400 group-focus-visible:bg-brand-500" />
    </div>
  );
}
