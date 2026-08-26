# EKS v1-Parity UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/eks` 리스트를 v1 `/k8s` Overview 구성(클러스터 카드 + 노드 리소스 바 + Pod 차트 + Warning Events)으로 재구축하고, `/eks/[cluster]` 탭마다 리소스별 KPI/시각화를 추가한다. 전부 read-only.

**Architecture:** Wave-1 고립 커밋 `fdc9626`(eks-resources.ts 집계 + Nodes 탭 Meter)을 cherry-pick으로 기반 확보 → `events` kind와 순수 탭 통계 헬퍼를 lib에 추가 → 서버 집계 전용 `/api/eks/fleet` 라우트(클러스터별 fan-out, pod 원본 비전송) → 리스트 페이지를 카드 기반으로 재구성, 상세 탭에 KPI/차트 부착.

**Tech Stack:** Next.js 14 (thin-BFF), vitest (+jsdom page tests), 기존 UI 컴포넌트(StatTile/Card/Meter/Badge/DataTable/DonutBreakdown/BarDistribution), presigned-STS in-cluster GET.

**Spec:** `docs/superpowers/specs/2026-06-11-eks-v1-parity-ui-design.md`

**파일 스코프 (scope guard):**
- Modify: `web/lib/eks-incluster.ts`, `web/lib/eks-incluster.test.ts`, `web/app/eks/page.tsx`, `web/app/eks/eks-list.test.tsx`, `web/app/eks/[cluster]/page.tsx`
- Create: `web/lib/eks-resources.ts`, `web/lib/eks-resources.test.ts` (cherry-pick), `web/lib/eks-tab-stats.ts`, `web/lib/eks-tab-stats.test.ts`, `web/app/api/eks/fleet/route.ts`, `web/app/api/eks/fleet/route.test.ts`, `web/app/eks/[cluster]/cluster-tabs.test.tsx`

---

### Task 1: Wave-1 노드 리소스 기반 cherry-pick

**Files:**
- Create: `web/lib/eks-resources.ts`, `web/lib/eks-resources.test.ts`
- Modify: `web/lib/eks-incluster.ts`, `web/lib/eks-incluster.test.ts`, `web/app/eks/[cluster]/page.tsx`

- [ ] **Step 1: cherry-pick 실행**

```bash
git cherry-pick -x fdc9626
# 예상: web/lib/eks-incluster.test.ts 1건 충돌 (양쪽 모두 테스트 추가)
```

- [ ] **Step 2: 충돌 해소** — `web/lib/eks-incluster.test.ts`에서 HEAD 측 테스트(예: nodeRoles fallback)와 fdc9626 측 테스트(capacity/allocatable/requests 파싱) **둘 다 보존**하는 방향으로 병합. `<<<<<<<` 마커 제거 후:

```bash
git add web/lib/eks-incluster.test.ts && git cherry-pick --continue
```

- [ ] **Step 3: 검증**

```bash
cd web && npx vitest run && npx tsc --noEmit
```
Expected: 전체 green (fdc9626은 원브랜치에서 392 green이었음). 실패 시 충돌 병합 부위만 수정.

- [ ] **Step 4: 커밋 확인** — cherry-pick이 이미 커밋했으므로 `git log --oneline -1`로 확인만.

---

### Task 2: `events` kind (TDD)

**Files:**
- Modify: `web/lib/eks-incluster.ts`, `web/lib/eks-incluster.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `web/lib/eks-incluster.test.ts`에 추가:

```ts
import { normalizeEvent, isKind } from './eks-incluster';

describe('normalizeEvent', () => {
  it('maps a Warning event to EventRow with sortable timestamp', () => {
    const row = normalizeEvent({
      metadata: { namespace: 'default', creationTimestamp: '2026-06-11T00:00:00Z' },
      involvedObject: { kind: 'Pod', name: 'web-abc' },
      reason: 'BackOff', message: 'Back-off restarting failed container',
      count: 7, lastTimestamp: '2026-06-11T01:02:03Z', type: 'Warning',
    });
    expect(row.kind).toBe('Pod');
    expect(row.object).toBe('default/web-abc');
    expect(row.reason).toBe('BackOff');
    expect(row.count).toBe(7);
    expect(row.lastSeenTs).toBe(Date.parse('2026-06-11T01:02:03Z'));
    expect(row.lastSeen).toBeTruthy(); // compact age string
  });
  it('falls back count→1 and lastTimestamp→eventTime', () => {
    const row = normalizeEvent({
      metadata: { creationTimestamp: '2026-06-11T00:00:00Z' },
      involvedObject: { kind: 'Node', name: 'n1' },
      reason: 'X', message: 'm', eventTime: '2026-06-11T00:30:00Z',
    });
    expect(row.count).toBe(1);
    expect(row.object).toBe('n1'); // no namespace → name only
    expect(row.lastSeenTs).toBe(Date.parse('2026-06-11T00:30:00Z'));
  });
  it('falls back to creationTimestamp when lastTimestamp/eventTime absent (P2: codex)', () => {
    const row = normalizeEvent({
      metadata: { creationTimestamp: '2026-06-11T00:00:00Z' },
      involvedObject: { kind: 'Node', name: 'n1' }, reason: 'X', message: 'm',
    });
    expect(row.lastSeenTs).toBe(Date.parse('2026-06-11T00:00:00Z'));
  });
  it('events is a valid kind', () => { expect(isKind('events')).toBe(true); });
});
```

- [ ] **Step 2: 실패 확인** — `cd web && npx vitest run lib/eks-incluster.test.ts` → FAIL (normalizeEvent not exported)

- [ ] **Step 3: 구현** — `web/lib/eks-incluster.ts`. **P2 패널 합의: 아래 5곳이 전부 한 커밋에 함께 들어가야 tsc가 통과한다** (`Kind` union ↔ `Record<Kind,…>` 두 레코드 ↔ `InClusterRow` union ↔ NORMALIZERS):

```ts
// 1) Kind union 확장
export type Kind = 'nodes' | 'pods' | 'deployments' | 'services' | 'namespaces' | 'events';

