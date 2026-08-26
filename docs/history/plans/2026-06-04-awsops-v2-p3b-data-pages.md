# P3-B Data Pages MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-data pages (Overview, EKS, Jobs, Cost) to the chat-only v2 web so the app is actually usable, with the chat drawer docked alongside.

**Architecture:** Thin-BFF (Next.js on Fargate) reads data per-page: **AWS SDK direct** (EKS describe, Cost Explorer) via the Fargate task role for live data, and **Aurora** (`web/lib/db.ts` getPool) for `worker_jobs`. New `/api/{eks,cost,overview}` routes + a `GET` on the existing `/api/jobs`, all `verifyUser`-gated (reusing `web/lib/auth.ts` from P3-A). No Steampipe; not a general inventory.

**Tech Stack:** Next.js 14 (App Router), TS, React 18, `@aws-sdk/client-eks` + `@aws-sdk/client-cost-explorer` (new) + `pg` + `jose` (existing), vitest. Spec: `docs/superpowers/specs/2026-06-04-awsops-v2-p3b-data-pages-design.md`.

**Measured facts:** v2 Aurora has data ONLY in `worker_jobs` (6 rows); ADR-030 tables empty (skipped). Task role already has `eks-read` + Aurora; **needs `ce:GetCostAndUsage`** (T9). Cost Explorer is **us-east-1-only** (global). `web/app/api/jobs/route.ts` already has POST (enqueue) — add GET. `web/lib/{db,auth}.ts` exist (P2/P3-A).

**Operating constraints:** branch `feat/v2-architecture-design` (verify before infra). NO `git add -A` (untracked `graphify-out/`, `AGENTS.md`, `GEMINI.md`, `.superpowers/`, parallel docs) — explicit paths. T1–T10 = $0 AWS. T11 = real infra (controller; pause for go-ahead).

---

### Task 1: Add EKS + Cost Explorer SDK deps

**Files:** Modify `web/package.json`

- [ ] **Step 1: Install (into dependencies — standalone tracing needs them)**
```bash
cd /home/atomoh/awsops/web
npm install --save @aws-sdk/client-eks @aws-sdk/client-cost-explorer
```

- [ ] **Step 2: Verify they landed in `dependencies` + suite still green**
```bash
cd /home/atomoh/awsops/web
node -e "const d=require('./package.json').dependencies;console.log('eks',!!d['@aws-sdk/client-eks'],'ce',!!d['@aws-sdk/client-cost-explorer'])"
npm run test 2>&1 | grep -E "Test Files|Tests"
```
Expected: `eks true ce true`; existing 24 tests still pass.

- [ ] **Step 3: Commit**
```bash
cd /home/atomoh/awsops
git add web/package.json web/package-lock.json
git commit -m "chore(v2-p3b): add @aws-sdk/client-eks + client-cost-explorer deps"
```

---

### Task 2: `web/lib/aws.ts` — EKS + Cost Explorer wrappers

**Files:** Create `web/lib/aws.ts`, `web/lib/aws.test.ts`

- [ ] **Step 1: Write the failing test — `web/lib/aws.test.ts`**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const eksSend = vi.fn();
const ceSend = vi.fn();
vi.mock('@aws-sdk/client-eks', () => ({
  EKSClient: class { send = eksSend; },
  ListClustersCommand: class { constructor(public input: unknown) {} },
  DescribeClusterCommand: class { constructor(public input: { name: string }) {} },
}));
vi.mock('@aws-sdk/client-cost-explorer', () => ({
  CostExplorerClient: class { send = ceSend; },
  GetCostAndUsageCommand: class { constructor(public input: unknown) {} },
}));

beforeEach(() => { eksSend.mockReset(); ceSend.mockReset(); });

