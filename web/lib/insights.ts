// AI Insights — BFF read side (latest cached insight for the Overview dashboard) + the admin refresh
// enqueue. Read-only DB access; generation happens in the worker (thin-BFF). Refresh fail-closes when
// the feature flag is off and dedups against a recently-enqueued/running insight job.
import { getPool } from '@/lib/db';
import { enqueueJob } from '@/lib/jobs';

export interface Insight { severity: 'critical' | 'warning' | 'info'; title: string; detail: string; source: string; refs?: Record<string, unknown> }
export interface LatestInsight {
  status: string;
  insights: Insight[];
  sourcesUsed: Record<string, number>;
  model: string | null;
  generatedAt: string | null;
}

function asArr<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === 'string' && v) { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}
function asObj(v: unknown): Record<string, number> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, number>;
  if (typeof v === 'string' && v) { try { return JSON.parse(v); } catch { return {}; } }
  return {};
}

/** Latest cached insight row (account-scoped, single-account 'self'), or null when none generated yet. */
export async function getLatestInsight(accountId = 'self'): Promise<LatestInsight | null> {
  const { rows } = await getPool().query(
    `SELECT status, insights, sources_used, model, generated_at
       FROM ai_insights WHERE account_id = $1 ORDER BY generated_at DESC LIMIT 1`,
    [accountId],
  );
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    status: String(r.status),
    insights: asArr<Insight>(r.insights),
    sourcesUsed: asObj(r.sources_used),
    model: (r.model as string) ?? null,
    generatedAt: r.generated_at ? String(r.generated_at) : null,
  };
}

/** True when an insight job was enqueued/started in the last `withinMin` minutes (dedup guard). */
export async function hasRecentInsightJob(withinMin = 10): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM worker_jobs
      WHERE type = 'insight' AND status IN ('queued', 'running')
        AND created_at > now() - ($1 || ' minutes')::interval LIMIT 1`,
    [String(withinMin)],
  );
  return rows.length > 0;
}

/** Enqueue an insight refresh. Returns 'disabled' (flag off), 'deduped' (recent job), or 'queued'. */
export async function enqueueInsightRefresh(): Promise<'disabled' | 'deduped' | 'queued'> {
  if (process.env.AI_INSIGHTS_ENABLED !== 'true') return 'disabled';  // runtime fail-closed
  if (await hasRecentInsightJob()) return 'deduped';                  // avoid duplicate Bedrock jobs
  await enqueueJob('insight', { scheduled: false });
  return 'queued';
}
