'use client';

// K8s 4-column map (gap-audit L164): Ingress | Service | Pod | Node, per registered cluster.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import MapCanvas, { MapLegend } from '@/components/topology/MapCanvas';
import { buildK8sMap } from '@/lib/k8s-map';
import type { IngressRow, ServiceRow, EndpointRow } from '@/lib/eks-incluster';
import type { PodRow, NodeRow } from '@/lib/eks-resources';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useTheme } from '@/lib/use-theme';

const COLUMNS = [{ title: 'Ingress' }, { title: 'Service' }, { title: 'Pod' }, { title: 'Node' }];
const KINDS = ['ingresses', 'services', 'pods', 'nodes', 'endpoints'] as const;

export default function K8sMapView({ query }: { query: string }) {
  // Only 'dark' is a dark theme (cobalt/teal are light variants) — same mapping as /topology.
  const theme = useTheme() === 'dark' ? 'dark' as const : 'light' as const;
  const { tt } = useI18n();
  const [clusters, setClusters] = useState<string[] | null>(null);
  const [cluster, setCluster] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<{ ingresses: IngressRow[]; services: ServiceRow[]; pods: PodRow[]; nodes: NodeRow[]; endpoints: EndpointRow[] } | null>(null);

  useEffect(() => {
    let live = true;
    setClusters(null);
    setCluster('');
    setData(null);
    setErr('');
    // The in-cluster data path (clusterConn/access/authModes) is host-only and keyed by cluster
    // name — listing member-account clusters here would either show them un-connectable or, on a
    // name collision, render the WRONG cluster's data. Pin host scope like /eks/explorer does.
    fetch('/api/eks?account=self')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { clusters?: { name: string; access?: string }[] }) => {
        if (!live) return;
        // Only 'connected' clusters are readable in-cluster — others would 502 on first fetch.
        const names = (d.clusters ?? []).filter((c) => c.access === 'connected').map((c) => c.name);
        setClusters(names);
        if (names.length > 0) setCluster((cur) => cur || names[0]);
      })
      .catch((e) => { if (live) { setClusters([]); setErr(String(e instanceof Error ? e.message : e)); } });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!cluster) return;
    let live = true;
    setBusy(true);
    setData(null);
    setErr('');
    Promise.allSettled(KINDS.map(async (kind) => {
      const r = await fetch(`/api/eks/${encodeURIComponent(cluster)}/incluster?kind=${kind}`);
      const d = await r.json();
      if (!r.ok) throw new Error(String(d?.message ?? r.status));
      return [kind, d.rows as unknown[]] as const;
    }))
      .then((settled) => {
        if (!live) return;
        const rows: Record<string, unknown[]> = {};
        const failedKinds: string[] = [];
        settled.forEach((s, i) => {
          if (s.status === 'fulfilled') rows[s.value[0]] = s.value[1];
          else failedKinds.push(KINDS[i]);
        });
        setData({
          ingresses: (rows.ingresses ?? []) as IngressRow[], services: (rows.services ?? []) as ServiceRow[],
          pods: (rows.pods ?? []) as PodRow[], nodes: (rows.nodes ?? []) as NodeRow[], endpoints: (rows.endpoints ?? []) as EndpointRow[],
        });
        if (failedKinds.length > 0) setErr(`일부 kind 조회 실패: ${failedKinds.join(', ')}`);
      })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [cluster]);

  const graph = useMemo(() => data && buildK8sMap(data), [data]);

  if (clusters !== null && clusters.length === 0 && !err) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-ink-500">
        <span>{tt('연결된 EKS 클러스터가 없습니다 —')} <Link href="/eks" className="text-brand-700 underline">{tt('/eks에서 클러스터를 등록')}</Link>{tt('하세요.')}</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1 text-[11px] text-ink-500">
        <select
          value={cluster}
          onChange={(e) => setCluster(e.target.value)}
          className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]"
        >
          {(clusters ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {busy && <span>{tt('불러오는 중…')}</span>}
        {err && <span className="text-red-600">{tt('조회 실패:')} {err}</span>}
        {graph && <span>{tt(`노드 ${graph.nodes.length.toLocaleString()} · 엣지 ${graph.edges.length.toLocaleString()}`)}</span>}
        {graph && <MapLegend graph={graph} theme={theme} />}
        {graph && graph.nodes.length === 0 && !busy && <span>{tt('클러스터에 표시할 리소스가 없습니다.')}</span>}
      </div>
      {graph && graph.nodes.length > 0 && (
        <MapCanvas graph={graph} columns={COLUMNS} query={query} theme={theme} />
      )}
    </div>
  );
}
