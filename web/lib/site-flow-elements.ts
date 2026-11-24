// Pure SiteFlow → Cytoscape element builder for the clustered site canvas (no React, DOM or i18n).
// - Compound parents come from `flow.groups` (`parent`); unknown group/parent ids yield no parent, never a dangling one.
// - A group is either EXPANDED (rendered as a compound parent) or COLLAPSED (one node labelled `<label> (+N)`,
//   N = every leaf below it, recursively). A hidden element is represented by its OUTERMOST collapsed ancestor.
// - Edges are re-pointed to those representatives; edges that end up inside one collapsed node are dropped,
//   duplicates (directed source→target) merge keeping the strongest evidence (EVIDENCE_RANK) and summed traced
//   calls/errors, and keep their member edge ids for highlight roll-up.
// - Highlight: `hl` when any member is in highlight.nodes/edges; else `inferred` when any member is in
//   highlight.inferred (a separate overlay, the element keeps its own `ev-*` evidence class); else `faded`.
import type { ElementDefinition } from 'cytoscape';
import { EVIDENCE_RANK, type SiteEvidence, type SiteFlow, type SiteGroup } from './site-flow';

/** Group kinds that start collapsed; host/cdn/lb start expanded. */
export const COLLAPSED_KINDS: ReadonlySet<SiteGroup['kind']> = new Set(['cluster', 'namespace', 'datastore']);
/** Canvas label font size (px); zoom limits are derived from it. */
export const LABEL_PX = 12;
/** Visible element count up to which the canvas guarantees ≥ 10px labels at its minimum zoom. */
export const LEGIBLE_MAX_ELEMENTS = 60;

export type SiteElementRole = 'leaf' | 'group' | 'collapsed';

export function initialExpanded(flow: SiteFlow): Set<string> {
  return new Set(flow.groups.filter((g) => !COLLAPSED_KINDS.has(g.kind)).map((g) => g.id));
}

