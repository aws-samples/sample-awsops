'use client';

// Clustered force-directed canvas for one host's SiteFlow (Cytoscape + fcose, compound groups).
// Elements come from the pure `buildSiteElements` (collapse/re-point/highlight rules live there); this
// component only owns the Cytoscape lifecycle:
//  - cytoscape and cytoscape-fcose are imported dynamically on mount (SSR safe; fcose registered once); ONE
//    instance lives for the mount (the view remounts the canvas per host) and is built from the latest flow;
//  - a new flow with the same structure (node/edge/group ids, endpoints, parents) — a path/highlight change or an
//    error-label language switch — updates element data and classes in place inside cy.batch: no rebuild, no
//    re-layout, positions and expanded groups untouched;
//  - a structural change (evidence landing) rebuilds the elements on the SAME instance, carrying the expanded set
//    (groups new to this flow get their default) and every known position forward; new nodes are seeded at a known
//    ancestor or neighbour, and fcose re-runs with `randomize: false` (randomized only if nothing carries over);
//  - tap on a leaf → onSelect(node); tap on a collapsed group, or on an expanded group's label (above its body),
//    toggles it on the SAME instance and re-runs fcose with `randomize: false`, seeding revealed nodes at the toggled group's position;
//  - `theme` / `themeKey` changes only restyle (colours re-read from CSS tokens), never rebuild or re-layout.
//    `themeKey` is the raw app theme (teal/cobalt/dark): two light themes differ in brand tokens.
// The container is role="img" with a count summary; the view provides the accessible list fallback.
import { useEffect, useRef } from 'react';
import type { Core, ElementDefinition, LayoutOptions, Position } from 'cytoscape';
import type { SiteFlow, SiteNode } from '@/lib/site-flow';
import { buildSiteElements, initialExpanded, toggleGroup, zoomLimits } from '@/lib/site-flow-elements';
import { buildSiteStyle, readSitePalette } from '@/lib/site-flow-style';
import { useI18n } from '@/components/shell/LanguageProvider';

let fcoseRegistered = false;
/** Model-px below an expanded group's top edge still counted as its label band. */
const LABEL_BAND_TOLERANCE = 6;
/** Data keys cytoscape treats as immutable (never removed in an in-place update). */
const IMMUTABLE_KEYS = new Set(['id', 'source', 'target', 'parent']);

const LAYOUT = {
  name: 'fcose', quality: 'default', nodeDimensionsIncludeLabels: true, packComponents: true,
  animate: false, fit: true, padding: 32,
} as const;

/** Stylesheet from the live CSS tokens (call only in the browser). */
function tokenStyle() {
  const cs = getComputedStyle(document.documentElement);
  return buildSiteStyle(readSitePalette((t) => cs.getPropertyValue(t)));
}

/** Structure of a flow: what decides whether the canvas can be updated in place or must be rebuilt. */
export function siteStructure(flow: SiteFlow): string {
  return JSON.stringify([
    flow.nodes.map((n) => `${n.id}\u0000${n.group ?? ''}`).sort(),
    flow.edges.map((e) => `${e.id}\u0000${e.source}\u0000${e.target}`).sort(),
    flow.groups.map((g) => `${g.id}\u0000${g.parent ?? ''}\u0000${g.kind}`).sort(),
  ]);
}

/** Keep known positions; seed revealed nodes around `seedOf(el)` (compound parents derive theirs from children). */
function withPositions(els: ElementDefinition[], prev: Map<string, Position>,
  seedOf: (el: ElementDefinition) => Position | undefined): ElementDefinition[] {
  let i = 0;
  return els.map((el) => {
    if (el.group !== 'nodes' || el.data.role === 'group') return el;
    const known = prev.get(String(el.data.id));
    if (known) return { ...el, position: { ...known } };
    const seed = seedOf(el);
    if (!seed) return el;
    const k = i;
    i += 1;
    return { ...el, position: { x: seed.x + (k % 5) * 12, y: seed.y + Math.floor(k / 5) * 12 } };
  });
}

/** Seed for a node new in this flow: its nearest known ancestor group, else a known neighbour. */
function structuralSeed(flow: SiteFlow, els: ElementDefinition[], prev: Map<string, Position>) {
  const parentOf = new Map(flow.groups.map((g) => [g.id, g.parent]));
  const neighbours = new Map<string, string[]>();
  for (const el of els) {
    if (el.group !== 'edges') continue;
    const s = String(el.data.source), t = String(el.data.target);
    (neighbours.get(s) ?? neighbours.set(s, []).get(s)!).push(t);
    (neighbours.get(t) ?? neighbours.set(t, []).get(t)!).push(s);
  }
  return (el: ElementDefinition): Position | undefined => {
    const seen = new Set<string>();
    for (let g = el.data.parent as string | undefined; g && !seen.has(g); g = parentOf.get(g)) {
      seen.add(g);
      const pos = prev.get(g);
      if (pos) return pos;
    }
    for (const n of neighbours.get(String(el.data.id)) ?? []) {
      const pos = prev.get(n);
      if (pos) return pos;
    }
    return undefined;
  };
}