describe('listClusters', () => {
  it('lists names then describes each', async () => {
    eksSend
      .mockResolvedValueOnce({ clusters: ['fsi-demo-cluster'] })
      .mockResolvedValueOnce({ cluster: { status: 'ACTIVE', version: '1.30', endpoint: 'https://x', createdAt: new Date('2026-01-01T00:00:00Z') } });
    const { listClusters } = await import('./aws');
    const out = await listClusters();
    expect(out).toEqual([{ name: 'fsi-demo-cluster', status: 'ACTIVE', version: '1.30', endpoint: 'https://x', createdAt: '2026-01-01T00:00:00.000Z' }]);
  });
  it('returns [] when no clusters', async () => {
    eksSend.mockResolvedValueOnce({ clusters: [] });
    const { listClusters } = await import('./aws');
    expect(await listClusters()).toEqual([]);
  });
});

describe('getMtdCost', () => {
  it('aggregates + sorts by-service desc', async () => {
    ceSend.mockResolvedValue({ ResultsByTime: [{ Groups: [
      { Keys: ['Amazon RDS'], Metrics: { UnblendedCost: { Amount: '310.5', Unit: 'USD' } } },
      { Keys: ['Amazon EKS'], Metrics: { UnblendedCost: { Amount: '180.0', Unit: 'USD' } } },
      { Keys: ['Zero'], Metrics: { UnblendedCost: { Amount: '0', Unit: 'USD' } } },
    ] }] });
    const { getMtdCost } = await import('./aws');
    const c = await getMtdCost();
    expect(c.currency).toBe('USD');
    expect(c.byService[0]).toEqual({ service: 'Amazon RDS', amount: 310.5 });
    expect(c.byService.find((s) => s.service === 'Zero')).toBeUndefined();
    expect(c.total).toBeCloseTo(490.5);
  });
});
```

- [ ] **Step 2: Run it — verify FAIL** (`npx vitest run lib/aws.test.ts` → Cannot find module './aws')

- [ ] **Step 3: Create `web/lib/aws.ts`**
```typescript
import { EKSClient, ListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';

let eks: EKSClient | null = null;
let ce: CostExplorerClient | null = null;
function eksClient(): EKSClient { if (!eks) eks = new EKSClient({ region: REGION }); return eks; }
// Cost Explorer is a GLOBAL service reached via us-east-1 only.
function ceClient(): CostExplorerClient { if (!ce) ce = new CostExplorerClient({ region: 'us-east-1' }); return ce; }

export interface ClusterInfo { name: string; status: string; version: string; endpoint: string; createdAt: string }

export async function listClusters(): Promise<ClusterInfo[]> {
  const c = eksClient();
  const { clusters = [] } = await c.send(new ListClustersCommand({}));
  const out: ClusterInfo[] = [];
  for (const name of clusters.slice(0, 25)) {
    const { cluster } = await c.send(new DescribeClusterCommand({ name }));
    out.push({
      name,
      status: cluster?.status ?? '?',
      version: cluster?.version ?? '?',
      endpoint: cluster?.endpoint ?? '',
      createdAt: cluster?.createdAt instanceof Date ? cluster.createdAt.toISOString() : '',
    });
  }
  return out;
}

export interface CostBreakdown { total: number; currency: string; byService: { service: string; amount: number }[] }

export async function getMtdCost(): Promise<CostBreakdown> {
  const now = new Date();
  const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10); // tomorrow → start<end always, MTD-to-date
  const r = await ceClient().send(new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  }));
  const groups = r.ResultsByTime?.[0]?.Groups ?? [];
  const byService = groups
    .map((g) => ({ service: g.Keys?.[0] ?? '?', amount: Number(g.Metrics?.UnblendedCost?.Amount ?? 0) }))
    .filter((s) => s.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);
  const currency = groups[0]?.Metrics?.UnblendedCost?.Unit ?? 'USD';
  const total = byService.reduce((s, x) => s + x.amount, 0);
  return { total, currency, byService };
}
```

- [ ] **Step 4: Run it — verify PASS** (`npx vitest run lib/aws.test.ts` → 4 tests pass)

- [ ] **Step 5: Commit**
```bash
cd /home/atomoh/awsops
git add web/lib/aws.ts web/lib/aws.test.ts
git commit -m "feat(v2-p3b): lib/aws.ts — EKS listClusters + Cost Explorer getMtdCost (us-east-1) wrappers"
```

---

### Task 3: `GET /api/eks`

**Files:** Create `web/app/api/eks/route.ts`, `web/app/api/eks/route.test.ts`

- [ ] **Step 1: Failing test — `web/app/api/eks/route.test.ts`**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const listClusters = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/aws', () => ({ listClusters: (...a: unknown[]) => listClusters(...a) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/eks', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); listClusters.mockReset(); });

describe('GET /api/eks', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 with clusters', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    listClusters.mockResolvedValue([{ name: 'c1', status: 'ACTIVE', version: '1.30', endpoint: 'e', createdAt: '' }]);
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).clusters[0].name).toBe('c1');
  });
  it('500 on SDK error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    listClusters.mockRejectedValue(new Error('denied'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

- [ ] **Step 3: Create `web/app/api/eks/route.ts`**
```typescript
import { verifyUser } from '@/lib/auth';
import { listClusters } from '@/lib/aws';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    return Response.json({ clusters: await listClusters() });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run — verify PASS** (3 tests)

