// POST /api/datasources/query — execute a read-only query against a datasource INSTANCE.
// Authenticated (read-only exploration), NOT admin. Accepts an instance `id` (preferred — resolves the
// row + credential and passes an inline conn-config so the RIGHT instance is hit) or a `slug`
// (deprecated — the connector Lambda falls back to the kind-mirror = the default instance).
// SECURITY: TOOL holds ONLY read tools; the resolved endpoint is SSRF-guarded before invoke.
import { verifyUser } from '@/lib/auth';
import { invokeMcpLambdaTool, type ConnConfig } from '@/lib/mcp-lambda-invoke';
import { getDatasource, resolveConnConfig } from '@/lib/datasources';
import { isDatasourceKind } from '@/lib/integrations-category';
import { assertDatasourceEndpointAllowed } from '@/lib/ssrf-guard';
import { normalizeResult } from '@/lib/datasource-render';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import { TOOL, EFFECTIVE_TIMEOUT_CAP, EXECUTION_TIMEOUT_KINDS } from '@/lib/datasource-query-tools';

export const dynamic = 'force-dynamic';

const MAX_QUERY = 8_000;

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);

  let body: { id?: unknown; slug?: unknown; query?: unknown; range?: unknown };
  try { body = (await readJsonBounded(request)) as typeof body; }
  catch (e) {
    if (e instanceof BodyTooLargeError) return json({ error: 'request body too large' }, 413);
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'body must be an object' }, 400);

  // Resolve the kind + (for an instance id) the inline conn-config.
  let kind = '';
  let connConfig: ConnConfig | undefined;
  let dsTimeoutS: number | undefined; // gap L203: per-datasource upstream execution bound
  const id = Number(body.id);
  if (body.id !== undefined && (
    !['number', 'string'].includes(typeof body.id)
    || typeof body.id === 'string' && !/^[1-9]\d*$/.test(body.id)
    || !Number.isSafeInteger(id) || id <= 0
  )) return json({ error: 'invalid datasource instance id' }, 400);
  if (Number.isInteger(id) && id > 0) {
    const ds = await getDatasource(id);
    if (!ds || !isDatasourceKind(ds.kind)) return json({ error: 'unknown datasource instance' }, 400);
    kind = ds.kind;
    dsTimeoutS = ds.settings?.timeoutS; // defensive: older callers/mocks may lack the field
    connConfig = await resolveConnConfig(ds); // row endpoint (authoritative) + SM cred — works even for auth=none
  } else {
    kind = typeof body.slug === 'string' ? body.slug : '';
  }

  const spec = TOOL[kind];
  if (!spec) return json({ error: 'datasource is not queryable' }, 400);

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return json({ error: 'query required' }, 400);
  if (query.length > MAX_QUERY) return json({ error: 'query too large' }, 413);

  if (connConfig?.endpoint) {
    try { assertDatasourceEndpointAllowed(connConfig.endpoint); }
    catch (e) { return json({ error: (e as Error).message }, 400); }
  }

  const args: Record<string, unknown> = { [spec.arg]: query, ...(spec.extra ?? {}) };

  // Provider execution ceilings belong to the connector, on every invocation path.
  // Keep the argument as an additional ceiling for older deployed PromQL producers.
  if (kind === 'prometheus' || kind === 'mimir') args.timeout = `${Math.min(dsTimeoutS ?? 10, EFFECTIVE_TIMEOUT_CAP)}s`;

  // Search windows are independent of whether the provider exposes a separate range tool.
  let tool = spec.instant;
  const r = body.range;
  let queriedWindow: { start: string; end: string } | null = null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (r !== undefined && r !== false && r !== true && (!r || typeof r !== 'object' || Array.isArray(r))) {
    return json({ error: 'range must be false, true, or a window object' }, 400);
  }
  if (r && !spec.range && !spec.timeWindow) return json({ error: 'this datasource requires time filters in its query' }, 400);
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    const window = Number((r as { window?: unknown }).window);
    const step = Number((r as { step?: unknown }).step);
    // Upper bound widened to 30d (gap-audit L86, v1 parity) — the point-density cap below still
    // bounds RETURNED points; upstream evaluation is bounded by the forwarded prometheus/mimir
    // `timeout` param (range + instant) and, for Loki, by the tighter 7d window below (Loki accepts
    // no per-request timeout).
    // A 30d window at the UI's ~250-point autoStep is ~10368s steps.
    // Metric queries permit 30d; log/trace searches retain the narrower 7d bound.
    const maxWindow = ['loki', 'tempo', 'jaeger'].includes(kind) ? 604800 : 2592000;
    if (!Number.isInteger(window) || window < 60 || window > maxWindow) {
      return json({ error: `range.window must be an integer in [60, ${maxWindow}] seconds` }, 400);
    }
    if (!Number.isInteger(step) || step < 1 || step > 86400) {
      return json({ error: 'range.step must be an integer in [1, 86400] seconds' }, 400);
    }
    // window/step are bounded independently; also cap the resulting point count so a direct API caller
    // can't request a huge series (e.g. {window:86400, step:1} = 86400 points). The UI's autoStep keeps
    // this ~250; this bound guards the non-UI path from cost/DoS before the connector/upstream is hit.
    if (Math.ceil(window / step) > 5000) {
      return json({ error: 'range too dense: ceil(window / step) must be ≤ 5000 points' }, 400);
    }
    args.start = String(nowSec - window);
    args.end = String(nowSec);
    queriedWindow = { start: args.start as string, end: args.end as string };
    if (spec.range) {
      tool = spec.range;
      args.step = String(step);
    }
  } else if (r === true || spec.timeWindow) {
    if (spec.range) tool = spec.range;
    args.start = String(nowSec - 3600);
    args.end = String(nowSec);
    queriedWindow = { start: args.start as string, end: args.end as string };
  }

  try {
    const t0 = Date.now();
    const result = await invokeMcpLambdaTool({ kind, tool, args, connConfig });
    // Additive metadata for the Explore result bar (gap-audit L88) — existing consumers read only `result`.
    const timeoutMode = EXECUTION_TIMEOUT_KINDS.has(kind) ? 'execution' : 'transport';
    return json({ result: normalizeResult(kind, tool, result), metadata: {
      executionTimeMs: Date.now() - t0, tool, window: queriedWindow, scope: 'shared',
      // A slug-only legacy call has no row settings available to the BFF.
      ...(connConfig ? { timeoutMode, effectiveTimeoutS: Math.min(dsTimeoutS ?? (timeoutMode === 'execution' ? 10 : 12), EFFECTIVE_TIMEOUT_CAP) } : {}),
    } }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'query failed' }, 502);
  }
}
