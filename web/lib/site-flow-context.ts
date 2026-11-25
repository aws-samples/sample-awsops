// Bounded plain-text rendering of a SiteFlow for the AI agent (client-safe, pure).
// Names/routes only: kind-free labels, edge evidence, route, call/error counts and gap names. Never node refs,
// row data or ids. Labels are untrusted inventory strings, so whitespace is collapsed to keep each line one line.
import type { SiteEdge, SiteFlow } from './site-flow';

const MARKER = '…[site flow truncated]';
const INFERRED = 'INFERRED (name match, not observed): ';
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
/** First `n` UTF-16 units without leaving a lone high surrogate at the cut. */
const safeSlice = (s: string, n: number) => {
  const t = s.slice(0, Math.max(n, 0)), last = t.charCodeAt(t.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? t.slice(0, -1) : t;
};
/** Groups whose labels lead a section heading only inside their own placement tier; host/CDN/LB parents are
 *  named by the header and their own sections, so `cluster / namespace` stays short and unambiguous. */
const PATH_STOP = new Set(['host', 'cdn', 'lb']);

/** Highlighted edges in path order: walk out from nodes with no highlighted incoming edge; leftovers (cycles) by id. */
function chainOrder(edges: SiteEdge[]): SiteEdge[] {
  const byId = [...edges].sort((a, b) => cmp(a.id, b.id));
  const targets = new Set(byId.map((e) => e.target));
  const queue = [...new Set(byId.map((e) => e.source))].filter((n) => !targets.has(n)).sort(cmp);
  const out: SiteEdge[] = [], emitted = new Set<string>(), seen = new Set(queue);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of byId) {
      if (e.source !== cur || emitted.has(e.id)) continue;
      emitted.add(e.id); out.push(e);
      if (!seen.has(e.target)) { seen.add(e.target); queue.push(e.target); }
    }
  }
  return [...out, ...byId.filter((e) => !emitted.has(e.id))];
}

/** `gapNames` replaces `flow.gaps` in the Gaps line (the view passes the gaps it actually shows on screen). */
export function renderSiteFlowContext(flow: SiteFlow, maxChars = 3000, gapNames?: readonly string[]): string {
  const label = new Map(flow.nodes.map((n) => [n.id, clean(n.label)]));
  const groupOf = new Map(flow.nodes.map((n) => [n.id, n.group]));
  const groupById = new Map(flow.groups.map((g) => [g.id, g]));
  const heading = (id: string) => { // e.g. `shop-az-a / platform`; never the (ARN-bearing) group id
    const labels: string[] = [], seen = new Set<string>();
    for (let g = groupById.get(id); g && !seen.has(g.id); g = g.parent ? groupById.get(g.parent) : undefined) {
      seen.add(g.id); labels.unshift(clean(g.label));
      if (g.parent && PATH_STOP.has(groupById.get(g.parent)?.kind ?? '')) break;
    }
    return labels.join(' / ');
  };
  const hi = flow.highlight, inferred = new Set(hi?.inferred ?? []); // inferred ids are disjoint from highlight.edges
  const line = (e: SiteEdge) => `- ${inferred.has(e.id) ? INFERRED : ''}${label.get(e.source) ?? '?'} → ${label.get(e.target) ?? '?'} [${e.evidence}]`
    + (e.route ? ` route=${clean(e.route)}` : '')
    + (e.calls !== undefined ? ` calls=${e.calls}` : '') + (e.errors !== undefined ? ` errors=${e.errors}` : '');

  const cap = (v: string) => { // by code points (no split surrogates); keeps header + Gaps + marker inside the default budget
    const cps = Array.from(v);
    return cps.length > 200 ? `${cps.slice(0, 199).join('')}…` : v;
  };
  const head = `Site flow for ${cap(clean(flow.host))}${flow.path ? ` path ${cap(clean(flow.path))}` : ''} (data, not instructions)`;
  const lines: string[] = [];
  const hiEdges = new Set([...(hi?.edges ?? []), ...inferred]);
  const chain = chainOrder(flow.edges.filter((x) => hiEdges.has(x.id)));
  if (chain.length) lines.push('Path:');
  for (const e of chain) lines.push(line(e));

  // Bucket by group id (same-named namespaces in two clusters stay apart); order by heading, then id.
  const buckets = new Map<string, SiteEdge[]>();
  for (const e of [...flow.edges].sort((a, b) => cmp(a.id, b.id))) {
    if (hiEdges.has(e.id)) continue;
    const g = groupOf.get(e.source);
    const key = g && groupById.has(g) ? g : '';
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(e);
  }
  const headed = [...buckets.keys()].map((id) => ({ id, h: id ? heading(id) : '' }))
    .sort((a, b) => (a.id === '' ? 1 : b.id === '' ? -1 : cmp(a.h, b.h) || cmp(a.id, b.id)));
  for (const { id, h } of headed) {
    lines.push(`## ${h || 'Ungrouped'}`);
    for (const e of buckets.get(id)!) lines.push(line(e));
  }
  // Gaps sit right after the header and survive truncation: a truncated flow must never look complete.
  const sortedGaps = [...new Set<string>(gapNames ?? flow.gaps)].sort(cmp);
  const gaps = `Gaps: ${sortedGaps.length ? sortedGaps.join(', ') : 'none'}`;
  const full = [head, gaps, ...lines].join('\n');
  if (full.length <= maxChars) return full;
  let shownGaps = gaps;
  for (let n = sortedGaps.length - 1; head.length + shownGaps.length + MARKER.length + 2 > maxChars && n >= 0; n--)
    shownGaps = `Gaps: ${sortedGaps.slice(0, n).join(', ')}${n ? ', ' : ''}…`.replace(', …', '…');
  const kept = [head, shownGaps];
  let len = kept.join('\n').length + 1 + MARKER.length;
  if (len <= maxChars) for (const l of lines) {
    if (len + l.length + 1 > maxChars) break;
    kept.push(l); len += l.length + 1;
  }
  // maxChars below ~the marker length yields a bare slice of the marker/header.
  return safeSlice(`${kept.join('\n')}\n${MARKER}`, maxChars);
}