- [ ] **Step 5: Commit**
```bash
cd /home/atomoh/awsops
git add web/app/api/eks/route.ts web/app/api/eks/route.test.ts
git commit -m "feat(v2-p3b): GET /api/eks — verifyUser-gated live cluster list"
```

---

### Task 4: `GET /api/jobs` (add to the existing POST route)

**Files:** Modify `web/app/api/jobs/route.ts`; Create `web/app/api/jobs/get.test.ts`

- [ ] **Step 1: Failing test — `web/app/api/jobs/get.test.ts`**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/jobs', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); query.mockReset(); });

describe('GET /api/jobs', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 with jobs list', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [{ job_id: 'j1', type: 'noop', status: 'succeeded', runtime: 'lambda', error: null, created_at: 't', updated_at: 't' }] });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).jobs[0].job_id).toBe('j1');
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`npx vitest run app/api/jobs/get.test.ts` → no `GET` export)

- [ ] **Step 3: Add the GET handler to `web/app/api/jobs/route.ts`** — add this import near the top (with the others) and append the `GET` export at the END of the file (keep the entire existing POST handler unchanged):
```typescript
// add to the import block at the top:
import { verifyUser } from '@/lib/auth';
```
```typescript
// append at the end of the file:
export async function GET(req: NextRequest) {
  if (!(await verifyUser(req.headers.get('cookie')))) {
    return NextResponse.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const r = await getPool().query(
      `SELECT job_id, type, status, runtime, error, created_at, updated_at
       FROM worker_jobs ORDER BY created_at DESC LIMIT 50`,
    );
    return NextResponse.json({ jobs: r.rows });
  } catch (e) {
    return NextResponse.json(
      { status: 'error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Run — verify PASS.** Also re-run the existing POST test: `npx vitest run app/api/jobs/` — confirm BOTH the existing route POST behavior (if a POST test exists) and the new GET pass; at minimum confirm the GET test passes and the file still compiles.

- [ ] **Step 5: Commit**
```bash
cd /home/atomoh/awsops
git add web/app/api/jobs/route.ts web/app/api/jobs/get.test.ts
git commit -m "feat(v2-p3b): GET /api/jobs — verifyUser-gated recent worker_jobs list (POST enqueue unchanged)"
```

---

### Task 5: `GET /api/cost`

**Files:** Create `web/app/api/cost/route.ts`, `web/app/api/cost/route.test.ts`

- [ ] **Step 1: Failing test — `web/app/api/cost/route.test.ts`**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const getMtdCost = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/aws', () => ({ getMtdCost: (...a: unknown[]) => getMtdCost(...a) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/cost', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); getMtdCost.mockReset(); });

describe('GET /api/cost', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 with cost', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMtdCost.mockResolvedValue({ total: 490.5, currency: 'USD', byService: [{ service: 'Amazon RDS', amount: 310.5 }] });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(490.5);
  });
  it('500 on CE error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMtdCost.mockRejectedValue(new Error('no ce perms'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

- [ ] **Step 3: Create `web/app/api/cost/route.ts`**
```typescript
import { verifyUser } from '@/lib/auth';
import { getMtdCost } from '@/lib/aws';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    return Response.json(await getMtdCost());
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run — verify PASS** (3 tests)

