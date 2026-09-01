'use client';
import { useEffect, useRef, useState } from 'react';
import DetailPanel from '@/components/ui/DetailPanel';
import NodeCapacityCards from '@/components/eks/NodeCapacityCards';
import { isTerminalPodPhase } from '@/lib/eks-resources';
import NodePodsSection from '@/components/eks/NodePodsSection';
import NodeEniSection from '@/components/eks/NodeEniSection';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { NodeRow, PodRow } from '@/lib/eks-resources';

// v1 parity 노드 드릴다운 (공유): 노드 선택 → CPU/Memory 3분할 + Pod Info + ENI + Pods.
// EKS 개요와 /eks/nodes 플릿 페이지가 함께 사용 — 클러스터의 nodes+pods를 라이브로
// 자체 조회하고, 요청량(request)은 해당 노드 파드들의 스케줄러 유효 요청 합으로 계산
// (normalizePod의 eff-request 의미론 — 개요의 fleet agg와 동일한 수치).

export default function NodeDrilldownPanel({ cluster, nodeName, onClose }: {
  cluster: string; nodeName: string; onClose: () => void;
}) {
  const { tt } = useI18n();
  const [detail, setDetail] = useState<{ node: NodeRow | null; pods: PodRow[] | null; err: string }>({ node: null, pods: null, err: '' });
  const seqRef = useRef(0);

  useEffect(() => {
    setDetail({ node: null, pods: null, err: '' });
    const seq = ++seqRef.current;
    Promise.all([
      fetch(`/api/eks/${encodeURIComponent(cluster)}/incluster?kind=nodes`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
      fetch(`/api/eks/${encodeURIComponent(cluster)}/incluster?kind=pods`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
      .then(([nd, pd]) => {
        if (seq !== seqRef.current) return;
        const node = ((nd.rows ?? []) as NodeRow[]).find((n) => n.name === nodeName) ?? null;
        const pods = pd ? ((pd.rows ?? []) as PodRow[]).filter((x) => x.node === nodeName) : null;
        setDetail({ node, pods, err: node ? '' : tt('노드를 찾지 못했습니다') });
      })
      .catch((e) => { if (seq === seqRef.current) setDetail({ node: null, pods: null, err: String(e instanceof Error ? e.message : e) }); });
    return () => { seqRef.current += 1; };
  }, [cluster, nodeName, tt]);

  const pods = detail.pods;
  // null = the pods fetch failed — the shared StackBar renders its honest unknown mode
  // instead of a fabricated zero-requested bar. Terminal pods hold no reservation.
  const active = pods == null ? null : pods.filter((p) => !isTerminalPodPhase(p.status));
  const cpuRequest = active == null ? null : active.reduce((s, p) => s + (p.cpuRequest || 0), 0);
  const memRequest = active == null ? null : active.reduce((s, p) => s + (p.memRequest || 0), 0);

  return (
    <DetailPanel
      title={nodeName}
      data={detail.node
        ? ({ ...detail.node } as unknown as Record<string, unknown>)
        : { name: nodeName, cluster, ...(detail.err ? { error: detail.err } : { 상태: tt('조회 중…') }) }}
      onClose={onClose}
    >
      {detail.node && (
        <>
          <NodeCapacityCards
            cpuCapacity={detail.node.cpuCapacity}
            cpuAllocatable={detail.node.cpuAllocatable}
            cpuRequest={cpuRequest}
            memCapacityMiB={detail.node.memCapacity}
            memAllocatableMiB={detail.node.memAllocatable}
            memRequestMiB={memRequest}
            podCIDR={detail.node.podCIDR}
            podCount={pods?.length ?? 0}
            podRunning={(pods ?? []).filter((x) => x.status === 'Running').length}
            podPending={(pods ?? []).filter((x) => x.status === 'Pending').length}
            podFailed={(pods ?? []).filter((x) => x.status === 'Failed').length}
            createdAt={detail.node.createdAt}
          />
          <NodePodsSection pods={pods} error="" />
          <NodeEniSection nodeName={nodeName} />
        </>
      )}
    </DetailPanel>
  );
}
