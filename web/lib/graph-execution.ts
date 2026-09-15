import { graphDiagnostic } from './graph-state';

export interface GraphExecutionTotals {
  nodes: number; edges: number;
}

/** Only the current builders' node/edge totals are supported; no publication status is inferred. */
function projectOutcome(value: unknown): GraphExecutionTotals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid graph outcome');
  const raw = value as Record<string, unknown>;
  const count = (key: string): number => {
    const value = raw[key];
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid graph count');
    return value as number;
  };
  return { nodes: count('nodes'), edges: count('edges') };
}

/** The caller must respect layer dependencies; this helper reports execution, not completeness. */
export async function executeGraphLayer(
  stage: string, action: () => Promise<unknown>, report: (line: string, failed?: boolean) => void,
): Promise<{ failed: boolean; totals?: GraphExecutionTotals }> {
  const safeStage: string = JSON.parse(graphDiagnostic(stage, null)).stage;
  try {
    const totals = projectOutcome(await action());
    report(`[graph-rebuild] ${safeStage}: ${JSON.stringify(totals)}`);
    return { totals, failed: false };
  } catch (error) {
    report(`[graph-rebuild] failed ${graphDiagnostic(safeStage, error)}`, true);
    return { failed: true };
  }
}
