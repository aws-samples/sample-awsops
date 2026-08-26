'use client';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Boxes, DollarSign, Receipt } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import StatTile from '@/components/ui/StatTile';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import DetailPanel from '@/components/ui/DetailPanel';
import MetricTable, { type MetricCol } from '@/components/inventory/metrics/MetricTable';
import { RangePicker, dash } from '@/components/inventory/metrics/shared';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { NfmCategory, PodTransferResult, PodTransferRow } from '@/lib/nfm';
import type { InvType } from '@/lib/inventory-types';

// EKS 비용 메뉴의 "Pod 전송량 (NFM)" 섹션 — CloudWatch Network Flow Monitor의
// DATA_TRANSFERRED를 파드별로 집계한 /api/eks/<cluster>/pod-transfer를 소비한다.
// NFM 비동기 쿼리는 수 초~수십 초 걸리므로 로딩을 명확히 표기하고, cluster/range가
// 바뀔 때만 재조회한다. 실패는 rose 라인으로 degrade — 섹션/페이지를 비우지 않는다.
// 타입은 lib/nfm에서 `import type`으로만 가져온다 (AWS SDK가 클라이언트 번들에 안 들어가게).

const OTHER_CATEGORIES: readonly NfmCategory[] = ['INTER_REGION', 'AMAZON_S3', 'AMAZON_DYNAMODB', 'UNCLASSIFIED'];
// NFM 모니터 쿼리 한도: 최대 1시간 윈도우 → 프리셋을 15m/30m/1h로 제한.
const NFM_RANGES = [['15m', 900], ['30m', 1800], ['1h', 3600]] as const;

const fmtBytes = (n: number): string => {
  if (!Number.isFinite(n) || n < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
  const i = Math.min(units.length - 1, Math.floor(Math.log2(n) / 10));
  const v = n / 2 ** (10 * i);
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
};
const usd = (v: number) => (v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const catBytes = (r: PodTransferRow, c: NfmCategory) => r.byCategory[c] ?? null;
const otherBytes = (r: PodTransferRow) => OTHER_CATEGORIES.reduce((s, c) => s + (r.byCategory[c] ?? 0), 0);
/** local endpoint 표기: pod면 ns/name, 아니면 key의 instance/ip (prefix 제거). */
const podLabel = (r: PodTransferRow) => (r.podName ? `${r.namespace ?? '-'}/${r.podName}` : r.key.replace(/^(i:|ip:)/, ''));

const catCol = (cat: NfmCategory): MetricCol<PodTransferRow> => ({
  key: cat,
  label: cat,
  type: 'num',
  value: (r) => catBytes(r, cat),
  render: (r) => {
    const v = catBytes(r, cat);
    return v == null ? dash : fmtBytes(v);
  },
});

// 상세 패널을 인벤토리 상세와 같은 섹션 카드 디자인으로 렌더하기 위한 최소 spec.
const XFER_DETAIL_SPEC: InvType = {
  label: 'Pod Transfer', group: 'Compute',
  columns: [
    { key: 'pod', label: 'Pod' }, { key: 'namespace', label: 'Namespace' }, { key: 'service', label: 'Service' },
    { key: 'total_transfer', label: 'Total Transfer' },
    { key: 'INTRA_AZ', label: 'INTRA_AZ' }, { key: 'INTER_AZ', label: 'INTER_AZ' }, { key: 'INTER_VPC', label: 'INTER_VPC' },
    { key: 'INTER_REGION', label: 'INTER_REGION' }, { key: 'AMAZON_S3', label: 'AMAZON_S3' },
    { key: 'AMAZON_DYNAMODB', label: 'AMAZON_DYNAMODB' }, { key: 'UNCLASSIFIED', label: 'UNCLASSIFIED' },
    { key: 'billable_transfer', label: 'Billable Transfer' }, { key: 'est_usd', label: 'Est. Cost (USD)' },
  ],
  sections: [
    { label: 'Identity', keys: ['pod', 'namespace', 'service'] },
    { label: 'Network Transfer', keys: ['total_transfer', 'INTRA_AZ', 'INTER_AZ', 'INTER_VPC', 'INTER_REGION', 'AMAZON_S3', 'AMAZON_DYNAMODB', 'UNCLASSIFIED'] },
    { label: 'Cost', keys: ['billable_transfer', 'est_usd'] },
  ],
};

/** 상세 패널용 flat 뷰 — 빈 카테고리는 제외. */
function xferDetail(r: PodTransferRow): Record<string, unknown> {
  const cats = Object.fromEntries(
    Object.entries(r.byCategory).filter(([, v]) => (v ?? 0) > 0).map(([k, v]) => [k, fmtBytes(v ?? 0)]));
  const all: Record<string, unknown> = {
    pod: podLabel(r), namespace: r.namespace, service: r.serviceName,
    total_transfer: fmtBytes(r.bytes), ...cats,
    billable_transfer: fmtBytes(r.billableBytes), est_usd: usd(r.estUsd),
  };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v != null && v !== ''));
}

