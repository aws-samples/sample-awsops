// Pre-built datasource diagnostic signals (datasource_diag_signals) — the BFF read side (Explore
// quick-query buttons) + the enqueue helper that asks the worker to (re)build them. Read-only DB
// access; the actual query execution / build happens in the worker (thin-BFF).
import { getPool } from '@/lib/db';
import { enqueueJob } from '@/lib/jobs';

export interface DiagQuery { tool: string; queries: { label: string; expr: string }[] }
export interface ReadySignal { signalKey: string; title: string; query: DiagQuery; meta: Record<string, unknown> }
export interface UnavailableSignal { signalKey: string; title: string; missingMetrics: string[] }
export interface DiagSignals { ready: ReadySignal[]; unavailable: UnavailableSignal[] }

function asObj(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string' && v) { try { return JSON.parse(v); } catch { return {}; } }
  return {};
}
function asArr(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

/** Read this instance's pre-built signals, split into clickable (ready) and disabled (unavailable). */
export async function getDiagSignals(integrationId: number): Promise<DiagSignals> {
  const { rows } = await getPool().query(
    `SELECT signal_key, title, status, query, missing_metrics, meta
       FROM datasource_diag_signals
      WHERE account_id = 'self' AND integration_id = $1
      ORDER BY signal_key`,
    [integrationId],
  );
  const ready: ReadySignal[] = [];
  const unavailable: UnavailableSignal[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (r.status === 'ready') {
      ready.push({ signalKey: String(r.signal_key), title: String(r.title),
        query: asObj(r.query) as unknown as DiagQuery, meta: asObj(r.meta) });
    } else {
      unavailable.push({ signalKey: String(r.signal_key), title: String(r.title),
        missingMetrics: asArr(r.missing_metrics).map(String) });
    }
  }
  return { ready, unavailable };
}

/** Ask the worker to (re)build signals for one instance (after add / schema refresh). Prom/Mimir only;
 *  best-effort — a worker-queue hiccup must never fail the datasource write that triggered it. */
export async function enqueueDatasourceIndex(integrationId: number, kind?: string): Promise<void> {
  if (process.env.DATASOURCE_DIAGNOSIS_ENABLED !== 'true') return;
  if (kind && kind !== 'prometheus' && kind !== 'mimir') return;  // v1 scope
  try {
    await enqueueJob('datasource_index', { integration_id: integrationId });
  } catch {
    /* swallow — the daily dispatcher will rebuild; never block the caller */
  }
}