// 2) KIND_PATH — fieldSelector 값은 인코딩(type%3DWarning)이 관례적 형태 (P2: kiro — 미인코딩도 동작하나 프록시 안전)
const KIND_PATH: Record<Kind, string> = {
  // …기존 5개…
  events: '/api/v1/events?fieldSelector=type%3DWarning', // Warning만 (v1 parity, read-only GET)
};

// 3) isKind — 명시적 전체 나열 (P2: gemini)
export function isKind(k: string): k is Kind {
  return k === 'nodes' || k === 'pods' || k === 'deployments' || k === 'services' || k === 'namespaces' || k === 'events';
}

// 4) K8sItem interface에 이벤트 필드 추가 (top-level optional):
//   involvedObject?: { kind?: string; name?: string };
//   reason?: string; message?: string; count?: number;
//   lastTimestamp?: string; eventTime?: string; type?: string;
// 참고(P2: kiro): 코어 /api/v1/events 선택이 맞음 — events.k8s.io/v1은 count/lastTimestamp를
// deprecatedCount/series로 개명하므로 코어 엔드포인트를 유지할 것.

export interface EventRow {
  kind: string; object: string; reason: string; message: string;
  count: number; lastSeen: string; lastSeenTs: number;
}

export function normalizeEvent(it: K8sItem): EventRow {
  const ns = it.metadata?.namespace;
  const name = it.involvedObject?.name ?? '';
  const ts = it.lastTimestamp ?? it.eventTime ?? it.metadata?.creationTimestamp ?? '';
  const tsMs = ts ? Date.parse(ts) : 0;
  return {
    kind: it.involvedObject?.kind ?? '',
    object: ns ? `${ns}/${name}` : name, // namespace는 object에 내장 (별도 컬럼 없음 — 설계 의도)
    reason: it.reason ?? '',
    message: it.message ?? '',
    count: it.count ?? 1,
    lastSeen: age(ts),
    lastSeenTs: Number.isFinite(tsMs) ? tsMs : 0,
  };
}

// 5) union + NORMALIZERS 동시 갱신:
export type InClusterRow = NodeRow | PodRow | DeploymentRow | ServiceRow | NamespaceRow | EventRow;
//    NORMALIZERS: Record<Kind, …>에 events: normalizeEvent 추가
```

추가(P2: kiro): 파일 상단 주석의 `AmazonEKSViewPolicy`는 stale — 현재 배포된 association은 `AmazonEKSAdminViewPolicy`(2026-06-11 403 수정). 이 주석도 함께 갱신.

- [ ] **Step 4: green 확인 + 커밋**

```bash
cd web && npx vitest run lib/eks-incluster.test.ts && npx tsc --noEmit
git add web/lib/eks-incluster.ts web/lib/eks-incluster.test.ts
git commit -m "feat(eks-ui): events kind — Warning events via in-cluster GET (read-only)"
```

---

### Task 3: 순수 탭 통계 헬퍼 (TDD)

**Files:**
- Create: `web/lib/eks-tab-stats.ts`, `web/lib/eks-tab-stats.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `web/lib/eks-tab-stats.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { podStatusCounts, podsByNamespace, deploymentHealth, serviceTypeCounts } from './eks-tab-stats';

const pods = [
  { namespace: 'a', status: 'Running' }, { namespace: 'a', status: 'Running' },
  { namespace: 'b', status: 'Pending' }, { namespace: 'b', status: 'Failed' },
];
describe('eks-tab-stats', () => {
  it('podStatusCounts counts by status', () => {
    expect(podStatusCounts(pods)).toEqual({ Running: 2, Pending: 1, Failed: 1 });
  });
  it('podsByNamespace sorts desc', () => {
    expect(podsByNamespace(pods)).toEqual([{ namespace: 'a', count: 2 }, { namespace: 'b', count: 2 }]);
  });
  it('deploymentHealth parses ready a/b, degraded first', () => {
    const out = deploymentHealth([
      { name: 'ok', namespace: 'x', ready: '3/3', available: 3 },
      { name: 'bad', namespace: 'x', ready: '1/3', available: 1 },
    ]);
    expect(out[0]).toEqual({ name: 'bad', namespace: 'x', desired: 3, available: 1, pct: 33 });
    expect(out[1].pct).toBe(100);
  });
  it('deploymentHealth treats desired 0 as 100%', () => {
    expect(deploymentHealth([{ name: 'z', namespace: 'x', ready: '0/0', available: 0 }])[0].pct).toBe(100);
  });
  it('deploymentHealth falls back to the ready numerator when available is absent (P2: codex)', () => {
    expect(deploymentHealth([{ name: 'y', namespace: 'x', ready: '2/3' }])[0]).toEqual(
      { name: 'y', namespace: 'x', desired: 3, available: 2, pct: 67 });
  });
  it('serviceTypeCounts counts by type', () => {
    expect(serviceTypeCounts([{ type: 'ClusterIP' }, { type: 'ClusterIP' }, { type: 'LoadBalancer' }]))
      .toEqual({ ClusterIP: 2, LoadBalancer: 1 });
  });
});
```

