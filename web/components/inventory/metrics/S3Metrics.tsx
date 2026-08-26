'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import DiagnosisGuide from './DiagnosisGuide';
import { S3_GUIDE } from './guides';
import MetricTable, { type MetricCol } from './MetricTable';
import { type Row, type Fleet, num, dash, cnt, mb, ms, RangePicker } from './shared';

// S3 per-bucket diagnostics (owner 가이드): 스토리지(일별)/요청(유료, 활성화 시)/복제.
// 요청 메트릭 미활성 버킷은 '—' — 가이드의 'S3만의 특이점' 섹션이 이유를 설명한다.
// 기간별 조회(RangePicker) + 컬럼 정렬/검색/문제만 필터는 MetricTable이 제공.
interface ReplicationRow { source: string; dest: string; rule: string; latencySec: number | null; failed: number | null }

type Item = { row: Row; m: Record<string, number | null> };

const fmtSize = (v: number | null) => {
  if (v == null) return dash;
  if (v >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(2)} TB`;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  return `${(v / 1024 ** 2).toFixed(1)} MB`;
};

export function S3Metrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const [range, setRange] = useState(3600);
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 150), [rows]);
  const [fleet, setFleet] = useState<Fleet>({});
  const [replication, setReplication] = useState<ReplicationRow[]>([]);
  const [err, setErr] = useState('');
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/inventory/s3/metrics?ids=${encodeURIComponent(key)}&range=${range}`)
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

  const columns: MetricCol<Item>[] = [
    { key: 'bucket', label: 'Bucket', mono: true, value: (it) => String(it.row.resource_id) },
    {
      key: 'size', label: 'Size (Standard)', type: 'num',
      title: tt('BucketSizeBytes(StandardStorage, 일별) — 이상 급증 = 비용/이상 업로드. 일별 지표라 기간 선택과 무관'),
      value: (it) => num(it.m.sizeStd), render: (it) => fmtSize(num(it.m.sizeStd)),
    },
    {
      key: 'objects', label: 'Objects', type: 'num',
      title: tt('NumberOfObjects(일별) — 급증/급감으로 대량 생성/삭제 감지. 일별 지표라 기간 선택과 무관'),
      value: (it) => num(it.m.objects), render: (it) => cnt(num(it.m.objects)),
    },
    {
      key: 'req', label: 'Requests', type: 'num',
      title: tt('AllRequests(선택 기간 누적) — 요청 메트릭 활성 버킷만'),
      value: (it) => num(it.m.allReq), render: (it) => cnt(num(it.m.allReq)),
    },
    {
      key: 'e4', label: '4xx', type: 'num',
      title: tt('4xxErrors(선택 기간 누적) — 급증 시 권한(403)/경로(404) 문제, CloudTrail 데이터 이벤트로 추적'),
      value: (it) => num(it.m.req4xx), render: (it) => cnt(num(it.m.req4xx)),
      danger: (it) => { const v = num(it.m.req4xx); return v != null && v > 0; },
    },
    {
      key: 'e5', label: '5xx', type: 'num',
      title: tt('5xxErrors(선택 기간 누적) — 503 SlowDown이면 핫 프리픽스(프리픽스당 3,500w/5,500r 한도)'),
      value: (it) => num(it.m.req5xx), render: (it) => cnt(num(it.m.req5xx)),
      danger: (it) => { const v = num(it.m.req5xx); return v != null && v > 0; },
    },
    {
      key: 'firstByte', label: 'First Byte', type: 'num',
      title: tt('FirstByteLatency(평균 ms) — 급증 = S3 처리 지연 (TotalRequestLatency와 구분)'),
      value: (it) => num(it.m.firstByte), render: (it) => ms(num(it.m.firstByte)),
    },
    {
      key: 'bytesDown', label: 'Bytes ↓', type: 'num', title: tt('BytesDownloaded(선택 기간 누적)'),
      value: (it) => num(it.m.bytesDown), render: (it) => mb(num(it.m.bytesDown)),
    },
    {
      key: 'bytesUp', label: 'Bytes ↑', type: 'num', title: tt('BytesUploaded(선택 기간 누적)'),
      value: (it) => num(it.m.bytesUp), render: (it) => mb(num(it.m.bytesUp)),
    },
  ];

  const replCols: MetricCol<ReplicationRow>[] = [
    { key: 'source', label: 'Source', mono: true, value: (l) => l.source },
    { key: 'dest', label: 'Destination', mono: true, value: (l) => l.dest || null },
    { key: 'rule', label: 'Rule', mono: true, value: (l) => l.rule || null },
    {
      key: 'latency', label: 'Latency', type: 'num',
      title: tt('ReplicationLatency — RTC SLA 15분(900초) 초과 시 경보'),
      value: (l) => l.latencySec,
      render: (l) => (l.latencySec == null ? null : `${Math.round(l.latencySec).toLocaleString()}s`),
      danger: (l) => l.latencySec != null && l.latencySec > 900,
    },
    {
      key: 'failed', label: 'Failed', type: 'num',
      title: tt('OperationsFailedReplication — >0이면 권한/설정 문제 조사'),
      value: (l) => l.failed,
      render: (l) => (l.failed == null ? null : Math.round(l.failed).toLocaleString()),
      danger: (l) => l.failed != null && l.failed > 0,
    },
  ];

  return (
    <Card
      title={tt('버킷 진단 메트릭')}
      subtitle={`${ids.length} buckets · ${tt('크기/객체 수는 일별 집계(Standard), 요청 지표는 요청 메트릭(EntireBucket) 활성 버킷만')} · ${tt('값은 선택 기간 전체 집계')}`}
      right={<RangePicker value={range} onChange={setRange} />}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패')}: {err}</div>}
      <MetricTable columns={columns} items={items} rowKey={(it) => String(it.row.resource_id)} />

      {/* CRR/SRR 복제 상태 — Source/Dest/RuleId 차원은 ListMetrics로 발견 (복제 룰 있는 계정만 표시) */}
      {replication.length > 0 && (
        <div className="border-t border-ink-100">
          <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">{tt('복제 상태 (CRR/SRR, 선택 기간)')}</div>
          <MetricTable
            columns={replCols}
            items={replication.slice(0, 15)}
            rowKey={(l, i) => `${l.source}|${l.dest}|${l.rule}|${i}`}
          />
        </div>
      )}

      <DiagnosisGuide spec={S3_GUIDE} />
    </Card>
  );
}
