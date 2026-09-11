'use client';
import { useMemo } from 'react';
import GroupedBarList from '@/components/charts/GroupedBarList';
import { useI18n } from '@/components/shell/LanguageProvider';
import { estimateDailyParts } from '@/lib/cost-basis';
import type { Row } from './shared';

// Cost by Service — CPU vs Memory grouped bar (gap L195, v1 container-cost parity): FARGATE
// tasks group by their task_group's `service:` name, and the CPU/Memory daily-cost split
// comes from the SHARED estimateDailyParts (the batch-25 single-source rule — the same
// constants the table's Daily $ column computes with). EC2 launch-type tasks and tasks
// without a service group are EXCLUDED — the deriver gives them no estimate, and a bar must
// not mix estimated and unestimated populations. Named export per the metrics-module
// convention.

const usd = (v: number) => `$${v.toFixed(2)}`;

export function EcsCostByService({ rows, isTruncated = false }: { rows: Row[]; isTruncated?: boolean }) {
  const { tt } = useI18n();
  const data = useMemo(() => {
    // keyed on cluster+service (ECS service names are unique only within a cluster — a 'web'
    // in two clusters must not merge into one bar); labeled cluster/service.
    const byService = new Map<string, { label: string; cpu: number; mem: number }>();
    for (const r of rows) {
      if (String(r.launch_type ?? '').toUpperCase() !== 'FARGATE') continue;
      const g = String(r.task_group ?? '');
      if (!g.startsWith('service:')) continue;
      const cpu = Number(r.cpu);
      const mem = Number(r.memory);
      // > 0, not isFinite: a null/'' cpu coerces to 0 and would contribute a confident $0.00
      if (!(cpu > 0) || !(mem > 0)) continue;
      const parts = estimateDailyParts(cpu / 1024, mem / 1024);
      // KEY on the full cluster_arn (round-2 gate: same-named clusters exist per region per
      // account — 'default' everywhere); the short cluster_h stays the display label.
      const svc = g.slice('service:'.length);
      const key = `${String(r.cluster_arn ?? '')}|${svc}`;
      const label = `${String(r.cluster_h ?? r.cluster_arn ?? '')}/${svc}`;
      const e = byService.get(key) ?? { label, cpu: 0, mem: 0 };
      e.cpu += parts.cpu; e.mem += parts.ram;
      byService.set(key, e);
    }
    return [...byService.values()]
      .map((v) => ({ service: v.label, cpu: Math.round(v.cpu * 100) / 100, mem: Math.round(v.mem * 100) / 100 }))
      .sort((a, b) => (b.cpu + b.mem) - (a.cpu + a.mem))
      .slice(0, 10);
  }, [rows]);

  if (data.length === 0) return null;
  const title = tt('서비스별 비용 (일간, CPU vs Memory)');
  return (
    <GroupedBarList
      // 표본 기준: the page's ONE truncation signal for every sample-based consumer.
      title={isTruncated ? `${title} (${tt('표본 기준')})` : title}
      data={data}
      labelKey="service"
      // both series are USD/day → ONE shared scale (per-series would render the largest
      // Memory bar as wide as the largest CPU bar, destroying the comparison).
      sharedScale
      series={[
        { key: 'cpu', label: 'CPU', color: '#3D6FB5', fmt: usd },
        { key: 'mem', label: 'Memory', color: '#8A5BD0', fmt: usd },
      ]}
    />
  );
}

export default EcsCostByService;
