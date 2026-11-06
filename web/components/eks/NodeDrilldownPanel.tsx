'use client';
import { useEffect, useRef, useState } from 'react';
import DetailPanel from '@/components/ui/DetailPanel';
import NodeCapacityCards from '@/components/eks/NodeCapacityCards';
import { isTerminalPodPhase, nodePodKeys } from '@/lib/eks-resources';
import NodePodsSection from '@/components/eks/NodePodsSection';
import NodeEniSection from '@/components/eks/NodeEniSection';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { NodeRow, PodRow } from '@/lib/eks-resources';

// v1 parity 노드 드릴다운 (공유): 노드 선택 → CPU/Memory 3분할 + Pod Info + ENI + Pods.
// EKS 개요와 /eks/nodes 플릿 페이지가 함께 사용 — 클러스터의 nodes+pods를 라이브로
// 자체 조회하고, 요청량(request)은 해당 노드 파드들의 스케줄러 유효 요청 합으로 계산
// (normalizePod의 eff-request 의미론 — 개요의 fleet agg와 동일한 수치).

// Member EC2/node-group rows (source 'aws-api'): the caller passes the row it already has,
// so no node re-list is made; a Kubernetes 403 on the node read (View policy) is reported as
// an explicit "kubelet details unavailable" state instead of a bare status code.
export const KUBELET_UNAVAILABLE = 'kubelet 상세 정보 없음 (View 정책 — 노드 읽기 권한 없음)';

class NodeReadError extends Error { constructor(readonly status: number, readonly reason = '') { super(String(status)); } }
/** The incluster route reports a Kubernetes 403 as `reason: 'denied'` (HTTP 502), never as a 403. */
const nodeReadError = async (r: Response) => {
  const body = await r.json().catch(() => null) as { reason?: unknown; message?: unknown } | null;
  return new NodeReadError(r.status, typeof body?.reason === 'string' ? body.reason : '');
};

export default function NodeDrilldownPanel({ cluster, nodeName, onClose, node: knownNode }: {
  cluster: string; nodeName: string; onClose: () => void;
  /** Row the caller already holds; an 'aws-api' row skips the live node list request. */
  node?: NodeRow;
}) {
  const { tt } = useI18n();
  const [detail, setDetail] = useState<{ node: NodeRow | null; pods: PodRow[] | null; err: string }>({ node: null, pods: null, err: '' });
  const seqRef = useRef(0);

  const ec2Known = knownNode?.source === 'aws-api' && knownNode.name === nodeName ? knownNode : null;
  useEffect(() => {
    setDetail({ node: null, pods: null, err: '' });
    const seq = ++seqRef.current;
    Promise.all([
      ec2Known
        ? Promise.resolve({ rows: [ec2Known] })
        : fetch(`/api/eks/${encodeURIComponent(cluster)}/incluster?kind=nodes`).then(async (r) => (r.ok ? r.json() : Promise.reject(await nodeReadError(r)))),
      fetch(`/api/eks/${encodeURIComponent(cluster)}/incluster?kind=pods`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
      .then(([nd, pd]) => {
        if (seq !== seqRef.current) return;
        const node = ((nd.rows ?? []) as NodeRow[]).find((n) => n.name === nodeName) ?? null;
        // EC2-view rows may be named by private DNS while pods use another node name: join on
        // both keys, and treat "no pod references this EC2-view node" as unknown, not zero.
        const keys = node ? nodePodKeys(node) : [nodeName];
        const matched = pd ? ((pd.rows ?? []) as PodRow[]).filter((x) => keys.includes(x.node)) : null;
        const pods = matched && node?.source === 'aws-api' && matched.length === 0 ? null : matched;
        setDetail({ node, pods, err: node ? '' : tt('노드를 찾지 못했습니다') });
      })
      .catch((e) => {
        if (seq !== seqRef.current) return;
        const err = e instanceof NodeReadError && e.reason === 'denied' ? tt(KUBELET_UNAVAILABLE) : String(e instanceof Error ? e.message : e);
        setDetail({ node: null, pods: null, err });
      });
    return () => { seqRef.current += 1; };
  }, [cluster, nodeName, tt, ec2Known]);

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
            ec2View={detail.node.source === 'aws-api'}
            capacityUnknown={detail.node.capacityUnknown === true}
            podsUnknown={pods == null}
          />
          <NodePodsSection pods={pods} error="" />
          <NodeEniSection nodeName={nodeName} cluster={cluster} />
        </>
      )}
    </DetailPanel>
  );
}
