'use client';
import { useEffect, useMemo, useState } from 'react';
import { X, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useActiveScope, scopeParams } from '@/lib/account-context';

// VPC Resource Map (v1 parity) — a fullscreen 4-column routing map for ONE VPC:
// VPC → subnets grouped by AZ (public via map_public_ip_on_launch, free IPs, associated RT)
// → route tables (main badge, per-route dest→target coloring, blackhole strikethrough)
// → external connections (IGW / NAT / TGW / Peering) aggregated from all route targets.
// Clicking a subnet/RT/connection highlights its related cards and dims the rest (toggle);
// the search box matches subnets/RTs/targets and highlights with the same propagation rules.
// Data: subnet + route_table inventory rows fetched on open, filtered to this VPC client-side.

interface SubnetRow {
  subnet_id: string; cidr_block?: string; availability_zone?: string;
  available_ip_address_count?: number; map_public_ip_on_launch?: boolean | string;
  name?: string; vpc_id?: string;
}
interface RtRow { route_table_id: string; name?: string; vpc_id?: string; routes?: unknown; associations?: unknown }

interface Route { dest: string; target: string; kind: TargetKind; blackhole: boolean }
type TargetKind = 'IGW' | 'NAT' | 'TGW' | 'Peering' | 'Gateway' | 'local' | 'other';

const s0 = (v: unknown): string => (typeof v === 'string' ? v : '');

// Steampipe stores AWS SDK JSONB verbatim — keys arrive in PascalCase or snake_case.
function parseRoutes(raw: unknown): Route[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const dest = s0(o.DestinationCidrBlock ?? o.destination_cidr_block ?? o.DestinationPrefixListId ?? o.destination_prefix_list_id) || '—';
    const gw = s0(o.GatewayId ?? o.gateway_id);
    const nat = s0(o.NatGatewayId ?? o.nat_gateway_id);
    const tgw = s0(o.TransitGatewayId ?? o.transit_gateway_id);
    const pcx = s0(o.VpcPeeringConnectionId ?? o.vpc_peering_connection_id);
    const eni = s0(o.NetworkInterfaceId ?? o.network_interface_id);
    let target = gw || nat || tgw || pcx || eni || '—';
    let kind: TargetKind = 'other';
    if (gw === 'local') { kind = 'local'; target = 'local'; }
    else if (gw.startsWith('igw-')) kind = 'IGW';
    else if (gw) kind = 'Gateway';
    else if (nat) kind = 'NAT';
    else if (tgw) kind = 'TGW';
    else if (pcx) kind = 'Peering';
    const blackhole = s0(o.State ?? o.state) === 'blackhole';
    return { dest, target, kind, blackhole };
  });
}
function parseAssociations(raw: unknown): { subnetId: string; main: boolean }[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    return { subnetId: s0(o.SubnetId ?? o.subnet_id), main: Boolean(o.Main ?? o.main) };
  });
}

// External-connection card/route-target accent per kind (v2 light tokens; v1 semantic mapping).
const KIND_TEXT: Record<TargetKind, string> = {
  IGW: 'text-emerald-600', NAT: 'text-amber-600', TGW: 'text-purple-600',
  Peering: 'text-teal-600', Gateway: 'text-emerald-600', local: 'text-ink-400', other: 'text-ink-500',
};
const KIND_BORDER: Record<TargetKind, string> = {
  IGW: 'border-emerald-300', NAT: 'border-amber-300', TGW: 'border-purple-300',
  Peering: 'border-teal-300', Gateway: 'border-emerald-300', local: 'border-ink-200', other: 'border-ink-200',
};

