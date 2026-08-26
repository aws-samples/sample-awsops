import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { ec2AvgCpu, ec2HourlyCost, rdsMetrics, hasLiveMetrics, liveResourceMetrics, mskBootstrapBrokers, elasticacheFleetLive, opensearchFleetLive, mskListNodes, mskBrokerFleetLive, mskClusterHealth, mskOffsetLags, rdsFleetLive, ddbFleetLive, ddbReplicationLags, albFleetLive, albTargetHealth, nlbFleetLive, s3FleetLive, s3ReplicationStatus, ebsFleetLive, ec2EbsBalance, ec2DiagFleetLive, lambdaFleetLive, tgwFleetLive } from '@/lib/metrics';
import { regionWhereClause, type RegionScope } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

type Card = { label: string; value: string | number; accent?: boolean };

// Supplementary KPI cards (CloudWatch avg CPU + Pricing hourly cost). EC2-first.
// Every failure path degrades silently to { cards: [] } — these cards never blank
// the page (the F3 total/state tiles + donut + table + F4 detail panel stay intact).
// KNOWN LIMITATION (pre-existing, not introduced or fixed by the region-scope filter): the
// instance IDs fed to ec2AvgCpu/ec2HourlyCost/rdsMetrics below are now correctly scoped by
// region, but lib/metrics.ts itself queries CloudWatch/Pricing against a single fixed
// AWS_REGION client — it has no per-instance region routing. Selecting a non-default region
// narrows the table correctly but these two KPI cards can go null/inaccurate for it. Fixing
// that needs per-region CloudWatch clients in lib/metrics.ts, which is a separate change.
export async function GET(request: Request, { params }: { params: { type: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  // 진단 테이블 기간별 조회: allow-listed range (초) — 값은 선택 기간 전체에 대한 단일 집계.
  const RANGE_ALLOWED = [3600, 21600, 86400, 604800];
  const rangeRaw = Number(url.searchParams.get('range'));
  const range = RANGE_ALLOWED.includes(rangeRaw) ? rangeRaw : 3600;
  const regionsParam = url.searchParams.get('regions');
  const regions: RegionScope = regionsParam === null || regionsParam === '__all__' ? '__all__' : regionsParam.split(',').filter(Boolean);
  const includeGlobal = url.searchParams.get('includeGlobal') !== '0';
  try {
    if (params.type === 'ec2') {
      // Per-instance diagnostic fleet (page bottom table) — must run BEFORE the KPI-cards path.
      if (url.searchParams.get('ids') !== null) {
        const ids = (url.searchParams.get('ids') ?? '')
          .split(',').map((x) => x.trim()).filter((x) => /^i-[0-9a-f]+$/.test(x)).slice(0, 150);
        const rowsR = await getPool().query<{ resource_id: string; region: string | null }>(
          `SELECT resource_id, region FROM inventory_resources
           WHERE resource_type = 'ec2' AND resource_id = ANY($1)`, [ids],
        );
        const byRegion = new Map<string, string[]>();
        for (const row of rowsR.rows) {
          const reg = row.region || process.env.AWS_REGION || 'ap-northeast-2';
          byRegion.set(reg, [...(byRegion.get(reg) ?? []), row.resource_id]);
        }
        const fleet: Record<string, Record<string, number | null>> = {};
        await Promise.all(
          [...byRegion.entries()].map(async ([reg, insts]) => Object.assign(fleet, await ec2DiagFleetLive(insts, reg, range))),
        );
        return Response.json({ fleet, range });
      }
      const qparams: unknown[] = [];
      const where = `resource_type = 'ec2' AND account_id = 'self'` + regionWhereClause(regions, includeGlobal, qparams);
      const r = await getPool().query<{ id: string | null; state: string | null; type: string | null }>(
        `SELECT data->>'instance_id' AS id, data->>'instance_state' AS state, data->>'instance_type' AS type
         FROM inventory_resources WHERE ${where}`,
        qparams,
      );
      const runningIds = r.rows
        .filter((x) => x.state === 'running')
        .map((x) => x.id)
        .filter((id): id is string => !!id);
      const typeCounts: Record<string, number> = {};
      for (const x of r.rows) {
        if (x.type) typeCounts[x.type] = (typeCounts[x.type] ?? 0) + 1;
      }

      const [cpu, cost] = await Promise.all([ec2AvgCpu(runningIds), ec2HourlyCost(typeCounts)]);
      const cards: Card[] = [
        { label: '평균 CPU', value: cpu == null ? '—' : `${cpu}%`, accent: true },
        { label: '시간당 비용(USD)', value: cost == null ? '—' : `$${cost.toFixed(2)}`, accent: true },
      ];
      return Response.json({ cards });
    }

    if (params.type === 'rds') {
      // resource_id = DBInstanceIdentifier (sync_lambda). Metrics are a live CloudWatch read (not stored).
      // ?ids=a,b → per-instance diagnostic fleet (page table); ?id=<x> → detail-panel series; else KPI cards.
      const idsParam = new URL(request.url).searchParams.get('ids');
      if (idsParam !== null) {
        const ids = idsParam.split(',').map((x) => x.trim()).filter((x) => /^[a-zA-Z0-9.-]+$/.test(x)).slice(0, 200);
        return Response.json({ fleet: await rdsFleetLive(ids, range), range });
      }
      const instanceId = new URL(request.url).searchParams.get('id');
      if (instanceId) {
        const one = await rdsMetrics([instanceId]);
        return Response.json({ instance: one.byInstance[instanceId] ?? null });
      }
      const qparams: unknown[] = [];
      const where = `resource_type = 'rds' AND account_id = 'self'` + regionWhereClause(regions, includeGlobal, qparams);
      const r = await getPool().query<{ id: string | null }>(
        `SELECT resource_id AS id FROM inventory_resources WHERE ${where}`,
        qparams,
      );
      const ids = r.rows.map((x) => x.id).filter((id): id is string => !!id);
      const m = await rdsMetrics(ids);
      const vals = Object.values(m.byInstance);
      const conns = vals.map((x) => x.connections).filter((v): v is number => v != null);
      const totalConns = conns.length ? conns.reduce((a, b) => a + b, 0) : null;
      const stores = vals.map((x) => x.freeStorage).filter((v): v is number => v != null);
      const minStoreGb = stores.length ? Math.round((Math.min(...stores) / 1e9) * 10) / 10 : null;
      const cards: Card[] = [
        { label: '평균 CPU', value: m.avgCpu == null ? '—' : `${m.avgCpu}%`, accent: true },
        { label: '총 DB 커넥션', value: totalConns == null ? '—' : totalConns },
        { label: '최소 여유 스토리지', value: minStoreGb == null ? '—' : `${minStoreGb}GB` },
      ];
      return Response.json({ cards });
    }

    // ALB: per-LB diagnostics + per-TargetGroup health. The CloudWatch LoadBalancer dimension is
    // the ARN suffix ("app/<name>/<id>") — resolved from the synced inventory ARNs, keyed back to
    // resource_id for the page. TG dims come from target_group rows' load_balancer_arns linkage.
    if ((params.type === 'alb' || params.type === 'nlb') && url.searchParams.get('ids') !== null) {
      const isAlb = params.type === 'alb';
      const prefix = isAlb ? 'app' : 'net';
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',').map((x) => x.trim()).filter((x) => /^[a-zA-Z0-9-]+$/.test(x)).slice(0, 100);
      const lbRows = await getPool().query<{ resource_id: string; arn: string | null }>(
        `SELECT resource_id, data->>'arn' AS arn FROM inventory_resources
         WHERE resource_type = $2 AND resource_id = ANY($1)`, [ids, params.type],
      );
      const dimOf = new Map<string, string>(); // resource_id → "app|net/name/id"
      for (const row of lbRows.rows) {
        const mDim = (row.arn ?? '').match(new RegExp(`loadbalancer\\/(${prefix}\\/.+)$`));
        if (mDim) dimOf.set(row.resource_id, mDim[1]);
      }
      const tgRows = await getPool().query<{ arn: string | null; name: string | null; lbs: unknown }>(
        `SELECT data->>'target_group_arn' AS arn, data->>'target_group_name' AS name,
                data->'load_balancer_arns' AS lbs
         FROM inventory_resources WHERE resource_type = 'target_group'`,
      );
      const pairs: { tgDim: string; tgName: string; lbDim: string }[] = [];
      for (const tg of tgRows.rows) {
        const tgDim = (tg.arn ?? '').match(/(targetgroup\/.+)$/)?.[1];
        if (!tgDim) continue;
        for (const lbArn of Array.isArray(tg.lbs) ? (tg.lbs as unknown[]) : []) {
          const lbDim = String(lbArn).match(new RegExp(`loadbalancer\\/(${prefix}\\/.+)$`))?.[1];
          if (lbDim && [...dimOf.values()].includes(lbDim)) {
            pairs.push({ tgDim, tgName: tg.name ?? tgDim, lbDim });
          }
        }
      }
      const namespace = isAlb ? 'AWS/ApplicationELB' : 'AWS/NetworkELB';
      const [fleetByDim, targetHealth] = await Promise.all([
        isAlb ? albFleetLive([...dimOf.values()], range) : nlbFleetLive([...dimOf.values()], range),
        albTargetHealth(pairs, namespace, range),
      ]);
      // key the fleet back by resource_id; health rows carry lbDim → page maps via lbDim field
      const fleet: Record<string, Record<string, number | null>> = {};
      for (const [rid, dim] of dimOf) fleet[rid] = fleetByDim[dim] ?? {};
      const lbDimByResource = Object.fromEntries(dimOf);
      return Response.json({ fleet, targetHealth, lbDimByResource, range });
    }

    // S3: per-bucket storage(일별)+request(유료, 활성화 시) metrics — the metrics live in each
    // BUCKET's region, so ids are grouped by the inventory row region and queried per region.
    if (params.type === 's3' && url.searchParams.get('ids') !== null) {
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',').map((x) => x.trim()).filter((x) => /^[a-z0-9.-]{3,63}$/.test(x)).slice(0, 150);
      const rowsR = await getPool().query<{ resource_id: string; region: string | null }>(
        `SELECT resource_id, region FROM inventory_resources
         WHERE resource_type = 's3' AND resource_id = ANY($1)`, [ids],
      );
      const byRegion = new Map<string, string[]>();
      for (const row of rowsR.rows) {
        const reg = row.region || process.env.AWS_REGION || 'ap-northeast-2';
        byRegion.set(reg, [...(byRegion.get(reg) ?? []), row.resource_id]);
      }
      const fleet: Record<string, Record<string, number | null>> = {};
      const [replication, ...fleets] = await Promise.all([
        s3ReplicationStatus(30, range),
        ...[...byRegion.entries()].map(([reg, buckets]) => s3FleetLive(buckets, reg, range)),
      ]);
      for (const f of fleets) Object.assign(fleet, f);
      return Response.json({ fleet, replication, range });
    }

    // Transit Gateway: 진단 메트릭 (Bytes/Packets + Blackhole/NoRoute 드롭) — TGW 리전별 그룹.
    if (params.type === 'transit_gateway' && url.searchParams.get('ids') !== null) {
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',').map((x) => x.trim()).filter((x) => /^tgw-[0-9a-f]+$/.test(x)).slice(0, 30);
      const rowsR = await getPool().query<{ resource_id: string; region: string | null }>(
        `SELECT resource_id, region FROM inventory_resources
         WHERE resource_type = 'transit_gateway' AND resource_id = ANY($1)`, [ids],
      );
      const byRegion = new Map<string, string[]>();
      for (const row of rowsR.rows) {
        const reg = row.region || process.env.AWS_REGION || 'ap-northeast-2';
        byRegion.set(reg, [...(byRegion.get(reg) ?? []), row.resource_id]);
      }
      const fleet: Record<string, Record<string, number | null>> = {};
      await Promise.all(
        [...byRegion.entries()].map(async ([reg, tg]) => Object.assign(fleet, await tgwFleetLive(tg, reg, range))),
      );
      return Response.json({ fleet, range });
    }

    // Lambda: per-function diagnostics grouped by the function's region.
    if (params.type === 'lambda' && url.searchParams.get('ids') !== null) {
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',').map((x) => x.trim()).filter((x) => /^[a-zA-Z0-9._-]{1,140}$/.test(x)).slice(0, 150);
      const rowsR = await getPool().query<{ resource_id: string; region: string | null }>(
        `SELECT resource_id, region FROM inventory_resources
         WHERE resource_type = 'lambda' AND resource_id = ANY($1)`, [ids],
      );
      const byRegion = new Map<string, string[]>();
      for (const row of rowsR.rows) {
        const reg = row.region || process.env.AWS_REGION || 'ap-northeast-2';
        byRegion.set(reg, [...(byRegion.get(reg) ?? []), row.resource_id]);
      }
      const fleet: Record<string, Record<string, number | null>> = {};
      await Promise.all(
        [...byRegion.entries()].map(async ([reg, fns]) => Object.assign(fleet, await lambdaFleetLive(fns, reg, range))),
      );
      return Response.json({ fleet, range });
    }

    // EBS: per-volume diagnostics grouped by the volume's region + instance-level EBS balance
    // (EBSIOBalance%/EBSByteBalance%) for the ATTACHED instances (from attachments JSONB).
    if (params.type === 'ebs_volume' && url.searchParams.get('ids') !== null) {
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',').map((x) => x.trim()).filter((x) => /^vol-[0-9a-f]+$/.test(x)).slice(0, 150);
      const rowsR = await getPool().query<{ resource_id: string; region: string | null; att: unknown }>(
        `SELECT resource_id, region, data->'attachments' AS att FROM inventory_resources
         WHERE resource_type = 'ebs_volume' AND resource_id = ANY($1)`, [ids],
      );
      const volByRegion = new Map<string, string[]>();
      const instByRegion = new Map<string, Set<string>>();
      const instOfVol: Record<string, string> = {};
      for (const row of rowsR.rows) {
        const reg = row.region || process.env.AWS_REGION || 'ap-northeast-2';
        volByRegion.set(reg, [...(volByRegion.get(reg) ?? []), row.resource_id]);
        for (const a of Array.isArray(row.att) ? (row.att as Record<string, unknown>[]) : []) {
          const iid = String(a.InstanceId ?? a.instance_id ?? '');
          if (/^i-[0-9a-f]+$/.test(iid)) {
            instOfVol[row.resource_id] = iid;
            if (!instByRegion.has(reg)) instByRegion.set(reg, new Set());
            instByRegion.get(reg)!.add(iid);
          }
        }
      }
      const fleet: Record<string, Record<string, number | null>> = {};
      const instanceBalance: Record<string, Record<string, number | null>> = {};
      await Promise.all([
        ...[...volByRegion.entries()].map(async ([reg, vols]) => Object.assign(fleet, await ebsFleetLive(vols, reg, range))),
        ...[...instByRegion.entries()].map(async ([reg, insts]) => Object.assign(instanceBalance, await ec2EbsBalance([...insts], reg, range))),
      ]);
      return Response.json({ fleet, instanceBalance, instOfVol, range });
    }

    // DynamoDB: per-table diagnostics + Global Tables replication lag (discovered via ListMetrics).
    if (params.type === 'dynamodb' && url.searchParams.get('ids') !== null) {
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',').map((x) => x.trim()).filter((x) => /^[a-zA-Z0-9._-]+$/.test(x)).slice(0, 200);
      const [fleet, replication] = await Promise.all([ddbFleetLive(ids, range), ddbReplicationLags(30, range)]);
      return Response.json({ fleet, replication, range });
    }
    // v1-parity fleet metrics (page-level tables):
    // elasticache/opensearch ?ids=a,b → { fleet: { id: {metricKey: value|null} } }
    if ((params.type === 'elasticache' || params.type === 'opensearch') && url.searchParams.get('ids') !== null) {
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',').map((x) => x.trim()).filter((x) => /^[a-zA-Z0-9._-]+$/.test(x)).slice(0, 200);
      const fleet = params.type === 'elasticache' ? await elasticacheFleetLive(ids, range) : await opensearchFleetLive(ids, range);
      return Response.json({ fleet, range });
    }
    // msk ?nodes=<clusterArn> → { nodes, brokerMetrics } (kafka ListNodes + per-broker CloudWatch)
    if (params.type === 'msk' && url.searchParams.get('nodes') !== null) {
      const arn = url.searchParams.get('nodes') ?? '';
      if (!/^arn:aws:kafka:[a-z0-9-]+:\d{12}:cluster\/[a-zA-Z0-9._-]+\/[a-z0-9-]+$/.test(arn)) {
        return Response.json({ status: 'error', message: 'invalid cluster arn' }, { status: 400 });
      }
      const clusterName = arn.split('/')[1];
      const clusterRegion = arn.split(':')[3];
      const nodes = await mskListNodes(arn);
      const brokerIds = nodes.filter((n) => n.nodeType === 'BROKER' && n.brokerId != null).map((n) => n.brokerId as number);
      const [brokerMetrics, health, lags] = await Promise.all([
        brokerIds.length ? mskBrokerFleetLive(clusterName, brokerIds, clusterRegion, range) : Promise.resolve({}),
        mskClusterHealth(clusterName, clusterRegion, range),
        mskOffsetLags(clusterName, clusterRegion, 20, range),
      ]);
      return Response.json({ nodes, brokerMetrics, health, lags, range });
    }

    // ElastiCache/OpenSearch/MSK: per-resource live metrics for the detail panel (?id=).
    if (hasLiveMetrics(params.type)) {
      const id = url.searchParams.get('id');
      if (id) {
        const metrics = await liveResourceMetrics(params.type, id);
        // MSK: append bootstrap broker connection strings (v1 parity) — ARN from the synced row.
        if (params.type === 'msk') {
          try {
            const r = await getPool().query<{ arn: string | null }>(
              `SELECT data->>'arn' AS arn FROM inventory_resources
               WHERE resource_type='msk' AND resource_id=$1 LIMIT 1`,
              [id],
            );
            const arn = r.rows[0]?.arn;
            if (arn) metrics.push(...(await mskBootstrapBrokers(arn)));
          } catch { /* bootstrap rows omitted */ }
        }
        return Response.json({ metrics });
      }
    }

    return Response.json({ cards: [] });
  } catch {
    return Response.json({ cards: [] });
  }
}
