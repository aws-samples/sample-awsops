// Route templates (OpenTelemetry http.route values) and page -> API inference.
// Segment-based matching; deliberately separate from CloudFront pattern matching.

export interface RouteCandidate {
  service: string;
  route: string;
}

/** Matches returned (best first); ties at the best rank make the result ambiguous. */
const MAX_MATCHES = 3;

function segments(path: string): string[] {
  const noQuery = path.split(/[?#]/, 1)[0];
  return noQuery.split('/').filter((s) => s !== '');
}

function isParam(seg: string): boolean {
  return seg === '*' || (seg.startsWith('{') && seg.endsWith('}')) || (seg.startsWith(':') && seg.length > 1);
}

function matchSegments(tpl: string[], path: string[]): boolean {
  for (let i = 0; i < tpl.length; i++) {
    const seg = tpl[i];
    const last = i === tpl.length - 1;
    if (seg === '**' && last) return true;
    if (seg === '*' && last) return path.length > i; // trailing /* matches the rest (>= 1 segment)
    if (i >= path.length) return false;
    if (!isParam(seg) && seg !== path[i]) return false;
  }
  return tpl.length === path.length;
}

export function templateMatches(template: string, path: string): boolean {
  return matchSegments(segments(template), segments(path));
}

// Higher is better: literal segment count, with rest wildcards ranking below equal-literal templates.
function rank(route: string): number {
  const segs = segments(route);
  const literals = segs.filter((s) => s !== '**' && !isParam(s)).length;
  const last = segs[segs.length - 1];
  const hasRest = last === '**' || last === '*';
  return literals * 2 + (hasRest ? 0 : 1);
}

// Route minus the CloudFront API prefix, or null when the route is not behind the prefix
// (segment-based; an empty prefix qualifies every route).
function stripPrefix(route: string, prefixSegs: string[]): string | null {
  const segs = segments(route);
  if (segs.length < prefixSegs.length) return null;
  for (let i = 0; i < prefixSegs.length; i++) if (segs[i] !== prefixSegs[i]) return null;
  return '/' + segs.slice(prefixSegs.length).join('/');
}

/**
 * Infer which API routes a static page likely calls (name match, not observed).
 * Only routes behind the API behavior prefix are considered; a route outside it
 * is never inferred. Note: a mid-path `**` is treated as a literal segment (only
 * a trailing `**` / `*` is a rest wildcard).
 */
export function inferApiRoutes(
  pagePath: string,
  apiPrefix: string,
  candidates: RouteCandidate[],
): { matches: RouteCandidate[]; ambiguous: boolean } {
  const prefixSegs = segments(apiPrefix);
  const prefixed = '/' + [...prefixSegs, ...segments(pagePath)].join('/');
  const seen = new Set<string>();
  const hits: Array<{ c: RouteCandidate; r: number }> = [];
  for (const c of candidates) {
    const key = `${c.service}\u0000${c.route}`;
    if (seen.has(key)) continue;
    const stripped = stripPrefix(c.route, prefixSegs);
    if (stripped === null) continue;
    if (templateMatches(c.route, prefixed) || templateMatches(stripped, pagePath)) {
      seen.add(key);
      hits.push({ c, r: rank(c.route) });
    }
  }
  hits.sort((a, b) => b.r - a.r); // stable: ties keep input order
  const best = hits.length ? hits[0].r : 0;
  const bestCount = hits.filter((h) => h.r === best).length;
  return {
    matches: hits.slice(0, MAX_MATCHES).map((h) => h.c),
    ambiguous: bestCount > 1, // only a tie at the best rank is ambiguous; lower-ranked extras are just capped
  };
}
