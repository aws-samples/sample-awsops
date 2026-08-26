'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import DiagnosisGuide from './DiagnosisGuide';
import { EBS_GUIDE } from './guides';
import MetricTable, { type MetricCol } from './MetricTable';
import { type Row, type Fleet, num, dash, RangePicker } from './shared';

// EBS per-volume diagnostics (owner 가이드): 원시값(선택 기간 합계)을 IOPS·MB/s·평균지연
// (TotalTime/Ops)으로 환산해 표시. 볼륨 한계 vs 인스턴스 EBS 대역폭(밸런스 테이블) 구분.
// 기간별 조회(RangePicker) + 컬럼 정렬/검색/facet/문제만 필터는 MetricTable이 제공.

type Item = { row: Row; m: Record<string, number | null> };
type BalanceItem = { iid: string; io: number | null; byte: number | null };

export function EbsMetrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const [range, setRange] = useState(3600);
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 150), [rows]);
  const [fleet, setFleet] = useState<Fleet>({});
  const [instanceBalance, setInstanceBalance] = useState<Fleet>({});
  const [instOfVol, setInstOfVol] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/inventory/ebs_volume/metrics?ids=${encodeURIComponent(key)}&range=${range}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (live) {
          setFleet(d.fleet ?? {}); setInstanceBalance(d.instanceBalance ?? {});
          setInstOfVol(d.instOfVol ?? {}); setErr('');
        }
      })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [key, range]);

  const items: Item[] = useMemo(
    () => rows.map((row) => ({ row, m: fleet[String(row.resource_id)] ?? {} })),
    [rows, fleet],
  );
  if (rows.length === 0) return null;

  // gp2 baseline = 3 IOPS/GB (100~16000 clamp) — row.iops가 없을 때의 비교 기준.
  const provisionedIops = (r: Row): number | null => {
    const iops = Number(r.iops);
    if (Number.isFinite(iops) && iops > 0) return iops;
    if (String(r.volume_type) === 'gp2') {
      const size = Number(r.size);
      return Number.isFinite(size) ? Math.min(16000, Math.max(100, 3 * size)) : null;
    }
    return null;
  };

  // 선택 기간 합계 → 평균 환산. 평균지연은 TotalTime/Ops 비율이라 range와 무관.
  const iopsOf = (it: Item): number | null => {
    if (num(it.m.readOps) == null && num(it.m.writeOps) == null) return null;
    return ((num(it.m.readOps) ?? 0) + (num(it.m.writeOps) ?? 0)) / range;
  };
  const mbpsOf = (it: Item): number | null => {
    if (num(it.m.readBytes) == null && num(it.m.writeBytes) == null) return null;
    return ((num(it.m.readBytes) ?? 0) + (num(it.m.writeBytes) ?? 0)) / range / 1024 / 1024;
  };
  const latROf = (it: Item): number | null => {
    const rOps = num(it.m.readOps) ?? 0;
    return rOps > 0 && num(it.m.totalReadTime) != null ? ((num(it.m.totalReadTime) as number) / rOps) * 1000 : null;
  };
  const latWOf = (it: Item): number | null => {
    const wOps = num(it.m.writeOps) ?? 0;
    return wOps > 0 && num(it.m.totalWriteTime) != null ? ((num(it.m.totalWriteTime) as number) / wOps) * 1000 : null;
  };
  const fmtIops = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString());

  const columns: MetricCol<Item>[] = [
    { key: 'id', label: 'Volume', mono: true, value: (it) => String(it.row.resource_id) },
    { key: 'type', label: 'Type', facet: true, value: (it) => (it.row.volume_type != null ? String(it.row.volume_type) : null) },
    {
      key: 'size', label: 'Size', type: 'num',
      value: (it) => (it.row.size != null && Number.isFinite(Number(it.row.size)) ? Number(it.row.size) : null),
      render: (it) => (it.row.size != null ? `${it.row.size} GB` : dash),
    },
    {
      key: 'iops', label: tt('IOPS (사용/프로비저닝)'), type: 'num',
      title: tt('VolumeRead+WriteOps → 선택 기간 평균 IOPS vs 프로비저닝(gp2는 3 IOPS/GB baseline) — 한계에 붙으면 볼륨 병목'),
      value: (it) => iopsOf(it),
      render: (it) => {
        const iops = iopsOf(it); const prov = provisionedIops(it.row);
        return iops == null ? dash : `${fmtIops(iops)}${prov != null ? ` / ${prov.toLocaleString()}` : ''}`;
      },
      danger: (it) => {
        const iops = iopsOf(it); const prov = provisionedIops(it.row);
        return iops != null && prov != null && iops >= prov * 0.8;
      },
    },
    {
      key: 'provIops', label: tt('프로비저닝 IOPS'), type: 'num',
      title: tt('프로비저닝 IOPS — row.iops, 없으면 gp2 baseline(3 IOPS/GB, 100~16000)'),
      value: (it) => provisionedIops(it.row),
      render: (it) => { const v = provisionedIops(it.row); return v == null ? dash : v.toLocaleString(); },
    },
    {
      key: 'mbps', label: 'MB/s', type: 'num',
      title: tt('VolumeRead+WriteBytes → 선택 기간 평균 MB/s — gp3는 IOPS와 처리량을 독립적으로 봐야 함'),
      value: (it) => mbpsOf(it),
      render: (it) => { const v = mbpsOf(it); return v == null ? dash : v.toFixed(2); },
    },
    {
      key: 'latR', label: tt('평균 지연 R (ms)'), type: 'num',
      title: tt('평균 지연 = VolumeTotalReadTime/ReadOps — 높은데 IOPS/처리량 미달이면 I/O 크기·랜덤성 문제'),
      value: (it) => latROf(it),
      render: (it) => { const v = latROf(it); return v == null ? dash : v.toFixed(1); },
    },
    {
      key: 'latW', label: tt('평균 지연 W (ms)'), type: 'num',
      title: tt('평균 지연 = VolumeTotalWriteTime/WriteOps — 높은데 IOPS/처리량 미달이면 I/O 크기·랜덤성 문제'),
      value: (it) => latWOf(it),
      render: (it) => { const v = latWOf(it); return v == null ? dash : v.toFixed(1); },
    },
    {
      key: 'queue', label: 'Queue', type: 'num',
      title: tt('VolumeQueueLength — 가장 직관적인 포화 지표. 지속적으로 높으면 볼륨이 요청을 못 따라감'),
      value: (it) => num(it.m.queueLength),
      render: (it) => { const v = num(it.m.queueLength); return v == null ? dash : v.toFixed(1); },
      danger: (it) => { const v = num(it.m.queueLength); return v != null && v > 8; },
    },
    {
      key: 'burst', label: 'Burst %', type: 'num',
      title: tt('BurstBalance(gp2/st1/sc1) — 0 근접 시 baseline 강등. gp2 원인불명 성능저하의 단골 (gp3 전환 권장)'),
      value: (it) => num(it.m.burstBalance),
      render: (it) => { const v = num(it.m.burstBalance); return v == null ? dash : `${v.toFixed(0)}%`; },
      danger: (it) => { const v = num(it.m.burstBalance); return v != null && v < 20; },
    },
    {
      key: 'tpPct', label: tt('Prov. 성능 %'), type: 'num',
      title: tt('VolumeThroughputPercentage(io1/io2) — 100% 미만 지속 = 프로비저닝 성능 미달'),
      value: (it) => num(it.m.throughputPct),
      render: (it) => { const v = num(it.m.throughputPct); return v == null ? dash : `${v.toFixed(0)}%`; },
      danger: (it) => { const v = num(it.m.throughputPct); return v != null && v < 100; },
    },
    { key: 'inst', label: 'Instance', mono: true, value: (it) => instOfVol[String(it.row.resource_id)] ?? null },
  ];

  const balanceRows: BalanceItem[] = Object.entries(instanceBalance)
    .map(([iid, m]) => ({ iid, io: num(m.ioBalance), byte: num(m.byteBalance) }))
    .filter((x) => x.io != null || x.byte != null);

  const balanceColumns: MetricCol<BalanceItem>[] = [
    { key: 'iid', label: 'Instance', mono: true, value: (b) => b.iid },
    {
      key: 'io', label: 'EBS IO Balance %', type: 'num',
      title: tt('EBSIOBalance% — 0 근접 시 인스턴스 EBS baseline으로 강등 (볼륨이 커도 병목)'),
      value: (b) => b.io,
      render: (b) => (b.io == null ? dash : `${b.io.toFixed(0)}%`),
      danger: (b) => b.io != null && b.io < 20,
    },
    {
      key: 'byte', label: 'EBS Byte Balance %', type: 'num',
      title: tt('EBSByteBalance% — 0 근접 시 인스턴스 EBS 대역폭 강등'),
      value: (b) => b.byte,
      render: (b) => (b.byte == null ? dash : `${b.byte.toFixed(0)}%`),
      danger: (b) => b.byte != null && b.byte < 20,
    },
  ];

  return (
    <Card
      title={tt('볼륨 진단 메트릭')}
      subtitle={`${ids.length} volumes · CloudWatch AWS/EBS · ${tt('값은 선택 기간 전체 집계')} · ${tt('IOPS/MBps는 기간 합계 환산, 지연은 TotalTime/Ops')}`}
      right={<RangePicker value={range} onChange={setRange} />}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패')}: {err}</div>}
      <MetricTable columns={columns} items={items} rowKey={(it) => String(it.row.resource_id)} />

      {/* 인스턴스 레벨 EBS 대역폭 밸런스 — 볼륨이 여유로운데 느릴 때의 범인 (소형 Nitro만 발행) */}
      {balanceRows.length > 0 && (
        <div className="border-t border-ink-100">
          <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">{tt('인스턴스 EBS 대역폭 밸런스')}</div>
          <MetricTable columns={balanceColumns} items={balanceRows} rowKey={(b) => b.iid} />
        </div>
      )}

      <DiagnosisGuide spec={EBS_GUIDE} />
    </Card>
  );
}