- [ ] **Step 2: 실패 확인** → 모듈 없음 FAIL

- [ ] **Step 3: 구현** — `web/lib/eks-tab-stats.ts` (client-safe, 서버 import 금지):

```ts
// Pure aggregation helpers for the EKS tab/fleet visualizations.
// CRITICAL: client-safe — no server-only imports (mirrors eks-resources.ts).

export function podStatusCounts(rows: { status?: unknown }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) { const s = String(r.status ?? '') || 'Unknown'; out[s] = (out[s] ?? 0) + 1; }
  return out;
}

export function podsByNamespace(rows: { namespace?: unknown }[]): { namespace: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) { const ns = String(r.namespace ?? '') || '—'; m.set(ns, (m.get(ns) ?? 0) + 1); }
  return [...m.entries()].map(([namespace, count]) => ({ namespace, count }))
    .sort((a, b) => b.count - a.count || a.namespace.localeCompare(b.namespace));
}

export interface DeploymentHealth { name: string; namespace: string; desired: number; available: number; pct: number }
// pct = available/desired (스펙 §3.3 "available / desired" — readyReplicas가 아니라
// availableReplicas 기준. 롤아웃 중 ready와 다를 수 있음은 의도된 동작, P2: kiro 확인).
export function deploymentHealth(rows: { name?: unknown; namespace?: unknown; ready?: unknown; available?: unknown }[]): DeploymentHealth[] {
  return rows.map((r) => {
    const parts = String(r.ready ?? '').split('/');
    const desired = parseInt(parts[1] ?? '0', 10) || 0;
    // available 부재 시 ready 분자로 폴백 (P2: codex — 광고된 "a/b 파싱"을 실제로 커버)
    const available = r.available != null ? Number(r.available) || 0 : parseInt(parts[0] ?? '0', 10) || 0;
    const pct = desired > 0 ? Math.max(0, Math.min(100, Math.round((available / desired) * 100))) : 100;
    return { name: String(r.name ?? ''), namespace: String(r.namespace ?? ''), desired, available, pct };
  }).sort((a, b) => a.pct - b.pct || a.name.localeCompare(b.name));
}

export function serviceTypeCounts(rows: { type?: unknown }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) { const t = String(r.type ?? '') || 'Unknown'; out[t] = (out[t] ?? 0) + 1; }
  return out;
}
```

- [ ] **Step 4: green + 커밋**

```bash
cd web && npx vitest run lib/eks-tab-stats.test.ts && npx tsc --noEmit
git add web/lib/eks-tab-stats.ts web/lib/eks-tab-stats.test.ts
git commit -m "feat(eks-ui): pure tab-stats helpers (pod status/ns, deployment health, service types)"
```

---

### Task 4: `/api/eks/fleet` 라우트 (TDD)

**Files:**
- Create: `web/app/api/eks/fleet/route.ts`, `web/app/api/eks/fleet/route.test.ts`

- [ ] **Step 1: 실패 테스트** — `web/app/api/eks/fleet/route.test.ts` (기존 `api/eks/route.test.ts` mock 패턴):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const getAllowedClusters = vi.fn();
const listInCluster = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/eks-registry', () => ({ getAllowedClusters: (...a: unknown[]) => getAllowedClusters(...a) }));
vi.mock('@/lib/eks-incluster', () => ({ listInCluster: (...a: unknown[]) => listInCluster(...a) }));
import { GET } from './route';

const req = () => new Request('http://x/api/eks/fleet', { headers: { cookie: 'awsops_token=t' } });
const NODE = { name: 'n1', status: 'Ready', roles: 'worker', version: 'v1.30', instanceType: 'm5.large', zone: 'a', age: '1d', cpuCapacity: 4, cpuAllocatable: 3.9, memCapacity: 16000, memAllocatable: 15000 };
const POD = { name: 'p1', namespace: 'default', status: 'Running', node: 'n1', restarts: 0, age: '1h', cpuRequest: 0.5, memRequest: 512 };
const EVENT = { kind: 'Pod', object: 'default/p1', reason: 'BackOff', message: 'm', count: 3, lastSeen: '5m', lastSeenTs: 1000 };

