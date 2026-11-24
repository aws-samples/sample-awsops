'use client';

// Clustered force-directed canvas for one host's SiteFlow (Cytoscape + fcose, compound groups).
// Elements come from the pure `buildSiteElements` (collapse/re-point/highlight rules live there); this
// component only owns the Cytoscape lifecycle:
//  - cytoscape and cytoscape-fcose are imported dynamically inside the effect (SSR safe; fcose registered once);
//  - the instance is created per `flow` (and per error-label language) and destroyed on change/unmount;
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

const LAYOUT = {
  name: 'fcose', quality: 'default', nodeDimensionsIncludeLabels: true, packComponents: true,
  animate: false, fit: true, padding: 32,
} as const;

/** Stylesheet from the live CSS tokens (call only in the browser). */
function tokenStyle() {
  const cs = getComputedStyle(document.documentElement);
  return buildSiteStyle(readSitePalette((t) => cs.getPropertyValue(t)));
}

/** Keep known positions; seed revealed nodes around `seed` (compound parents derive theirs from children). */
function withPositions(els: ElementDefinition[], prev: Map<string, Position>, seed: Position | undefined): ElementDefinition[] {
  let i = 0;
  return els.map((el) => {
    if (el.group !== 'nodes' || el.data.role === 'group') return el;
    const known = prev.get(String(el.data.id));
    if (known) return { ...el, position: { ...known } };
    if (!seed) return el;
    const k = i;
    i += 1;
    return { ...el, position: { x: seed.x + (k % 5) * 12, y: seed.y + Math.floor(k / 5) * 12 } };
  });
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let cancelled = false;
    let cy: Core | null = null;
    let expanded = initialExpanded(flow);
    const nodeById = new Map(flow.nodes.map((n) => [n.id, n]));
    const build = () => buildSiteElements(flow, expanded, { errors: errorsWord });

    const toggle = (id: string) => {
      if (!cy) return;
      const prev = new Map<string, Position>();
      cy.nodes().forEach((n) => { prev.set(n.id(), { ...n.position() }); });
      expanded = toggleGroup(expanded, id);
      const elements = withPositions(build(), prev, prev.get(id));
      const z = zoomLimits(elements.length);
      const core = cy;
      core.batch(() => { core.elements().remove(); core.add(elements); });
      core.minZoom(z.minZoom);
      core.maxZoom(z.maxZoom);
      core.layout({ ...LAYOUT, randomize: false } as unknown as LayoutOptions).run();
    };

    void (async () => {
      const [{ default: cytoscape }, { default: fcose }] = await Promise.all([import('cytoscape'), import('cytoscape-fcose')]);
      if (cancelled) return;
      if (!fcoseRegistered) { cytoscape.use(fcose); fcoseRegistered = true; }
      const elements = build();
      const z = zoomLimits(elements.length);
      cy = cytoscape({
        container, elements, style: tokenStyle(), minZoom: z.minZoom, maxZoom: z.maxZoom,
        boxSelectionEnabled: false, layout: { ...LAYOUT, randomize: true } as unknown as LayoutOptions,
      });
      cyRef.current = cy;
      // One core-level delegate: fires once per tap with the originating element (no compound bubbling).
      cy.on('tap', 'node', (evt) => {
        const id: string = evt.target.id();
        const role = evt.target.data('role');
        if (role === 'leaf') {
          const node = nodeById.get(id);
          if (node) onSelectRef.current?.(node);
          return;
        }
        // An expanded group collapses only from its label (drawn above the body); a tap on the body's blank
        // space is ignored, since host/cdn/lb compounds cover most of the canvas.
        if (role === 'group') {
          const body = evt.target.boundingBox({ includeLabels: false, includeOverlays: false });
          if (evt.position.y > body.y1 + LABEL_BAND_TOLERANCE) return;
        }
        toggle(id);
      });
    })();

    return () => {
      cancelled = true;
      cy?.destroy();
      cy = null;
      cyRef.current = null;
    };
  }, [flow, errorsWord]);

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
