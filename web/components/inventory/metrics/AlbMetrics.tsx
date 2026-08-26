'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import DiagnosisGuide from './DiagnosisGuide';
import { ALB_GUIDE } from './guides';
import MetricTable, { type MetricCol } from './MetricTable';
import TgHealthTable, { type TgHealthRow } from './TgHealthTable';
import { type Row, type Fleet, num, dash, cnt, RangePicker } from './shared';

// ALB per-LB diagnostics (owner 가이드): ELB가 낸 에러 vs 타깃이 낸 에러 구분 + p50/p99 지연 +
// 연결 거부/타깃 연결 실패 + 타깃그룹 헬스. 응답은 {fleet(resource_id 키), targetHealth, lbDimByResource}.
// 기간별 조회(RangePicker) + 컬럼 정렬/검색/문제만 필터는 MetricTable이 제공.

type Item = { row: Row; m: Record<string, number | null> };

export function AlbMetrics({ rows }: { rows: Row[] }) {
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
    fetch(`/api/inventory/alb/metrics?ids=${encodeURIComponent(key)}&range=${range}`)
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

  const secs = (v: number | null) => (v == null ? dash : `${(v * 1000).toFixed(0)} ms`); // TargetResponseTime unit = seconds

  const columns: MetricCol<Item>[] = [
    { key: 'id', label: 'ALB', mono: true, value: (it) => String(it.row.resource_id) },
    {
      key: 'requests', label: 'Requests', type: 'num', title: tt('RequestCount(선택 기간 누적) — 트래픽 기준선'),
      value: (it) => num(it.m.requests), render: (it) => cnt(num(it.m.requests)),
    },
    {
      key: 'elb5xx', label: 'ELB 5xx', type: 'num',
      title: tt('HTTPCode_ELB_5XX — LB↔타깃 문제 (ELB가 낸 에러, 백엔드 아님)'),
      value: (it) => num(it.m.elb5xx), render: (it) => cnt(num(it.m.elb5xx)),
      danger: (it) => { const v = num(it.m.elb5xx); return v != null && v > 0; },
    },
    {
      key: 'elb502', label: '502', type: 'num',
      title: tt('HTTPCode_ELB_502 — 타깃 연결 끊김/keep-alive 불일치'),
      value: (it) => num(it.m.elb502), render: (it) => cnt(num(it.m.elb502)),
      danger: (it) => { const v = num(it.m.elb502); return v != null && v > 0; },
    },
    {
      key: 'elb503', label: '503', type: 'num',
      title: tt('HTTPCode_ELB_503 — 정상 타깃 없음'),
      value: (it) => num(it.m.elb503), render: (it) => cnt(num(it.m.elb503)),
      danger: (it) => { const v = num(it.m.elb503); return v != null && v > 0; },
    },
    {
      key: 'elb504', label: '504', type: 'num',
      title: tt('HTTPCode_ELB_504 — 백엔드 타임아웃'),
      value: (it) => num(it.m.elb504), render: (it) => cnt(num(it.m.elb504)),
      danger: (it) => { const v = num(it.m.elb504); return v != null && v > 0; },
    },
    {
      key: 'tgt5xx', label: 'Target 5xx', type: 'num', title: tt('HTTPCode_Target_5XX — 백엔드 애플리케이션 오류'),
      value: (it) => num(it.m.tgt5xx), render: (it) => cnt(num(it.m.tgt5xx)),
      danger: (it) => { const v = num(it.m.tgt5xx); return v != null && v > 0; },
    },
    {
      key: 'tgt2xx', label: 'Target 2xx', type: 'num', title: tt('HTTPCode_Target_2XX — 정상 트래픽 기준선'),
      value: (it) => num(it.m.tgt2xx), render: (it) => cnt(num(it.m.tgt2xx)),
    },
    {
      key: 'respP50', label: 'Resp p50', type: 'num', title: 'TargetResponseTime p50',
      value: (it) => num(it.m.respP50), render: (it) => secs(num(it.m.respP50)),
    },
    {
      key: 'respP99', label: 'Resp p99', type: 'num', title: tt('TargetResponseTime p99 — 평균은 롱테일을 숨김, 급증=백엔드 성능 저하'),
      value: (it) => num(it.m.respP99), render: (it) => secs(num(it.m.respP99)),
    },
    {
      key: 'active', label: 'Active', type: 'num', title: 'ActiveConnectionCount',
      value: (it) => num(it.m.active), render: (it) => cnt(num(it.m.active)),
    },
    {
      key: 'rejected', label: 'Rejected', type: 'num', title: tt('RejectedConnectionCount — >0이면 ALB 연결 한도 도달(용량 문제)'),
      value: (it) => num(it.m.rejected), render: (it) => cnt(num(it.m.rejected)),
      danger: (it) => { const v = num(it.m.rejected); return v != null && v > 0; },
    },
    {
      key: 'tgtConnErr', label: 'Tgt Conn Err', type: 'num', title: tt('TargetConnectionErrorCount — ALB→타깃 연결 실패(네트워크/SG/포트)'),
      value: (it) => num(it.m.tgtConnErr), render: (it) => cnt(num(it.m.tgtConnErr)),
      danger: (it) => { const v = num(it.m.tgtConnErr); return v != null && v > 0; },
    },
    {
      key: 'clientTlsErr', label: 'TLS Err', type: 'num', title: 'ClientTLSNegotiationErrorCount',
      value: (it) => num(it.m.clientTlsErr), render: (it) => cnt(num(it.m.clientTlsErr)),
    },
    {
      key: 'lcu', label: 'LCU', type: 'num', title: tt('ConsumedLCUs(선택 기간 누적) — 용량/요금 산정, 급증 감지'),
      value: (it) => num(it.m.lcu),
      render: (it) => { const v = num(it.m.lcu); return v == null ? dash : v.toFixed(1); },
    },
  ];

  return (
    <Card
      title={tt('LB 진단 메트릭')}
      subtitle={`${ids.length} load balancers · CloudWatch AWS/ApplicationELB · ${tt('값은 선택 기간 전체 집계')} · ${tt('ELB 에러(LB 자체) vs Target 에러(백엔드) 구분')}`}
      right={<RangePicker value={range} onChange={setRange} />}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패')}: {err}</div>}
      <MetricTable columns={columns} items={items} rowKey={(it) => String(it.row.resource_id)} />

      <TgHealthTable health={health} lbDims={lbDims} />

      <DiagnosisGuide spec={ALB_GUIDE} />
    </Card>
  );
}
