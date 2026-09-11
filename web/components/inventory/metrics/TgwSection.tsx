'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { useI18n } from '@/components/shell/LanguageProvider';
import MetricTable, { type MetricCol } from './MetricTable';
import { type Row, num, dash, cnt, RangePicker, useFleet } from './shared';
import type { TgwAttachment, TgwRoute, TgwRouteTable } from '@/lib/tgw';

// Transit Gateway per-TGW diagnostics (owner 가이드): CloudWatch Bytes/Packets +
// Blackhole/NoRoute 드롭(>0 = 라우팅 문제 신호) + 어태치먼트/라우트 테이블 상세(/api/tgw).
// 기간별 조회(RangePicker) + 정렬/검색/문제만 필터는 MetricTable이 제공.

type Item = { row: Row; m: Record<string, number | null> };

const bytes = (v: number | null) => {
  if (v == null) return dash;
  if (v >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(2)} TB`;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${Math.round(v)} B`;
};

export function TgwSection({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const [range, setRange] = useState(3600);
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 30), [rows]);
  const { fleet, err } = useFleet('transit_gateway', ids, range);

  const [attachments, setAttachments] = useState<TgwAttachment[]>([]);
  const [routeTables, setRouteTables] = useState<TgwRouteTable[]>([]);
  const [optionsDegraded, setOptionsDegraded] = useState<string[]>([]);
  const [detailErr, setDetailErr] = useState('');
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/tgw?ids=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (live) {
          setAttachments(d.attachments ?? []);
          setRouteTables(d.routeTables ?? []);
          setOptionsDegraded(d.optionsDegradedRegions ?? []);
          setDetailErr('');
        }
      })
      .catch((e) => {
        if (live) {
          setDetailErr(String(e instanceof Error ? e.message : e));
          // a stale degraded-region list must not stand next to rows it no longer describes
          setOptionsDegraded([]);
        }
      });
    return () => { live = false; };
  }, [key]);

  const items: Item[] = useMemo(
    () => rows.map((row) => ({ row, m: fleet[String(row.resource_id)] ?? {} })),
    [rows, fleet],
  );
  if (rows.length === 0) return null;

  const metricCols: MetricCol<Item>[] = [
    { key: 'id', label: 'TGW', mono: true, value: (it) => String(it.row.resource_id) },
    {
      key: 'bytesIn', label: 'Bytes In', type: 'num', title: tt('BytesIn(선택 기간 누적) — TGW로 들어온 트래픽'),
      value: (it) => num(it.m.bytesIn), render: (it) => bytes(num(it.m.bytesIn)),
    },
    {
      key: 'bytesOut', label: 'Bytes Out', type: 'num', title: tt('BytesOut(선택 기간 누적) — TGW에서 나간 트래픽'),
      value: (it) => num(it.m.bytesOut), render: (it) => bytes(num(it.m.bytesOut)),
    },
    {
      key: 'packetsIn', label: 'Packets In', type: 'num', title: 'PacketsIn (Sum)',
      value: (it) => num(it.m.packetsIn), render: (it) => cnt(num(it.m.packetsIn)),
    },
    {
      key: 'packetsOut', label: 'Packets Out', type: 'num', title: 'PacketsOut (Sum)',
      value: (it) => num(it.m.packetsOut), render: (it) => cnt(num(it.m.packetsOut)),
    },
    {
      key: 'dropBlackhole', label: tt('Blackhole 드롭'), type: 'num',
      title: tt('PacketDropCountBlackhole — >0이면 블랙홀 라우트로 드롭된 트래픽(라우팅 문제 신호)'),
      value: (it) => num(it.m.dropBlackhole), render: (it) => cnt(num(it.m.dropBlackhole)),
      danger: (it) => { const v = num(it.m.dropBlackhole); return v != null && v > 0; },
    },
    {
      key: 'dropNoRoute', label: tt('NoRoute 드롭'), type: 'num',
      title: tt('PacketDropCountNoRoute — >0이면 매칭 라우트 없음(라우팅 문제 신호)'),
      value: (it) => num(it.m.dropNoRoute), render: (it) => cnt(num(it.m.dropNoRoute)),
      danger: (it) => { const v = num(it.m.dropNoRoute); return v != null && v > 0; },
    },
  ];

  const attCols: MetricCol<TgwAttachment>[] = [
    { key: 'tgw', label: 'TGW', facet: true, mono: true, value: (a) => a.tgwId },
    { key: 'att', label: 'Attachment', mono: true, value: (a) => a.id },
    { key: 'type', label: 'Type', facet: true, value: (a) => a.resourceType },
    { key: 'resource', label: 'Resource', mono: true, value: (a) => a.resourceId || null },
    {
      key: 'state', label: 'State', facet: true, value: (a) => a.state,
      danger: (a) => a.state !== 'available',
    },
    { key: 'rtb', label: 'Route Table', mono: true, value: (a) => a.routeTableId },
    {
      // gap L168: v1's row-click options JSON, rendered inline. Options exist only on VPC
      // attachments (per-type API) — other types read '—'; a DENIED options describe is
      // disclosed via the subtitle (optionsDegraded), never presented as "not a VPC
      // attachment". Missing individual fields render '—' (the table's null convention).
      key: 'options', label: 'Options', mono: true,
      value: (a) => (a.options
        ? `DNS:${a.options.dnsSupport ?? '—'} IPv6:${a.options.ipv6Support ?? '—'} Appliance:${a.options.applianceModeSupport ?? '—'}`
        : null),
    },
  ];

  const routeCols: MetricCol<TgwRoute>[] = [
    { key: 'cidr', label: 'CIDR', mono: true, value: (r) => r.cidr },
    { key: 'type', label: 'Type', facet: true, value: (r) => r.type },
    {
      key: 'state', label: 'State', facet: true, value: (r) => r.state,
      danger: (r) => r.state === 'blackhole',
    },
    {
      key: 'target', label: 'Target', mono: true,
      value: (r) => (r.resourceId ? `${r.resourceId}${r.resourceType ? ` (${r.resourceType})` : ''}` : null),
    },
  ];

  return (
    <>
      <Card
        title={tt('TGW 진단 메트릭')}
        subtitle={`${ids.length} transit gateways · CloudWatch AWS/TransitGateway · ${tt('값은 선택 기간 전체 집계')} · ${tt('Blackhole/NoRoute 드롭 >0 = 라우팅 문제 신호')}`}
        right={<RangePicker value={range} onChange={setRange} />}
        padded={false}
      >
        {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패')}: {err}</div>}
        <MetricTable columns={metricCols} items={items} rowKey={(it) => String(it.row.resource_id)} />
      </Card>

      <Card
        title={tt('어태치먼트')}
        subtitle={`${attachments.length} attachments · ${tt('available 아닌 상태는 위험으로 표시')} · ${tt('Options는 VPC 어태치먼트만 제공')}${optionsDegraded.length ? ` · ${tt('일부 리전의 Options 불완전(조회 실패·절단·미반환) — 해당 리전의 — 값은 확정 아님')} (${optionsDegraded.join(', ')})` : ''}`}
        padded={false}
      >
        {detailErr && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('상세 조회 실패')}: {detailErr}</div>}
        <MetricTable columns={attCols} items={attachments} rowKey={(a) => a.id} />
      </Card>

      <Card
        title={tt('라우팅 테이블')}
        subtitle={`${routeTables.length} route tables · ${tt('라우트는 active/blackhole만, 테이블당 상한 있음')}`}
        padded={false}
      >
        {routeTables.map((t) => (
          <div key={t.id} className="border-b border-ink-100 last:border-0">
            <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-1">
              <span className="font-mono text-[12px] font-semibold text-ink-800">{t.id}</span>
              <span className="font-mono text-[11px] text-ink-400">{t.tgwId}</span>
              {t.defaultAssociation && <Badge tone="brand">default assoc</Badge>}
              {t.defaultPropagation && <Badge tone="brand">default prop</Badge>}
              {t.state !== 'available' && <Badge tone="negative">{t.state}</Badge>}
              {t.truncated && <Badge tone="negative" variant="outline">{tt('상한 도달')}</Badge>}
            </div>
            {t.routes.length === 0 ? (
              <div className="px-4 pb-3 text-[12px] text-ink-400">{tt('라우트 없음')}</div>
            ) : (
              <MetricTable columns={routeCols} items={t.routes} rowKey={(r, i) => `${t.id}|${r.cidr}|${i}`} />
            )}
          </div>
        ))}
        {routeTables.length === 0 && (
          <div className="px-4 py-3 text-[12px] text-ink-400">{tt('데이터 없음')}</div>
        )}
      </Card>
    </>
  );
}
