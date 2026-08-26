'use client';
import { useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import DiagnosisGuide from './DiagnosisGuide';
import { EC2_GUIDE } from './guides';
import MetricTable, { type MetricCol } from './MetricTable';
import { type Row, num, meter, RangePicker, useFleet } from './shared';

// EC2 per-instance diagnostics (owner 가이드): 상태 점검 System/Instance/EBS 구분(책임 소재),
// T계열 크레딧, 네트워크 Mbps/PPS(선택 기간 합계 환산), 인스턴스 관점 EBS IOPS·밸런스.
// 기간별 조회(RangePicker) + 컬럼 정렬/검색/facet/문제만 필터는 MetricTable이 제공.

type Item = { row: Row; m: Record<string, number | null> };

export function Ec2Metrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const [range, setRange] = useState(3600);
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 150), [rows]);
  const { fleet, err } = useFleet('ec2', ids, range);

  const items: Item[] = useMemo(
    () => rows.map((row) => ({ row, m: fleet[String(row.resource_id)] ?? {} })),
    [rows, fleet],
  );
  if (rows.length === 0) return null;

  const mbps = (v: number | null) => (v == null ? null : (v / range) * 8 / 1e6);
  const statusText = (m: Record<string, number | null>): string | null => {
    const sSys = num(m.statusSystem); const sInst = num(m.statusInstance); const sEbs = num(m.statusEbs);
    if (sSys == null && sInst == null && sEbs == null) return null;
    const fails = [(sSys ?? 0) >= 1 ? 'Sys' : '', (sInst ?? 0) >= 1 ? 'Inst' : '', (sEbs ?? 0) >= 1 ? 'EBS' : ''].filter(Boolean);
    return fails.length ? `FAIL (${fails.join(' ')})` : 'OK';
  };

  const columns: MetricCol<Item>[] = [
    { key: 'id', label: 'Instance', mono: true, value: (it) => String(it.row.resource_id) },
    { key: 'name', label: 'Name', value: (it) => (typeof it.row.name === 'string' ? it.row.name : null) },
    { key: 'type', label: 'Type', mono: true, facet: true, value: (it) => (typeof it.row.instance_type === 'string' ? it.row.instance_type : null) },
    {
      key: 'cpu', label: 'CPU', type: 'num', title: tt('CPUUtilization — 지속 80% 초과 시 확장/타입 변경 검토 (하이퍼바이저 관점)'),
      value: (it) => num(it.m.cpu), render: (it) => meter(num(it.m.cpu)),
    },
    {
      key: 'credit', label: 'CPU Credit', type: 'num',
      title: tt('CPUCreditBalance(T계열 전용) — 0 근접 시 baseline 강등/추가 과금. 원인불명 성능저하의 단골'),
      value: (it) => num(it.m.cpuCredit),
      render: (it) => { const v = num(it.m.cpuCredit); return v == null ? null : Math.round(v).toLocaleString(); },
      danger: (it) => { const v = num(it.m.cpuCredit); return v != null && v < 50; },
    },
    {
      key: 'status', label: 'Status', facet: true,
      title: tt('StatusCheckFailed System/Instance/AttachedEBS — System=AWS 인프라(stop/start로 이전), Instance=OS 내부(로그/스크린샷 조사)'),
      value: (it) => statusText(it.m),
      danger: (it) => (statusText(it.m) ?? '').startsWith('FAIL'),
    },
    {
      key: 'netIn', label: 'Net In (Mbps)', type: 'num', title: tt('NetworkIn → 선택 기간 평균 Mbps — 인스턴스 타입 대역폭 상한 대비'),
      value: (it) => mbps(num(it.m.netIn)), render: (it) => { const v = mbps(num(it.m.netIn)); return v == null ? null : v.toFixed(2); },
    },
    {
      key: 'netOut', label: 'Net Out (Mbps)', type: 'num', title: tt('NetworkOut → 선택 기간 평균 Mbps'),
      value: (it) => mbps(num(it.m.netOut)), render: (it) => { const v = mbps(num(it.m.netOut)); return v == null ? null : v.toFixed(2); },
    },
    {
      key: 'ppsIn', label: 'PPS In', type: 'num', title: tt('NetworkPacketsIn → 선택 기간 평균 PPS — PPS 상한 감지'),
      value: (it) => (num(it.m.pktIn) == null ? null : Math.round((num(it.m.pktIn) as number) / range)),
    },
    {
      key: 'ppsOut', label: 'PPS Out', type: 'num', title: tt('NetworkPacketsOut → 선택 기간 평균 PPS'),
      value: (it) => (num(it.m.pktOut) == null ? null : Math.round((num(it.m.pktOut) as number) / range)),
    },
    {
      key: 'ebsR', label: 'EBS IOPS R', type: 'num', title: tt('EBSReadOps → 선택 기간 평균 IOPS — 인스턴스 관점 EBS I/O'),
      value: (it) => (num(it.m.ebsReadOps) == null ? null : Math.round((num(it.m.ebsReadOps) as number) / range)),
    },
    {
      key: 'ebsW', label: 'EBS IOPS W', type: 'num', title: tt('EBSWriteOps → 선택 기간 평균 IOPS'),
      value: (it) => (num(it.m.ebsWriteOps) == null ? null : Math.round((num(it.m.ebsWriteOps) as number) / range)),
    },
    {
      key: 'ioBal', label: 'IO Bal %', type: 'num', title: tt('EBSIOBalance% — 0 근접 시 인스턴스 EBS baseline 강등 (볼륨이 커도 병목)'),
      value: (it) => num(it.m.ioBalance),
      render: (it) => { const v = num(it.m.ioBalance); return v == null ? null : `${v.toFixed(0)}%`; },
      danger: (it) => { const v = num(it.m.ioBalance); return v != null && v < 20; },
    },
    {
      key: 'byteBal', label: 'Byte Bal %', type: 'num', title: tt('EBSByteBalance% — 0 근접 시 인스턴스 EBS 대역폭 강등'),
      value: (it) => num(it.m.byteBalance),
      render: (it) => { const v = num(it.m.byteBalance); return v == null ? null : `${v.toFixed(0)}%`; },
      danger: (it) => { const v = num(it.m.byteBalance); return v != null && v < 20; },
    },
  ];

  return (
    <Card
      title={tt('인스턴스 진단 메트릭')}
      subtitle={`${ids.length} instances · CloudWatch AWS/EC2 · ${tt('값은 선택 기간 전체 집계')} · ${tt('메모리/디스크는 기본 메트릭에 없음(CloudWatch Agent 필요 — 가이드 참조)')}`}
      right={<RangePicker value={range} onChange={setRange} />}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패')}: {err}</div>}
      <MetricTable columns={columns} items={items} rowKey={(it) => String(it.row.resource_id)} />
      <DiagnosisGuide spec={EC2_GUIDE} />
    </Card>
  );
}
