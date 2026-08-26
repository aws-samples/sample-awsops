'use client';
import { useEffect, useMemo, useState } from 'react';
import { Cable, CheckCircle2, DollarSign, Globe, List, Network, Search, Unplug } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import StatTile from '@/components/ui/StatTile';
import Badge from '@/components/ui/Badge';
import Input from '@/components/ui/Input';
import DetailPanel from '@/components/ui/DetailPanel';
import MetricTable, { type MetricCol } from '@/components/inventory/metrics/MetricTable';
import { TH, MONO, DANGER, dash } from '@/components/inventory/metrics/shared';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { EniRow, EipRow, PodIpInfo } from '@/lib/ip-inventory';
import type { InvType } from '@/lib/inventory-types';

// /ip-addresses — IP 인벤토리/조회. 계정의 모든 IP는 ENI에 귀속되므로 ENI 전량이 원천이고,
// EIP(미사용 public IP = 유휴 과금)와 EKS 파드 IP(VPC CNI 보조 IP)를 조인해
// "어떤 IP가 어느 리소스에서 쓰이는지"를 한 번의 검색으로 답한다.
// 데이터 계층은 lib/ip-inventory.ts(4분 TTL 캐시)가 담당 — 이 페이지는 GET /api/ip-inventory 1회만 소비.

interface IpResp {
  summary: {
    eniTotal: number; eniInUse: number; eniAvailable: number;
    publicIps: number; privateIps: number; eipTotal: number; eipUnused: number;
  };
  enis: EniRow[];
  eips: EipRow[];
  podsByIp: Record<string, PodIpInfo>;
}

// 상세 패널을 인벤토리 상세와 같은 섹션 카드 디자인으로 렌더하기 위한 최소 spec —
// sections가 있으면 DetailPanel이 아이콘 있는 섹션 + 친화적 라벨 포맷을 쓴다 (FLOW_DETAIL_SPEC 선례).
const ENI_DETAIL_SPEC: InvType = {
  label: 'ENI', group: 'Network', stateKey: 'status',
  columns: [
    { key: 'id', label: 'ENI ID' }, { key: 'status', label: 'Status' }, { key: 'kind', label: 'Kind' },
    { key: 'resource', label: 'Resource' }, { key: 'description', label: 'Description' },
    { key: 'private_ips', label: 'Private IPs' }, { key: 'public_ip', label: 'Public IP' },
    { key: 'pods', label: 'Pods' },
    { key: 'subnet_id', label: 'Subnet' }, { key: 'vpc_id', label: 'VPC' },
    { key: 'az', label: 'AZ' }, { key: 'instance_id', label: 'Instance' },
  ],
  sections: [
    { label: 'Identity', keys: ['id', 'status', 'kind', 'resource', 'description'] },
    { label: 'IP Addresses', keys: ['private_ips', 'public_ip'] },
    { label: 'Pods', keys: ['pods'] },
    { label: 'Network', keys: ['subnet_id', 'vpc_id', 'az', 'instance_id'] },
  ],
};

/** 상세 패널용 flat 뷰 — 빈 필드는 제외. privateIps/pods는 문자열 배열로 넘겨 한 줄에 하나씩 렌더. */
function eniDetail(e: EniRow, podsByIp: Record<string, PodIpInfo>): Record<string, unknown> {
  const pods = e.privateIps
    .map((ip) => { const p = podsByIp[ip]; return p ? `${p.cluster} · ${p.namespace}/${p.name} (${ip})` : null; })
    .filter((x): x is string => x != null);
  const all: Record<string, unknown> = {
    id: e.id, status: e.status, kind: e.kind, resource: e.resource, description: e.description,
    private_ips: e.privateIps, public_ip: e.publicIp,
    pods: pods.length ? pods : undefined,
    subnet_id: e.subnetId, vpc_id: e.vpcId, az: e.az, instance_id: e.instanceId,
  };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v != null && v !== ''));
}

/** ENI가 검색어(부분 일치 IP)에 걸리는지 — privateIps 또는 publicIp. */
function eniMatches(e: EniRow, needle: string): boolean {
  return e.privateIps.some((ip) => ip.includes(needle)) || (e.publicIp?.includes(needle) ?? false);
}

