'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import DiagnosisGuide from './DiagnosisGuide';
import { DDB_GUIDE } from './guides';
import MetricTable, { type MetricCol } from './MetricTable';
import { type Row, type Fleet, num, dash, cnt, RangePicker } from './shared';

// DynamoDB per-table diagnostics (owner 가이드: 스로틀링·용량·지연·에러·Global Tables).
// 기간별 조회(RangePicker) + 컬럼 정렬/검색/facet/문제만 필터는 MetricTable이 제공.
interface DdbReplicationRow { table: string; region: string; latencyMs: number | null }

type Item = { row: Row; m: Record<string, number | null> };

export function DynamoTableMetrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const [range, setRange] = useState(3600);
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 200), [rows]);
  const [fleet, setFleet] = useState<Fleet>({});
  const [replication, setReplication] = useState<DdbReplicationRow[]>([]);
  const [err, setErr] = useState('');
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/inventory/dynamodb/metrics?ids=${encodeURIComponent(key)}&range=${range}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setFleet(d.fleet ?? {}); setReplication(d.replication ?? []); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [key, range]);

  const items: Item[] = useMemo(
    () => rows.map((row) => ({ row, m: fleet[String(row.resource_id)] ?? {} })),
    [rows, fleet],
  );
  if (rows.length === 0) return null;

  const latFmt = (v: number | null) => (v == null ? dash : v.toFixed(1)); // SuccessfulRequestLatency is already ms
  // 소비 용량: Sum(선택 기간) → 초당 소비율. Provisioned와 직접 비교 (근접/초과 = 위험).
  const rate = (sum: number | null) => (sum == null ? null : sum / range);
  const provOf = (v: number | null) => (v != null && v > 0 ? v : null); // On-Demand는 0 → 비교 불가
  const rateFmt = (c: number | null) => (c == null ? dash : c < 10 ? c.toFixed(2) : Math.round(c).toLocaleString());
  const capHot = (consumed: number | null, prov: number | null) => {
    const c = rate(consumed); const p = provOf(prov);
    return p != null && c != null && c >= p * 0.8;
  };

  const throttleTitle = (metric: string) =>
    `${metric}${tt('(선택 기간 누적) — >0 지속이면 용량 부족 또는 핫 파티션. Contributor Insights로 핫 키 확인')}`;

  const columns: MetricCol<Item>[] = [
    { key: 'table', label: 'Table', mono: true, value: (it) => String(it.row.resource_id) },
    {
      key: 'billing', label: 'Billing', facet: true,
      value: (it) => (String(it.row.billing_mode ?? '—') === 'PAY_PER_REQUEST' ? 'On-Demand' : 'Provisioned'),
    },
    {
      key: 'throttleR', label: 'Throttle R', type: 'num', title: throttleTitle('ReadThrottleEvents'),
      value: (it) => num(it.m.rThrottle), render: (it) => cnt(num(it.m.rThrottle)),
      danger: (it) => (num(it.m.rThrottle) ?? 0) > 0,
    },
    {
      key: 'throttleW', label: 'Throttle W', type: 'num', title: throttleTitle('WriteThrottleEvents'),
      value: (it) => num(it.m.wThrottle), render: (it) => cnt(num(it.m.wThrottle)),
      danger: (it) => (num(it.m.wThrottle) ?? 0) > 0,
    },
    {
      key: 'rcuUsed', label: tt('RCU 소비'), type: 'num',
      title: tt('ConsumedReadCapacityUnits(초당 소비율) — 프로비저닝의 80% 이상이면 위험(근접/초과)'),
      value: (it) => rate(num(it.m.consumedR)), render: (it) => rateFmt(rate(num(it.m.consumedR))),
      danger: (it) => capHot(num(it.m.consumedR), num(it.m.provR)),
    },
    {
      key: 'rcuProv', label: tt('RCU 프로비저닝'), type: 'num',
      title: tt('ProvisionedReadCapacityUnits — On-Demand는 표시 없음'),
      value: (it) => provOf(num(it.m.provR)),
      render: (it) => { const p = provOf(num(it.m.provR)); return p == null ? dash : Math.round(p).toLocaleString(); },
    },
    {
      key: 'wcuUsed', label: tt('WCU 소비'), type: 'num',
      title: tt('ConsumedWriteCapacityUnits(초당 소비율) — 프로비저닝의 80% 이상이면 위험(근접/초과)'),
      value: (it) => rate(num(it.m.consumedW)), render: (it) => rateFmt(rate(num(it.m.consumedW))),
      danger: (it) => capHot(num(it.m.consumedW), num(it.m.provW)),
    },
    {
      key: 'wcuProv', label: tt('WCU 프로비저닝'), type: 'num',
      title: tt('ProvisionedWriteCapacityUnits — On-Demand는 표시 없음'),
      value: (it) => provOf(num(it.m.provW)),
      render: (it) => { const p = provOf(num(it.m.provW)); return p == null ? dash : Math.round(p).toLocaleString(); },
    },
    {
      key: 'latGet', label: 'Lat Get', type: 'num', title: 'SuccessfulRequestLatency(GetItem, ms)',
      value: (it) => num(it.m.latGet), render: (it) => latFmt(num(it.m.latGet)),
    },
    {
      key: 'latQuery', label: 'Lat Query', type: 'num', title: tt('SuccessfulRequestLatency(Query, ms) — 급증 시 액세스 패턴 의심'),
      value: (it) => num(it.m.latQuery), render: (it) => latFmt(num(it.m.latQuery)),
    },
    {
      key: 'latPut', label: 'Lat Put', type: 'num', title: 'SuccessfulRequestLatency(PutItem, ms)',
      value: (it) => num(it.m.latPut), render: (it) => latFmt(num(it.m.latPut)),
    },
    {
      key: 'latScan', label: 'Lat Scan', type: 'num', title: tt('SuccessfulRequestLatency(Scan, ms) — 풀스캔/큰 결과셋 의심'),
      value: (it) => num(it.m.latScan), render: (it) => latFmt(num(it.m.latScan)),
    },
    {
      key: 'condFail', label: 'CondFail', type: 'num', title: tt('ConditionalCheckFailedRequests — 낙관적 락이면 정상 발생 가능, 맥락 판단'),
      value: (it) => num(it.m.condFail), render: (it) => cnt(num(it.m.condFail)),
    },
    {
      key: 'txnConflict', label: 'TxnConflict', type: 'num', title: tt('TransactionConflict — 높으면 경합 심함'),
      value: (it) => num(it.m.txnConflict), render: (it) => cnt(num(it.m.txnConflict)),
    },
  ];

  const repColumns: MetricCol<DdbReplicationRow>[] = [
    { key: 'table', label: 'Table', mono: true, value: (l) => l.table },
    { key: 'region', label: 'Receiving Region', mono: true, facet: true, value: (l) => l.region || null },
    {
      key: 'latency', label: 'Latency', type: 'num', title: tt('리전 간 복제 지연 — 증가 추세면 경보'),
      value: (l) => l.latencyMs,
      render: (l) => (l.latencyMs == null ? dash : `${Math.round(l.latencyMs).toLocaleString()} ms`),
    },
  ];

  return (
    <Card
      title={tt('테이블 진단 메트릭')}
      subtitle={`${ids.length} tables · CloudWatch AWS/DynamoDB · ${tt('용량은 초당 소비율')} · ${tt('값은 선택 기간 전체 집계')}`}
      right={<RangePicker value={range} onChange={setRange} />}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패')}: {err}</div>}
      <MetricTable columns={columns} items={items} rowKey={(it, i) => `${String(it.row.resource_id)}:${i}`} />

      {replication.length > 0 && (
        <div className="border-t border-ink-100">
          <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">{tt('Global Tables 복제 지연 (ReplicationLatency, 선택 기간)')}</div>
          <MetricTable
            columns={repColumns}
            items={replication.slice(0, 15)}
            rowKey={(l, i) => `${l.table}:${l.region}:${i}`}
          />
        </div>
      )}

      <DiagnosisGuide spec={DDB_GUIDE} />
    </Card>
  );
}
