import { verifyUser } from '@/lib/auth';
import { tgwDetails } from '@/lib/tgw';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Transit Gateway 상세: 어태치먼트 + 라우트 테이블(+라우트). ids는 tgw- 접두사만 통과.
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const ids = (new URL(request.url).searchParams.get('ids') ?? '')
    .split(',').map((s) => s.trim()).filter((s) => /^tgw-[0-9a-f]+$/.test(s));
  if (ids.length === 0) return Response.json({ attachments: [], routeTables: [] });
  try {
    // TGW는 리전 리소스 — 인벤토리에서 각 TGW의 소속 리전을 해석해 리전별로 조회.
    const r = await getPool().query<{ resource_id: string; region: string | null }>(
      `SELECT resource_id, region FROM inventory_resources
       WHERE resource_type = 'transit_gateway' AND resource_id = ANY($1)`, [ids],
    );
    const regionOf = new Map(r.rows.map((x) => [x.resource_id, x.region ?? undefined]));
    return Response.json(await tgwDetails(ids.map((id) => ({ id, region: regionOf.get(id) }))));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
