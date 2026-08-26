// awsops-only Bedrock token cost. Thin-BFF: a fast SUM-by-model SELECT against ai_usage_daily
// (populated by the scheduled ai-cost aggregator). No heavy/long AWS call here — pricing is pure
// (web/lib/ai-usage → web/lib/bedrock). Auth-gated, read-only.
import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { priceUsage, type UsageRow } from '@/lib/ai-usage';

export const dynamic = 'force-dynamic';

// Daily-granularity ranges (ai_usage_daily is per-UTC-day). Default 30d.
const RANGE_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const raw = new URL(request.url).searchParams.get('range') || '30d';
  const range = RANGE_DAYS[raw] ? raw : '30d';
  const days = RANGE_DAYS[range];
  try {
    const { rows } = await getPool().query(
      `SELECT model,
              SUM(input_tokens)::bigint       AS input_tokens,
              SUM(output_tokens)::bigint      AS output_tokens,
              SUM(cache_read_tokens)::bigint  AS cache_read_tokens,
              SUM(cache_write_tokens)::bigint AS cache_write_tokens
         FROM ai_usage_daily
        WHERE day >= CURRENT_DATE - ($1::int * INTERVAL '1 day')
        GROUP BY model
        ORDER BY model`,
      [days],
    );
    const { models, totalCost } = priceUsage(rows as UsageRow[]);
    return Response.json({ range, totalCost, models });
  } catch (e) {
    return Response.json(
      { status: 'error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
