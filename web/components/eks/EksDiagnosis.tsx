'use client';
import { useEffect, useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import DiagnosisGuide from '@/components/inventory/metrics/DiagnosisGuide';
import { EKS_GUIDE } from '@/components/inventory/metrics/guides';
import MetricTable, { type MetricCol } from '@/components/inventory/metrics/MetricTable';
import { HealthPill, RangePicker, num, meter, kbps } from '@/components/inventory/metrics/shared';
import type { NodeRow } from '@/lib/eks-resources';
import type { DeploymentRow, DaemonSetRow } from '@/lib/eks-incluster';

// EKS 진단 계층 (owner 가이드): 컨트롤 플레인(AWS/EKS) → 노드(Container Insights + 인-클러스터
// conditions) → 워크로드/스케줄링(CI 클러스터 롤업) → 애드온(kube-system ready/desired).
// CI 미설치 클러스터는 CloudWatch 값이 null → '—' 정직 표시, 인-클러스터 신호는 그대로 동작.

type M = Record<string, number | null>;
interface DiagData { controlPlane: M; cluster: M; nodes: Record<string, M> }
type NodeItem = { name: string; m: M; node?: NodeRow };
type AddonItem = { kind: string; namespace: string; name: string; ready: number; desired: number };

const GB = 1024 ** 3;

export default function EksDiagnosis({ cluster }: { cluster: string }) {
  const { tt } = useI18n();
  const [range, setRange] = useState(3600);
  const [data, setData] = useState<DiagData | null>(null);
  const [err, setErr] = useState('');
  const [inNodes, setInNodes] = useState<NodeRow[] | null>(null);
  const [addons, setAddons] = useState<AddonItem[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/eks/${encodeURIComponent(cluster)}/metrics?range=${range}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setData(d); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [cluster, range]);

  useEffect(() => {
    let live = true;
    const get = (kind: string) =>
      fetch(`/api/eks/${encodeURIComponent(cluster)}/incluster?kind=${kind}`)
        .then((r) => (r.ok ? r.json() : null)).then((d) => d?.rows ?? null).catch(() => null);
    get('nodes').then((rows) => { if (live) setInNodes(rows as NodeRow[] | null); });
    // Addon health = kube-system workloads (coredns Deployment, aws-node/kube-proxy DaemonSets, …).
    Promise.all([get('deployments'), get('daemonsets')]).then(([deps, dss]) => {
      if (!live) return;
      if (!deps && !dss) { setAddons(null); return; }
      const out: AddonItem[] = [];
      for (const d of (deps ?? []) as DeploymentRow[]) {
        if (d.namespace !== 'kube-system') continue;
        const [ready, desired] = String(d.ready ?? '0/0').split('/').map((x) => Number(x) || 0);
        out.push({ kind: 'Deployment', namespace: d.namespace, name: d.name, ready, desired });
      }
      for (const d of (dss ?? []) as DaemonSetRow[]) {
        if (d.namespace !== 'kube-system') continue;
        out.push({ kind: 'DaemonSet', namespace: d.namespace, name: d.name, ready: d.ready ?? 0, desired: d.desired ?? 0 });
      }
      out.sort((a, b) => (a.ready < a.desired ? 0 : 1) - (b.ready < b.desired ? 0 : 1) || a.name.localeCompare(b.name));
      setAddons(out);
    });
    return () => { live = false; };
  }, [cluster]);

  const cp = data?.controlPlane ?? {};
  const ci = data?.cluster ?? {};
  const ciMissing = !!data && Object.values(ci).every((v) => v == null);

  const nodeItems: NodeItem[] = useMemo(() => {
    const byName = new Map((inNodes ?? []).map((n) => [n.name, n]));
    const names = new Set([...Object.keys(data?.nodes ?? {}), ...(inNodes ?? []).map((n) => n.name)]);
    return [...names].sort().map((name) => ({ name, m: data?.nodes?.[name] ?? {}, node: byName.get(name) }));
  }, [data, inNodes]);

  const cnt = (v: number | null) => (v == null ? '—' : Math.round(v).toLocaleString());
  const apiP99 = useMemo(() => {
    const vals = ['p99Get', 'p99List', 'p99Post', 'p99Put', 'p99Patch', 'p99Delete']
      .map((k) => num(cp[k])).filter((v): v is number => v != null);
    return vals.length ? Math.max(...vals) : null;
  }, [cp]);

  const pressures = (n?: NodeRow): string[] =>
    (n?.conditions ?? [])
      .filter((c) => c.type !== 'Ready' && c.type.endsWith('Pressure') && c.status === 'True')
      .map((c) => c.type);

  const nodeCols: MetricCol<NodeItem>[] = [
    { key: 'name', label: 'Node', mono: true, value: (it) => it.name },
    {
      key: 'ready', label: 'Ready', facet: true, title: tt('인-클러스터 node condition — NotReady면 kubelet/OS 레벨 조사'),
      value: (it) => it.node?.status ?? null,
      danger: (it) => it.node != null && it.node.status !== 'Ready',
    },
    {
      key: 'pressure', label: 'Pressure', title: tt('Memory/Disk/PID Pressure=True → 파드 축출 위험 (인-클러스터 조회)'),
      value: (it) => (it.node ? (pressures(it.node).join(', ') || 'none') : null),
      danger: (it) => pressures(it.node).length > 0,
    },
    { key: 'cpu', label: 'CPU', type: 'num', title: tt('node_cpu_utilization — 노드 CPU 사용률'), value: (it) => num(it.m.cpu), render: (it) => meter(num(it.m.cpu)) },
    { key: 'mem', label: 'Memory', type: 'num', title: tt('node_memory_utilization — OOM/eviction 진단 핵심'), value: (it) => num(it.m.mem), render: (it) => meter(num(it.m.mem)) },
    {
      key: 'fs', label: 'Disk %', type: 'num', title: tt('node_filesystem_utilization — 85% 초과 시 DiskPressure로 파드 축출'),
      value: (it) => num(it.m.fs),
      render: (it) => { const v = num(it.m.fs); return v == null ? null : `${v.toFixed(1)}%`; },
      danger: (it) => { const v = num(it.m.fs); return v != null && v > 85; },
    },
    {
      key: 'cpuRes', label: 'CPU Rsv %', type: 'num', title: tt('node_cpu_reserved_capacity — request 과다 예약이면 노드가 "논리적으로 꽉 참"'),
      value: (it) => num(it.m.cpuReserved),
      render: (it) => { const v = num(it.m.cpuReserved); return v == null ? null : `${v.toFixed(0)}%`; },
      danger: (it) => { const v = num(it.m.cpuReserved); return v != null && v > 90; },
    },
    {
      key: 'memRes', label: 'Mem Rsv %', type: 'num', title: tt('node_memory_reserved_capacity — request 과다 예약 감지'),
      value: (it) => num(it.m.memReserved),
      render: (it) => { const v = num(it.m.memReserved); return v == null ? null : `${v.toFixed(0)}%`; },
      danger: (it) => { const v = num(it.m.memReserved); return v != null && v > 90; },
    },
    { key: 'net', label: 'Net', type: 'num', title: tt('node_network_total_bytes — 노드 네트워크 처리량(평균 B/s)'), value: (it) => num(it.m.netBytes), render: (it) => kbps(num(it.m.netBytes)) },
    {
      key: 'drops', label: 'Drops', type: 'num', title: tt('rx/tx dropped 합(기간 누적) — >0이면 네트워크 포화/ENI 한계 의심'),
      value: (it) => { const rx = num(it.m.rxDropped); const tx = num(it.m.txDropped); return rx == null && tx == null ? null : (rx ?? 0) + (tx ?? 0); },
      danger: (it) => (((num(it.m.rxDropped) ?? 0) + (num(it.m.txDropped) ?? 0)) > 0),
    },
  ];

  const addonCols: MetricCol<AddonItem>[] = [
    { key: 'name', label: 'Addon', mono: true, value: (it) => it.name },
    { key: 'kind', label: 'Kind', facet: true, value: (it) => it.kind },
    {
      key: 'ready', label: 'Ready / Desired', title: tt('kube-system 워크로드 가용성 — CoreDNS 저하는 광범위한 장애로 번짐'),
      value: (it) => `${it.ready}/${it.desired}`,
      danger: (it) => it.ready < it.desired,
    },
  ];

  return (
    <Card
      title={tt('EKS 진단 메트릭')}
      subtitle={`${tt('컨트롤 플레인(AWS/EKS) · Container Insights · 인-클러스터 API — 계층별 진단')} · ${tt('값은 선택 기간 전체 집계')}`}
      right={<RangePicker value={range} onChange={setRange} />}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패')}: {err}</div>}
      {ciMissing && (
        <div className="mx-3 mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
          {tt('Container Insights 미감지 — 노드/워크로드 CloudWatch 지표는 에이전트(CloudWatch Observability add-on) 설치 후 표시됩니다')}
        </div>
      )}

      <div className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{tt('① 컨트롤 플레인 (API 서버 / etcd)')}</div>
      <div className="flex flex-wrap gap-1.5 px-3 pb-2">
        <HealthPill label="API p99" value={apiP99 == null ? '—' : `${(apiP99 * 1000).toFixed(0)} ms`} ok={apiP99 == null ? null : apiP99 < 1}
          hint={tt('apiserver_request_duration_seconds P99 (동사별 최대) — 급증하면 컨트롤 플레인 과부하')} />
        <HealthPill label="429" value={cnt(num(cp.err429))} ok={num(cp.err429) == null ? null : num(cp.err429) === 0}
          hint={tt('apiserver_request_total 429 — APF 스로틀. 컨트롤러/오퍼레이터의 과도한 요청 의심')} />
        <HealthPill label="5xx" value={cnt(num(cp.err5xx))} ok={num(cp.err5xx) == null ? null : num(cp.err5xx) === 0}
          hint={tt('apiserver_request_total 5XX — API 서버 오류 비율')} />
        <HealthPill label="etcd DB" value={num(cp.etcdDbBytes) == null ? '—' : `${((num(cp.etcdDbBytes) as number) / GB).toFixed(2)} GB`}
          ok={num(cp.etcdDbBytes) == null ? null : (num(cp.etcdDbBytes) as number) < 6 * GB}
          hint={tt('etcd DB 크기 — 기본 상한 8GB 근접 시 쓰기 거부·클러스터 마비 위험 (6GB부터 경고)')} />
        <HealthPill label="Inflight" value={`${cnt(num(cp.inflightMutating))} / ${cnt(num(cp.inflightReadonly))}`} ok={null}
          hint={tt('apiserver_current_inflight_requests (mutating/readonly 최대) — APF 스로틀 확인')} />
        <HealthPill label={tt('Pending 파드')} value={cnt(num(cp.pendingPods))} ok={num(cp.pendingPods) == null ? null : num(cp.pendingPods) === 0}
          hint={tt('scheduler_pending_pods — >0 지속이면 리소스 부족/IP 고갈/taint/PV 미할당')} />
        <HealthPill label={tt('스케줄 실패')} value={cnt(num(cp.schedErrors))} ok={num(cp.schedErrors) == null ? null : num(cp.schedErrors) === 0}
          hint={tt('scheduler_schedule_attempts ERROR(기간 누적) — 스케줄러가 배치 실패')} />
      </div>

      <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{tt('② 워크로드 / 스케일링 (Container Insights)')}</div>
      <div className="flex flex-wrap gap-1.5 px-3 pb-3">
        <HealthPill label={tt('재시작(기간)')} value={cnt(num(ci.restarts))} ok={num(ci.restarts) == null ? null : num(ci.restarts) === 0}
          hint={tt('pod_number_of_container_restarts(기간 누적) — 급증하면 CrashLoopBackOff/OOMKill. 가장 중요한 이상 지표')} />
        <HealthPill label="OOMKilled" value={cnt(num(ci.oomKilled))} ok={num(ci.oomKilled) == null ? null : num(ci.oomKilled) === 0}
          hint={tt('terminated_reason_oom_killed — limit 상향 또는 앱 메모리 누수 조사')} />
        <HealthPill label="CrashLoop" value={cnt(num(ci.crashLoop))} ok={num(ci.crashLoop) == null ? null : num(ci.crashLoop) === 0}
          hint={tt('waiting_reason_crash_loop_back_off — 로그·kubectl describe로 원인 확인')} />
        <HealthPill label="Pending" value={cnt(num(ci.podPending))} ok={num(ci.podPending) == null ? null : num(ci.podPending) === 0}
          hint={tt('pod_status_pending 최대 — 스케줄링/스케일링/IP 실패 신호')} />
        <HealthPill label="Failed" value={cnt(num(ci.podFailed))} ok={num(ci.podFailed) == null ? null : num(ci.podFailed) === 0}
          hint={tt('pod_status_failed 최대')} />
        <HealthPill label={tt('Mem/limit')} value={num(ci.memOverLimit) == null ? '—' : `${(num(ci.memOverLimit) as number).toFixed(0)}%`}
          ok={num(ci.memOverLimit) == null ? null : (num(ci.memOverLimit) as number) < 90}
          hint={tt('pod_memory_utilization_over_pod_limit(클러스터 평균) — 100% 근접 시 OOMKilled 위험')} />
        <HealthPill label={tt('노드')} value={`${cnt(num(ci.nodeCount))}${num(ci.failedNodes) ? ` (${tt('실패')} ${cnt(num(ci.failedNodes))})` : ''}`}
          ok={num(ci.failedNodes) == null ? null : num(ci.failedNodes) === 0}
          hint={tt('cluster_node_count / cluster_failed_node_count')} />
        <HealthPill label={tt('실행 파드')} value={cnt(num(ci.runningPods))} ok={null} hint={tt('cluster_number_of_running_pods(평균)')} />
      </div>

      <div className="px-3 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{tt('③ 노드 (Container Insights + 인-클러스터 conditions)')}</div>
      <MetricTable columns={nodeCols} items={nodeItems} rowKey={(it) => it.name} />

      <div className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{tt('④ 애드온 상태 (kube-system)')}</div>
      {addons == null
        ? <div className="px-3 pb-3 text-[12px] text-ink-400">{tt('인-클러스터 조회 불가 — 클러스터 인증 등록 필요')}</div>
        : <MetricTable columns={addonCols} items={addons} rowKey={(it) => `${it.kind}/${it.name}`} />}

      <DiagnosisGuide spec={EKS_GUIDE} />
    </Card>
  );
}