export default function PodTransferSection({ clusters }: { clusters: string[] }) {
  const { tt } = useI18n();
  const [cluster, setCluster] = useState(clusters[0] ?? '');
  const [rangeSec, setRangeSec] = useState(3600);
  const [data, setData] = useState<PodTransferResult | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<PodTransferRow | null>(null);

  // 새로고침으로 클러스터 목록이 바뀌어 선택이 무효가 되면 첫 클러스터로 복귀.
  useEffect(() => {
    if (clusters.length > 0 && !clusters.includes(cluster)) setCluster(clusters[0]);
  }, [clusters, cluster]);

  // cluster/range 변경 시에만 재조회 — 서버가 TTL 캐시 + in-flight 공유를 하므로 재선택은 저렴.
  useEffect(() => {
    if (!cluster) return;
    let alive = true;
    setLoading(true);
    setErr('');
    setSelected(null);
    fetch(`/api/eks/${encodeURIComponent(cluster)}/pod-transfer?range=${rangeSec}`)
      .then((r) => (r.ok ? (r.json() as Promise<PodTransferResult>) : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [cluster, rangeSec]);

  const columns = useMemo<MetricCol<PodTransferRow>[]>(() => [
    { key: 'pod', label: 'Pod', mono: true, value: podLabel },
    { key: 'service', label: 'Service', facet: true, value: (r) => r.serviceName },
    { key: 'namespace', label: 'Namespace', facet: true, value: (r) => r.namespace },
    { key: 'bytes', label: tt('총 전송량'), type: 'num', value: (r) => r.bytes, render: (r) => fmtBytes(r.bytes) },
    catCol('INTRA_AZ'),
    catCol('INTER_AZ'),
    catCol('INTER_VPC'),
    {
      key: 'other', label: tt('기타(합)'), title: 'INTER_REGION + AMAZON_S3 + AMAZON_DYNAMODB + UNCLASSIFIED',
      type: 'num', value: otherBytes, render: (r) => fmtBytes(otherBytes(r)),
    },
    {
      key: 'billable', label: tt('과금 전송량'), title: 'INTER_AZ + INTER_VPC + INTER_REGION',
      type: 'num', value: (r) => r.billableBytes, render: (r) => fmtBytes(r.billableBytes),
    },
    {
      key: 'estUsd', label: `${tt('추정 비용')} (USD)`, title: tt('방향당 $0.01/GB 추정'),
      type: 'num', value: (r) => r.estUsd, render: (r) => usd(r.estUsd), danger: (r) => r.estUsd > 0,
    },
  ], [tt]);

  const donutData = useMemo(() => {
    if (!data?.available) return [];
    return Object.entries(data.totals.byCategory)
      .filter(([, v]) => (v ?? 0) > 0)
      .map(([name, value]) => ({ name, value: value ?? 0 }));
  }, [data]);

  if (clusters.length === 0) return null;

  const selectCls = 'rounded-md border border-ink-200 bg-card px-2 py-1 font-mono text-[12px]';

  return (
    <Card
      padded={false}
      title="Pod 전송량 (NFM)"
      subtitle="선택 기간 전체 집계 · 방향당 $0.01/GB 추정 — 정확한 청구 아님"
      right={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <select value={cluster} onChange={(e) => setCluster(e.target.value)} className={selectCls} aria-label="Cluster">
            {clusters.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <RangePicker value={rangeSec} onChange={setRangeSec} ranges={NFM_RANGES} />
        </div>
      }
    >
      {err && (
        <div className="px-4 py-3 text-[13px] text-rose-600">{tt('조회 실패')}: {err}</div>
      )}
      {loading && (
        <div className="px-4 py-3 text-[12.5px] text-ink-400">{tt('NFM 쿼리 실행 중… (수 초~수십 초 소요)')}</div>
      )}
      {!loading && !err && !data && (
        <div className="px-4 py-3 text-[12.5px] text-ink-400">{tt('데이터 없음')}</div>
      )}

      {data && !data.available && !loading && (
        <p className="px-4 py-3 text-[13px] text-ink-600">
          {tt('해당 클러스터에 NFM 모니터가 온보딩되지 않았습니다')}{' '}
          (<code className="font-mono text-[11.5px] text-ink-500">nfm-eks-{cluster}</code>).{' '}
          {tt('CloudWatch Network Flow Monitor 온보딩 후 데이터가 표시됩니다.')}
        </p>
      )}

      {data?.available && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 px-4 py-4">
            <StatTile label="총 전송량" value={fmtBytes(data.totals.bytes)} icon={<ArrowLeftRight size={16} />} />
            <StatTile label="과금 전송량" value={fmtBytes(data.totals.billableBytes)} icon={<Receipt size={16} />} />
            <StatTile
              label="추정 비용"
              value={usd(data.totals.estUsd)}
              variant={data.totals.estUsd > 0 ? 'warn' : 'default'}
              hint={<Badge tone="brand" variant="soft">{tt('추정')}</Badge>}
              icon={<DollarSign size={16} />}
            />
            <StatTile label="파드 수" value={data.pods.length} icon={<Boxes size={16} />} />
          </div>

          {data.failedCategories.length > 0 && (
            <div className="mx-4 mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
              {tt('일부 카테고리 조회 실패')}: {data.failedCategories.join(', ')}
            </div>
          )}

          {donutData.length > 0 && (
            <div className="px-4 pb-4">
              <DonutBreakdown
                title={`${tt('카테고리별 전송량')} (bytes)`}
                data={donutData}
                nameKey="name"
                valueKey="value"
              />
            </div>
          )}

          <MetricTable
            columns={columns}
            items={data.pods}
            rowKey={(r) => r.key}
            defaultSortKey="bytes"
            onRowClick={setSelected}
          />
        </>
      )}

      <DetailPanel
        title={selected ? podLabel(selected) : undefined}
        data={selected ? xferDetail(selected) : null}
        spec={XFER_DETAIL_SPEC}
        onClose={() => setSelected(null)}
      />
    </Card>
  );
}
