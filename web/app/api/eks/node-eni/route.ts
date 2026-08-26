import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { ec2DiagFleetLive } from '@/lib/metrics';

// IPv4 addresses per ENI for common instance types (AWS 공식 한도표의 자주 쓰는 항목만 —
// 미등재 타입은 v1과 동일하게 15로 폴백). 정확한 전수 조회는 DescribeInstanceTypes가 필요.
const IPV4_PER_ENI: Record<string, number> = {
  't3.micro': 2, 't3.small': 4, 't3.medium': 6, 't3.large': 12, 't3.xlarge': 15,
  't4g.micro': 2, 't4g.small': 4, 't4g.medium': 6, 't4g.large': 12, 't4g.xlarge': 15, 't4g.2xlarge': 15,
  'm5.large': 10, 'm5.xlarge': 15, 'm6g.large': 10, 'm6g.xlarge': 15,
  'm7g.large': 10, 'm7g.xlarge': 15, 'm7g.2xlarge': 15, 'm7g.4xlarge': 30,
  'c5.large': 10, 'c6g.large': 10, 'c7g.large': 10, 'c7g.xlarge': 15,
  'r5.large': 10, 'r6g.large': 10, 'r7g.large': 10, 'r7g.xlarge': 15,
};

export const dynamic = 'force-dynamic';

interface EniRow { id: string; privateIp: string; publicIp: string | null; subnet: string | null; ips: number }

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] != null) return o[k];
  return undefined;
};

/**
 * EKS Node ENI panel (v1 parity): the node's EC2 network interfaces + IP capacity,
 * matched from the SYNCED ec2 inventory row by private DNS name — no live EC2 call.
 */
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const node = new URL(request.url).searchParams.get('node') ?? '';
  if (!node) return Response.json({ status: 'error', message: 'node required' }, { status: 400 });
  try {
    const r = await getPool().query<{ id: string; data: Record<string, unknown> }>(
      `SELECT resource_id AS id, data FROM inventory_resources
       WHERE resource_type='ec2' AND (data->>'private_dns_name') = $1 LIMIT 1`,
      [node],
    );
    const row = r.rows[0];
    if (!row) return Response.json({ found: false });
    const d = row.data;
    const enis: EniRow[] = asArr(d.network_interfaces).map((e) => {
      const o = rec(e);
      const assoc = rec(pick(o, 'Association', 'association'));
      const priv = asArr(pick(o, 'PrivateIpAddresses', 'private_ip_addresses'));
      return {
        id: String(pick(o, 'NetworkInterfaceId', 'network_interface_id') ?? ''),
        privateIp: String(pick(o, 'PrivateIpAddress', 'private_ip_address') ?? ''),
        publicIp: typeof assoc.PublicIp === 'string' ? assoc.PublicIp : null,
        subnet: (pick(o, 'SubnetId', 'subnet_id') as string | undefined) ?? null,
        ips: priv.length || 1,
      };
    }).filter((e) => e.id);
    const maxEnis = Number(d.max_enis) || null;
    const instanceType = typeof d.instance_type === 'string' ? d.instance_type : null;
    const ipv4PerEni = instanceType ? IPV4_PER_ENI[instanceType] ?? 15 : 15; // v1 폴백: /15
    // 인스턴스 트래픽 (1h): CloudWatch에 ENI별 메트릭은 없음 — 인스턴스 레벨로 정직하게 표시.
    let traffic: { netIn: number | null; netOut: number | null; pktIn: number | null; pktOut: number | null } | null = null;
    try {
      const m = (await ec2DiagFleetLive([row.id], typeof d.region === 'string' ? d.region : undefined))[row.id] ?? {};
      traffic = {
        netIn: m.netIn ?? null, netOut: m.netOut ?? null,
        pktIn: m.pktIn ?? null, pktOut: m.pktOut ?? null,
      };
    } catch { /* traffic omitted */ }
    return Response.json({
      found: true,
      instanceId: row.id,
      ipv4PerEni,
      traffic,
      instanceType: (d.instance_type as string | undefined) ?? null,
      maxEnis,
      eniCount: enis.length,
      totalIps: enis.reduce((s, e) => s + e.ips, 0),
      enis,
    });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