export default function VpcResourceMap({
  vpcId, vpcName, cidr, onClose,
}: { vpcId: string; vpcName?: string; cidr?: string; onClose: () => void }) {
  const [scope] = useActiveScope();
  const [subnets, setSubnets] = useState<SubnetRow[]>([]);
  const [rts, setRts] = useState<RtRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<{ type: 'subnet' | 'rt' | 'target'; id: string } | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    const get = (t: string) =>
      fetch(`/api/inventory/${t}?limit=500&${scopeParams(scope)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => (d.rows ?? []).map((x: { resource_id: unknown; data?: object }) => ({ resource_id: x.resource_id, ...(x.data ?? {}) })));
    Promise.all([get('subnet'), get('route_table')])
      .then(([sn, rt]) => {
        if (!live) return;
        setSubnets((sn as SubnetRow[]).filter((s) => s.vpc_id === vpcId));
        setRts((rt as RtRow[]).filter((r) => r.vpc_id === vpcId));
        setErr('');
      })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [vpcId, scope]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Relationship maps (v1 L747-780 equivalents).
  const model = useMemo(() => {
    const rtRoutes = new Map<string, Route[]>();
    const rtToSubnets = new Map<string, string[]>();
    const subnetToRt = new Map<string, string>();
    let mainRtId = '';
    for (const rt of rts) {
      rtRoutes.set(rt.route_table_id, parseRoutes(rt.routes));
      for (const a of parseAssociations(rt.associations)) {
        if (a.main) mainRtId = rt.route_table_id;
        if (a.subnetId) {
          subnetToRt.set(a.subnetId, rt.route_table_id);
          rtToSubnets.set(rt.route_table_id, [...(rtToSubnets.get(rt.route_table_id) ?? []), a.subnetId]);
        }
      }
    }
    // External network connections: unique non-local route targets across all RTs.
    const targets = new Map<string, TargetKind>();
    const rtToTargets = new Map<string, string[]>();
    for (const [rtId, routes] of rtRoutes) {
      for (const r of routes) {
        if (r.kind === 'local' || r.target === '—') continue;
        if (r.kind === 'IGW' || r.kind === 'NAT' || r.kind === 'TGW' || r.kind === 'Peering' || r.kind === 'Gateway') {
          targets.set(r.target, r.kind);
          rtToTargets.set(rtId, [...(rtToTargets.get(rtId) ?? []), r.target]);
        }
      }
    }
    // Subnets grouped by AZ (sorted).
    const azGroups = new Map<string, SubnetRow[]>();
    for (const s of [...subnets].sort((a, b) => String(a.availability_zone).localeCompare(String(b.availability_zone)))) {
      const az = s.availability_zone ?? '?';
      azGroups.set(az, [...(azGroups.get(az) ?? []), s]);
    }
    return { rtRoutes, rtToSubnets, subnetToRt, mainRtId, targets, rtToTargets, azGroups };
  }, [subnets, rts]);

  // Highlight propagation (v1 L806-879): selection OR search → 3 sets (subnets, RTs, targets).
  const hl = useMemo(() => {
    const hs = new Set<string>(); const hr = new Set<string>(); const ht = new Set<string>();
    const { subnetToRt, rtToSubnets, rtToTargets, mainRtId } = model;
    const implicitSubnets = () => subnets.filter((s) => !subnetToRt.has(s.subnet_id)).map((s) => s.subnet_id);
    const addRt = (rtId: string) => {
      hr.add(rtId);
      for (const sn of rtToSubnets.get(rtId) ?? []) hs.add(sn);
      if (rtId === mainRtId) for (const sn of implicitSubnets()) hs.add(sn);
      for (const t of rtToTargets.get(rtId) ?? []) ht.add(t);
    };
    const needle = q.trim().toLowerCase();
    if (needle) {
      for (const s of subnets) {
        if ([s.subnet_id, s.name, s.cidr_block].some((v) => String(v ?? '').toLowerCase().includes(needle))) {
          hs.add(s.subnet_id); addRt(subnetToRt.get(s.subnet_id) ?? mainRtId);
        }
      }
      for (const rt of rts) {
        if ([rt.route_table_id, rt.name].some((v) => String(v ?? '').toLowerCase().includes(needle))) addRt(rt.route_table_id);
      }
      for (const [t, kind] of model.targets) {
        if (t.toLowerCase().includes(needle) || kind.toLowerCase().includes(needle)) {
          ht.add(t);
          for (const [rtId, ts] of rtToTargets) if (ts.includes(t)) addRt(rtId);
        }
      }
    } else if (sel) {
      if (sel.type === 'subnet') { hs.add(sel.id); addRt(subnetToRt.get(sel.id) ?? mainRtId); }
      else if (sel.type === 'rt') addRt(sel.id);
      else { ht.add(sel.id); for (const [rtId, ts] of rtToTargets) if (ts.includes(sel.id)) addRt(rtId); }
    }
    return { hs, hr, ht, active: Boolean(needle) || Boolean(sel) };
  }, [model, subnets, rts, sel, q]);

  const cardCls = (isHl: boolean) =>
    cn(
      'rounded-lg border bg-card p-2.5 text-left transition',
      isHl && 'border-brand-400 ring-2 ring-brand-300/50 bg-brand-500/5',
      !isHl && !hl.active && 'border-ink-100 hover:border-brand-200',
      !isHl && hl.active && 'border-ink-100 opacity-35',
    );
  const toggle = (type: 'subnet' | 'rt' | 'target', id: string) =>
    setSel((cur) => (cur && cur.type === type && cur.id === id ? null : { type, id }));
  const rtName = (rtId: string) => rts.find((r) => r.route_table_id === rtId)?.name || rtId;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-ink-900/50 p-4 lg:p-8" role="dialog" aria-modal="true" aria-label="VPC Resource Map">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-ink-200 bg-paper shadow-pop">
        <header className="flex flex-wrap items-center gap-3 border-b border-ink-100 px-5 py-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink-800">VPC Resource Map</h2>
            <div className="font-mono text-[11.5px] text-ink-400">{vpcName ? `${vpcName} · ` : ''}{vpcId}{cidr ? ` · ${cidr}` : ''}</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-300" />
              <input
                value={q}
                onChange={(e) => { setQ(e.target.value); setSel(null); }}
                placeholder="서브넷 / 라우트 테이블 / 연결 검색"
                className="w-64 rounded-md border border-ink-200 bg-card py-1.5 pl-7 pr-2 text-[12px]"
              />
            </div>
            {q && <button className="text-[12px] text-ink-500 hover:text-ink-700" onClick={() => setQ('')}>검색 지우기</button>}
            {sel && !q && <button className="text-[12px] text-ink-500 hover:text-ink-700" onClick={() => setSel(null)}>선택 해제</button>}
            <button aria-label="닫기" onClick={onClose} className="rounded p-1.5 text-ink-400 hover:bg-ink-50 hover:text-ink-700"><X size={16} /></button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {loading ? (
            <div className="text-[13px] text-ink-400">서브넷 · 라우트 테이블 로딩 중…</div>
          ) : err ? (
            <div className="text-[13px] text-rose-600">로드 실패: {err}</div>
          ) : (
            <div className="grid min-h-[400px] grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
              {/* 1 — VPC */}
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">VPC</div>
                <div className="rounded-lg border-2 border-brand-300 bg-card p-3">
                  <div className="truncate text-[13px] font-semibold text-ink-800">{vpcName || vpcId}</div>
                  {cidr && <div className="font-mono text-[12px] text-brand-600">{cidr}</div>}
                  <div className="font-mono text-[11px] text-ink-400">{vpcId}</div>
                  <div className="mt-1.5 text-[11px] text-ink-400">{subnets.length} subnets · {rts.length} route tables</div>
                </div>
              </div>

              {/* 2 — Subnets by AZ */}
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">Subnets</div>
                <div className="flex flex-col gap-3">
                  {[...model.azGroups.entries()].map(([az, list]) => (
                    <div key={az}>
                      <div className="mb-1 font-mono text-[11px] text-ink-400">{az}</div>
                      <div className="flex flex-col gap-1.5">
                        {list.map((s) => {
                          const isPublic = String(s.map_public_ip_on_launch) === 'true';
                          const rtId = model.subnetToRt.get(s.subnet_id) ?? model.mainRtId;
                          return (
                            <button key={s.subnet_id} type="button" onClick={() => toggle('subnet', s.subnet_id)} className={cardCls(hl.hs.has(s.subnet_id))}>
                              <div className="flex items-center gap-1.5">
                                <span className={cn('rounded px-1 text-[10px] font-semibold', isPublic ? 'bg-emerald-500/10 text-emerald-600' : 'bg-brand-500/10 text-brand-600')}>
                                  {isPublic ? 'public' : 'private'}
                                </span>
                                <span className="truncate text-[12px] font-medium text-ink-700">{s.name || s.subnet_id}</span>
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] text-ink-400">
                                {s.cidr_block} · {Number(s.available_ip_address_count ?? 0).toLocaleString()} free
                              </div>
                              {rtId && <div className="mt-0.5 truncate font-mono text-[10.5px] text-ink-400">→ {rtName(rtId)}</div>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  {subnets.length === 0 && <div className="text-[12px] text-ink-300">서브넷 없음</div>}
                </div>
              </div>

              {/* 3 — Route Tables */}
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">Route Tables</div>
                <div className="flex flex-col gap-1.5">
                  {rts.map((rt) => {
                    const isMain = rt.route_table_id === model.mainRtId;
                    return (
                      <button key={rt.route_table_id} type="button" onClick={() => toggle('rt', rt.route_table_id)}
                        className={cn(cardCls(hl.hr.has(rt.route_table_id)), isMain && !hl.active && 'border-amber-300')}>
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] font-medium text-ink-700">{rt.name || rt.route_table_id}</span>
                          {isMain && <span className="rounded bg-amber-500/10 px-1 text-[10px] font-semibold text-amber-600">main</span>}
                        </div>
                        <div className="mt-1 flex flex-col gap-0.5">
                          {(model.rtRoutes.get(rt.route_table_id) ?? []).map((r, i) => (
                            <div key={i} className={cn('flex items-center gap-1 font-mono text-[10.5px]', r.blackhole && 'line-through opacity-60')}>
                              <span className="text-ink-500">{r.dest}</span>
                              <span className="text-ink-300">→</span>
                              <span className={KIND_TEXT[r.kind]}>{r.target.length > 21 ? `…${r.target.slice(-18)}` : r.target}</span>
                            </div>
                          ))}
                        </div>
                      </button>
                    );
                  })}
                  {rts.length === 0 && <div className="text-[12px] text-ink-300">라우트 테이블 없음</div>}
                </div>
              </div>

              {/* 4 — Network Connections */}
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">Network Connections</div>
                <div className="flex flex-col gap-1.5">
                  {[...model.targets.entries()].map(([id, kind]) => (
                    <button key={id} type="button" onClick={() => toggle('target', id)}
                      className={cn(cardCls(hl.ht.has(id)), !hl.active && `border-2 ${KIND_BORDER[kind]}`)}>
                      <div className={cn('text-[11px] font-semibold', KIND_TEXT[kind])}>{kind === 'Gateway' ? 'IGW' : kind}</div>
                      <div className="truncate font-mono text-[11px] text-ink-500">{id}</div>
                    </button>
                  ))}
                  {model.targets.size === 0 && <div className="text-[12px] text-ink-300">외부 연결 없음 (isolated VPC)</div>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
