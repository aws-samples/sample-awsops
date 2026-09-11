import {
  EC2Client,
  DescribeTransitGatewayAttachmentsCommand,
  DescribeTransitGatewayRouteTablesCommand,
  DescribeTransitGatewayVpcAttachmentsCommand,
  SearchTransitGatewayRoutesCommand,
  type TransitGatewayVpcAttachment,
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
  /** VPC-attachment options (gap L168 — v1's row-click options JSON). The API exposes
   *  options per attachment TYPE; only `vpc` attachments carry them — others stay null.
   *  A null on a VPC attachment can also mean the options describe was denied/failed for
   *  its region — that state is disclosed via TgwDetails.optionsDegradedRegions, never
   *  silently conflated with "not a VPC attachment". Missing individual fields are null. */
  options: { dnsSupport: string | null; ipv6Support: string | null; applianceModeSupport: string | null } | null;
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
export interface TgwDetails {
  attachments: TgwAttachment[];
  routeTables: TgwRouteTable[];
  // regions whose describe failed — their attachments/routeTables are MISSING, not empty (honest-degrade)
  degradedRegions?: string[];
  // regions whose VPC-attachment OPTIONS describe failed (denied/throttled) while the main
  // describes succeeded — their VPC attachments render without options, and the UI must not
  // present that as "not a VPC attachment" (same honest-degrade contract as degradedRegions).
  optionsDegradedRegions?: string[];
}

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
      degradedRegions: parts.flatMap((p) => p.degradedRegions ?? []),
      optionsDegradedRegions: parts.flatMap((p) => p.optionsDegradedRegions ?? []),
    };
  });
}

async function tgwRegionDetails(region: string, ids: string[]): Promise<TgwDetails> {
  try {
    const [att, rtb, vpcAtt] = await Promise.all([
      ec2(region).send(new DescribeTransitGatewayAttachmentsCommand({
        Filters: [{ Name: 'transit-gateway-id', Values: ids }], MaxResults: 200,
      })),
      ec2(region).send(new DescribeTransitGatewayRouteTablesCommand({
        Filters: [{ Name: 'transit-gateway-id', Values: ids }], MaxResults: 50,
      })),
      // VPC-attachment options (gap L168): read-only describes per region — options are only
      // exposed on the per-type API. NextToken is followed (the general attachment list's
      // MaxResults cap is pre-existing; without pagination HERE a displayed row past page 1
      // would silently read '—'). EVERY incomplete-view path is disclosed as incomplete —
      // never conflated with "not a VPC attachment": a failed page (already-fetched pages are
      // KEPT — a throttle on page 3 must not blank pages 1-2), a leftover NextToken after the
      // page cap, and (reconciled below) a VPC-type row the response never returned.
      (async () => {
        const out: TransitGatewayVpcAttachment[] = [];
        let token: string | undefined;
        try {
          for (let page = 0; page < 5; page += 1) {
            const r = await ec2(region).send(new DescribeTransitGatewayVpcAttachmentsCommand({
              Filters: [{ Name: 'transit-gateway-id', Values: ids }], MaxResults: 200,
              ...(token ? { NextToken: token } : {}),
            }));
            out.push(...(r.TransitGatewayVpcAttachments ?? []));
            token = r.NextToken;
            if (!token) break;
          }
          // leftover token after the page cap = truncated view, NOT success
          return { list: out, incomplete: Boolean(token) };
        } catch (e) {
          // error NAME only (AccessDenied vs Throttling matters in the merge→apply window;
          // never the raw message — it can carry payload)
          console.warn(`[tgw] options describe failed (${region}):`, e instanceof Error ? e.name : 'unknown');
          return { list: out, incomplete: true };
        }
      })(),
    ]);
    let optionsDegraded = vpcAtt.incomplete;
    const optById = new Map<string, TgwAttachment['options']>();
    for (const v of vpcAtt.list) {
      if (!v.TransitGatewayAttachmentId || !v.Options) continue;
      optById.set(v.TransitGatewayAttachmentId, {
        dnsSupport: v.Options.DnsSupport ?? null,
        ipv6Support: v.Options.Ipv6Support ?? null,
        applianceModeSupport: v.Options.ApplianceModeSupport ?? null,
      });
    }
    const attachments: TgwAttachment[] = (att.TransitGatewayAttachments ?? []).map((a) => ({
      id: a.TransitGatewayAttachmentId ?? '', tgwId: a.TransitGatewayId ?? '',
      resourceType: a.ResourceType ?? '?', resourceId: a.ResourceId ?? '',
      state: a.State ?? '?', routeTableId: a.Association?.TransitGatewayRouteTableId ?? null,
      options: optById.get(a.TransitGatewayAttachmentId ?? '') ?? null,
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
    // Reconciliation: a VPC-TYPE attachment the (successful) options response never returned
    // (e.g. a RAM-shared cross-account attachment) is an INCOMPLETE options view, not a
    // non-VPC row — disclose it the same way.
    if (!optionsDegraded && attachments.some((a) => a.resourceType === 'vpc' && a.options === null)) {
      optionsDegraded = true;
    }
    return {
      attachments, routeTables,
      ...(optionsDegraded ? { optionsDegradedRegions: [region] } : {}),
    };
  } catch {
    return { attachments: [], routeTables: [], degradedRegions: [region] }; // per-region degrade
  }
}
