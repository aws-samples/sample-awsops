// Cytoscape stylesheet for the site canvas, built from a palette of CSS design tokens.
// Edge evidence is never conveyed by colour alone: observed = solid, configured = dotted, evidence `inferred` =
// dashed (muted), traced = solid + calls label. The `inferred` HIGHLIGHT overlay (page→API name inference) is a
// separate class: dashed + its own colour, ordered after the evidence/highlight rules so it always wins. A merged
// highlighted edge that also carries inferred members (`partial-inferred`) is a dashed highlight (highlight colour,
// shorter dashes than the inferred overlay), so the inferred part never reads as a solid observed hop.
import type { StylesheetStyle } from 'cytoscape';
import type { SiteGroup, SiteKind } from './site-flow';
import { LABEL_PX } from './site-flow-elements';

export interface SitePalette {
  fg: string; muted: string; surface: string; groupBg: string; border: string; edge: string;
  highlight: string; inferred: string; error: string;
  kinds: Record<SiteKind, string>; groups: Record<SiteGroup['kind'], string>;
}

/** [token, fallback]. Only concrete-hex tokens: getComputedStyle does not resolve var() aliases in custom props. */
const BASE: Record<Exclude<keyof SitePalette, 'kinds' | 'groups'>, [string, string]> = {
  fg: ['--ink-800', '#16202A'], muted: ['--ink-500', '#5A6873'], surface: ['--paper', '#F4F6F8'],
  groupBg: ['--ink-50', '#F4F6F8'], border: ['--ink-300', '#AFBAC3'], edge: ['--ink-400', '#7D8A96'],
  highlight: ['--brand-500', '#01A88D'], inferred: ['--warning', '#F59E0B'], error: ['--negative', '#D13212'],
};
const KINDS: Record<SiteKind, [string, string]> = {
  dns: ['--sec-network', '#2F6F8F'], cdn: ['--sec-data', '#7C5CBF'], behavior: ['--sec-data', '#7C5CBF'],
  origin: ['--sec-iac', '#8E4830'], lb: ['--sec-monitoring', '#2563EB'], rule: ['--sec-security', '#BE123C'],
  tg: ['--sec-monitoring', '#2563EB'], target: ['--ink-400', '#7D8A96'], workload: ['--sec-container', '#1F7A48'],
  service: ['--sec-observability', '#0E7490'], datastore: ['--sec-cost', '#8A5A12'],
};
const GROUPS: Record<SiteGroup['kind'], [string, string]> = {
  host: ['--sec-network', '#2F6F8F'], cdn: ['--sec-data', '#7C5CBF'], lb: ['--sec-monitoring', '#2563EB'],
  cluster: ['--sec-container', '#1F7A48'], namespace: ['--sec-container', '#1F7A48'], datastore: ['--sec-cost', '#8A5A12'],
};
const SHAPES: Record<SiteKind, string> = {
  dns: 'round-diamond', cdn: 'round-hexagon', behavior: 'round-tag', origin: 'round-rectangle', lb: 'round-octagon',
  rule: 'round-triangle', tg: 'round-rectangle', target: 'ellipse', workload: 'round-rectangle', service: 'ellipse',
  datastore: 'barrel',
};

const mapValues = <K extends string>(rec: Record<K, [string, string]>, read: (t: string) => string) =>
  Object.fromEntries((Object.entries(rec) as [K, [string, string]][]).map(([k, [t, fb]]) => [k, read(t) || fb])) as Record<K, string>;

/** Read the palette through `getVar` (e.g. getComputedStyle(document.documentElement).getPropertyValue). */
export function readSitePalette(getVar: (token: string) => string): SitePalette {
  const read = (t: string) => String(getVar(t) ?? '').trim();
  return { ...mapValues(BASE, read), kinds: mapValues(KINDS, read), groups: mapValues(GROUPS, read) };
}

export function buildSiteStyle(p: SitePalette): StylesheetStyle[] {
  const label = { 'font-size': LABEL_PX, color: p.fg, 'text-wrap': 'ellipsis', 'text-max-width': '160px' } as const;
  const s = (selector: string, style: Record<string, unknown>): StylesheetStyle => ({ selector, style } as StylesheetStyle);
  return [
    s('node', {
      ...label, label: 'data(label)', 'text-valign': 'bottom', 'text-margin-y': 4, width: 30, height: 30,
      'background-color': p.edge, 'background-opacity': 0.25, 'border-width': 2, 'border-color': p.edge,
      'text-background-color': p.surface, 'text-background-opacity': 0.8, 'text-background-padding': '2px',
    }),
    ...(Object.keys(SHAPES) as SiteKind[]).map((k) =>
      s(`node.kind-${k}`, { shape: SHAPES[k], 'background-color': p.kinds[k], 'border-color': p.kinds[k] })),
    s('node.expanded', {
      shape: 'round-rectangle', 'background-color': p.groupBg, 'background-opacity': 0.6, 'border-width': 1,
      'border-color': p.border, 'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -4,
      'font-weight': 600, color: p.muted, padding: '14px', 'text-events': 'yes',
    }),
    s('node.collapsed', {
      shape: 'round-rectangle', width: 46, height: 46, 'border-width': 2, 'border-style': 'double',
      'background-opacity': 0.3, 'font-weight': 600,
    }),
    ...(Object.keys(GROUPS) as SiteGroup['kind'][]).map((k) =>
      s(`node.collapsed.gkind-${k}`, { 'background-color': p.groups[k], 'border-color': p.groups[k] })),
    s('edge', {
      width: 1.5, 'curve-style': 'bezier', 'line-color': p.edge, 'target-arrow-shape': 'triangle',
      'target-arrow-color': p.edge, 'arrow-scale': 0.8,
    }),
    s('edge.ev-observed', { 'line-style': 'solid' }),
    s('edge.ev-configured', { 'line-style': 'dotted' }),
    s('edge.ev-inferred', { 'line-style': 'dashed', 'line-dash-pattern': [6, 4], 'line-color': p.muted, 'target-arrow-color': p.muted }),
    s('edge.ev-traced', {
      'line-style': 'solid', width: 2, ...label, label: 'data(label)', 'text-rotation': 'autorotate',
      'text-background-color': p.surface, 'text-background-opacity': 0.85, 'text-background-padding': '2px',
    }),
    s('edge.has-errors', { color: p.error }),
    s('node.hl', { 'border-color': p.highlight, 'border-width': 3 }),
    s('edge.hl', { 'line-color': p.highlight, 'target-arrow-color': p.highlight, width: 2.5 }),
    s('edge.hl.partial-inferred', {
      'line-style': 'dashed', 'line-dash-pattern': [4, 3], 'line-color': p.highlight, 'target-arrow-color': p.highlight,
    }),
    s('node.inferred', { 'border-color': p.inferred, 'border-style': 'dashed', 'border-width': 3 }),
    s('edge.inferred', {
      'line-style': 'dashed', 'line-dash-pattern': [8, 4], 'line-color': p.inferred,
      'target-arrow-color': p.inferred, width: 2.5,
    }),
    s('.faded', { opacity: 0.15 }),
    // Compound opacity multiplies into children; fade an expanded group's own paint instead.
    s('node.expanded.faded', { opacity: 1, 'background-opacity': 0.15, 'border-opacity': 0.25, 'text-opacity': 0.3 }),
    s('node:selected', { 'overlay-opacity': 0.12, 'overlay-color': p.highlight }),
  ];
}
