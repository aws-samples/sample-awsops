import { graphDiagnostic } from './graph-state';

export interface GraphExecutionTotals {
  nodes: number; edges: number;
  published?: number; retained?: number; skipped?: number; degraded?: number; failed?: number;
  failureCode?: string; reasons?: string[]; accountsTruncated?: boolean; metadataOmitted?: boolean;
}
const REASONS = new Set(['account_failed', 'account_limit', 'graph_limit', 'publication_busy',
  'rebuild_busy', 'snapshot_limit', 'state_schema_missing', 'superseded', 'time_limit',
  'skip_record_busy', 'skip_record_failed', 'collection_error', 'collection_partial', 'collection_unavailable']);

/** Legacy node/edge totals remain valid; absent publication metadata is never invented. */
function projectOutcome(value: unknown, stage: string): GraphExecutionTotals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid graph outcome');
  const raw = value as Record<string, unknown>;
  const count = (key: string, required = false): number | undefined => {
    const value = raw[key];
    if (value === undefined && !required) return undefined;
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid graph count');
    return value as number;
  };
  const result: GraphExecutionTotals = { nodes: count('nodes', true)!, edges: count('edges', true)! };
  for (const key of ['published', 'retained', 'skipped', 'degraded', 'failed'] as const) {
    const value = count(key);
    if (value !== undefined) result[key] = value;
  }
  if (typeof raw.accountsTruncated === 'boolean') result.accountsTruncated = raw.accountsTruncated;
  if (raw.reasons !== undefined) {
    const reasons = Array.isArray(raw.reasons) ? raw.reasons : [];
    result.reasons = reasons.slice(0, 16).filter((reason): reason is string => typeof reason === 'string' && REASONS.has(reason));
    if (!Array.isArray(raw.reasons) || result.reasons.length !== reasons.length) result.metadataOmitted = true;
  }
  if (result.failed) result.failureCode = JSON.parse(graphDiagnostic(stage, { code: raw.failureCode })).code;
  return result;
}

/** One layer's failure cannot suppress the caller's next layer; all reports are bounded projections. */
export async function executeGraphLayer(
  stage: string, action: () => Promise<unknown>, report: (line: string, failed?: boolean) => void,
): Promise<{ failed: boolean; incomplete: boolean; totals?: GraphExecutionTotals }> {
  const safeStage: string = JSON.parse(graphDiagnostic(stage, null)).stage;
  try {
    const totals = projectOutcome(await action(), safeStage);
    report(`[graph-rebuild] ${safeStage}: ${JSON.stringify(totals)}`);
    if (totals.failed) report(`[graph-rebuild] failed ${graphDiagnostic(safeStage, { code: totals.failureCode })}`, true);
    return { totals, failed: !!totals.failed, incomplete: !!(totals.retained || totals.skipped) };
  } catch (error) {
    report(`[graph-rebuild] failed ${graphDiagnostic(safeStage, error)}`, true);
    return { failed: true, incomplete: false };
  }
}