- [ ] **Step 5: Commit**
```bash
cd /home/atomoh/awsops
git add web/app/api/cost/route.ts web/app/api/cost/route.test.ts
git commit -m "feat(v2-p3b): GET /api/cost — verifyUser-gated Cost Explorer MTD breakdown"
```

---

### Task 6: `GET /api/overview` (server aggregate)

**Files:** Create `web/app/api/overview/route.ts`, `web/app/api/overview/route.test.ts`

- [ ] **Step 1: Failing test — `web/app/api/overview/route.test.ts`**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const listClusters = vi.fn();
const getMtdCost = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/aws', () => ({ listClusters: (...a: unknown[]) => listClusters(...a), getMtdCost: (...a: unknown[]) => getMtdCost(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/overview', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); listClusters.mockReset(); getMtdCost.mockReset(); query.mockReset(); });

describe('GET /api/overview', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('aggregates jobs/clusters/cost, degrades cost to null on CE failure', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [{ status: 'succeeded', n: '5' }, { status: 'failed', n: '1' }] });
    listClusters.mockResolvedValue([{ name: 'c1' }, { name: 'c2' }]);
    getMtdCost.mockRejectedValue(new Error('no ce'));
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.succeeded).toBe(5);
    expect(body.jobs.failed).toBe(1);
    expect(body.clusterCount).toBe(2);
    expect(body.mtdCost).toBeNull(); // cost degrades, page still loads
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

- [ ] **Step 3: Create `web/app/api/overview/route.ts`**
```typescript
import { verifyUser } from '@/lib/auth';
import { listClusters, getMtdCost } from '@/lib/aws';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  // jobs counts (Aurora) — required
  const jobs = { queued: 0, running: 0, succeeded: 0, failed: 0 } as Record<string, number>;
  try {
    const r = await getPool().query(`SELECT status, count(*)::int AS n FROM worker_jobs GROUP BY status`);
    for (const row of r.rows) if (row.status in jobs) jobs[row.status] = Number(row.n);
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  // clusters + cost — degrade independently (a CE/EKS hiccup shouldn't blank the whole page)
  let clusterCount: number | null = null;
  try { clusterCount = (await listClusters()).length; } catch { clusterCount = null; }
  let mtdCost: number | null = null;
  try { mtdCost = (await getMtdCost()).total; } catch { mtdCost = null; }
  return Response.json({ jobs, clusterCount, mtdCost });
}
```

- [ ] **Step 4: Run — verify PASS** (2 tests)

- [ ] **Step 5: Commit**
```bash
cd /home/atomoh/awsops
git add web/app/api/overview/route.ts web/app/api/overview/route.test.ts
git commit -m "feat(v2-p3b): GET /api/overview — jobs/clusters/cost aggregate (cost+clusters degrade independently)"
```

---

### Task 7: Shared UI — StatCard + DataTable

**Files:** Create `web/components/ui/StatCard.tsx`, `web/components/ui/DataTable.tsx` (presentational; verified by build in T8)

- [ ] **Step 1: Create `web/components/ui/StatCard.tsx`**
```tsx
export default function StatCard({ label, value, accent = '#00d4ff' }: { label: string; value: string | number; accent?: string }) {
  return (
    <div style={{ background: '#0f1629', border: '1px solid #1a2540', borderLeft: `3px solid ${accent}`, borderRadius: 8, padding: '14px 16px', minWidth: 160 }}>
      <div style={{ fontSize: 11, color: '#7da2c9', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ fontSize: 24, color: '#e6eefb', fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}
```

