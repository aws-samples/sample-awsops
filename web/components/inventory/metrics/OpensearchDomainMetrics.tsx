'use client';
import { useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { useI18n } from '@/components/shell/LanguageProvider';
import DiagnosisGuide from './DiagnosisGuide';
import { OS_GUIDE } from './guides';
import MetricTable, { type MetricCol } from './MetricTable';
import { type Row, num, dash, cnt, ms, meter, RangePicker, useFleet } from './shared';

// ── OpenSearch: per-domain metric rows (v1 도메인 메트릭) ──
// 기간별 조회(RangePicker) + 컬럼 정렬/검색/facet/문제만 필터는 MetricTable이 제공.

type Item = { row: Row; m: Record<string, number | null> };

export function OpensearchDomainMetrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const [range, setRange] = useState(3600);
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 200), [rows]);
  const { fleet, err } = useFleet('opensearch', ids, range);

  const items: Item[] = useMemo(
    () => rows.map((row) => ({ row, m: fleet[String(row.resource_id)] ?? {} })),
    [rows, fleet],
  );
  if (rows.length === 0) return null;

  const clusterStatus = (m: Record<string, number | null>): string | null =>
    (num(m.red) ?? 0) >= 1 ? 'RED' : (num(m.yellow) ?? 0) >= 1 ? 'YELLOW' : (num(m.green) ?? 0) >= 1 ? 'GREEN' : null;

  const domainCols: MetricCol<Item>[] = [
    { key: 'id', label: 'Domain', mono: true, value: (it) => String(it.row.resource_id) },
    { key: 'engine', label: 'Engine', facet: true, value: (it) => (typeof it.row.engine_type === 'string' ? it.row.engine_type : null) },
    { key: 'version', label: 'Version', mono: true, value: (it) => (typeof it.row.engine_version === 'string' ? it.row.engine_version : null) },
    {
      key: 'status', label: 'Cluster Status', facet: true,
      value: (it) => clusterStatus(it.m),
      render: (it) => {
        const s = clusterStatus(it.m);
        return s ? (
          <Badge tone={s === 'GREEN' ? 'positive' : s === 'YELLOW' ? 'brand' : 'negative'} variant="soft" dot>{s}</Badge>
        ) : dash;
      },
      danger: (it) => clusterStatus(it.m) === 'RED',
    },
    { key: 'cpu', label: 'CPU', type: 'num', value: (it) => num(it.m.cpu), render: (it) => meter(num(it.m.cpu)) },
    { key: 'jvm', label: 'JVM Memory', type: 'num', value: (it) => num(it.m.jvm), render: (it) => meter(num(it.m.jvm)) },
    { key: 'nodes', label: 'Nodes', type: 'num', value: (it) => num(it.m.nodes), render: (it) => cnt(num(it.m.nodes)) },
    { key: 'docs', label: 'Documents', type: 'num', value: (it) => num(it.m.docs), render: (it) => cnt(num(it.m.docs)) },
    {
      key: 'freeStorage', label: 'Free Storage', type: 'num',
      value: (it) => num(it.m.freeStorage),
      render: (it) => { const v = num(it.m.freeStorage); return v == null ? dash : `${(v / 1024).toFixed(1)} GB`; },
    },
    {
      key: 'searchRate', label: 'Search Rate', type: 'num', title: tt('선택 기간 누적'),
      value: (it) => num(it.m.searchRate),
      render: (it) => { const v = num(it.m.searchRate); return v == null ? dash : v.toFixed(1); },
    },
    { key: 'searchLatency', label: 'Search Latency', type: 'num', value: (it) => num(it.m.searchLatency), render: (it) => ms(num(it.m.searchLatency)) },
    {
      key: 'indexRate', label: 'Index Rate', type: 'num', title: tt('선택 기간 누적'),
      value: (it) => num(it.m.indexRate),
      render: (it) => { const v = num(it.m.indexRate); return v == null ? dash : v.toFixed(1); },
    },
    { key: 'indexLatency', label: 'Index Latency', type: 'num', value: (it) => num(it.m.indexLatency), render: (it) => ms(num(it.m.indexLatency)) },
  ];

  // 진단 지표 (owner 가이드): 쓰기 차단·스레드풀 큐/거부·마스터 병목·스냅샷 실패 — 포화 신호
  const diagCols: MetricCol<Item>[] = [
    { key: 'id', label: 'Domain', mono: true, value: (it) => String(it.row.resource_id) },
    {
      key: 'writesBlocked', label: 'Writes Blocked', facet: true,
      title: tt('ClusterIndexWritesBlocked — 값 1 = 쓰기 차단 (디스크 부족/JVM 압박/red). 매우 중요한 경보 지표'),
      value: (it) => { const v = num(it.m.writesBlocked); return v == null ? null : v >= 1 ? 'BLOCKED' : 'OK'; },
      danger: (it) => { const v = num(it.m.writesBlocked); return v != null && v >= 1; },
    },
    {
      key: 'masterCpu', label: 'Master CPU', type: 'num', title: tt('MasterCPUUtilization — 전용 마스터 포화 시 샤드 할당·상태 갱신 지연'),
      value: (it) => num(it.m.masterCpu), render: (it) => meter(num(it.m.masterCpu)),
    },
    {
      key: 'searchQueue', label: 'Search Queue', type: 'num', title: tt('ThreadpoolSearchQueue — 큐가 쌓이면 검색 처리 지연 중'),
      value: (it) => num(it.m.searchQueue), render: (it) => cnt(num(it.m.searchQueue)),
    },
    {
      key: 'writeQueue', label: 'Write Queue', type: 'num', title: tt('ThreadpoolWriteQueue — 큐가 쌓이면 인덱싱 처리 지연 중'),
      value: (it) => num(it.m.writeQueue), render: (it) => cnt(num(it.m.writeQueue)),
    },
    {
      key: 'searchRejected', label: 'Search Rejected', type: 'num', title: tt('ThreadpoolSearchRejected — >0이면 클라이언트가 에러를 받는 중 → 즉시 조사'),
      value: (it) => num(it.m.searchRejected), render: (it) => cnt(num(it.m.searchRejected)),
      danger: (it) => { const v = num(it.m.searchRejected); return v != null && v > 0; },
    },
    {
      key: 'writeRejected', label: 'Write Rejected', type: 'num', title: tt('ThreadpoolWriteRejected — >0이면 쓰기 거부(포화) → 즉시 조사'),
      value: (it) => num(it.m.writeRejected), render: (it) => cnt(num(it.m.writeRejected)),
      danger: (it) => { const v = num(it.m.writeRejected); return v != null && v > 0; },
    },
    {
      key: 'diskQueue', label: 'Disk Queue', type: 'num', title: tt('DiskQueueDepth — 높으면 I/O 병목'),
      value: (it) => num(it.m.diskQueue),
      render: (it) => { const v = num(it.m.diskQueue); return v == null ? dash : v.toFixed(1); },
    },
    {
      key: 'http5xx', label: '5xx', type: 'num', title: tt('5xx(선택 기간 누적) — 급증 시 서버 측 이상'),
      value: (it) => num(it.m.http5xx), render: (it) => cnt(num(it.m.http5xx)),
      danger: (it) => { const v = num(it.m.http5xx); return v != null && v > 0; },
    },
    {
      key: 'snapshotFail', label: 'Snapshot Fail', facet: true,
      title: tt('AutomatedSnapshotFailure — 값 1 = 자동 스냅샷(백업) 실패'),
      value: (it) => { const v = num(it.m.snapshotFail); return v == null ? null : v >= 1 ? 'FAIL' : 'OK'; },
      danger: (it) => { const v = num(it.m.snapshotFail); return v != null && v >= 1; },
    },
  ];

  return (
    <Card
      title={tt('도메인 메트릭')}
      subtitle={`${ids.length} domains · CloudWatch AWS/ES · ${tt('값은 선택 기간 전체 집계')}`}
      right={<RangePicker value={range} onChange={setRange} />}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패')}: {err}</div>}
      <MetricTable columns={domainCols} items={items} rowKey={(it) => String(it.row.resource_id)} />

      <div className="border-t border-ink-100">
        <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">{tt('진단 지표')}</div>
        <MetricTable columns={diagCols} items={items} rowKey={(it) => String(it.row.resource_id)} />
      </div>

      <DiagnosisGuide spec={OS_GUIDE} />
    </Card>
  );
}
