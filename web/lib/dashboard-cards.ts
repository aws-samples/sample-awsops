// Pre-built datasource dashboard cards (datasource_dashboard_cards) — BFF read side for the
// card dashboard on /integrations/datasources/[id]. Cards are built by the datasource-index
// worker from the cached schema (card_catalog.py); the stored query is executed live at view
// time by the CardDashboard component via POST /api/datasources/query. Read-only DB access;
// deterministic-only rows (no LLM provenance gate — unlike diag-signals).
import { getPool } from '@/lib/db';

export interface CardQuery { tool: string; expr: string; range: { window: number; step: number } | null }
export interface ReadyCard { cardKey: string; title: string; viz: 'stat' | 'timeseries' | 'table'; unit: string; query: CardQuery }
// `indeterminate` = the worker could not DETERMINE absence (the cached schema was truncated, so the
// requirement may well exist) — the UI must say "미확정", not claim the item is missing.
export interface UnavailableCard { cardKey: string; title: string; missing: string[]; indeterminate: boolean }
export interface DashboardCards { ready: ReadyCard[]; unavailable: UnavailableCard[] }

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

/** Read this instance's pre-built dashboard cards, split into runnable (ready) and dimmed (unavailable). */
export async function getDashboardCards(integrationId: number): Promise<DashboardCards> {
  const { rows } = await getPool().query(
    `SELECT card_key, title, viz, unit, status, query, missing
       FROM datasource_dashboard_cards
      WHERE account_id = 'self' AND integration_id = $1
        -- '__schema_version__' is the worker's bookkeeping row (db.py SCHEMA_VERSION_SENTINEL_KEY):
        -- it exists so a schema that yields no cards is remembered rather than rebuilt every run,
        -- and it is not a card, so it must never reach the UI.
        AND card_key <> '__schema_version__'
      ORDER BY card_key`,
    [integrationId],
  );
  const ready: ReadyCard[] = [];
  const unavailable: UnavailableCard[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (r.status === 'ready') {
      ready.push({
        cardKey: String(r.card_key), title: String(r.title),
        viz: (r.viz === 'timeseries' || r.viz === 'table' ? r.viz : 'stat'),
        unit: String(r.unit ?? ''),
        query: asObj(r.query) as unknown as CardQuery,
      });
    } else {
      unavailable.push({
        cardKey: String(r.card_key), title: String(r.title),
        missing: asArr(r.missing).map(String),
        indeterminate: r.status === 'unknown',
      });
    }
  }
  return { ready, unavailable };
}