- [ ] **Step 2: Create `web/components/ui/DataTable.tsx`**
```tsx
export interface Column { key: string; label: string }

export default function DataTable({ columns, rows }: { columns: Column[]; rows: Record<string, unknown>[] }) {
  if (rows.length === 0) {
    return <div style={{ padding: 24, color: '#7da2c9', textAlign: 'center' }}>데이터 없음</div>;
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr>{columns.map((c) => (
          <th key={c.key} style={{ textAlign: 'left', padding: '8px 10px', color: '#7da2c9', borderBottom: '1px solid #1a2540', fontWeight: 600 }}>{c.label}</th>
        ))}</tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>{columns.map((c) => (
            <td key={c.key} style={{ padding: '8px 10px', color: '#bcd6f2', borderBottom: '1px solid #131d31' }}>{String(row[c.key] ?? '')}</td>
          ))}</tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 3: Commit** (build happens in T8)
```bash
cd /home/atomoh/awsops
git add web/components/ui/
git commit -m "feat(v2-p3b): shared UI — StatCard + DataTable (navy theme, empty state)"
```

---

### Task 8: Pages (Overview/EKS/Jobs/Cost) + TopNav nav

**Files:** Modify `web/app/page.tsx`, `web/components/shell/TopNav.tsx`; Create `web/app/eks/page.tsx`, `web/app/jobs/page.tsx`, `web/app/cost/page.tsx`

- [ ] **Step 1: Replace `web/components/shell/TopNav.tsx` with real nav (client component, active highlight)**
```tsx
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/eks', label: 'EKS' },
  { href: '/jobs', label: 'Jobs' },
  { href: '/cost', label: 'Cost' },
];

export default function TopNav() {
  const path = usePathname();
  return (
    <header style={{ height: 48, display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', background: '#0f1629', borderBottom: '1px solid #1a2540', color: '#7da2c9', fontSize: 13 }}>
      <span style={{ color: '#00d4ff', fontWeight: 700 }}>AWSops</span>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} style={{ color: path === l.href ? '#e6eefb' : '#7da2c9', textDecoration: 'none', fontWeight: path === l.href ? 600 : 400 }}>{l.label}</Link>
      ))}
      <span style={{ marginLeft: 'auto' }}>◷ admin</span>
    </header>
  );
}
```

- [ ] **Step 2: Replace `web/app/page.tsx` with the Overview dashboard**
```tsx
'use client';
import { useEffect, useState } from 'react';
import StatCard from '@/components/ui/StatCard';

interface Overview { jobs: { queued: number; running: number; succeeded: number; failed: number }; clusterCount: number | null; mtdCost: number | null }