export function toggleGroup(expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function zoomLimits(visibleElements: number): { minZoom: number; maxZoom: number } {
  return { minZoom: visibleElements <= LEGIBLE_MAX_ELEMENTS ? 10 / LABEL_PX : 0.4, maxZoom: 2.5 };
}

type Status = '' | 'hl' | 'inferred' | 'faded';

export function buildSiteElements(
  flow: SiteFlow, expanded: ReadonlySet<string>, opts: { errors?: string } = {},
): ElementDefinition[] {
  const groupById = new Map(flow.groups.map((g) => [g.id, g]));
  /** Known group chain from `gid` outward (innermost first); cycle-safe. */
  const chain = (gid: string | undefined): string[] => {
    const out: string[] = [];
    for (let g = gid; g && groupById.has(g) && !out.includes(g); g = groupById.get(g)!.parent) out.push(g);
    return out;
  };
  const outermostCollapsed = (ch: string[]): string | undefined => {
    for (let i = ch.length - 1; i >= 0; i -= 1) if (!expanded.has(ch[i])) return ch[i];
    return undefined;
  };

  const hl = flow.highlight;
  const hlSet = new Set(hl ? [...hl.nodes, ...hl.edges] : []);
  const infSet = new Set(hl?.inferred ?? []);
  const status = (members: Iterable<string>): Status => {
    if (!hl) return '';
    let inferred = false;
    for (const m of members) {
      if (hlSet.has(m)) return 'hl';
      if (infSet.has(m)) inferred = true;
    }
    return inferred ? 'inferred' : 'faded';
  };
  const classes = (...xs: string[]) => xs.filter(Boolean).join(' ');

  // Leaves per group (recursive) and each leaf's representative.
  const leavesOf = new Map<string, string[]>();
  const rep = new Map<string, string>();
  const elements: ElementDefinition[] = [];
  for (const n of flow.nodes) {
    const ch = chain(n.group);
    for (const g of ch) (leavesOf.get(g) ?? leavesOf.set(g, []).get(g)!).push(n.id);
    const hiddenBy = outermostCollapsed(ch);
    rep.set(n.id, hiddenBy ?? n.id);
    if (hiddenBy) continue;
    elements.push({
      group: 'nodes',
      data: { id: n.id, label: n.label, kind: n.kind, role: 'leaf' satisfies SiteElementRole, ...(ch[0] ? { parent: ch[0] } : {}) },
      classes: classes('leaf', `kind-${n.kind}`, status([n.id])),
    });
  }

  const groupEls: ElementDefinition[] = [];
  const depth = (g: SiteGroup) => chain(g.parent).length;
  for (const g of [...flow.groups].sort((a, b) => depth(a) - depth(b))) {
    const up = chain(g.parent);
    if (outermostCollapsed(up)) continue; // hidden inside a collapsed ancestor
    const leaves = leavesOf.get(g.id) ?? [];
    const parent = up[0] ? { parent: up[0] } : {};
    if (expanded.has(g.id)) {
      const s = status(leaves);
      groupEls.push({
        group: 'nodes',
        data: { id: g.id, label: g.label, groupKind: g.kind, role: 'group' satisfies SiteElementRole, ...parent },
        classes: classes('group', 'expanded', `gkind-${g.kind}`, s === 'faded' ? 'faded' : ''),
      });
    } else {
      groupEls.push({
        group: 'nodes',
        data: {
          id: g.id, label: `${g.label} (+${leaves.length})`, groupKind: g.kind, count: leaves.length,
          role: 'collapsed' satisfies SiteElementRole, ...parent,
        },
        classes: classes('group', 'collapsed', `gkind-${g.kind}`, status(leaves)),
      });
    }
  }

  interface Merged { source: string; target: string; evidence: SiteEvidence; members: string[]; calls?: number; errors?: number; id: string }
  const merged = new Map<string, Merged>();
  for (const e of flow.edges) {
    const source = rep.get(e.source);
    const target = rep.get(e.target);
    if (!source || !target) continue; // unknown endpoint: never draw a dangling edge
    if (source === target && source !== e.source) continue; // internal to one collapsed group
    const key = `${source}\u0000${target}`;
    const m = merged.get(key);
    if (!m) {
      const untouched = source === e.source && target === e.target;
      merged.set(key, {
        id: untouched ? e.id : `agg:${source}->${target}`, source, target, evidence: e.evidence, members: [e.id],
        ...(e.calls !== undefined ? { calls: e.calls } : {}), ...(e.errors !== undefined ? { errors: e.errors } : {}),
      });
      continue;
    }
    if (m.members.length === 1) m.id = `agg:${source}->${target}`;
    m.members.push(e.id);
    if (EVIDENCE_RANK[e.evidence] > EVIDENCE_RANK[m.evidence]) m.evidence = e.evidence;
    if (e.calls !== undefined) m.calls = (m.calls ?? 0) + e.calls;
    if (e.errors !== undefined) m.errors = (m.errors ?? 0) + e.errors;
  }

  const errWord = opts.errors ?? 'errors';
  const edgeEls: ElementDefinition[] = [...merged.values()].map((m) => {
    const errors = m.errors ?? 0;
    const label = m.evidence === 'traced' && m.calls !== undefined
      ? (errors > 0 ? `${m.calls} · ${errWord} ${errors}` : String(m.calls))
      : undefined;
    return {
      group: 'edges',
      data: {
        id: m.id, source: m.source, target: m.target, evidence: m.evidence, members: m.members,
        ...(m.calls !== undefined ? { calls: m.calls } : {}), ...(m.errors !== undefined ? { errors: m.errors } : {}),
        ...(label !== undefined ? { label } : {}),
      },
      classes: classes(`ev-${m.evidence}`, m.evidence === 'traced' && errors > 0 ? 'has-errors' : '', status(m.members)),
    };
  });

  // Parents before children keeps cytoscape's add() order-independent of compound depth.
  return [...groupEls, ...elements, ...edgeEls];
}
