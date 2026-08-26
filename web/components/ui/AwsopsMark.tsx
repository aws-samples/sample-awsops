import type { CSSProperties } from 'react';

/**
 * AWSops brand mark — a brand-tinted rounded-square tile (theme-reactive; radius 10/40)
 * with the neural-pulse graph (matches app/icon.svg favicon: same node layout,
 * colors inverted for the teal tile — white nodes/edges, haloed AI node).
 * Used in the sidebar lockup, login, KPI watermark, and AI avatar.
 */
export default function AwsopsMark({ size = 36, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={style}
    >
      {/* rounded-square brand tile — radius 10 on a 40 viewBox */}
      <rect width="40" height="40" rx="10" className="fill-brand-500" />
      {/* neural graph edges (ops infra links) */}
      <g stroke="#FFFFFF" strokeOpacity="0.55" strokeWidth="2.2" strokeLinecap="round">
        <line x1="11.5" y1="28.5" x2="20" y2="15" />
        <line x1="20" y1="15" x2="30" y2="25" />
        <line x1="11.5" y1="28.5" x2="30" y2="25" />
      </g>
      {/* infra nodes */}
      <circle cx="11.5" cy="28.5" r="4" fill="#FFFFFF" />
      <circle cx="30" cy="25" r="4" fill="#FFFFFF" />
      {/* the AI node — haloed pulse (favicon's orange pulse, inverted to white on orange) */}
      <circle cx="20" cy="15" r="6.75" fill="#FFFFFF" fillOpacity="0.28" />
      <circle cx="20" cy="15" r="4.5" fill="#FFFFFF" />
    </svg>
  );
}