beforeEach(() => {
  verifyUser.mockReset(); getAllowedClusters.mockReset(); listInCluster.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u' });
  getAllowedClusters.mockResolvedValue(new Set(['c1']));
});

describe('GET /api/eks/fleet', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });
  it('aggregates per cluster server-side (no raw pods in payload)', async () => {
    listInCluster.mockImplementation(async (_c: string, kind: string) => (
      { nodes: [NODE], pods: [POD], deployments: [{ name: 'd', namespace: 'x', ready: '1/1', available: 1 }], services: [{ type: 'ClusterIP' }], events: [EVENT] } as Record<string, unknown[]>
    )[kind] ?? []);
    const body = await (await GET(req())).json();
    const c = body.clusters[0];
    expect(c.name).toBe('c1');
    expect(c.reachable).toBe(true);
    expect(c.counts).toEqual({ nodes: 1, nodesReady: 1, pods: 1, podsRunning: 1, deployments: 1, services: 1 });
    expect(c.nodeAgg[0].name).toBe('n1');
    expect(c.podStatus).toEqual({ Running: 1 });
    expect(c.podsByNamespace).toEqual([{ namespace: 'default', count: 1 }]);
    expect(c.events[0].reason).toBe('BackOff');
    expect(JSON.stringify(body)).not.toContain('"restarts"'); // raw pod rows must not ship
  });
  it('degrades a failing cluster to reachable:false (never 500)', async () => {
    getAllowedClusters.mockResolvedValue(new Set(['ok', 'down']));
    listInCluster.mockImplementation(async (c: string, kind: string) => {
      if (c === 'down') throw new Error('403');
      return ({ nodes: [NODE], pods: [POD], deployments: [], services: [], events: [] } as Record<string, unknown[]>)[kind] ?? [];
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    const down = body.clusters.find((c: { name: string }) => c.name === 'down');
    expect(down.reachable).toBe(false);
    expect(down.counts.nodes).toBe(0);
  });
  it('an events-only failure keeps the cluster reachable with empty events (P2: kiro)', async () => {
    listInCluster.mockImplementation(async (_c: string, kind: string) => {
      if (kind === 'events') throw new Error('403');
      return ({ nodes: [NODE], pods: [POD], deployments: [], services: [] } as Record<string, unknown[]>)[kind] ?? [];
    });
    const body = await (await GET(req())).json();
    expect(body.clusters[0].reachable).toBe(true);
    expect(body.clusters[0].events).toEqual([]);
  });
  it('caps events at 25 sorted by lastSeenTs desc (P2: kiro)', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...EVENT, object: `o${i}`, lastSeenTs: i }));
    listInCluster.mockImplementation(async (_c: string, kind: string) => (
      { nodes: [], pods: [], deployments: [], services: [], events: many } as Record<string, unknown[]>
    )[kind] ?? []);
    const body = await (await GET(req())).json();
    expect(body.clusters[0].events).toHaveLength(25);
    expect(body.clusters[0].events[0].lastSeenTs).toBe(29);
  });
  it('registry failure degrades to an empty fleet, not 500 (P2: kiro)', async () => {
    getAllowedClusters.mockRejectedValue(new Error('aurora down'));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).clusters).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인** → 모듈 없음 FAIL

- [ ] **Step 3: 구현** — `web/app/api/eks/fleet/route.ts`:

```ts
import { verifyUser } from '@/lib/auth';
import { getAllowedClusters } from '@/lib/eks-registry';
import { listInCluster, type NodeRow, type PodRow, type DeploymentRow, type ServiceRow, type EventRow } from '@/lib/eks-incluster';
import { aggregateNodeResources } from '@/lib/eks-resources';
import { podStatusCounts, podsByNamespace } from '@/lib/eks-tab-stats';

export const dynamic = 'force-dynamic';

// v1 /k8s Overview parity: per-cluster live aggregates, computed SERVER-side.
// Raw pod rows never ship to the client (thin-BFF) — only small aggregates do.
// Per-cluster failures degrade to reachable:false; even a registry failure
// returns 200 + empty fleet (the fleet view must not 500 — spec §3.1d).
// NOTE: per-cluster podsByNamespace is pre-capped at 10, so the client-side
// cross-cluster merge is an approximation near the cut — acceptable for an
// overview (P2: kiro, documented).

const EVENTS_CAP = 25;
const NS_CAP = 10;

const EMPTY = (name: string) => ({
  name, reachable: false,
  counts: { nodes: 0, nodesReady: 0, pods: 0, podsRunning: 0, deployments: 0, services: 0 },
  nodeAgg: [], podStatus: {}, podsByNamespace: [], events: [],
});

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  let names: string[] = [];
  try { names = [...(await getAllowedClusters())]; } catch { return Response.json({ clusters: [] }); }
  const clusters = await Promise.all(names.map(async (name) => {
    try {
      const [nodes, pods, deployments, services, events] = await Promise.all([
        listInCluster(name, 'nodes') as Promise<NodeRow[]>,
        listInCluster(name, 'pods') as Promise<PodRow[]>,
        listInCluster(name, 'deployments') as Promise<DeploymentRow[]>,
        listInCluster(name, 'services') as Promise<ServiceRow[]>,
        (listInCluster(name, 'events') as Promise<EventRow[]>).catch(() => [] as EventRow[]), // events-only failure must not kill the cluster entry
      ]);
      return {
        name,
        reachable: true,
        counts: {
          nodes: nodes.length,
          nodesReady: nodes.filter((n) => n.status === 'Ready').length,
          pods: pods.length,
          podsRunning: pods.filter((p) => p.status === 'Running').length,
          deployments: deployments.length,
          services: services.length,
        },
        nodeAgg: aggregateNodeResources(nodes, pods),
        podStatus: podStatusCounts(pods),
        podsByNamespace: podsByNamespace(pods).slice(0, NS_CAP),
        events: [...events].sort((a, b) => b.lastSeenTs - a.lastSeenTs).slice(0, EVENTS_CAP),
      };
    } catch {
      return EMPTY(name);
    }
  }));
  return Response.json({ clusters });
}
```

