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

/** Read this instance's pre-built signals, split into clickable (ready) and disabled (unavailable).
 *
 * LLM-generated rows are gated on the READ side too, not only on the write side. Turning
 * `diag_signal_querygen_enabled` off makes the worker sweep them on the next rebuild, but that rebuild
 * needs the worker to actually run — with `workers_enabled`/`datasource_diagnosis_enabled` off, or the
 * daily job paused, the stored rows would keep being served indefinitely after the gate closed (review).
 * A flag-off read serves only deterministic-catalog signals, whatever is still in the table.
 */
export async function getDiagSignals(integrationId: number): Promise<DiagSignals> {
  const generatedAllowed = process.env.DIAG_SIGNAL_QUERYGEN_ENABLED === 'true';
  const { rows } = await getPool().query(
    `SELECT signal_key, title, status, query, missing_metrics, meta
       FROM datasource_diag_signals
      WHERE account_id = 'self' AND integration_id = $1
        -- '__schema_version__' is the worker's bookkeeping row (db.py SCHEMA_VERSION_SENTINEL_KEY):
        -- it exists so a schema that yields no signals is remembered rather than rebuilt every run,
        -- and it is not a signal, so it must never reach the UI as a chip.
        -- '__diag_signal_budget__' (db.py BUDGET_KEY) is the weekly-retry marker, kept in its own row's
        -- meta field precisely so it never shares a version column with real content — also not a signal.
        AND signal_key NOT IN ('__schema_version__', '__diag_signal_budget__')
        AND ($2::boolean OR (meta->>'provenance') IS DISTINCT FROM 'generated')
      ORDER BY signal_key`,
    [integrationId, generatedAllowed],
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

// kinds actually wired into the production diag-signal pipeline (datasource_index_dispatcher.py's
// _LIST_SQL + workers.tf's ds_connector_arns) — other kinds have no worker IAM grant to invoke.
const DIAG_SIGNAL_KINDS = new Set(['prometheus', 'mimir', 'loki', 'tempo', 'clickhouse']);

/** Ask the worker to (re)build signals for one instance (after add / schema refresh).
 *  best-effort — a worker-queue hiccup must never fail the datasource write that triggered it. */
export async function enqueueDatasourceIndex(integrationId: number, kind?: string): Promise<void> {
  if (process.env.DATASOURCE_DIAGNOSIS_ENABLED !== 'true') return;
  if (kind && !DIAG_SIGNAL_KINDS.has(kind)) return;  // kinds wired into the diag-signal production pipeline
  try {
    await enqueueJob('datasource_index', { integration_id: integrationId });
  } catch {
    /* swallow — the daily dispatcher will rebuild; never block the caller */
  }
}