export default function SiteFlowCanvas({ flow, theme, themeKey, onSelect }: {
  flow: SiteFlow; theme: 'light' | 'dark'; themeKey?: string; onSelect?: (node: SiteNode) => void;
}) {
  const { tt } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  const errorsWord = tt('오류');
  // Latest inputs and canvas state, read by the long-lived instance (the flow can change before it exists).
  const flowRef = useRef(flow);
  const wordRef = useRef(errorsWord);
  const expandedRef = useRef<Set<string>>(initialExpanded(flow));
  const knownGroupsRef = useRef<Set<string>>(new Set(flow.groups.map((g) => g.id)));
  const structureRef = useRef<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let cancelled = false;
    let cy: Core | null = null;
    void (async () => {
      const [{ default: cytoscape }, { default: fcose }] = await Promise.all([import('cytoscape'), import('cytoscape-fcose')]);
      if (cancelled) return;
      if (!fcoseRegistered) { cytoscape.use(fcose); fcoseRegistered = true; }
      const elements = buildSiteElements(flowRef.current, expandedRef.current, { errors: wordRef.current });
      const z = zoomLimits(elements.length);
      cy = cytoscape({
        container, elements, style: tokenStyle(), minZoom: z.minZoom, maxZoom: z.maxZoom,
        boxSelectionEnabled: false, layout: { ...LAYOUT, randomize: true } as unknown as LayoutOptions,
      });
      cyRef.current = cy;
      structureRef.current = siteStructure(flowRef.current);
      // One core-level delegate: fires once per tap with the originating element (no compound bubbling).
      cy.on('tap', 'node', (evt) => {
        const id: string = evt.target.id();
        const role = evt.target.data('role');
        if (role === 'leaf') {
          const node = flowRef.current.nodes.find((n) => n.id === id);
          if (node) onSelectRef.current?.(node);
          return;
        }
        // An expanded group collapses only from its label (drawn above the body); a tap on the body's blank
        // space is ignored, since host/cdn/lb compounds cover most of the canvas.
        if (role === 'group') {
          const body = evt.target.boundingBox({ includeLabels: false, includeOverlays: false });
          if (evt.position.y > body.y1 + LABEL_BAND_TOLERANCE) return;
        }
        if (!cy) return;
        expandedRef.current = toggleGroup(expandedRef.current, id);
        rebuild(cy, (prev) => () => prev.get(id));
      });
    })();

    return () => {
      cancelled = true;
      cy?.destroy();
      cy = null;
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    flowRef.current = flow;
    wordRef.current = errorsWord;
    const structure = siteStructure(flow);
    const structural = structure !== structureRef.current;
    if (structural) {
      // Groups already known keep their expanded state; groups new to this flow get their default.
      const defaults = initialExpanded(flow);
      const next = new Set<string>();
      for (const g of flow.groups) {
        if (knownGroupsRef.current.has(g.id) ? expandedRef.current.has(g.id) : defaults.has(g.id)) next.add(g.id);
      }
      expandedRef.current = next;
      knownGroupsRef.current = new Set(flow.groups.map((g) => g.id));
    }
    const cy = cyRef.current;
    if (!cy) return; // the pending mount builds from the refs
    if (structural) {
      structureRef.current = structure;
      rebuild(cy, (prev, els) => structuralSeed(flow, els, prev));
      return;
    }
    // Same structure: highlight / label changes only, in place.
    const elements = buildSiteElements(flow, expandedRef.current, { errors: errorsWord });
    cy.batch(() => {
      for (const el of elements) {
        const ele = cy.getElementById(String(el.data.id));
        if (!ele.nonempty()) continue;
        const current = ele.data() as Record<string, unknown>;
        for (const k of Object.keys(current)) if (!(k in el.data) && !IMMUTABLE_KEYS.has(k)) ele.removeData(k);
        ele.data(el.data);
        ele.classes(el.classes ?? '');
      }
    });
  }, [flow, errorsWord]);

  /** Rebuild the elements on the same instance, keeping known positions, and re-run fcose. */
  function rebuild(cy: Core, seeds: (prev: Map<string, Position>, els: ElementDefinition[]) => (el: ElementDefinition) => Position | undefined) {
    const prev = new Map<string, Position>();
    cy.nodes().forEach((n) => { prev.set(n.id(), { ...n.position() }); });
    const built = buildSiteElements(flowRef.current, expandedRef.current, { errors: wordRef.current });
    const elements = withPositions(built, prev, seeds(prev, built));
    const carried = elements.some((el) => el.group === 'nodes' && !!el.position);
    const z = zoomLimits(elements.length);
    cy.batch(() => { cy.elements().remove(); cy.add(elements); });
    cy.minZoom(z.minZoom);
    cy.maxZoom(z.maxZoom);
    cy.layout({ ...LAYOUT, randomize: !carried } as unknown as LayoutOptions).run();
  }

  useEffect(() => {
    // Theme switch: the data-theme attribute is already applied, so the tokens read the new values.
    cyRef.current?.style(tokenStyle());
  }, [theme, themeKey]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={`${tt('사이트 흐름 그래프')} · ${tt('노드')} ${flow.nodes.length} · ${tt('엣지')} ${flow.edges.length}`}
      className="h-[560px] w-full rounded-lg border border-ink-100 bg-card"
    />
  );
}