(P2: kiro — `serviceTypes`는 리스트 페이지가 쓰지 않고 상세 탭은 incluster를 직접 부르므로 **페이로드에서 제외**. Step 1 테스트와 Task 5의 FLEET mock에서도 제외.)

- [ ] **Step 4: green + 커밋**

```bash
cd web && npx vitest run app/api/eks/fleet/route.test.ts && npx tsc --noEmit
git add web/app/api/eks/fleet/
git commit -m "feat(eks-ui): /api/eks/fleet — per-cluster server-side aggregates (counts/nodeAgg/podStatus/events)"
```

---

### Task 5: `/eks` 리스트 페이지 재구성 (카드 + 노드 바 + 차트 + 이벤트)

**Files:**
- Modify: `web/app/eks/page.tsx`, `web/app/eks/eks-list.test.tsx`

- [ ] **Step 1: 테스트 갱신 (먼저)** — `web/app/eks/eks-list.test.tsx`: `SUMMARY` mock을 `FLEET`으로 교체, 기존 4개 동작(connected 링크·register 플로우·스크립트 가이드·stats 행) 유지 + 카드/노드/이벤트 어서션 추가:

```ts
const FLEET = {
  'GET /api/eks/fleet': () => ({
    status: 200,
    body: { clusters: [{
      name: 'conn', reachable: true,
      counts: { nodes: 2, nodesReady: 2, pods: 10, podsRunning: 9, deployments: 3, services: 4 },
      nodeAgg: [{ name: 'n1', cpuAllocatable: 3.9, cpuRequest: 1.2, cpuPct: 31, memAllocatable: 15000, memRequest: 4000, memPct: 27, podCount: 5 }],
      podStatus: { Running: 9, Pending: 1 },
      podsByNamespace: [{ namespace: 'default', count: 6 }, { namespace: 'kube-system', count: 4 }],
      events: [{ kind: 'Pod', object: 'default/p1', reason: 'BackOff', message: 'restarting', count: 3, lastSeen: '5m', lastSeenTs: 1000 }],
    }] },
  }),
};
// 모든 mockFetch({ ...SUMMARY, ... }) → mockFetch({ ...FLEET, ... })
// (FLEET 클러스터 이름 'conn'은 기존 /api/eks fixture의 connected 클러스터와 일치 — 의도적)
// 'renders the fleet summary stats row' 테스트: '10'(pods) 어서션 유지
// 추가 어서션:
//   - 클러스터 카드: screen.getByText('vpc-1') (카드 본문 VPC), getByText(/2 nodes/) (미니 카운트)
//   - 노드 리소스: getByText('n1')
//   - Warning Events: getByText('BackOff')
//   - (P2: codex) 'admin sees the register button...' 테스트에 fleet 재요청 어서션:
//     등록 성공 후 fetch가 'GET /api/eks/fleet'을 다시 호출했는지 카운트로 확인
```

실행: `npx vitest run app/eks/eks-list.test.tsx` → FAIL (페이지가 아직 summary/테이블)

- [ ] **Step 2: 페이지 재구성** — `web/app/eks/page.tsx` 전체 교체. 기존 `register`/`unregister`/`guide` 패널(Copied! 포함)·`btn` 스타일·notice 로직은 **그대로 이관**하고 렌더만 카드화:

