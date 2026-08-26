import {
  EC2Client,
  DescribeTransitGatewayAttachmentsCommand,
  DescribeTransitGatewayRouteTablesCommand,
  SearchTransitGatewayRoutesCommand,
} from '@aws-sdk/client-ec2';

// Transit Gateway 상세 (inventory transit_gateway 페이지 하단 테이블): 어태치먼트 +
// 라우트 테이블 + 라우트(SearchTransitGatewayRoutes — active/blackhole만, 테이블당 상한).
// 라이브 EC2 API + TTL 캐시 (ip-inventory와 동일 패턴).

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
// TGW는 리전 리소스 — 타 리전 TGW(예: us-west-2)는 해당 리전 클라이언트로 조회해야 한다
// (기본 리전만 쓰면 필터 미매치로 조용히 빈 결과 — MSK DR 클러스터와 동일 함정).
const clients = new Map<string, EC2Client>();
const ec2 = (region?: string) => {
  const r = region || REGION;
  let c = clients.get(r);
  if (!c) { c = new EC2Client({ region: r }); clients.set(r, c); }
  return c;
};

const TTL_MS = 4 * 60_000;
const cache = new Map<string, { at: number; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().then((v) => {
    cache.set(key, { at: Date.now(), v });
    return v;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export function _resetTgwCacheForTests() { cache.clear(); inflight.clear(); clients.clear(); }

export interface TgwAttachment {
  id: string; tgwId: string; resourceType: string; resourceId: string;
  state: string; routeTableId: string | null;
}
export interface TgwRoute {
  cidr: string; type: string; state: string;
  resourceId: string | null; resourceType: string | null;
}
export interface TgwRouteTable {
  id: string; tgwId: string; state: string;
  defaultAssociation: boolean; defaultPropagation: boolean;
  routes: TgwRoute[];
  /** SearchTransitGatewayRoutes 상한 도달 여부 (routes가 전량이 아닐 수 있음). */
  truncated: boolean;
}
export interface TgwDetails { attachments: TgwAttachment[]; routeTables: TgwRouteTable[] }

const ROUTE_CAP = 100;

/** 여러 TGW의 어태치먼트 + 라우트 테이블(+라우트)을 한 번에 조회 — TGW 소속 리전별로 그룹 실행. */
export async function tgwDetails(tgws: { id: string; region?: string }[]): Promise<TgwDetails> {
  const uniq = [...new Map(tgws.map((t) => [t.id, t])).values()].slice(0, 20);
  if (uniq.length === 0) return { attachments: [], routeTables: [] };
  const key = uniq.map((t) => `${t.id}@${t.region ?? ''}`).sort().join(',');
  return cached(`d|${key}`, async () => {
    const byRegion = new Map<string, string[]>();
    for (const t of uniq) {
      const r = t.region || REGION;
      byRegion.set(r, [...(byRegion.get(r) ?? []), t.id]);
    }
    const parts = await Promise.all([...byRegion.entries()].map(([region, ids]) => tgwRegionDetails(region, ids)));
    return {
      attachments: parts.flatMap((p) => p.attachments),
      routeTables: parts.flatMap((p) => p.routeTables),
    };
  });
}

async function tgwRegionDetails(region: string, ids: string[]): Promise<TgwDetails> {
  try {
    const [att, rtb] = await Promise.all([
      ec2(region).send(new DescribeTransitGatewayAttachmentsCommand({
        Filters: [{ Name: 'transit-gateway-id', Values: ids }], MaxResults: 200,
      })),
      ec2(region).send(new DescribeTransitGatewayRouteTablesCommand({
        Filters: [{ Name: 'transit-gateway-id', Values: ids }], MaxResults: 50,
      })),
    ]);
    const attachments: TgwAttachment[] = (att.TransitGatewayAttachments ?? []).map((a) => ({
      id: a.TransitGatewayAttachmentId ?? '', tgwId: a.TransitGatewayId ?? '',
      resourceType: a.ResourceType ?? '?', resourceId: a.ResourceId ?? '',
      state: a.State ?? '?', routeTableId: a.Association?.TransitGatewayRouteTableId ?? null,
    }));
    const routeTables: TgwRouteTable[] = await Promise.all(
      (rtb.TransitGatewayRouteTables ?? []).map(async (t) => {
        const id = t.TransitGatewayRouteTableId ?? '';
        let routes: TgwRoute[] = [];
        let truncated = false;
        try {
          const r = await ec2(region).send(new SearchTransitGatewayRoutesCommand({
            TransitGatewayRouteTableId: id,
            Filters: [{ Name: 'state', Values: ['active', 'blackhole'] }],
            MaxResults: ROUTE_CAP,
          }));
          truncated = r.AdditionalRoutesAvailable ?? false;
          routes = (r.Routes ?? []).map((x) => ({
            cidr: x.DestinationCidrBlock ?? '', type: x.Type ?? '?', state: x.State ?? '?',
            resourceId: x.TransitGatewayAttachments?.[0]?.ResourceId ?? null,
            resourceType: x.TransitGatewayAttachments?.[0]?.ResourceType ?? null,
          }));
        } catch { /* per-table degrade — 빈 라우트로 두고 테이블 자체는 표시 */ }
        return {
          id, tgwId: t.TransitGatewayId ?? '', state: t.State ?? '?',
          defaultAssociation: t.DefaultAssociationRouteTable ?? false,
          defaultPropagation: t.DefaultPropagationRouteTable ?? false,
          routes, truncated,
        };
      }),
    );
    return { attachments, routeTables };
  } catch {
    return { attachments: [], routeTables: [] }; // per-region degrade
  }
}
