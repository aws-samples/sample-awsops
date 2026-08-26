'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import DiagnosisGuide from './DiagnosisGuide';
import { NLB_GUIDE } from './guides';
import MetricTable, { type MetricCol } from './MetricTable';
import TgHealthTable, { type TgHealthRow } from './TgHealthTable';
import { type Row, type Fleet, num, cnt, mb, RangePicker } from './shared';

// NLB per-LB diagnostics (owner 가이드): L4 — HTTP 코드가 없어 RST 카운트/타깃 헬스가 핵심.
// 응답: {fleet(resource_id 키), targetHealth, lbDimByResource} — ALB와 동일 계약(net/ 차원).
// 기간별 조회(RangePicker) + 컬럼 정렬/검색/문제만 필터는 MetricTable이 제공.

type Item = { row: Row; m: Record<string, number | null> };

export function NlbMetrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const [range, setRange] = useState(3600);
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 100), [rows]);
  const [fleet, setFleet] = useState<Fleet>({});
  const [health, setHealth] = useState<TgHealthRow[]>([]);
  const [lbDims, setLbDims] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/inventory/nlb/metrics?ids=${encodeURIComponent(key)}&range=${range}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setFleet(d.fleet ?? {}); setHealth(d.targetHealth ?? []); setLbDims(d.lbDimByResource ?? {}); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [key, range]);

  const items: Item[] = useMemo(
    () => rows.map((row) => ({ row, m: fleet[String(row.resource_id)] ?? {} })),
    [rows, fleet],
  );
  if (rows.length === 0) return null;

  const columns: MetricCol<Item>[] = [
    { key: 'id', label: 'NLB', mono: true, value: (it) => String(it.row.resource_id) },
    {
      key: 'activeFlow', label: 'Active Flow', type: 'num', title: tt('ActiveFlowCount — 활성 플로우, 급증/급감으로 트래픽 이상 감지'),
      value: (it) => num(it.m.activeFlow), render: (it) => cnt(num(it.m.activeFlow)),
    },
    {
      key: 'newFlow', label: 'New Flow', type: 'num', title: tt('NewFlowCount(선택 기간 누적) — 연결 수립률'),
      value: (it) => num(it.m.newFlow), render: (it) => cnt(num(it.m.newFlow)),
    },
    {
      key: 'tgtRst', label: 'Target RST', type: 'num',
      title: tt('TCP_Target_Reset_Count(선택 기간 누적) — 타깃발 RST 급증 = 백엔드 문제 강한 신호 (앱 크래시/포트 닫힘/백로그 초과)'),
      value: (it) => num(it.m.tgtRst), render: (it) => cnt(num(it.m.tgtRst)),
    },
    {
      key: 'elbRst', label: 'ELB RST', type: 'num',
      title: tt('TCP_ELB_Reset_Count(선택 기간 누적) — NLB발 RST 급증 = idle timeout(350초)/비대칭 라우팅'),
      value: (it) => num(it.m.elbRst), render: (it) => cnt(num(it.m.elbRst)),
    },
    {
      key: 'clientRst', label: 'Client RST', type: 'num', title: tt('TCP_Client_Reset_Count(선택 기간 누적) — 클라이언트발 RST'),
      value: (it) => num(it.m.clientRst), render: (it) => cnt(num(it.m.clientRst)),
    },
    {
      key: 'processed', label: 'Processed', type: 'num', title: tt('ProcessedBytes(선택 기간 누적)'),
      value: (it) => num(it.m.processedBytes), render: (it) => mb(num(it.m.processedBytes)),
    },
    {
      key: 'portAllocErr', label: 'Port Alloc Err', type: 'num',
      title: tt('PortAllocationErrorCount — SNAT 소스 포트 고갈, >0이면 연결 실패 발생 (놓치기 쉬운 원인)'),
      value: (it) => num(it.m.portAllocErr), render: (it) => cnt(num(it.m.portAllocErr)),
      danger: (it) => { const v = num(it.m.portAllocErr); return v != null && v > 0; },
    },
    {
      key: 'unhealthyRouting', label: 'Unhealthy Routing', type: 'num',
      title: tt('UnhealthyRoutingFlowCount — 정상 타깃이 없어 라우팅 실패한 플로우'),
      value: (it) => num(it.m.unhealthyRouting), render: (it) => cnt(num(it.m.unhealthyRouting)),
      danger: (it) => { const v = num(it.m.unhealthyRouting); return v != null && v > 0; },
    },
    {
      key: 'clientTlsErr', label: 'Client TLS Err', type: 'num',
      title: tt('ClientTLSNegotiationErrorCount — 클라이언트 측 TLS 협상 실패'),
      value: (it) => num(it.m.clientTlsErr), render: (it) => cnt(num(it.m.clientTlsErr)),
      danger: (it) => { const v = num(it.m.clientTlsErr); return v != null && v > 0; },
    },
    {
      key: 'targetTlsErr', label: 'Target TLS Err', type: 'num',
      title: tt('TargetTLSNegotiationErrorCount — 타깃 측 TLS 협상 실패'),
      value: (it) => num(it.m.targetTlsErr), render: (it) => cnt(num(it.m.targetTlsErr)),
      danger: (it) => { const v = num(it.m.targetTlsErr); return v != null && v > 0; },
    },
    {
      key: 'lcu', label: 'LCU', type: 'num', title: tt('ConsumedLCUs(선택 기간 누적)'),
      value: (it) => num(it.m.lcu),
      render: (it) => { const v = num(it.m.lcu); return v == null ? null : v.toFixed(1); },
    },
  ];

  return (
    <Card
      title={tt('LB 진단 메트릭')}
      subtitle={`${ids.length} load balancers · CloudWatch AWS/NetworkELB · ${tt('값은 선택 기간 전체 집계')} · L4: ${tt('RST 카운트와 타깃 헬스가 진단의 핵심')}`}
      right={<RangePicker value={range} onChange={setRange} />}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패')}: {err}</div>}
      <MetricTable columns={columns} items={items} rowKey={(it) => String(it.row.resource_id)} />

      <TgHealthTable health={health} lbDims={lbDims} />

      <DiagnosisGuide spec={NLB_GUIDE} />
    </Card>
  );
}