export default function IpAddressesPage() {
  const { tt } = useI18n();
  const [data, setData] = useState<IpResp | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<EniRow | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/ip-inventory')
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
        return d as IpResp;
      })
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  const needle = q.trim();

  // 검색어에 부분 일치하는 IP 전체 (ENI private/public + EIP + 파드 IP) — 정확히 1개면 매칭 요약 카드.
  const matchedIps = useMemo(() => {
    if (!data || !needle) return [];
    const set = new Set<string>();
    for (const e of data.enis) {
      for (const ip of e.privateIps) if (ip.includes(needle)) set.add(ip);
      if (e.publicIp?.includes(needle)) set.add(e.publicIp);
    }
    for (const a of data.eips) if (a.publicIp.includes(needle)) set.add(a.publicIp);
    for (const ip of Object.keys(data.podsByIp)) if (ip.includes(needle)) set.add(ip);
    return [...set];
  }, [data, needle]);

  const match = useMemo(() => {
    if (!data || matchedIps.length !== 1) return null;
    const ip = matchedIps[0];
    return {
      ip,
      eni: data.enis.find((e) => e.privateIps.includes(ip) || e.publicIp === ip) ?? null,
      eip: data.eips.find((a) => a.publicIp === ip) ?? null,
      pod: data.podsByIp[ip] ?? null,
    };
  }, [data, matchedIps]);
  const matchEni = match?.eni ?? null;

  // 메인 ENI 테이블은 상단 IP 검색과 연동 필터 (테이블 자체 검색/facet은 MetricTable 내장).
  const shownEnis = useMemo(() => {
    if (!data) return [];
    return needle ? data.enis.filter((e) => eniMatches(e, needle)) : data.enis;
  }, [data, needle]);

  const unusedEips = useMemo(() => data?.eips.filter((a) => a.unused) ?? [], [data]);
  const availEnis = useMemo(() => data?.enis.filter((e) => e.status === 'available') ?? [], [data]);

  const podsByIp = data?.podsByIp ?? {};
  const columns = useMemo<MetricCol<EniRow>[]>(() => [
    {
      key: 'ip', label: 'IP', mono: true,
      title: tt('프라이빗 IP — 여러 개면 첫 IP + 나머지 개수'),
      value: (e) => (e.privateIps.length ? e.privateIps.join(', ') : null),
      render: (e) => e.privateIps.length
        ? (
          <span title={e.privateIps.join(', ')}>
            {e.privateIps[0]}
            {e.privateIps.length > 1 && <span className="text-ink-400"> +{e.privateIps.length - 1}</span>}
          </span>
        )
        : dash,
    },
    { key: 'publicIp', label: 'Public IP', mono: true, value: (e) => e.publicIp },
    { key: 'kind', label: 'Kind', facet: true, value: (e) => e.kind },
    { key: 'resource', label: 'Resource', mono: true, value: (e) => e.resource },
    {
      key: 'pod', label: 'Pod', mono: true,
      title: tt('해당 IP를 쓰는 EKS 파드 (VPC CNI 보조 IP 조인)'),
      value: (e) => {
        const p = e.privateIps.map((ip) => podsByIp[ip]).find(Boolean);
        return p ? `${p.namespace}/${p.name}` : null;
      },
    },
    { key: 'subnet', label: 'Subnet', facet: true, mono: true, value: (e) => e.subnetId || null },
    { key: 'az', label: 'AZ', facet: true, value: (e) => e.az || null },
    {
      key: 'status', label: 'Status', facet: true,
      title: tt('available = 어디에도 부착되지 않은 ENI'),
      value: (e) => e.status || null,
      danger: (e) => e.status === 'available',
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [tt, data]);

  const s = data?.summary;
  const bothUnused = unusedEips.length > 0 && availEnis.length > 0;

  return (
    <>
      <PageHeader
        title="IP Addresses"
        subtitle="ENI 전량 + EIP + EKS 파드 IP를 조인해 어떤 IP가 어느 리소스에서 쓰이는지 조회하고, 미사용 public IP(EIP)를 찾습니다"
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {err && (
          <div className="text-[13px] text-rose-600">{tt('IP 인벤토리 조회 실패')}: {err}</div>
        )}
        {!data && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}

        {data && s && (
          <>
            {/* ① 대형 IP 검색 — 부분 일치로 ENI/EIP/파드 IP를 필터, 정확히 1개 IP면 즉답 카드 */}
            <Card>
              <Input
                icon={<Search size={15} />}
                placeholder={tt('IP 검색 — 예: 10.0.1.23 (부분 일치)')}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="h-[44px] pl-9 font-mono text-[15px]"
                aria-label="IP search"
              />
              {match && (
                <div
                  role={matchEni ? 'button' : undefined}
                  onClick={matchEni ? () => setSelected(matchEni) : undefined}
                  title={matchEni ? tt('클릭하여 상세 보기') : undefined}
                  className={`mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-brand-200 bg-brand-500/5 px-4 py-3 ${matchEni ? 'cursor-pointer hover:border-brand-300' : ''}`}
                >
                  <span className="font-mono text-[15px] font-semibold text-ink-800">{match.ip}</span>
                  <span className="text-ink-300">→</span>
                  {matchEni && (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <Badge tone="brand" variant="soft">{matchEni.kind}</Badge>
                      <span className="font-mono text-[12.5px] text-ink-700">{matchEni.resource ?? matchEni.id}</span>
                      <span className="text-[11.5px] text-ink-400">
                        ({[matchEni.id, matchEni.instanceId].filter(Boolean).join(' · ')})
                      </span>
                    </span>
                  )}
                  {match.eip && (
                    <span className="inline-flex items-center gap-1.5">
                      <Badge tone={match.eip.unused ? 'negative' : 'neutral'} variant="soft">EIP</Badge>
                      <span className="font-mono text-[11.5px] text-ink-500">{match.eip.allocationId}</span>
                      {match.eip.unused && (
                        <span className="text-[11.5px] font-semibold text-rose-600">{tt('미사용 — 유휴 과금 발생')}</span>
                      )}
                    </span>
                  )}
                  {match.pod && (
                    <span className="inline-flex items-center gap-1.5">
                      <Badge tone="positive" variant="soft">Pod</Badge>
                      <span className="font-mono text-[11.5px] text-ink-700">
                        {match.pod.cluster} · {match.pod.namespace}/{match.pod.name}
                      </span>
                    </span>
                  )}
                </div>
              )}
            </Card>

            {/* ② KPI — 미부착 ENI(>0 warn) + 미사용 EIP(>0 danger, 유휴 과금) */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <StatTile label="총 ENI" value={s.eniTotal} icon={<Network size={16} />} />
              <StatTile label="사용 중" value={s.eniInUse} icon={<Cable size={16} />} />
              <StatTile
                label="미부착 ENI"
                value={s.eniAvailable}
                variant={s.eniAvailable > 0 ? 'warn' : 'default'}
                hint="available"
                icon={<Unplug size={16} />}
              />
              <StatTile label="Public IP" value={s.publicIps} icon={<Globe size={16} />} />
              <StatTile
                label="미사용 EIP"
                value={s.eipUnused}
                variant={s.eipUnused > 0 ? 'danger' : 'default'}
                hint={s.eipUnused > 0 ? tt('유휴 과금 발생') : `EIP ${s.eipTotal}`}
                icon={<DollarSign size={16} />}
              />
              <StatTile label="프라이빗 IP" value={s.privateIps} icon={<List size={16} />} />
            </div>

            {/* ③ 미사용 리소스 — 연결 안 된 EIP(유휴 과금) + available ENI. 둘 다 0이면 초록 한 줄 */}
            <Card
              title="미사용 리소스"
              subtitle="연결 안 된 EIP(유휴 과금) + 미부착(available) ENI"
              padded={false}
            >
              {unusedEips.length === 0 && availEnis.length === 0 ? (
                <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-emerald-700">
                  <CheckCircle2 size={15} />
                  {tt('이상 없음 — 미사용 public IP/ENI 없음')}
                </div>
              ) : (
                <div className={`grid divide-y divide-ink-100 ${bothUnused ? 'lg:grid-cols-2 lg:divide-y-0 lg:divide-x' : ''}`}>
                  {unusedEips.length > 0 && (
                    <div className="pb-2">
                      <div className="px-4 pt-3 pb-1 text-[12px] font-semibold text-rose-600">
                        {tt('연결 안 된 EIP — 유휴 과금 발생 중')} ({unusedEips.length})
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead><tr className="border-b border-ink-100">
                            <th className={TH}>Allocation ID</th>
                            <th className={TH}>Public IP</th>
                          </tr></thead>
                          <tbody>
                            {unusedEips.map((a) => (
                              <tr key={a.allocationId} className="border-b border-ink-50 last:border-0">
                                <td className={MONO}>{a.allocationId}</td>
                                <td className={`${MONO} ${DANGER}`}>{a.publicIp}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  {availEnis.length > 0 && (
                    <div className="pb-2">
                      <div className="px-4 pt-3 pb-1 text-[12px] font-semibold text-ink-600">
                        {tt('미부착(available) ENI')} ({availEnis.length})
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead><tr className="border-b border-ink-100">
                            <th className={TH}>ENI ID</th>
                            <th className={TH}>Kind</th>
                            <th className={TH}>Subnet</th>
                            <th className={TH}>AZ</th>
                          </tr></thead>
                          <tbody>
                            {availEnis.map((e) => (
                              <tr
                                key={e.id}
                                onClick={() => setSelected(e)}
                                className="cursor-pointer border-b border-ink-50 last:border-0 hover:bg-ink-50"
                              >
                                <td className={MONO}>{e.id}</td>
                                <td className={MONO}>{e.kind}</td>
                                <td className={MONO}>{e.subnetId || dash}</td>
                                <td className={MONO}>{e.az || dash}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card>

            {/* ④ 메인 ENI 인벤토리 — 상단 IP 검색과 연동, 행 클릭 → 상세 패널 */}
            <Card
              title="ENI 인벤토리"
              subtitle="행 클릭 → 주소·파드·네트워크 상세"
              padded={false}
            >
              <MetricTable
                columns={columns}
                items={shownEnis}
                rowKey={(e) => e.id}
                emptyText="검색과 일치하는 ENI 없음"
                onRowClick={setSelected}
              />
            </Card>
          </>
        )}
      </div>

      <DetailPanel
        title={selected?.id}
        data={selected ? eniDetail(selected, podsByIp) : null}
        spec={ENI_DETAIL_SPEC}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
