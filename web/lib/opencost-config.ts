// web/lib/opencost-config.ts — Aurora CRUD for OpenCost install config (read-only feature:
// this writes only the app's OWN Aurora, never a cluster/AWS resource). Mirrors agent-space.ts:
// degrade-safe (null/false when AURORA_ENDPOINT unset or on query error — never throws).
import { getPool } from '@/lib/db';
import { writeAudit } from '@/lib/catalog';

export interface OpencostConfigRow {
  cluster: string;
  chartVersion: string | null;
  config: Record<string, unknown>;
  updatedBy: string | null;
  updatedAt: string | null;
}

export async function getOpencostConfig(cluster: string): Promise<OpencostConfigRow | null> {
  if (!process.env.AURORA_ENDPOINT) return null;
  try {
    const { rows } = await getPool().query(
      `SELECT cluster, chart_version, config, updated_by, updated_at FROM opencost_config WHERE cluster = $1`,
      [cluster],
    );
    if (rows.length === 0) return null;
    const r = rows[0] as Record<string, unknown>;
    return {
      cluster: r.cluster as string,
      chartVersion: (r.chart_version as string) ?? null,
      config: (r.config as Record<string, unknown>) ?? {},
      updatedBy: (r.updated_by as string) ?? null,
      updatedAt: r.updated_at ? String(r.updated_at) : null,
    };
  } catch {
    return null; // degrade — never break the page
  }
}

/** Upsert config. Returns false when storage is unavailable (route → 503). Audited. */
export async function upsertOpencostConfig(input: {
  cluster: string;
  chartVersion: string | null;
  config: Record<string, unknown>;
  updatedBy: string;
}): Promise<boolean> {
  if (!process.env.AURORA_ENDPOINT) return false;
  try {
    await getPool().query(
      `INSERT INTO opencost_config (cluster, chart_version, config, updated_by)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (cluster) DO UPDATE
         SET chart_version = EXCLUDED.chart_version,
             config        = EXCLUDED.config,
             updated_by    = EXCLUDED.updated_by,
             updated_at    = NOW()`,
      [input.cluster, input.chartVersion, JSON.stringify(input.config), input.updatedBy],
    );
    await writeAudit({ actor: input.updatedBy, action: 'upsert', objectType: 'opencost_config', objectId: input.cluster });
    return true;
  } catch {
    return false;
  }
}
