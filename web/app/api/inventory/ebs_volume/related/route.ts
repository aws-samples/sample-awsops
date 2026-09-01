import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

// EBS volume drill-down (gap-audit L97/L98, v1 parity): per-volume snapshots + attached-EC2
// enrichment, both pure cross-queries over the already-synced Aurora rows — no AWS call.
// Account-scoped: resource ids can collide across synced accounts, and a volume's detail must
// never surface another account's rows.

const VOL_RE = /^vol-[0-9a-f]{8,32}$/;
const INST_RE = /^i-[0-9a-f]{8,32}$/;
const REGION_RE = /^[a-z0-9-]{1,32}$/;
const MAX_INSTANCES = 16; // io2 multi-attach supports up to 16
const SNAPSHOT_LIMIT = 20;

/** Host-account rows are stored under the 'self' SENTINEL in account_id, but the row payload
 *  (and therefore the panel) carries the real 12-digit id — filtering by the raw id returns
 *  zero rows for every host volume (the same self-vs-real-id trap root CLAUDE.md documents for
 *  the agent tier). Translate server-side so callers may pass either form. */
function normalizeAccount(account: string): string {
  const host = process.env.AWS_ACCOUNT_ID;
  return host && account === host ? 'self' : account;
}

export interface RelatedSnapshot {
  snapshotId: string; sizeGb: number | null; encrypted: boolean | null; startTime: string; state: string;
}
export interface RelatedInstance {
  instanceId: string; name: string; instanceType: string; state: string;
}

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const volumeId = url.searchParams.get('volumeId') ?? '';
  if (!VOL_RE.test(volumeId)) {
    return Response.json({ status: 'error', message: 'invalid volumeId' }, { status: 400 });
  }
  const instParam = url.searchParams.get('instanceIds');
  const instanceIds = instParam ? instParam.split(',').filter(Boolean) : [];
  if (instanceIds.length > MAX_INSTANCES || instanceIds.some((i) => !INST_RE.test(i))) {
    return Response.json({ status: 'error', message: 'invalid instanceIds' }, { status: 400 });
  }
  const accountParam = url.searchParams.get('account') ?? 'self';
  if (accountParam !== 'self' && !/^[0-9]{12}$/.test(accountParam)) {
    return Response.json({ status: 'error', message: 'invalid account' }, { status: 400 });
  }
  const account = normalizeAccount(accountParam);
  // Region narrows both queries to the volume's own region (the table identity is
  // (type, account, region, id)); optional for backward compatibility.
  const regionParam = url.searchParams.get('region');
  if (regionParam !== null && !REGION_RE.test(regionParam)) {
    return Response.json({ status: 'error', message: 'invalid region' }, { status: 400 });
  }

  const pool = getPool();
  // The two blocks degrade independently — one failing query renders an inline error in its
  // own section, never a dead panel (house rule).
  let snapshots: RelatedSnapshot[] | null = null;
  try {
    const params: unknown[] = [account, volumeId];
    let regionCond = '';
    if (regionParam) { params.push(regionParam); regionCond = ` AND region = $${params.length}`; }
    params.push(SNAPSHOT_LIMIT);
    const r = await pool.query(
      `SELECT resource_id, data FROM inventory_resources
       WHERE resource_type = 'ebs_snapshot' AND account_id = $1 AND data->>'volume_id' = $2${regionCond}
       ORDER BY (data->>'start_time')::timestamptz DESC NULLS LAST LIMIT $${params.length}`,
      params,
    );
    snapshots = r.rows.map((row) => {
      const d = (row.data ?? {}) as Record<string, unknown>;
      const size = Number(d.volume_size);
      return {
        snapshotId: String(row.resource_id),
        sizeGb: Number.isFinite(size) ? size : null,
        // tri-state: an absent/unknown value must not render a definitive 미암호화 badge
        encrypted: d.encrypted === true || d.encrypted === 'true' ? true
          : d.encrypted === false || d.encrypted === 'false' ? false : null,
        startTime: typeof d.start_time === 'string' ? d.start_time : '',
        state: typeof d.state === 'string' ? d.state : '',
      };
    });
  } catch (e) {
    console.error('ebs related: snapshot query failed:', e); // degradation is honest on the wire — keep it visible operationally too
  }

  let instances: RelatedInstance[] | null = null;
  if (instanceIds.length > 0) {
    try {
      const params: unknown[] = [account, instanceIds];
      let regionCond = '';
      if (regionParam) { params.push(regionParam); regionCond = ` AND region = $${params.length}`; }
      const r = await pool.query(
        `SELECT resource_id, data FROM inventory_resources
         WHERE resource_type = 'ec2' AND account_id = $1 AND resource_id = ANY($2)${regionCond}`,
        params,
      );
      instances = r.rows.map((row) => {
        const d = (row.data ?? {}) as Record<string, unknown>;
        return {
          instanceId: String(row.resource_id),
          name: typeof d.name === 'string' ? d.name : '',
          instanceType: typeof d.instance_type === 'string' ? d.instance_type : '',
          state: typeof d.instance_state === 'string' ? d.instance_state : '',
        };
      });
    } catch (e) {
      console.error('ebs related: instance query failed:', e);
    }
  } else {
    instances = [];
  }

  return Response.json({ snapshots, instances, snapshotLimit: SNAPSHOT_LIMIT });
}