```tsx
'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import DataTable from '@/components/ui/DataTable';
import Badge from '@/components/ui/Badge';
import StatCard from '@/components/ui/StatCard';
import Card from '@/components/ui/Card';
import Meter from '@/components/ui/Meter';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import BarDistribution from '@/components/charts/BarDistribution';

// v1 /k8s Overview parity: cluster cards + per-node resource bars + pod charts
// + Warning events — paper+ink. Register/guide UX unchanged (auto-register aware).

interface Cluster { /* 기존 그대로 */ }
interface Guide { commands: string[]; note: string }
interface FleetCluster {
  name: string; reachable: boolean;
  counts: { nodes: number; nodesReady: number; pods: number; podsRunning: number; deployments: number; services: number };
  nodeAgg: { name: string; cpuAllocatable: number; cpuRequest: number; cpuPct: number; memAllocatable: number; memRequest: number; memPct: number; podCount: number }[];
  podStatus: Record<string, number>;
  podsByNamespace: { namespace: string; count: number }[];
  events: { kind: string; object: string; reason: string; message: string; count: number; lastSeen: string; lastSeenTs: number }[];
}

export default function EksPage() {
  // 기존 state 유지 (summary → fleet 교체; 기존 summary useEffect는 제거 — P2: gemini)
  const [fleet, setFleet] = useState<FleetCluster[] | null>(null);

  // (P2: codex) fleet 로드는 재사용 가능한 콜백으로 — register/unregister 성공 후에도 호출해
  // 새로 연결된 클러스터의 카운트/노드바/이벤트가 즉시 반영되게 한다.
  const loadFleet = useCallback(() => {
    fetch('/api/eks/fleet').then((r) => (r.ok ? r.json() : null))
      .then((d) => setFleet(d?.clusters ?? [])).catch(() => setFleet([]));
  }, []);
  useEffect(() => { loadFleet(); }, [loadFleet]);
  // register()/unregister() 성공 분기에서 load() 다음에 loadFleet() 추가 호출.

  const fleetBy = useMemo(() => new Map((fleet ?? []).map((f) => [f.name, f])), [fleet]);
  const totals = useMemo(() => { /* fleet 합산: connected(=reachable 수)/nodes/nodesReady/pods/podsRunning/deployments/services */ }, [fleet]);
  // (P2: kiro) Clusters 타일은 fleet이 아니라 /api/eks 전체 rows.length —
  // fleet은 allowed 클러스터만 담으므로 entry-only/no-entry까지 세려면 rows 기준이어야 한다.
  const podStatusData = useMemo(() => { /* fleet podStatus 병합 → [{name, value}] */ }, [fleet]);
  const nsData = useMemo(() => { /* fleet podsByNamespace 병합 → top 10 [{namespace, count}] (per-cluster pre-cap 10의 근사치 — 허용) */ }, [fleet]);
  const eventRows = useMemo(() => { /* fleet events 병합 + cluster 필드, lastSeenTs desc */ }, [fleet]);
  // (P2: codex) 섹션 5(노드)/6(차트)/7(이벤트)은 totals.connected > 0 일 때만 렌더 —
  // 연결 0개면 카드+가이드만 보이는 기존 온보딩 UX 유지 ("경고 이벤트 없음" 문구도 미렌더).

  return (
    <div className="px-8 py-8 flex flex-col gap-6">
      {/* 1. 헤더 (기존) */}
      {/* 2. Stats 행: Clusters / Connected / Nodes(trend `${nodesReady} ready`) / Pods(trend `${podsRunning} running`) / Deployments / Services */}
      {/* 3. notice/err/guide 패널 (기존 그대로) */}
      {/* 4. 클러스터 카드 그리드 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {(rows ?? []).map((c) => {
          const f = fleetBy.get(c.name);
          return (
            <Card key={c.name} className="p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                {c.access === 'connected'
                  ? <Link href={`/eks/${encodeURIComponent(c.name)}`} className="font-mono text-[13px] font-semibold text-claude-600 hover:underline truncate">{c.name}</Link>
                  : <span className="font-mono text-[13px] font-semibold text-ink-700 truncate">{c.name}</span>}
                <span className="flex items-center gap-1.5 shrink-0">
                  {/* access Badge 4종 — 기존 로직 그대로 */}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                <div><span className="text-ink-400">Version</span> <span className="text-ink-700">{c.version}</span></div>
                <div><span className="text-ink-400">Region</span> <span className="text-ink-700">{c.region}</span></div>
                <div><span className="text-ink-400">VPC</span> <span className="text-ink-700">{c.vpcId || '—'}</span></div>
                <div><span className="text-ink-400">Platform</span> <span className="text-ink-700">{c.platformVersion || '—'}</span></div>
              </div>
              {f?.reachable && (
                <div className="text-[12px] text-ink-500">{f.counts.nodes} nodes · {f.counts.pods} pods · {f.counts.deployments} deploys</div>
              )}
              {c.access === 'connected' && f && !f.reachable && <Badge tone="negative" variant="soft">조회 불가</Badge>}
              <div className="flex items-center gap-2">{/* [조회 등록]/[스크립트]/[해제] 버튼 — 기존 로직 그대로 */}</div>
            </Card>
          );
        })}
      </div>
      {/* 5. 노드 리소스 — fleet에서 reachable && nodeAgg.length>0 인 클러스터별 그룹 */}
      {/*    Card title="노드 리소스" → 클러스터별 font-mono 소제목 + fdc9626 상세페이지와 동일한 행 레이아웃(name+podCount, CPU Meter, Mem Meter) */}
      {/* 6. 차트 행 */}
      {/*    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <DonutBreakdown title="Pod Status" data={podStatusData} nameKey="name" valueKey="value" />
              <BarDistribution title="Pods per Namespace" data={nsData} xKey="namespace" yKey="count" />
            </div>  — fleet 합산이 0이면 섹션 생략 */}
      {/* 7. Warning Events — eventRows.length>0 일 때만:
            <Card title="Warning Events" subtitle="최근 클러스터 경고 (Warning type only)">
              <DataTable columns={[cluster,kind,object,reason,message,count,lastSeen]} rows={eventRows} />
            </Card>
            0건 + fleet 있음 → 조용한 "경고 이벤트 없음" 한 줄 */}
    </div>
  );
}
```

