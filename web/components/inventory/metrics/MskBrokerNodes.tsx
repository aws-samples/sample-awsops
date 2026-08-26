'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { useI18n } from '@/components/shell/LanguageProvider';
import DiagnosisGuide from './DiagnosisGuide';
import { MSK_GUIDE } from './guides';
import MetricTable, { type MetricCol } from './MetricTable';
import { type Row, type Fleet, num, dash, kbps, cnt, meter, RangePicker, HealthPill } from './shared';

// ── MSK: broker/controller node rows (kafka ListNodes + per-broker CloudWatch) ──
interface MskNodeRow { nodeType: string; brokerId: number | null; instanceType: string | null; clientVpcIp: string | null; eni: string | null; endpoints: string[] }
interface MskLagRow { consumerGroup: string; topic: string; maxOffsetLag: number | null }
interface MskClusterData { nodes: MskNodeRow[]; brokerMetrics: Fleet; health?: Record<string, number | null>; lags?: MskLagRow[] }

type NodeItem = { cluster: string; n: MskNodeRow; m: Record<string, number | null> };
type LagItem = { cluster: string } & MskLagRow;

export function MskBrokerNodes({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const [range, setRange] = useState(3600);
  const [data, setData] = useState<Record<string, MskClusterData>>({});
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const clusters = useMemo(
    () => rows
      .map((r) => ({ name: String(r.resource_id), arn: typeof r.arn === 'string' ? r.arn : '' }))
      .filter((c) => c.arn),
    [rows],
  );
  const key = clusters.map((c) => c.arn).join(',');

  useEffect(() => {
    if (!key) return;
    let live = true;
    Promise.all(clusters.map((c) =>
      fetch(`/api/inventory/msk/metrics?nodes=${encodeURIComponent(c.arn)}&range=${range}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => [c.name, d] as const),
    ))
      .then((pairs) => { if (live) { setData(Object.fromEntries(pairs)); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); })
      .finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, range]);

  // 브로커+컨트롤러를 하나의 목록으로 병합 — 컨트롤러는 메트릭 없음(m={} → 각 컬럼 null → dash).
  const items = useMemo<NodeItem[]>(
    () => clusters.flatMap((c) => (data[c.name]?.nodes ?? []).map((n) => ({
      cluster: c.name,
      n,
      m: n.nodeType === 'BROKER' ? (data[c.name]?.brokerMetrics?.[String(n.brokerId)] ?? {}) : {},
    }))),
    [clusters, data],
  );
  const lagItems = useMemo<LagItem[]>(
    () => clusters.flatMap((c) => (data[c.name]?.lags ?? []).map((l) => ({ cluster: c.name, ...l }))),
    [clusters, data],
  );

  if (clusters.length === 0) return null;
  const brokerCount = items.filter((x) => x.n.nodeType === 'BROKER').length;
  const controllerCount = items.length - brokerCount;

  // 클러스터별 건강성 요약: 컨트롤러/오프라인 파티션은 클러스터 레벨, URP·MinISR·디스크·CPU는 브로커 값 집계.
  const healthRows = clusters.map((c) => {
    const d = data[c.name];
    const h = d?.health ?? {};
    const bm = Object.values(d?.brokerMetrics ?? {});
    const sum = (k: string) => bm.reduce<number | null>((acc, m) => (num(m[k]) == null ? acc : (acc ?? 0) + (num(m[k]) as number)), null);
    const max = (k: string) => bm.reduce<number | null>((acc, m) => (num(m[k]) == null ? acc : Math.max(acc ?? 0, num(m[k]) as number)), null);
    const cpuMax = bm.reduce<number | null>((acc, m) => {
      const u = num(m.cpuUser); const sy = num(m.cpuSystem);
      if (u == null && sy == null) return acc;
      return Math.max(acc ?? 0, (u ?? 0) + (sy ?? 0));
    }, null);
    return {
      cluster: c.name,
      controllers: num(h.activeControllers),
      offline: num(h.offlinePartitions),
      urp: sum('urp'),
      minIsr: sum('underMinIsr'),
      dataDiskMax: max('dataDisk'),
      rootDiskMax: max('rootDisk'),
      cpuMax,
    };
  });
  const fmtN = (v: number | null) => (v == null ? '—' : Math.round(v).toLocaleString());
  const fmtPct = (v: number | null) => (v == null ? '—' : `${v.toFixed(0)}%`);

  // 셀 파생값 — value()는 정렬용 원시 숫자, render()는 표시용.
  const cpuOf = (m: Record<string, number | null>): number | null => {
    const u = num(m.cpuUser); const s = num(m.cpuSystem);
    return u == null && s == null ? null : (u ?? 0) + (s ?? 0);
  };
  const memPctOf = (m: Record<string, number | null>): number | null => {
    const used = num(m.memUsed); const free = num(m.memFree);
    return used != null && free != null && used + free > 0 ? (used / (used + free)) * 100 : null;
  };
  const throttleOf = (m: Record<string, number | null>): number | null => {
    const p = num(m.produceThrottle); const f = num(m.fetchThrottle);
    return p == null && f == null ? null : Math.max(p ?? 0, f ?? 0);
  };

  const nodeCols: MetricCol<NodeItem>[] = [
    { key: 'cluster', label: 'Cluster', mono: true, facet: true, value: (it) => it.cluster },
    {
      key: 'type', label: 'Type', facet: true,
      value: (it) => (it.n.nodeType === 'BROKER' ? 'BROKER' : 'CTRL'),
      render: (it) => (it.n.nodeType === 'BROKER'
        ? <Badge tone="brand" variant="soft">BROKER</Badge>
        : <Badge tone="neutral" variant="soft">CTRL</Badge>),
    },
    { key: 'id', label: 'ID', type: 'num', value: (it) => it.n.brokerId },
    { key: 'instance', label: 'Instance', mono: true, value: (it) => (it.n.nodeType === 'BROKER' ? it.n.instanceType : 'KRaft') },
    { key: 'ip', label: 'VPC IP', mono: true, value: (it) => it.n.clientVpcIp },
    {
      key: 'cpu', label: 'CPU', type: 'num', title: tt('CpuUser + CpuSystem — 60% 초과 시 경보 권장'),
      value: (it) => cpuOf(it.m), render: (it) => meter(cpuOf(it.m)),
      danger: (it) => { const v = cpuOf(it.m); return v != null && v > 60; },
    },
    {
      key: 'mem', label: 'Memory', type: 'num',
      value: (it) => memPctOf(it.m), render: (it) => meter(memPctOf(it.m)),
    },
    {
      key: 'disk', label: 'Data Disk', type: 'num', title: tt('KafkaDataLogsDiskUsed — 85% 초과 위험 (가장 흔한 장애 원인)'),
      value: (it) => num(it.m.dataDisk), render: (it) => meter(num(it.m.dataDisk)),
      danger: (it) => { const v = num(it.m.dataDisk); return v != null && v > 85; },
    },
    { key: 'netIn', label: 'Net In', type: 'num', value: (it) => num(it.m.bytesIn), render: (it) => kbps(num(it.m.bytesIn)) },
    { key: 'netOut', label: 'Net Out', type: 'num', value: (it) => num(it.m.bytesOut), render: (it) => kbps(num(it.m.bytesOut)) },
    { key: 'msgs', label: 'Msgs/s', type: 'num', value: (it) => num(it.m.msgsIn), render: (it) => cnt(num(it.m.msgsIn)) },
    {
      key: 'throttle', label: 'Throttle', type: 'num', title: tt('ProduceThrottleTime / FetchThrottleTime 중 최대값 (ms)'),
      value: (it) => throttleOf(it.m),
      render: (it) => { const v = throttleOf(it.m); return v != null && v > 0 ? `${v.toFixed(1)} ms` : dash; },
      danger: (it) => { const v = throttleOf(it.m); return v != null && v > 0; },
    },
    { key: 'endpoint', label: 'Endpoint', mono: true, value: (it) => it.n.endpoints[0] ?? null },
  ];

  const lagCols: MetricCol<LagItem>[] = [
    { key: 'cluster', label: 'Cluster', mono: true, facet: true, value: (it) => it.cluster },
    { key: 'group', label: 'Consumer Group', mono: true, value: (it) => it.consumerGroup || null },
    { key: 'topic', label: 'Topic', mono: true, value: (it) => it.topic || null },
    {
      key: 'lag', label: 'Max Offset Lag', type: 'num',
      title: tt('lag이 계속 증가하면 컨슈머가 프로듀서를 못 따라가는 중 — 추세가 안정적이어야 정상'),
      value: (it) => it.maxOffsetLag,
      render: (it) => (it.maxOffsetLag == null ? dash : Math.round(it.maxOffsetLag).toLocaleString()),
    },
  ];

  return (
    <Card
      title={`Broker Nodes · ${tt('클러스터 건강성')}`}
      subtitle={`${brokerCount} brokers · ${controllerCount} controllers · CloudWatch AWS/Kafka (${tt('브로커 단위')}) · ${tt('값은 선택 기간 전체 집계')}`}
      right={<RangePicker value={range} onChange={setRange} />}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('노드 조회 실패')}: {err}</div>}

      {/* 진단 우선순위 스트립 — 정상 기대값(컨트롤러=1, 오프라인/URP/MinISR=0, 디스크<85%, CPU<60%) 대비 색상 */}
      {loaded && healthRows.length > 0 && (
        <div className="flex flex-col gap-1.5 px-4 py-3">
          {healthRows.map((h) => (
            <div key={h.cluster} className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 w-32 truncate font-mono text-[11.5px] text-ink-500" title={h.cluster}>{h.cluster}</span>
              <HealthPill label="Controller" value={fmtN(h.controllers)} ok={h.controllers == null ? null : h.controllers === 1} hint={tt('ActiveControllerCount — 정상값은 정확히 1. 0 또는 2+ 는 컨트롤러 이상 → 즉시 조사.')} />
              <HealthPill label="Offline" value={fmtN(h.offline)} ok={h.offline == null ? null : h.offline === 0} hint={tt('OfflinePartitionsCount — 정상값 0. 0보다 크면 해당 파티션 서비스 불가 (가용성 문제).')} />
              <HealthPill label="URP" value={fmtN(h.urp)} ok={h.urp == null ? null : h.urp === 0} hint={tt('UnderReplicatedPartitions — 정상값 0. 0보다 크면 복제가 뒤처지는 중 (브로커 부하/장애 신호).')} />
              <HealthPill label="MinISR" value={fmtN(h.minIsr)} ok={h.minIsr == null ? null : h.minIsr === 0} hint={tt('UnderMinIsrPartitionCount — min.insync.replicas 미달 파티션. acks=all 쓰기가 거부되는 상황.')} />
              <HealthPill label="Data Disk" value={fmtPct(h.dataDiskMax)} ok={h.dataDiskMax == null ? null : h.dataDiskMax < 85} hint={tt('KafkaDataLogsDiskUsed(max) — 가장 흔한 장애 원인. 85% 초과 시 위험: 스토리지 확장 필요.')} />
              <HealthPill label="Root Disk" value={fmtPct(h.rootDiskMax)} ok={h.rootDiskMax == null ? null : h.rootDiskMax < 85} hint={tt('RootDiskUsed(max) — 루트 볼륨 사용률.')} />
              <HealthPill label="CPU max" value={fmtPct(h.cpuMax)} ok={h.cpuMax == null ? null : h.cpuMax < 60} hint={tt('CpuUser+CpuSystem 브로커 최대값 — 60~70% 초과 시 경보 (여유 40% 이상 권장).')} />
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-ink-100">
        <MetricTable
          columns={nodeCols}
          items={items}
          rowKey={(it, i) => `${it.cluster}:${it.n.nodeType}:${it.n.brokerId ?? it.n.endpoints[0] ?? i}`}
          emptyText={loaded ? tt('브로커 노드 없음 — kafka:ListNodes 권한 또는 클러스터 상태를 확인하세요') : tt('노드 조회 중…')}
        />
      </div>

      {/* 컨슈머 그룹 lag — 실무 최우선 지표. 시리즈는 ListMetrics로 발견 (그룹/토픽별). */}
      {lagItems.length > 0 && (
        <div className="border-t border-ink-100">
          <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">{tt('컨슈머 그룹 Offset Lag (MaxOffsetLag, 선택 기간)')}</div>
          <MetricTable
            columns={lagCols}
            items={lagItems}
            rowKey={(it, i) => `${it.cluster}:${it.consumerGroup}:${it.topic}:${i}`}
            defaultSortKey="lag"
          />
        </div>
      )}

      <DiagnosisGuide spec={MSK_GUIDE} />
    </Card>
  );
}