export default function Home() {
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/overview').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(setD).catch((e) => setErr(String(e)));
  }, []);
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: '#e6eefb', fontSize: 20, marginBottom: 16 }}>Overview</h1>
      {err && <div style={{ color: '#ef4444' }}>로드 실패: {err} (세션 만료면 새로고침)</div>}
      {!d && !err && <div style={{ color: '#7da2c9' }}>로딩 중…</div>}
      {d && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <StatCard label="Jobs 성공" value={d.jobs.succeeded} accent="#00ff88" />
          <StatCard label="Jobs 실패" value={d.jobs.failed} accent="#ef4444" />
          <StatCard label="Jobs 대기/실행" value={d.jobs.queued + d.jobs.running} accent="#f59e0b" />
          <StatCard label="EKS 클러스터" value={d.clusterCount ?? '—'} accent="#00d4ff" />
          <StatCard label="이번 달 비용(USD)" value={d.mtdCost == null ? '—' : `$${d.mtdCost.toFixed(2)}`} accent="#a855f7" />
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 3: Create `web/app/eks/page.tsx`**
```tsx
'use client';
import { useEffect, useState } from 'react';
import DataTable from '@/components/ui/DataTable';

export default function EksPage() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/eks').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((d) => setRows(d.clusters)).catch((e) => setErr(String(e)));
  }, []);
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: '#e6eefb', fontSize: 20, marginBottom: 16 }}>EKS Clusters</h1>
      {err && <div style={{ color: '#ef4444' }}>로드 실패: {err}</div>}
      {!rows && !err && <div style={{ color: '#7da2c9' }}>로딩 중…</div>}
      {rows && <DataTable columns={[{ key: 'name', label: 'Name' }, { key: 'status', label: 'Status' }, { key: 'version', label: 'Version' }, { key: 'endpoint', label: 'Endpoint' }]} rows={rows} />}
    </main>
  );
}
```

- [ ] **Step 4: Create `web/app/jobs/page.tsx`**
```tsx
'use client';
import { useEffect, useState } from 'react';
import DataTable from '@/components/ui/DataTable';

export default function JobsPage() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/jobs').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((d) => setRows(d.jobs)).catch((e) => setErr(String(e)));
  }, []);
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: '#e6eefb', fontSize: 20, marginBottom: 16 }}>Async Jobs</h1>
      {err && <div style={{ color: '#ef4444' }}>로드 실패: {err}</div>}
      {!rows && !err && <div style={{ color: '#7da2c9' }}>로딩 중…</div>}
      {rows && <DataTable columns={[{ key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'runtime', label: 'Runtime' }, { key: 'error', label: 'Error' }, { key: 'created_at', label: 'Created' }]} rows={rows} />}
    </main>
  );
}
```

- [ ] **Step 5: Create `web/app/cost/page.tsx`**
```tsx
'use client';
import { useEffect, useState } from 'react';
import StatCard from '@/components/ui/StatCard';
import DataTable from '@/components/ui/DataTable';

interface Cost { total: number; currency: string; byService: { service: string; amount: number }[] }

export default function CostPage() {
  const [d, setD] = useState<Cost | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/cost').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(setD).catch((e) => setErr(String(e)));
  }, []);
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: '#e6eefb', fontSize: 20, marginBottom: 16 }}>Cost (MTD)</h1>
      {err && <div style={{ color: '#ef4444' }}>로드 실패: {err} (Cost Explorer 권한/요금 확인)</div>}
      {!d && !err && <div style={{ color: '#7da2c9' }}>로딩 중…</div>}
      {d && (
        <>
          <div style={{ marginBottom: 16 }}><StatCard label={`이번 달 합계 (${d.currency})`} value={`$${d.total.toFixed(2)}`} accent="#a855f7" /></div>
          <DataTable columns={[{ key: 'service', label: 'Service' }, { key: 'amount', label: 'Amount (USD)' }]} rows={d.byService.map((s) => ({ service: s.service, amount: s.amount.toFixed(2) }))} />
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 6: Build (verifies all pages + nav + UI compile)**
Run: `cd /home/atomoh/awsops/web && npm run build`
Expected: "✓ Compiled successfully"; manifest lists `/`, `/eks`, `/jobs`, `/cost`, `/api/eks`, `/api/cost`, `/api/overview`, `/api/jobs`. Fix any TS error minimally.

- [ ] **Step 7: Commit**
```bash
cd /home/atomoh/awsops
git add web/app/page.tsx web/app/eks/ web/app/jobs/page.tsx web/app/cost/ web/components/shell/TopNav.tsx
git commit -m "feat(v2-p3b): Overview/EKS/Jobs/Cost pages + TopNav nav (chat drawer docks alongside)"
```

---

### Task 9: IAM — Cost Explorer read on the web task role

**Files:** Modify `terraform/foundation/ai.tf`

- [ ] **Step 1: Add the policy after `aws_iam_role_policy.task_agentcore_invoke`**
```hcl
# web task role reads Cost Explorer for the Cost page / Overview (P3-B). CE has no resource-level
# scoping → "*". Read-only (GetCostAndUsage/GetCostForecast).
resource "aws_iam_role_policy" "task_cost" {
  count = local.ac_count
  name  = "${var.project}-task-cost-read"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ce:GetCostAndUsage", "ce:GetCostForecast"]
      Resource = "*"
    }]
  })
}
```

- [ ] **Step 2: fmt + validate + plan**
```bash
cd /home/atomoh/awsops/terraform/foundation
export PATH="$HOME/.local/bin:$PATH"
terraform fmt ai.tf
terraform validate
terraform plan -no-color -input=false -lock=false 2>&1 | grep -E "will be created|will be|Plan:|task-cost-read" | head
```
Expected: `aws_iam_role_policy.task_cost[0]` will be **created**; NO other resource changes (web task-def NOT replaced — no env change this task). If anything else changes, STOP and report.

- [ ] **Step 3: Commit**
```bash
cd /home/atomoh/awsops
git add terraform/foundation/ai.tf
git commit -m "feat(v2-p3b): web task-role ce:GetCostAndUsage/GetCostForecast (Cost page)"
```

---

### Task 10: Full build + unit gate

- [ ] **Step 1: Full unit suite** — `cd /home/atomoh/awsops/web && npm run test` → all pass (24 prior + aws[4] + eks[3] + jobs-GET[2] + cost[3] + overview[2] = 38).
- [ ] **Step 2: Production build** — `npm run build` → clean; `/eks`,`/jobs`,`/cost`,`/` + the 4 API routes present; `@aws-sdk/client-eks` + `@aws-sdk/client-cost-explorer` in `dependencies`.
- [ ] **Step 3: Commit lockfile if changed** (else skip)
```bash
cd /home/atomoh/awsops; git add -- web/package-lock.json 2>/dev/null && git commit -m "chore(v2-p3b): lockfile" || echo "nothing"
```

---

### Task 11: Deploy + verify (CONTROLLER — real infra; PAUSE for go-ahead)

> Do not run without explicit user go-ahead. Creates a CE IAM policy + rolls the web service (new image with the pages).

- [ ] **Step 1: Verify branch + apply** (`git rev-parse --abbrev-ref HEAD` = feat/v2-architecture-design)
```bash
cd /home/atomoh/awsops/terraform/foundation && export PATH="$HOME/.local/bin:$PATH"
terraform plan -out=/tmp/p3b.tfplan -input=false && terraform apply -input=false /tmp/p3b.tfplan
```
Expected: `task_cost` policy created (no task-def change → no forced web roll from TF).

- [ ] **Step 2: Build + push the web image + roll**
```bash
cd /home/atomoh/awsops && make deploy
```
Expected: buildx arm64 push → force-new-deployment → services-stable → `/api/health` 200.

- [ ] **Step 3: E2E in the browser** (`https://awsops-v2.example.com`, after Cognito login):
1. **Overview** — cards populated: Jobs 성공=5 / 실패=1 (the real worker_jobs), EKS 클러스터 count, 이번 달 비용 (or "—" if CE lag).
2. Nav → **EKS** lists clusters (name/status/version/endpoint); **Jobs** shows the 6 jobs; **Cost** shows MTD total + by-service.
3. Chat drawer (✦) still works on every page.
4. Unauthenticated `/api/eks` → 302 (edge) ; authed → 200.

