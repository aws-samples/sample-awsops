import { graphDiagnostic } from './graph-state';
import type { GraphRebuildResult } from './graph-store';

export type GraphExecutionTotals = GraphRebuildResult;
const reasons = new Set(['publication_busy', 'superseded', 'rebuild_busy', 'state_schema_missing',
  'account_limit', 'time_limit', 'skip_record_busy', 'skip_record_failed', 'snapshot_limit',
  'graph_limit', 'account_failed', 'collection_ok', 'collection_empty', 'collection_partial',
  'collection_unavailable', 'collection_error']);

/** Project the current publisher contract; node totals alone do not establish publication. */
function projectOutcome(value: unknown, stage: string): GraphExecutionTotals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid graph outcome');
  const raw = value as Record<string, unknown>;
  const count = (key: string): number => {
    const value = raw[key];
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid graph count');
    return value as number;
  };
  if (!Array.isArray(raw.reasons) || raw.reasons.length > reasons.size
    || raw.reasons.some(reason => typeof reason !== 'string' || !reasons.has(reason)))
    throw new Error('Invalid graph reasons');
  if (raw.accountsTruncated !== undefined && typeof raw.accountsTruncated !== 'boolean')
    throw new Error('Invalid graph account limit');
  const failed = raw.failed === undefined ? 0 : count('failed');
  return { nodes: count('nodes'), edges: count('edges'), published: count('published'),
    retained: count('retained'), skipped: count('skipped'), degraded: count('degraded'),
    reasons: [...new Set(raw.reasons)],
    ...(raw.accountsTruncated !== undefined ? { accountsTruncated: raw.accountsTruncated } : {}),
    ...(failed ? { failed, failureCode: JSON.parse(graphDiagnostic(stage, { code: raw.failureCode })).code } : {}) };
}

/** The caller must respect layer dependencies; this helper reports execution, not completeness. */
export async function executeGraphLayer(
  stage: string, action: () => Promise<unknown>, report: (line: string, failed?: boolean) => void,
): Promise<{ failed: boolean; incomplete?: boolean; totals?: GraphExecutionTotals }> {
  const safeStage: string = JSON.parse(graphDiagnostic(stage, null)).stage;
  try {
    const totals = projectOutcome(await action(), safeStage);
    report(`[graph-rebuild] ${safeStage}: ${JSON.stringify(totals)}`);
    if (totals.failed) report(`[graph-rebuild] failed ${graphDiagnostic(safeStage, { code: totals.failureCode })}`, true);
    return { totals, failed: !!totals.failed, incomplete: !!(totals.retained || totals.skipped) };
  } catch (error) {
    report(`[graph-rebuild] failed ${graphDiagnostic(safeStage, error)}`, true);
    return { failed: true };
  }
}
