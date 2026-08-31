'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Waypoints } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import PolicyGraph from '@/components/graph/PolicyGraph';
import { SgAnalysisSection } from '@/components/inventory/NodeMetricsTables';
import { useActiveScope, scopeParams } from '@/lib/account-context';
import { useI18n } from '@/components/shell/LanguageProvider';
import { buildSgUsageGraph } from '@/lib/sg-usage-graph';
import type { SgUsageRow, SgHitsResult } from '@/lib/sg-analysis';

type Row = Record<string, unknown>;

// /network/security-groups/usage — SG Usage screen (docs/superpowers/specs/
// 2026-08-13-security-group-rules-usage-design.md "Usage page contents"). Hosts the FULL analysis
// previously embedded at the bottom of /inventory/security_group (KPI cards, 1h/6h/24h/7d range,
// filters, table, row-click traffic-hit drilldown — unchanged, see SgAnalysisSection) plus, on row
// selection, a compact relationship graph (ENI attachments + mutual SG references, built by
// web/lib/sg-usage-graph.ts from the same /api/sg data) and a link into the Rules screen filtered
// to that SG.
export default function SecurityGroupUsagePage() {
  const { tt } = useI18n();
  const [scope] = useActiveScope();
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<SgUsageRow | null>(null);
  const [hits, setHits] = useState<SgHitsResult | null>(null);

  // The security_group inventory rows drive the same account/region SCOPE the legacy embedding
  // used inside /inventory/security_group — SgAnalysisSection derives its own `regions=` scope
  // from this row set (see its regionsKey), so the Usage page must feed it the same shape of rows.
  useEffect(() => {
    let alive = true;
    fetch(`/api/inventory/security_group?limit=500&${scopeParams(scope)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!alive) return;
        setRows((d.rows as { resource_id: string; region: string; data: object }[]).map((x) => ({ resource_id: x.resource_id, region: x.region, ...(x.data as object) })));
        setErr('');
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [scope]);

  const regionsKey = useMemo(() => [...new Set(rows.map((r) => String(r.region ?? '')).filter(Boolean))].sort().join(','), [rows]);

  // Best-effort hits fetch for the graph only — independent of SgAnalysisSection's own drilldown
  // fetch (which uses its own range selector); this graph always uses a fixed 24h window since its
  // job is to show relationship structure, not to replace the primary hit-matching table above.
  useEffect(() => {
    let alive = true;
    setHits(null);
    if (!selected) return;
    const regionsParam = regionsKey ? `&regions=${encodeURIComponent(regionsKey)}` : '';
    fetch(`/api/sg?view=hits&id=${encodeURIComponent(selected.id)}&range=86400${regionsParam}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setHits(d); })
      .catch(() => { if (alive) setHits(null); });
    return () => { alive = false; };
  }, [selected, regionsKey]);

  const graph = useMemo(() => (selected ? buildSgUsageGraph(selected, hits) : null), [selected, hits]);

  const onSelectSg = useCallback((row: SgUsageRow | null) => setSelected(row), []);

  return (
    <>
      <PageHeader title={tt('보안 그룹 사용 현황')} subtitle={tt('ENI 부착·상호참조 기반 사용 분석 — 행 클릭 시 트래픽 히트 매칭 + 관계 그래프')} />
      <div className="px-8 py-8 flex flex-col gap-6">
        {err && <div className="text-[13px] text-rose-600">{err}</div>}
        <SgAnalysisSection rows={rows} onSelect={onSelectSg} />

        {selected && graph && (
          <Card
            title={`${tt('관계 그래프')} — ${selected.id}`}
            subtitle={tt('ENI 부착 · 상호 참조 SG · 관측된 트래픽 상대')}
            padded={false}
            right={
              <Link
                href={`/network/security-groups/rules?sg=${encodeURIComponent(selected.id)}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-brand-700 hover:underline"
              >
                <Waypoints size={13} />
                {tt('이 SG의 규칙 보기')}
              </Link>
            }
          >
            <div className="h-[360px]">
              <PolicyGraph graph={graph} compact />
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