- [ ] **Step 4: Confirm GREEN + report** (no commit — deploy only). File follow-ups for any issue.

---

## Self-Review

**Spec coverage:** data-layer A=BFF-direct SDK (T2 lib/aws + T3/T5 routes) · Jobs from Aurora (T4) · Overview aggregate (T6) · pages+nav (T8) · StatCard/DataTable (T7) · all routes verifyUser-gated (T3-T6) · ce IAM (T9) · CE us-east-1 (T2) · empty ADR-030 tables skipped (only worker_jobs used) · testing (T1-T6,T10) · deploy/E2E (T11). All spec sections covered.

**Placeholder scan:** none — full code in every step.

**Type consistency:** `ClusterInfo`/`CostBreakdown` (T2) consumed by T3/T5/T6 routes + T8 pages. `listClusters()→ClusterInfo[]`, `getMtdCost()→CostBreakdown` stable across T2/T6. Route response shapes (`{clusters}`, `{jobs}`, `{total,currency,byService}`, `{jobs,clusterCount,mtdCost}`) consistent between route (T3-T6) and page fetch (T8). `verifyUser(cookie)→User|null` (P3-A) + `getPool()` (P2) reused unchanged. `StatCard{label,value,accent}` / `DataTable{columns,rows}` (T7) used in T8. `Column{key,label}` consistent.
