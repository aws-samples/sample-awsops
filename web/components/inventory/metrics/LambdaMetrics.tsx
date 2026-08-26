'use client';
import { useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import DiagnosisGuide from './DiagnosisGuide';
import { LAMBDA_GUIDE } from './guides';
import MetricTable, { type MetricCol } from './MetricTable';
import { type Row, num, RangePicker, useFleet } from './shared';

// Lambda per-function diagnostics (owner 가이드): 에러율(Invocations 대비), Duration p99 vs
// 타임아웃(행 데이터의 timeout과 비교 — 80% 이상이면 위험), 스로틀/DLQ/PC 스필오버 >0 = rose.

type Item = { row: Row; m: Record<string, number | null> };

export function LambdaMetrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const [range, setRange] = useState(3600);
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 150), [rows]);
  const { fleet, err } = useFleet('lambda', ids, range);

  const items: Item[] = useMemo(
    () => rows.map((row) => ({ row, m: fleet[String(row.resource_id)] ?? {} })),
    [rows, fleet],
  );
  if (rows.length === 0) return null;

  const errRate = (m: Record<string, number | null>): number | null => {
    const inv = num(m.invocations); const e = num(m.errors);
    if (inv == null || e == null || inv === 0) return null;
    return (e / inv) * 100;
  };
  const timeoutMs = (row: Row): number | null => {
    const t = Number(row.timeout);
    return Number.isFinite(t) && t > 0 ? t * 1000 : null;
  };

  const columns: MetricCol<Item>[] = [
    { key: 'fn', label: 'Function', mono: true, value: (it) => String(it.row.resource_id) },
    { key: 'runtime', label: 'Runtime', facet: true, value: (it) => (typeof it.row.runtime === 'string' ? it.row.runtime : 'custom') },
    { key: 'mem', label: 'Memory', type: 'num', title: tt('메모리 설정이 곧 성능 — 상향 시 CPU/네트워크도 비례 증가 (가이드 참조)'),
      value: (it) => (Number.isFinite(Number(it.row.memory_size)) ? Number(it.row.memory_size) : null),
      render: (it) => (Number.isFinite(Number(it.row.memory_size)) ? `${it.row.memory_size} MB` : null) },
    { key: 'inv', label: 'Invocations', type: 'num', title: tt('Invocations — 선택 기간 누적, 트래픽 기준선'),
      value: (it) => num(it.m.invocations),
      render: (it) => { const v = num(it.m.invocations); return v == null ? null : Math.round(v).toLocaleString(); } },
    { key: 'errors', label: 'Errors', type: 'num', title: tt('Errors — 선택 기간 누적 (핸들러 예외·타임아웃)'),
      value: (it) => num(it.m.errors),
      render: (it) => { const v = num(it.m.errors); return v == null ? null : Math.round(v).toLocaleString(); },
      danger: (it) => (num(it.m.errors) ?? 0) > 0 },
    { key: 'errRate', label: tt('에러율'), type: 'num', title: tt('에러율 = Errors/Invocations — 절대값이 아닌 비율로 봐야 함 (1% 이상 위험 표시)'),
      value: (it) => errRate(it.m),
      render: (it) => { const v = errRate(it.m); return v == null ? null : `${v.toFixed(1)}%`; },
      danger: (it) => { const v = errRate(it.m); return v != null && v >= 1; } },
    { key: 'throttles', label: 'Throttles', type: 'num', title: tt('Throttles — 동시성 한도 초과 429. >0이면 가장 흔한 스케일 문제'),
      value: (it) => num(it.m.throttles),
      render: (it) => { const v = num(it.m.throttles); return v == null ? null : Math.round(v).toLocaleString(); },
      danger: (it) => (num(it.m.throttles) ?? 0) > 0 },
    { key: 'p50', label: 'Dur p50', type: 'num', title: 'Duration p50 (ms)',
      value: (it) => num(it.m.durP50),
      render: (it) => { const v = num(it.m.durP50); return v == null ? null : `${Math.round(v).toLocaleString()} ms`; } },
    { key: 'p99', label: 'Dur p99', type: 'num', title: tt('Duration p99 (ms) — 타임아웃 설정의 80% 이상이면 타임아웃 에러 위험 (평균은 콜드스타트를 숨김)'),
      value: (it) => num(it.m.durP99),
      render: (it) => { const v = num(it.m.durP99); return v == null ? null : `${Math.round(v).toLocaleString()} ms`; },
      danger: (it) => { const v = num(it.m.durP99); const to = timeoutMs(it.row); return v != null && to != null && v >= to * 0.8; } },
    { key: 'timeout', label: 'Timeout', type: 'num', title: tt('함수 타임아웃 설정 (초)'),
      value: (it) => (Number.isFinite(Number(it.row.timeout)) ? Number(it.row.timeout) : null),
      render: (it) => (Number.isFinite(Number(it.row.timeout)) ? `${it.row.timeout}s` : null) },
    { key: 'concurrent', label: 'Concurrent', type: 'num', title: tt('ConcurrentExecutions(기간 최대) — 계정 기본 한도 1,000 대비 확인, 근접 시 스로틀 임박'),
      value: (it) => num(it.m.concurrent),
      render: (it) => { const v = num(it.m.concurrent); return v == null ? null : Math.round(v).toLocaleString(); } },
    { key: 'iterAge', label: 'Iterator Age', type: 'num', title: tt('IteratorAge(기간 최대, ms) — 스트림 소스 전용. 증가 추세면 컨슈머가 프로듀서를 못 따라감'),
      value: (it) => num(it.m.iteratorAge),
      render: (it) => { const v = num(it.m.iteratorAge); return v == null ? null : `${Math.round(v / 1000).toLocaleString()}s`; },
      danger: (it) => { const v = num(it.m.iteratorAge); return v != null && v > 60_000; } },
    { key: 'dlq', label: 'DLQ Err', type: 'num', title: tt('DeadLetterErrors — >0이면 실패 이벤트 유실 위험'),
      value: (it) => num(it.m.deadLetterErrors),
      render: (it) => { const v = num(it.m.deadLetterErrors); return v == null ? null : Math.round(v).toLocaleString(); },
      danger: (it) => (num(it.m.deadLetterErrors) ?? 0) > 0 },
    { key: 'pcSpill', label: 'PC Spill', type: 'num', title: tt('ProvisionedConcurrencySpilloverInvocations — >0이면 PC 부족 → 초과분 콜드스타트'),
      value: (it) => num(it.m.pcSpillover),
      render: (it) => { const v = num(it.m.pcSpillover); return v == null ? null : Math.round(v).toLocaleString(); },
      danger: (it) => (num(it.m.pcSpillover) ?? 0) > 0 },
  ];

  return (
    <Card
      title={tt('함수 진단 메트릭')}
      subtitle={`${ids.length} functions · CloudWatch AWS/Lambda · ${tt('값은 선택 기간 전체 집계')} · ${tt('콜드스타트는 로그 Init Duration으로 (가이드 참조)')}`}
      right={<RangePicker value={range} onChange={setRange} />}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패')}: {err}</div>}
      <MetricTable columns={columns} items={items} rowKey={(it) => String(it.row.resource_id)} defaultSortKey="inv" />
      <DiagnosisGuide spec={LAMBDA_GUIDE} />
    </Card>
  );
}
