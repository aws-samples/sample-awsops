'use client';

// 5-column infra map (gap-audit L163): External | VPC | Subnet | Compute | NAT.
// Data = existing /api/inventory/[type] reads only; TGW→VPC attachments via /api/tgw.
import { useEffect, useMemo, useState } from 'react';
import MapCanvas, { MapLegend } from '@/components/topology/MapCanvas';
import { buildInfraMap, type InvRow, type TgwAttachmentLite } from '@/lib/infra-map';
import { useActiveScope, scopeParams } from '@/lib/account-context';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useTheme } from '@/lib/use-theme';

const TYPES = ['internet_gateway', 'transit_gateway', 'vpc', 'subnet', 'ec2', 'alb', 'nlb', 'rds', 'nat_gateway'] as const;
type MapType = (typeof TYPES)[number];
const COLUMNS = [{ title: 'External' }, { title: 'VPC' }, { title: 'Subnet' }, { title: 'Compute' }, { title: 'NAT' }];
const LIMIT = 500;

interface InvPage { rows?: InvRow[] }

export default function InfraMapView({ query }: { query: string }) {
  const [scope] = useActiveScope();
  const { tt } = useI18n();
  // Only 'dark' is a dark theme (cobalt/teal are light variants) — same mapping as /topology.
  const theme = useTheme() === 'dark' ? 'dark' as const : 'light' as const;
  const [rows, setRows] = useState<Partial<Record<MapType, InvRow[]>> | null>(null);
  const [tgwAtt, setTgwAtt] = useState<TgwAttachmentLite[]>([]);
  const [tgwNote, setTgwNote] = useState('');
  const [failed, setFailed] = useState<string[]>([]);
  const [capped, setCapped] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setBusy(true);
    setTgwAtt([]);
    setTgwNote('');
    const scopeQ = scopeParams(scope);
    // /api/tgw describes with the host account's credentials only — a non-host scope can't be enriched.
    const hostScope = scope.accounts !== '__all__' && scope.accounts.length === 1 && scope.accounts[0] === 'self';
    Promise.all(TYPES.map(async (t) => {
      try {
        const r = await fetch(`/api/inventory/${t}?limit=${LIMIT}&${scopeQ}`);
        if (!r.ok) throw new Error(String(r.status));
        const page: InvPage = await r.json();
        return [t, page.rows ?? []] as const;
      } catch {
        return [t, null] as const;
      }
    })).then(async (results) => {
      if (!live) return;
      const out: Partial<Record<MapType, InvRow[]>> = {};
      const fails: string[] = [];
      const caps: string[] = [];
      for (const [t, r] of results) {
        if (r === null) fails.push(t);
        else {
          out[t] = r;
          // InventoryPage carries no total — a full page means the type may be capped.
          if (r.length === LIMIT) caps.push(t);
        }
      }
      setRows(out);
      setFailed(fails);
      setCapped(caps);
      setBusy(false);
      // TGW attachments (live describe) — degrade to edge-less TGW nodes on failure.
      const tgwIds = (out.transit_gateway ?? []).map((r) => r.resource_id).filter((id) => /^tgw-[0-9a-f]+$/.test(id));
      if (tgwIds.length > 0 && !hostScope) {
        if (live) setTgwNote('TGW 어태치먼트는 host 계정 스코프에서만 조회됩니다 — 엣지 없이 표시');
      } else if (tgwIds.length > 0) {
        // The server caps the describe at 20 ids — surface the truncation instead of silently dropping edges.
        if (live && tgwIds.length > 20) setTgwNote('TGW 20개 초과 — 어태치먼트는 처음 20개까지만 조회됨');
        try {
          const r = await fetch(`/api/tgw?ids=${tgwIds.join(',')}`);
          if (r.ok) {
            const d: { attachments?: { tgwId: string; resourceType: string; resourceId: string; state?: string }[] } = await r.json();
            if (live) setTgwAtt((d.attachments ?? []).map((a) => ({ tgwId: a.tgwId, resourceType: a.resourceType, resourceId: a.resourceId, state: a.state })));
            // A per-region describe failure means that region's attachments are MISSING, not empty —
            // this note overwrites the >20 truncation one (degradation is the stronger signal).
            const degraded = (d as { degradedRegions?: string[] }).degradedRegions ?? [];
            if (live && degraded.length > 0) setTgwNote(`일부 리전 TGW 어태치먼트 조회 실패(${degraded.join(', ')}) — 해당 리전 엣지 누락 가능`);
          } else if (live) {
            setTgwNote('TGW 어태치먼트 조회 실패 — 연결 엣지가 표시되지 않을 수 있음');
          }
        } catch {
          if (live) setTgwNote('TGW 어태치먼트 조회 실패 — 연결 엣지가 표시되지 않을 수 있음');
        }
      }
    });
    return () => { live = false; };
  }, [scope]);

  const graph = useMemo(() => rows && buildInfraMap({
    igw: rows.internet_gateway ?? [], tgw: rows.transit_gateway ?? [], vpc: rows.vpc ?? [],
    subnet: rows.subnet ?? [], ec2: rows.ec2 ?? [], alb: rows.alb ?? [], nlb: rows.nlb ?? [],
    rds: rows.rds ?? [], nat: rows.nat_gateway ?? [], tgwAttachments: tgwAtt,
  }), [rows, tgwAtt]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1 text-[11px] text-ink-500">
        {busy && <span>{tt('불러오는 중…')}</span>}
        {failed.length > 0 && <span className="text-red-600">{tt('조회 실패:')} {failed.join(', ')}</span>}
        {capped.length > 0 && <span className="text-amber-600">{tt('500행 초과로 일부만 표시:')} {capped.join(', ')}</span>}
        {tgwNote && <span className="text-amber-600">{tt(tgwNote)}</span>}
        {graph && <span>{tt(`노드 ${graph.nodes.length.toLocaleString()} · 엣지 ${graph.edges.length.toLocaleString()}`)}</span>}
        {graph && <MapLegend graph={graph} theme={theme} />}
        {graph && graph.nodes.length === 0 && !busy && <span>{tt('표시할 네트워크 리소스가 없습니다 (인벤토리 sync 확인).')}</span>}
      </div>
      {graph && graph.nodes.length > 0 && (
        <MapCanvas graph={graph} columns={COLUMNS} query={query} theme={theme} />
      )}
    </div>
  );
}
