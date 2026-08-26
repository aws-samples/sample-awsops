'use client';
import { useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import DiagnosisGuide from './DiagnosisGuide';
import { RDS_GUIDE } from './guides';
import MetricTable, { type MetricCol } from './MetricTable';
import { type Row, num, dash, gb, cnt, meter, RangePicker, useFleet } from './shared';

// RDS per-instance diagnostic table (owner 가이드: CloudWatch/복제/EM/PI 4층위).
// 임계값: CPU>80 지속=컴퓨트 병목, Free Storage 고갈=가장 흔한 장애 원인, Swap 증가=메모리 부족,
// 크레딧(BurstBalance/CPUCreditBalance) 0 근접=gp2/T계열 함정, ReplicaLag 증가=복제 지연.
// 기간별 조회(RangePicker) + 컬럼 정렬/검색/facet/문제만 필터는 MetricTable이 제공.

type Item = { row: Row; m: Record<string, number | null> };

export function RdsInstanceMetrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const [range, setRange] = useState(3600);
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 200), [rows]);
  const { fleet, err } = useFleet('rds', ids, range);

  const items: Item[] = useMemo(
    () => rows.map((row) => ({ row, m: fleet[String(row.resource_id)] ?? {} })),
    [rows, fleet],
  );
  if (rows.length === 0) return null;

  const lat = (v: number | null) => (v == null ? dash : `${(v * 1000).toFixed(1)} ms`); // CloudWatch RDS latency unit = seconds
  // Free Storage 진단 신호는 잔여 비율 — allocated_storage를 알 때 % 계산.
  const freePct = (it: Item): number | null => {
    const allocGb = Number(it.row.allocated_storage) || null;
    const freeB = num(it.m.freeStorage);
    return allocGb && freeB != null ? (freeB / (allocGb * 1024 ** 3)) * 100 : null;
  };
  const swapMb = (it: Item): number | null => {
    const v = num(it.m.swap);
    return v == null ? null : v / 1024 / 1024;
  };

  const columns: MetricCol<Item>[] = [
    { key: 'id', label: 'Instance', mono: true, value: (it) => String(it.row.resource_id) },
    { key: 'engine', label: 'Engine', facet: true, value: (it) => (typeof it.row.engine === 'string' ? it.row.engine : null) },
    {
      key: 'class', label: 'Class', mono: true, facet: true,
      value: (it) => {
        const c = it.row.class ?? it.row.db_instance_class;
        return typeof c === 'string' ? c : null;
      },
    },
    {
      key: 'cpu', label: 'CPU', type: 'num', title: tt('CPUUtilization — 지속 80% 초과 시 확장/쿼리 튜닝'),
      value: (it) => num(it.m.cpu), render: (it) => meter(num(it.m.cpu)),
    },
    {
      key: 'freeStorage', label: 'Free Storage', type: 'num',
      title: tt('FreeStorageSpace — 가장 흔한 장애 원인. 고갈되면 DB 정지'),
      // 정렬 값: allocated_storage로 %를 계산할 수 있으면 잔여 %(진단 신호), 아니면 잔여 바이트.
      // 스케일이 섞이지만(%↔bytes) % 미산출 행은 예외적이고, 고갈 위험 정렬에는 %가 옳은 축.
      value: (it) => freePct(it) ?? num(it.m.freeStorage),
      render: (it) => {
        const freeB = num(it.m.freeStorage);
        if (freeB == null) return dash;
        const p = freePct(it);
        return `${(freeB / 1024 ** 3).toFixed(1)} GB${p != null ? ` (${p.toFixed(0)}%)` : ''}`;
      },
      danger: (it) => { const p = freePct(it); return p != null && p < 15; },
    },
    { key: 'freeMem', label: 'Free Mem', type: 'num', value: (it) => num(it.m.freeMem), render: (it) => gb(num(it.m.freeMem)) },
    {
      key: 'swap', label: 'Swap', type: 'num',
      title: tt('SwapUsage — 0에 가까워야 정상. 커지면 메모리 부족 → 성능 급락'),
      value: (it) => swapMb(it),
      render: (it) => { const v = swapMb(it); return v == null ? dash : `${v.toFixed(0)} MB`; },
      danger: (it) => { const v = swapMb(it); return v != null && v > 100; },
    },
    {
      key: 'conn', label: 'Conn', type: 'num', title: tt('DatabaseConnections — max_connections 대비 확인'),
      value: (it) => num(it.m.conn), render: (it) => cnt(num(it.m.conn)),
    },
    {
      key: 'readLat', label: 'Read Lat', type: 'num', title: tt('ReadLatency — 급증 시 스토리지 병목'),
      value: (it) => num(it.m.readLat), render: (it) => lat(num(it.m.readLat)),
    },
    {
      key: 'writeLat', label: 'Write Lat', type: 'num', title: tt('WriteLatency — 급증 시 스토리지 병목'),
      value: (it) => num(it.m.writeLat), render: (it) => lat(num(it.m.writeLat)),
    },
    {
      key: 'iopsR', label: 'IOPS R', type: 'num',
      value: (it) => num(it.m.readIops),
      render: (it) => { const v = num(it.m.readIops); return v == null ? dash : Math.round(v).toLocaleString(); },
    },
    {
      key: 'iopsW', label: 'IOPS W', type: 'num',
      value: (it) => num(it.m.writeIops),
      render: (it) => { const v = num(it.m.writeIops); return v == null ? dash : Math.round(v).toLocaleString(); },
    },
    {
      key: 'queue', label: 'Queue', type: 'num', title: tt('DiskQueueDepth — 높으면 스토리지 병목'),
      value: (it) => num(it.m.diskQueue),
      render: (it) => { const v = num(it.m.diskQueue); return v == null ? dash : v.toFixed(1); },
    },
    {
      key: 'credit', label: 'Credit', type: 'num',
      title: tt('BurstBalance(gp2)/CPUCreditBalance(T계열) — 0 근접 시 성능 강등 (자주 놓치는 함정)'),
      // 크레딧: gp2=BurstBalance(%), T계열=CPUCreditBalance — 인스턴스당 한쪽만 존재하므로 단일
      // 컬럼 유지. 정렬 값은 있는 쪽(단위 혼재: %↔credits)이지만 '0 근접=위험' 축은 공유.
      value: (it) => num(it.m.burst) ?? num(it.m.cpuCredit),
      render: (it) => {
        const burst = num(it.m.burst); const credit = num(it.m.cpuCredit);
        return burst != null ? `${burst.toFixed(0)}%` : credit != null ? Math.round(credit).toLocaleString() : dash;
      },
      danger: (it) => {
        const burst = num(it.m.burst); const credit = num(it.m.cpuCredit);
        return (burst != null && burst < 20) || (credit != null && credit < 50);
      },
    },
    {
      key: 'replicaLag', label: 'Replica Lag', type: 'num', title: tt('ReplicaLag(초) — 증가 추세면 복제 지연'),
      value: (it) => num(it.m.replicaLag),
      render: (it) => { const v = num(it.m.replicaLag); return v == null ? dash : `${v.toFixed(1)}s`; },
      danger: (it) => { const v = num(it.m.replicaLag); return v != null && v > 10; },
    },
  ];

  return (
    <Card
      title={tt('인스턴스 진단 메트릭')}
      subtitle={`${ids.length} instances · CloudWatch AWS/RDS (${tt('인스턴스 레벨')}) · ${tt('값은 선택 기간 전체 집계')}`}
      right={<RangePicker value={range} onChange={setRange} />}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패')}: {err}</div>}
      <MetricTable columns={columns} items={items} rowKey={(it) => String(it.row.resource_id)} />
      <DiagnosisGuide spec={RDS_GUIDE} />
    </Card>
  );
}
