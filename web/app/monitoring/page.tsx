'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Cpu, Database, Server } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import StatTile from '@/components/ui/StatTile';
import Card from '@/components/ui/Card';
import Meter from '@/components/ui/Meter';
import SegmentedControl from '@/components/ui/SegmentedControl';
import MultiLineTrend from '@/components/charts/MultiLineTrend';

type TabKey = 'ec2' | 'rds';
interface Ec2Row { id: string; name: string | null; itype: string | null; az: string | null; cpu: number | null; netIn: number | null; netOut: number | null }
interface RdsRow {
  id: string; engine: string | null; clazz: string | null;
  cpu?: number | null; connections?: number | null; freeableMemory?: number | null; freeStorage?: number | null;
  readIops?: number | null; writeIops?: number | null; netIn?: number | null; netOut?: number | null;
}

const DASH = '—';
const RANGES = [
  { value: '1h', label: '1h' }, { value: '6h', label: '6h' },
  { value: '24h', label: '24h' }, { value: '7d', label: '7d' },
];
const SERIES_KEYS: Record<TabKey, string[]> = {
  ec2: ['CPU %', 'Net In MB', 'Net Out MB'],
  rds: ['CPU %', 'Connections', 'Free Mem GB'],
};

const mb = (v: number | null | undefined) => (v == null ? DASH : `${(v / 1e6).toFixed(1)} MB`);
const gb = (v: number | null | undefined) => (v == null ? DASH : `${(v / 1e9).toFixed(1)} GB`);

function cpuTone(v: number | null | undefined): string {
  if (v == null) return 'text-ink-300';
  if (v >= 80) return 'text-rose-600 font-semibold';
  if (v >= 60) return 'text-brand-700 font-semibold';
  return 'text-ink-800';
}

