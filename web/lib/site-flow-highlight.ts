// Rule 6 of the site flow: the request-path highlight (client-safe, pure; split out of site-flow.ts).
// Walks the composed site graph for one normalized path: a CDN follows only the behavior the path selects, the
// walk stops at workloads, and route templates continue it over traced edges. Page→API inference is recorded only
// in `inferred` (never on edges). Uncertain hops stop the walk and add a gap instead of a confident highlight.
import type { FlowEdge, FlowNode, FlowRule } from './flow-topology';
import { matchBehavior, type CfBehavior } from './cf-behaviors';
import { globMatch } from './glob-match';
import { inferApiRoutes } from './route-template';
import type { SiteEdge, SiteFlow, SiteGap, SiteNode, SiteRoute } from './site-flow';

type Highlight = { nodes: Set<string>; edges: Set<string> };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Longest ALB pattern matched (ELBv2's own limit) and longest request path matched; longer is unknown. */
const MAX_GLOB = 128, MAX_PATH = 2048;
// ALB globs (`*` any run, `?` one char) via the linear matcher: paths case-sensitive, host headers case-insensitive.
// An over-long pattern is never matched as a glob: it counts as matching (a candidate) and the rule is undecidable.
const tooLong = (r: FlowRule) => [...r.paths, ...r.hosts].some((v) => v.length > MAX_GLOB);
const pathMatches = (r: FlowRule, path: string) => !r.paths.length
  || r.paths.some((p) => p.length > MAX_GLOB || globMatch(p, path));
const hostMatches = (r: FlowRule, host: string) => !r.hosts.length
  || r.hosts.some((h) => h.length > MAX_GLOB || globMatch(h.toLowerCase(), host.toLowerCase()));
const priorityOrder = (a: FlowRule['priority'], b: FlowRule['priority']) =>
  (a === b ? 0 : a === 'default' ? 1 : b === 'default' ? -1 : a - b);

/**
 * ALB listener rules → the TG nodes a request to host+path is forwarded to, or null when that cannot be decided
 * (no rule data on an ALB with several TGs, a TG edge without rules beside ones with rules, a deciding rule with
 * another condition or a redirect/fixed-response action, no forward rule matching, an unknown path, or an unknown
 * `host` (null) where a host-header rule whose path matches could decide). Ascending priority, first match wins,
 * `default` last; every TG edge carrying a matching rule at the deciding priority is followed (weighted forward).
 */
function albForwardTargets(allTgEdges: FlowEdge[], host: string | null, path: string | null): Set<string> | null {
  // Rule data is judged on ALL TG edges: a weight-0-only edge is rule data too, so a rule-less sibling is partial
  // data, never the lone-TG fallback (the LB may answer every request itself, e.g. a 503 forward to weight 0).
  const ruleData = allTgEdges.some((e) => e.rules?.length || e.receivesNothing);
  const tgEdges = allTgEdges.filter((e) => !e.receivesNothing); // weight-0-only TGs get nothing (not partial data)
  if (!tgEdges.length) return null;
  const withRules = tgEdges.filter((e) => e.rules?.length);
  if (!withRules.length) return !ruleData && tgEdges.length === 1 ? new Set([tgEdges[0].target]) : null;
  if (withRules.length !== tgEdges.length || path === null) return null;
  const all = withRules.flatMap((e) => e.rules!.map((rule) => ({ rule, target: e.target })));
  const priorities = [...new Set(all.map((x) => x.rule.priority))].sort(priorityOrder);
  for (const p of priorities) {
    const candidates = all.filter((x) => x.rule.priority === p && pathMatches(x.rule, path));
    if (host === null && candidates.some((x) => x.rule.hosts.length)) return null; // the Host the ALB sees is unknown
    const hits = candidates.filter((x) => host === null || hostMatches(x.rule, host));
    if (!hits.length) continue;
    return hits.some((x) => x.rule.other || tooLong(x.rule)) ? null : new Set(hits.map((x) => x.target));
  }
  return null;
}

/** A CloudFront behavior's origin: whether it still sees the site host, and its normalized OriginPath (null unknown). */
export interface BehaviorOrigin { hostKept: boolean; originPath: string | null }
/** What the request looks like on arrival at a node: Host header and path (null = unknown). */
interface Req { host: string | null; path: string | null }

/** Outgoing edges by source, each list in id order. */
export function adjacency<E extends { source: string; target: string; id: string }>(edges: Iterable<E>): Map<string, E[]> {
  const out = new Map<string, E[]>();
  for (const e of [...edges].sort((a, b) => cmp(a.id, b.id))) (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e);
  return out;
}

export interface HighlightInput {
  /** Normalized site host (ALB host-header rules match against it). */
  host: string;
  path: string; entries: string[];
  nodes: Map<string, SiteNode>; edges: Map<string, SiteEdge>;
  behaviorsOf: Map<string, { b: CfBehavior; id: string }[]>;
  /** Behavior id → its origin (null: the origin row is unreadable, so Host and path beyond it are unknown). */
  originOf: Map<string, BehaviorOrigin | null>;
  wlInfo: Map<string, { arn: string; namespace: string; name: string }>;
  /** The kept flow-topology nodes and edges (by id), for flow-level kinds, meta and listener rules. */
  flowNodes: Map<string, FlowNode>;
  flowEdges: Map<string, FlowEdge>;
  routes: SiteRoute[] | null;
  /** Gaps found while walking are added here. */
  gaps: Set<SiteGap>;
}

export function computeHighlight(input: HighlightInput): NonNullable<SiteFlow['highlight']> {
  const { host, path: rawPath, entries, nodes, edges, behaviorsOf, originOf, wlInfo, flowNodes: keepN, flowEdges, routes, gaps } = input;
  // An over-long request path is not matched at all: no behavior is selected and every later hop sees an unknown path.
  const path: string | null = rawPath.length > MAX_PATH ? null : rawPath;
  const out = adjacency(edges.values());
  const selected = new Map<string, string>();
  if (path !== null) for (const [cf, behs] of behaviorsOf) {
    const m = matchBehavior(behs.map((x) => x.b), path);
    const hit = m && behs.find((x) => x.b === m);
    if (hit) selected.set(cf, hit.id);
  }
  // Walk the infra chain: a CDN follows only its selected behavior (none → stop); an ALB follows only the TGs its
  // listener rules forward the request to (undecidable → stop + gap); stop at workloads. The request (Host, path) is
  // carried per hop: DNS and CDN→behavior keep it, a behavior's origin prepends its OriginPath and keeps the site
  // host only when the origin domain is that host, and any other hop (e.g. API Gateway → ALB) loses the Host.
  // Returns each reached gateway with the request it receives (a gateway reached by two requests appears twice).
  const walk = (starts: string[], into: Highlight, reqPath: string | null = path, gapSink: Set<SiteGap> = gaps): [string, Req][] => {
    const gateways = new Map<string, [string, Req]>(), seen = new Set<string>();
    const queue: [string, Req][] = starts.map((id) => [id, { host, path: reqPath }]);
    while (queue.length) {
      const [cur, req] = queue.shift()!;
      const key = JSON.stringify([cur, req.host, req.path]); // a node reached by two different requests is walked for each
      if (seen.has(key)) continue;
      seen.add(key); into.nodes.add(cur);
      const kind = nodes.get(cur)?.kind;
      if (kind === 'workload') { gateways.set(key, [cur, req]); continue; }
      let forward: Set<string> | null = null;
      if (keepN.get(cur)?.kind === 'alb') {
        const tgEdges = (out.get(cur) ?? []).filter((e) => nodes.get(e.target)?.kind === 'tg').map((e) => flowEdges.get(e.id))
          .filter((e): e is FlowEdge => !!e);
        if (tgEdges.length) {
          forward = albForwardTargets(tgEdges, req.host, req.path !== null && req.path.length > MAX_PATH ? null : req.path);
          if (!forward) { gapSink.add('rule_unresolved'); forward = new Set(); }
        }
      }
      let next: Req = kind === 'dns' || kind === 'cdn' ? req : { host: null, path: req.path };
      if (kind === 'behavior') {
        const o = originOf.get(cur);
        next = o ? { host: o.hostKept ? req.host : null, path: o.originPath === null || req.path === null ? null : o.originPath + req.path }
          : { host: null, path: null };
      }
      for (const e of out.get(cur) ?? []) {
        if (kind === 'cdn' && e.target !== selected.get(cur)) continue;
        if (forward && nodes.get(e.target)?.kind === 'tg' && !forward.has(e.target)) continue;
        const tk = nodes.get(e.target)?.kind;
        if (tk === 'service' || tk === 'datastore') continue;
        into.edges.add(e.id); queue.push([e.target, next]);
      }
    }
    return [...gateways].sort(([a], [b]) => cmp(a, b)).map(([, g]) => g);
  };
  // Follow route templates downstream over traced edges; the terminal service's datastores close the chain. The chain
  // closes onto datastores only at a service whose route row is present and has no `next`: a missing row (or a next
  // hop without a route) or a declared next hop with no traced edge stops there with `route_unavailable`.
  // `seen` holds (service, route) pairs: one service reached under two routes follows both; a true cycle repeats a pair.
  const follow = (id: string, route: string | undefined, into: Highlight, seen = new Set<string>()) => {
    const key = JSON.stringify([id, route ?? null]);
    if (seen.has(key)) return;
    seen.add(key); into.nodes.add(id);
    const name = wlInfo.get(id)?.name;
    const rows = route === undefined || name === undefined ? [] : (routes ?? []).filter((r) => r.service === name && r.route === route);
    if (!rows.length) { gaps.add('route_unavailable'); return; } // the route is not known to end here
    let terminal = true; // the route has no downstream hop; an unjoinable `next` is not terminal
    for (const r of rows) {
      for (const nx of r.next ?? []) {
        terminal = false;
        const hits = (out.get(id) ?? []).filter((e) => e.evidence === 'traced' && wlInfo.get(e.target)?.name === nx.service);
        if (hits.length > 1) gaps.add('route_ambiguous');
        if (!hits.length) gaps.add('route_unavailable'); // the declared next hop has no traced edge
        if (hits.length !== 1) continue; // unknown or ambiguous name join: stop here
        into.edges.add(hits[0].id); follow(hits[0].target, nx.route, into, seen);
      }
    }
    if (terminal) for (const e of out.get(id) ?? []) {
      if (nodes.get(e.target)?.kind === 'datastore') { into.edges.add(e.id); into.nodes.add(e.target); }
    }
  };
  // A gateway's own routes; a gateway without a workload name has none (never every service's routes).
  const candidates = (service: string | undefined) => (service === undefined ? [] : (routes ?? []).filter((r) => r.service === service))
    .map((r) => ({ service: r.service, route: r.route }));
  const allCandidates = () => (routes ?? []).map((r) => ({ service: r.service, route: r.route }));
  const hl: Highlight = { nodes: new Set(), edges: new Set() }, inf: Highlight = { nodes: new Set(), edges: new Set() };
  const gateways = walk(entries, hl);
  // A CDN reached on the path whose parsed behaviors select nothing (no default): the request has no known route.
  for (const cf of behaviorsOf.keys()) if (hl.nodes.has(cf) && !selected.has(cf)) gaps.add('path_unmatched');
  // Missing routes (`routes` null) give no candidates, so the gap is added only where a gateway or an API behavior
  // is actually reached — the same places a present-but-unmatched route list reports it.
  for (const [g, req] of gateways) {
    // The gateway routes the request it receives (an origin's OriginPath prepended); an unknown path cannot be routed.
    if (req.path === null) { gaps.add('route_unavailable'); continue; }
    const res = inferApiRoutes(req.path, '', candidates(wlInfo.get(g)?.name)); // exact match + specificity ranking
    if (res.ambiguous) gaps.add('route_ambiguous');
    else if (res.matches[0]) follow(g, res.matches[0].route, hl);
    else gaps.add('route_unavailable'); // no route of this gateway matches the path
  }
  const isS3 = (id: string) => keepN.get(id)?.meta?.service === 's3';
  const targetsOf = (beh: string) => (out.get(beh) ?? []).map((e) => e.target);
  if (path !== null) for (const [cf, sel] of [...selected].sort(([a], [b]) => cmp(a, b))) { // (none selected for an unknown path)
    const origins = targetsOf(sel);
    if (!hl.nodes.has(sel) || !origins.length || !origins.every(isS3)) continue; // page path on a static origin only
    // Every API-shaped behavior is tried: an earlier `/auth/*` or dangling `/old/*` must not shadow `/api/*`.
    const apis = behaviorsOf.get(cf)!.filter((x) => !x.b.isDefault && x.b.pathPattern.endsWith('/*')
      && targetsOf(x.id).length > 0 && !targetsOf(x.id).some(isS3));
    let linked = false;
    for (const api of apis) {
      const chain: Highlight = { nodes: new Set(), edges: new Set() }, chainGaps = new Set<SiteGap>();
      const apiPrefix = api.b.pathPattern.slice(0, -2);
      // The API call the page would make (rooted even for a pattern like `api/*`). The walk is speculative: its
      // gaps count only if this behavior links, so an unlinked guess never reports a rule for a request not made.
      const apiPath = `/${apiPrefix}`.replace(/^\/+/, '/').replace(/\/+$/, '') + path;
      // CloudFront must route that call through this behavior: with nested patterns (`/api/products/*` before
      // `/api/*`) the `/api/*` guess for `/products/x` is sent to the other behavior, so it is not this chain.
      if (matchBehavior(behaviorsOf.get(cf)!.map((x) => x.b), apiPath) !== api.b) continue;
      const reached = walk([api.id], chain, apiPath, chainGaps);
      const names = new Set(reached.map(([g]) => wlInfo.get(g)?.name)); // only the gateways behind this behavior
      // The gateways receive the API call with the origin's OriginPath in front: infer under that whole prefix. One
      // behavior has one origin, so every reached gateway gets the same path; an unknown one cannot be linked.
      const arrived = new Set(reached.map(([, r]) => r.path));
      const [received] = arrived;
      // An unknown received path cannot link this behavior; no gap here (speculative, like the walk) — the page gets
      // route_unavailable below when no API behavior links.
      if (arrived.size > 1 || received === null || (received !== undefined && !received.endsWith(path))) continue;
      const prefix = received === undefined ? apiPrefix : received.slice(0, received.length - path.length);
      const res = inferApiRoutes(path, prefix, allCandidates().filter((c) => names.has(c.service)));
      if (!res.matches.length) continue;
      linked = true;
      for (const g of chainGaps) gaps.add(g);
      inf.edges.add(`${cf}->${api.id}`);
      for (const id of chain.nodes) inf.nodes.add(id);
      for (const id of chain.edges) inf.edges.add(id);
      if (res.ambiguous) { gaps.add('route_ambiguous'); continue; } // highlight nothing beyond the gateway
      const m = res.matches[0];
      for (const [g] of reached) if (wlInfo.get(g)?.name === m.service) follow(g, m.route, inf);
    }
    if (apis.length && !linked) gaps.add('route_unavailable'); // the page cannot be linked to any API route
  }
  const observed = new Set([...hl.nodes, ...hl.edges]);
  return {
    nodes: [...hl.nodes].sort(cmp), edges: [...hl.edges].sort(cmp),
    inferred: [...inf.nodes, ...inf.edges].filter((id) => !observed.has(id)).sort(cmp),
  };
}