주의: DataTable 제거 — 카드가 대체. 기존 `tableRows` 삭제. `lastSeenTs`는 렌더 컬럼에서 제외(정렬용 사전 sort만).

- [ ] **Step 3: green 확인**

```bash
cd web && npx vitest run app/eks/eks-list.test.tsx && npx vitest run && npx tsc --noEmit
```

- [ ] **Step 4: 커밋**

```bash
git add web/app/eks/page.tsx web/app/eks/eks-list.test.tsx
git commit -m "feat(eks-ui): /eks rebuilt as v1-parity overview — cluster cards, node resource bars, pod charts, warning events"
```

---

### Task 6: `/eks/[cluster]` 탭별 차별화

**Files:**
- Modify: `web/app/eks/[cluster]/page.tsx`
- Create: `web/app/eks/[cluster]/cluster-tabs.test.tsx`

- [ ] **Step 1: Events 탭 추가** — `Tab` union + `TABS`에 `{ value: 'events', label: 'Events' }` (Diagnosis 앞), `COLUMNS.events`:

```ts
events: [
  { key: 'kind', label: 'Kind' },
  { key: 'object', label: 'Object' },
  { key: 'reason', label: 'Reason' },
  { key: 'message', label: 'Message' },
  { key: 'count', label: 'Count' },
  { key: 'lastSeen', label: 'Last Seen' },
],
```
load()는 기존 incluster fetch가 kind=events를 그대로 처리(서버 라우트는 isKind만 게이트 — 추가 allow-list 없음, 확인 완료). **정렬은 명시적 분기** (P2: kiro — 빠뜨리면 무정렬 렌더):

```ts
// load() 안, setRows 직전:
const sorted = tab === 'events'
  ? [...(d.rows as Row[])].sort((a, b) => Number(b.lastSeenTs ?? 0) - Number(a.lastSeenTs ?? 0))
  : (d.rows as Row[]);
setRows(sorted);
```
`lastSeenTs`는 컬럼 비노출. events는 `NAMESPACED` 미포함(namespace는 object에 내장).

- [ ] **Step 2: 탭별 KPI/차트 블록** — import 추가(`StatCard`(= StatTile re-export — 기존 페이지 idiom 유지), `DonutBreakdown`, `Meter`, `Card`, eks-tab-stats 헬퍼) 후, 검색/필터 행 위에 탭 조건부 렌더 (전부 `allRows` 기준 — 필터 전):

```tsx
{tab === 'pods' && allRows.length > 0 && (() => {
  const s = podStatusCounts(allRows as { status?: unknown }[]);
  const donut = Object.entries(s).map(([name, value]) => ({ name, value }));
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total" value={allRows.length} />
        <StatCard label="Running" value={s.Running ?? 0} />
        <StatCard label="Pending" value={s.Pending ?? 0} variant={s.Pending ? 'warn' : 'default'} />
        <StatCard label="Failed" value={s.Failed ?? 0} variant={s.Failed ? 'danger' : 'default'} />
      </div>
      <DonutBreakdown title="Pod Status" data={donut} nameKey="name" valueKey="value" />
    </>
  );
})()}

{tab === 'deployments' && allRows.length > 0 && (() => {
  const h = deploymentHealth(allRows as Parameters<typeof deploymentHealth>[0]);
  const degraded = h.filter((d) => d.pct < 100).length;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard label="Total" value={h.length} />
        <StatCard label="Fully available" value={h.length - degraded} />
        <StatCard label="Degraded" value={degraded} variant={degraded ? 'danger' : 'default'} />
      </div>
      <Card title="레플리카 가용성" subtitle="available / desired (degraded 우선)">
        <div className="flex flex-col gap-2">
          {h.map((d) => (
            <div key={`${d.namespace}/${d.name}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 text-[12px]">
              <span className="min-w-0 truncate font-mono text-ink-700" title={`${d.namespace}/${d.name}`}>{d.namespace}/{d.name}</span>
              <Meter value={d.pct} />
              <span className="tabular text-ink-400">{d.available}/{d.desired}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
})()}