/** 통합 모니터링 허브 (v1 /monitoring parity): 플릿 라이브 메트릭 테이블 + 드릴다운 시계열. */
export default function MonitoringPage() {
  const [tab, setTab] = useState<TabKey>('ec2');
  const [rows, setRows] = useState<(Ec2Row | RdsRow)[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  // drill-down: selected resource id + range + fetched series
  const [picked, setPicked] = useState<string | null>(null);
  const [range, setRange] = useState('6h');
  const [series, setSeries] = useState<Array<Record<string, unknown>> | null>(null);

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/monitoring?tab=${tab}`);
      if (!r.ok) throw new Error(String(r.status));
      setRows((await r.json()).rows ?? []);
      setCapturedAt(new Date().toISOString());
    } catch (e) { setErr(String(e)); setRows([]); }
    finally { setBusy(false); }
  }, [tab]);
  useEffect(() => { setRows(null); setPicked(null); load(); }, [load]);

  useEffect(() => {
    if (!picked) { setSeries(null); return; }
    let alive = true;
    setSeries(null);
    fetch(`/api/monitoring?series=${tab}&id=${encodeURIComponent(picked)}&range=${range}`)
      .then((r) => (r.ok ? r.json() : { series: [] }))
      .then((d) => { if (alive) setSeries(d.series ?? []); })
      .catch(() => { if (alive) setSeries([]); });
    return () => { alive = false; };
  }, [picked, range, tab]);

  const ec2Rows = tab === 'ec2' ? ((rows ?? []) as Ec2Row[]) : [];
  const rdsRows = tab === 'rds' ? ((rows ?? []) as RdsRow[]) : [];

  const kpis = useMemo(() => {
    const cpus = (rows ?? []).map((r) => (r as Ec2Row).cpu).filter((v): v is number => typeof v === 'number');
    const avg = cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : null;
    const high = cpus.filter((v) => v >= 80).length;
    let peakId: string | null = null; let peak = -1;
    for (const r of rows ?? []) {
      const v = (r as Ec2Row).cpu;
      if (typeof v === 'number' && v > peak) { peak = v; peakId = (r as Ec2Row).id; }
    }
    return { count: rows?.length ?? 0, avg, high, peakId, peak: peak >= 0 ? peak : null };
  }, [rows]);

  const th = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400';
  const td = 'px-3 py-2 text-[12.5px]';

  return (
    <>
      <PageHeader
        title="통합 모니터링"
        subtitle="플릿 라이브 CloudWatch 메트릭 — 행 선택 시 시계열 차트"
        right={<RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        <SegmentedControl
          options={[{ value: 'ec2', label: `EC2 (${tab === 'ec2' ? kpis.count : '…'})` }, { value: 'rds', label: 'RDS' }]}
          value={tab}
          onChange={(v) => setTab(v as TabKey)}
        />
        {err && <div className="text-[13px] text-rose-600">로드 실패: {err}</div>}
        {!rows && !err && <div className="text-ink-400">라이브 메트릭 조회 중…</div>}

        {rows && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatTile label={tab === 'ec2' ? '실행 중 인스턴스' : 'RDS 인스턴스'} value={kpis.count} variant="accent" icon={tab === 'ec2' ? <Server size={16} /> : <Database size={16} />} />
              <StatTile label="평균 CPU" value={kpis.avg == null ? DASH : `${kpis.avg.toFixed(1)}%`} icon={<Cpu size={16} />} />
              <StatTile label="High CPU (>80%)" value={kpis.high} variant={kpis.high > 0 ? 'danger' : 'default'} icon={<Activity size={16} />} />
              <StatTile label="Peak" value={kpis.peak == null ? DASH : `${kpis.peak.toFixed(1)}%`} hint={kpis.peakId ?? undefined} icon={<Activity size={16} />} />
            </div>

            {picked && (
              <MultiLineTrend
                title={`${picked} — 시계열 (${range})`}
                right={<SegmentedControl options={RANGES} value={range} onChange={setRange} />}
                data={series ?? []}
                xKey="t"
                series={SERIES_KEYS[tab].map((k) => ({ key: k }))}
              />
            )}
            {picked && series && series.length === 0 && (
              <div className="text-[12px] text-ink-400">이 리소스의 데이터포인트가 없습니다 (기간을 늘려 보세요).</div>
            )}

            <Card padded={false}>
              <div className="overflow-x-auto">
                {tab === 'ec2' ? (
                  <table className="w-full">
                    <thead><tr className="border-b border-ink-100">
                      <th className={th}>Instance</th><th className={th}>Name</th><th className={th}>Type</th>
                      <th className={th}>AZ</th><th className={`${th} w-56`}>CPU</th><th className={th}>Net In</th><th className={th}>Net Out</th>
                    </tr></thead>
                    <tbody>
                      {ec2Rows.map((r) => (
                        <tr
                          key={r.id}
                          onClick={() => setPicked((cur) => (cur === r.id ? null : r.id))}
                          className={`cursor-pointer border-b border-ink-50 last:border-0 hover:bg-ink-50 ${picked === r.id ? 'bg-brand-50' : ''}`}
                        >
                          <td className={`${td} font-mono text-[11.5px] text-ink-600`}>{r.id}</td>
                          <td className={`${td} text-ink-800`}>{r.name ?? DASH}</td>
                          <td className={`${td} text-ink-600`}>{r.itype ?? DASH}</td>
                          <td className={`${td} text-ink-500`}>{r.az ?? DASH}</td>
                          <td className={td}>
                            <div className="flex items-center gap-2">
                              <span className={`w-14 shrink-0 tabular text-right ${cpuTone(r.cpu)}`}>{r.cpu == null ? DASH : `${r.cpu.toFixed(1)}%`}</span>
                              <Meter value={r.cpu ?? 0} />
                            </div>
                          </td>
                          <td className={`${td} tabular text-ink-600`}>{mb(r.netIn)}</td>
                          <td className={`${td} tabular text-ink-600`}>{mb(r.netOut)}</td>
                        </tr>
                      ))}
                      {ec2Rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-[13px] text-ink-400">실행 중 인스턴스 없음</td></tr>}
                    </tbody>
                  </table>
                ) : (
                  <table className="w-full">
                    <thead><tr className="border-b border-ink-100">
                      <th className={th}>Instance</th><th className={th}>Engine</th><th className={th}>Class</th>
                      <th className={`${th} w-52`}>CPU</th><th className={th}>Connections</th><th className={th}>Free Mem</th>
                      <th className={th}>Free Storage</th><th className={th}>R/W IOPS</th>
                    </tr></thead>
                    <tbody>
                      {rdsRows.map((r) => (
                        <tr
                          key={r.id}
                          onClick={() => setPicked((cur) => (cur === r.id ? null : r.id))}
                          className={`cursor-pointer border-b border-ink-50 last:border-0 hover:bg-ink-50 ${picked === r.id ? 'bg-brand-50' : ''}`}
                        >
                          <td className={`${td} font-mono text-[11.5px] text-ink-600`}>{r.id}</td>
                          <td className={`${td} text-ink-600`}>{r.engine ?? DASH}</td>
                          <td className={`${td} text-ink-600`}>{r.clazz ?? DASH}</td>
                          <td className={td}>
                            <div className="flex items-center gap-2">
                              <span className={`w-14 shrink-0 tabular text-right ${cpuTone(r.cpu)}`}>{r.cpu == null ? DASH : `${r.cpu.toFixed(1)}%`}</span>
                              <Meter value={r.cpu ?? 0} />
                            </div>
                          </td>
                          <td className={`${td} tabular text-ink-600`}>{r.connections ?? DASH}</td>
                          <td className={`${td} tabular text-ink-600`}>{gb(r.freeableMemory)}</td>
                          <td className={`${td} tabular text-ink-600`}>{gb(r.freeStorage)}</td>
                          <td className={`${td} tabular text-ink-600`}>{r.readIops ?? DASH} / {r.writeIops ?? DASH}</td>
                        </tr>
                      ))}
                      {rdsRows.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-[13px] text-ink-400">RDS 인스턴스 없음</td></tr>}
                    </tbody>
                  </table>
                )}
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