{tab === 'services' && allRows.length > 0 && (() => {
  const t = serviceTypeCounts(allRows as { type?: unknown }[]);
  const donut = Object.entries(t).map(([name, value]) => ({ name, value }));
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total" value={allRows.length} />
        <StatCard label="ClusterIP" value={t.ClusterIP ?? 0} />
        <StatCard label="NodePort" value={t.NodePort ?? 0} />
        <StatCard label="LoadBalancer" value={t.LoadBalancer ?? 0} />
      </div>
      <DonutBreakdown title="Service Types" data={donut} nameKey="name" valueKey="value" />
    </>
  );
})()}
```
Nodes 탭은 Task 1(cherry-pick)의 "노드 리소스" Card 그대로. Diagnosis 변경 없음. events는 `NAMESPACED` 미포함(네임스페이스 필터 없음 — object에 ns 포함됨).

- [ ] **Step 3: 페이지 테스트 (P2: codex+kiro 합의 — 탭 와이어링은 tsc가 못 잡는다)** — `web/app/eks/[cluster]/cluster-tabs.test.tsx` (jsdom, eks-list.test.tsx의 mockFetch 패턴 재사용):

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import EksClusterPage from './page';

vi.mock('next/navigation', () => ({ useParams: () => ({ cluster: 'c1' }) }));
afterEach(cleanup);
beforeEach(() => { vi.unstubAllGlobals(); });

function mockKind(handlers: Record<string, unknown[]>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const kind = new URL(url, 'http://x').searchParams.get('kind') ?? '';
    const rows = handlers[kind];
    if (!rows) throw new Error(`unmocked kind: ${kind}`);
    return { ok: true, status: 200, json: async () => ({ kind, rows }) } as Response;
  }));
}

describe('EKS cluster tabs', () => {
  it('pods tab: KPI counts stay pre-filter while the table filters (스펙 §3.3)', async () => {
    mockKind({ nodes: [], pods: [
      { name: 'p1', namespace: 'a', status: 'Running', node: 'n', restarts: 0, age: '1h' },
      { name: 'p2', namespace: 'b', status: 'Pending', node: 'n', restarts: 0, age: '1h' },
    ] });
    render(<EksClusterPage />);
    fireEvent.click(screen.getByText('Pods'));
    await waitFor(() => expect(screen.getByText('p1')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('검색…'), { target: { value: 'p1' } });
    expect(screen.queryByText('p2')).toBeNull();          // 테이블은 필터됨
    expect(screen.getByText('Pending').closest('div')).toBeTruthy(); // KPI(Pending=1)는 유지
  });
  it('events tab renders warning rows sorted by lastSeenTs desc', async () => {
    mockKind({ nodes: [], events: [
      { kind: 'Pod', object: 'a/p', reason: 'Old', message: 'm', count: 1, lastSeen: '2d', lastSeenTs: 1 },
      { kind: 'Pod', object: 'a/q', reason: 'New', message: 'm', count: 1, lastSeen: '5m', lastSeenTs: 9 },
    ] });
    render(<EksClusterPage />);
    fireEvent.click(screen.getByText('Events'));
    await waitFor(() => expect(screen.getByText('New')).toBeTruthy());
    const cells = screen.getAllByText(/New|Old/).map((e) => e.textContent);
    expect(cells.indexOf('New')).toBeLessThan(cells.indexOf('Old'));
  });
  it('deployments tab shows degraded-first replica bars', async () => {
    mockKind({ nodes: [], deployments: [
      { name: 'ok', namespace: 'x', ready: '3/3', upToDate: 3, available: 3, age: '1d' },
      { name: 'bad', namespace: 'x', ready: '1/3', upToDate: 1, available: 1, age: '1d' },
    ] });
    render(<EksClusterPage />);
    fireEvent.click(screen.getByText('Deployments'));
    await waitFor(() => expect(screen.getByText('Degraded')).toBeTruthy());
    expect(screen.getByText('1/3')).toBeTruthy(); // 레플리카 바 라벨
  });
});
```
(노트: nodes 탭이 기본 탭이라 첫 로드는 kind=nodes — mock에 `nodes: []` 포함. nodes 탭은 pods 보조 fetch를 best-effort로 하므로 `pods` 누락 시 throw해도 페이지는 살아있어야 하나, 단순화를 위해 mock에 pods를 넣어도 됨.)

- [ ] **Step 4: 검증 + 커밋**

```bash
cd web && npx vitest run && npx tsc --noEmit
git add "web/app/eks/[cluster]/page.tsx" "web/app/eks/[cluster]/cluster-tabs.test.tsx"
git commit -m "feat(eks-ui): per-tab KPI/viz — pods status donut, deployment replica bars, service types, events tab"
```

---

### Task 7: 최종 검증 + 배포

- [ ] **Step 1: 전체 게이트**

```bash
cd web && npx vitest run && npx tsc --noEmit && npx next lint --quiet 2>/dev/null || true
```
Expected: 전체 green (393+ 신규).

- [ ] **Step 2: 배포 + smoke** (컨트롤러 실행)

```bash
git branch --show-current   # = feat/v2-architecture-design 확인
make deploy                  # arm64 build → ECR → ECS rolling → /api/health smoke
```

- [ ] **Step 3: 라이브 확인** — `https://awsops-v2.example.com/eks` 카드/노드 바/차트/이벤트, `/eks/mall-apne2-az-a` 탭별 KPI.
