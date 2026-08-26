# EKS Page Buildout Implementation Plan

> **For agentic workers:** consensus P3 loop or superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** `/eks`를 v1-parity+로 — 풍부한 리스트(컬럼·접근배지·paper+ink 리스킨) + Access Entry 보유 클러스터의 **런타임 조회 등록**(재배포 없음, v1 kubeconfig 등록의 v2 등가) + Entry 미보유 클러스터의 v1식 온보딩 가이드.

**Architecture:** migration v11 `eks_registrations` → `eks-registry.ts`(허용리스트 = env ∪ DB, degrade=env-only) + `eks-access.ts`(STS role ARN·DescribeAccessEntry·가이드 생성) → `GET /api/eks` access 합성 + `POST/DELETE /api/eks/[cluster]/register`(admin) → 기존 incluster/k8sgpt 라우트 allow-list를 registry로 교체 → `/eks` 페이지 재작성.

**Tech Stack:** Next.js 14 BFF · node-pg(getPool) · @aws-sdk/client-eks(기존) + @aws-sdk/client-sts(신규 의존 — package.json 추가) · vitest 2.x

**사전 확보 사실:** schema 최신 **v10**(ADR-032 P4 prevention_insights가 선점 — P2 게이트 opus 검증) → 본 작업 **v11**. IAM 기존 보유: `eks:DescribeCluster/ListClusters/DescribeAccessEntry`(eks.tf) — **추가 IAM 불필요**(STS GetCallerIdentity는 IAM 권한 불요). `isAdmin(user)` = `web/lib/admin.ts:31`. 현재 allow-list 파싱은 `incluster/route.ts`·`k8sgpt/route.ts` 두 곳의 `(process.env.ONBOARDED_EKS_CLUSTERS || '').split(',').filter(Boolean)`. `listClusters()`는 `web/lib/aws.ts:14`(DescribeCluster 응답에서 vpcId=`cluster.resourcesVpcConfig.vpcId`, platformVersion=`cluster.platformVersion` 추출 가능). 디자인 시스템: paper+ink Tailwind — 패턴은 `web/app/inventory/[type]/page.tsx`·`web/components/ui/{DataTable,Badge}.tsx` 참조(구현 시 해당 파일 먼저 READ).

**커밋 규율:** 태스크마다 명시 경로 add+즉시 커밋, `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: migration v11 — eks_registrations

**Files:**
- Modify: `terraform/foundation/data/schema.sql`

- [ ] **Step 1:** 파일 끝(v9 블록 뒤)에 append — 먼저 `tail -8`로 현 최신이 v10인지 확인(동시 세션이 또 선점했으면 +1 리넘버):

```sql
-- ============================================================
-- v11: EKS runtime registration — clusters an admin registered for in-app queries
-- (the v2 equivalent of v1's "Register kubeconfig"; union'd with ONBOARDED_EKS_CLUSTERS env)
-- ============================================================
CREATE TABLE IF NOT EXISTS eks_registrations (
  cluster_name  TEXT PRIMARY KEY,
  registered_by TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, description)
VALUES (11, 'EKS runtime registration: eks_registrations (env-union allow-list, register button)')
ON CONFLICT (version) DO NOTHING;
```

- [ ] **Step 2:** 커밋 — `git add terraform/foundation/data/schema.sql && git commit -m "feat(eks-page): migration v11 — eks_registrations"`

### Task 2: `web/lib/eks-registry.ts` — 허용리스트 단일 소스

**Files:**
- Create: `web/lib/eks-registry.ts`
- Test: `web/lib/eks-registry.test.ts`

- [ ] **Step 1: RED** — `web/lib/eks-registry.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

describe('eks-registry', () => {
  beforeEach(async () => {
    query.mockReset();
    process.env.AURORA_ENDPOINT = 'x';
    process.env.ONBOARDED_EKS_CLUSTERS = 'tf-a,tf-b';
    const { _resetForTests } = await import('./eks-registry');
    _resetForTests();
  });

  it('allow-list = env ∪ DB', async () => {
    query.mockResolvedValue({ rows: [{ cluster_name: 'db-c' }] });
    const { getAllowedClusters } = await import('./eks-registry');
    const s = await getAllowedClusters();
    expect(s.has('tf-a')).toBe(true);
    expect(s.has('tf-b')).toBe(true);
    expect(s.has('db-c')).toBe(true);
    expect(s.has('nope')).toBe(false);
  });

  it('degrades to env-only when the DB query fails', async () => {
    query.mockRejectedValue(new Error('db down'));
    const { getAllowedClusters } = await import('./eks-registry');
    const s = await getAllowedClusters();
    expect(s.has('tf-a')).toBe(true);
    expect(s.size).toBe(2);
  });

  it('is env-only without AURORA_ENDPOINT (no DB call)', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { getAllowedClusters } = await import('./eks-registry');
    await getAllowedClusters();
    expect(query).not.toHaveBeenCalled();
  });

  it('caches within TTL (one DB query for two calls)', async () => {
    query.mockResolvedValue({ rows: [] });
    const { getAllowedClusters } = await import('./eks-registry');
    await getAllowedClusters();
    await getAllowedClusters();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('isAllowed consults the union', async () => {
    query.mockResolvedValue({ rows: [{ cluster_name: 'db-c' }] });
    const { isAllowed } = await import('./eks-registry');
    expect(await isAllowed('db-c')).toBe(true);
    expect(await isAllowed('nope')).toBe(false);
  });

  it('registerCluster inserts idempotently and busts the cache', async () => {
    query.mockResolvedValue({ rows: [] });
    const { registerCluster, getAllowedClusters } = await import('./eks-registry');
    await getAllowedClusters(); // warm cache
    expect(await registerCluster('new-c', 'u1')).toBe(true);
    const [sql, params] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(String(sql)).toContain('ON CONFLICT (cluster_name) DO NOTHING');
    expect(params).toEqual(['new-c', 'u1']);
    query.mockResolvedValue({ rows: [{ cluster_name: 'new-c' }] });
    expect((await getAllowedClusters()).has('new-c')).toBe(true); // cache busted → re-query
  });

  it('registerCluster returns false when the DB write fails (degrade, not throw)', async () => {
    query.mockRejectedValue(new Error('db down'));
    const { registerCluster } = await import('./eks-registry');
    expect(await registerCluster('c', 'u')).toBe(false);
  });

  it('registerCluster returns false without a DB', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { registerCluster } = await import('./eks-registry');
    expect(await registerCluster('c', 'u')).toBe(false);
  });

  it('unregisterCluster deletes and reports whether a row was removed', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [] });
    const { unregisterCluster } = await import('./eks-registry');
    expect(await unregisterCluster('db-c')).toBe(true);
  });

  it('isEnvCluster identifies Terraform-managed clusters', async () => {
    const { isEnvCluster } = await import('./eks-registry');
    expect(isEnvCluster('tf-a')).toBe(true);
    expect(isEnvCluster('db-c')).toBe(false);
  });
});
```

- [ ] **Step 2: 구현** — `web/lib/eks-registry.ts`:

```ts
import { getPool } from './db';

// Single source for "which EKS clusters may the app query".
// Allow-list = ONBOARDED_EKS_CLUSTERS env (Terraform-managed, immutable here) ∪ eks_registrations (runtime).
// DB failure/absence degrades to env-only — existing clusters keep working (never throws).

const TTL_MS = 30_000;
let cache: { set: Set<string>; at: number } | null = null;

const dbOn = () => !!process.env.AURORA_ENDPOINT;

export function envClusters(): string[] {
  return (process.env.ONBOARDED_EKS_CLUSTERS || '').split(',').filter(Boolean);
}

export function isEnvCluster(name: string): boolean {
  return envClusters().includes(name);
}

export function _resetForTests() { cache = null; }

export async function getAllowedClusters(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.set;
  const set = new Set(envClusters());
  if (dbOn()) {
    try {
      const r = await getPool().query(`SELECT cluster_name FROM eks_registrations`);
      for (const row of r.rows) set.add(row.cluster_name);
    } catch (e) {
      console.warn(`[eks-registry] falling back to env-only: ${e instanceof Error ? e.message : e}`);
    }
  }
  cache = { set, at: Date.now() };
  return set;
}

export async function isAllowed(cluster: string): Promise<boolean> {
  return (await getAllowedClusters()).has(cluster);
}

export async function registerCluster(cluster: string, userSub: string): Promise<boolean> {
  if (!dbOn()) return false;
  try {
    await getPool().query(
      `INSERT INTO eks_registrations (cluster_name, registered_by) VALUES ($1, $2)
       ON CONFLICT (cluster_name) DO NOTHING`,
      [cluster, userSub],
    );
  } catch (e) { // write failure degrades to "storage unavailable" (route → 503), never a 500
    console.warn(`[eks-registry] register failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  cache = null; // bust so the next read sees it immediately
  return true;
}

export async function unregisterCluster(cluster: string): Promise<boolean> {
  if (!dbOn()) return false;
  try {
    const r = await getPool().query(`DELETE FROM eks_registrations WHERE cluster_name = $1`, [cluster]);
    cache = null;
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    console.warn(`[eks-registry] unregister failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}
```

- [ ] **Step 3:** `cd web && npx vitest run lib/eks-registry.test.ts` → 9 pass. 커밋(2파일).

### Task 3: `web/lib/eks-access.ts` — role ARN·entry 확인·가이드

**Files:**
- Create: `web/lib/eks-access.ts`
- Test: `web/lib/eks-access.test.ts`
- Modify: `web/package.json`

- [ ] **Step 1:** `cd web && npm install @aws-sdk/client-sts@^3.1060.0`
- [ ] **Step 2: RED** — `web/lib/eks-access.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const stsSend = vi.fn();
const eksSend = vi.fn();
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = (...a: unknown[]) => stsSend(...a); },
  GetCallerIdentityCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-eks', () => ({
  EKSClient: class { send = (...a: unknown[]) => eksSend(...a); },
  DescribeAccessEntryCommand: class { constructor(public input: unknown) {} },
}));

describe('eks-access', () => {
  beforeEach(async () => {
    stsSend.mockReset(); eksSend.mockReset();
    const { _resetForTests } = await import('./eks-access');
    _resetForTests();
  });

  it('getTaskRoleArn converts an assumed-role ARN to the IAM role ARN', async () => {
    stsSend.mockResolvedValue({ Arn: 'arn:aws:sts::123456789012:assumed-role/awsops-v2-task/abc123' });
    const { getTaskRoleArn } = await import('./eks-access');
    expect(await getTaskRoleArn()).toBe('arn:aws:iam::123456789012:role/awsops-v2-task');
  });

  it('getTaskRoleArn passes a plain role ARN through and caches it', async () => {
    stsSend.mockResolvedValue({ Arn: 'arn:aws:iam::1:role/r' });
    const { getTaskRoleArn } = await import('./eks-access');
    await getTaskRoleArn();
    await getTaskRoleArn();
    expect(stsSend).toHaveBeenCalledTimes(1);
  });

  it('hasAccessEntry: found → true', async () => {
    stsSend.mockResolvedValue({ Arn: 'arn:aws:iam::1:role/r' });
    eksSend.mockResolvedValue({ accessEntry: {} });
    const { hasAccessEntry } = await import('./eks-access');
    expect(await hasAccessEntry('c1')).toBe(true);
  });

  it('hasAccessEntry: ResourceNotFoundException → false', async () => {
    stsSend.mockResolvedValue({ Arn: 'arn:aws:iam::1:role/r' });
    eksSend.mockRejectedValue(Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' }));
    const { hasAccessEntry } = await import('./eks-access');
    expect(await hasAccessEntry('c1')).toBe(false);
  });

  it('hasAccessEntry: other errors → null (unknown)', async () => {
    stsSend.mockResolvedValue({ Arn: 'arn:aws:iam::1:role/r' });
    eksSend.mockRejectedValue(new Error('throttled'));
    const { hasAccessEntry } = await import('./eks-access');
    expect(await hasAccessEntry('c1')).toBeNull();
  });

  it('onboardingGuide embeds the role ARN, cluster and region in both commands', async () => {
    stsSend.mockResolvedValue({ Arn: 'arn:aws:iam::1:role/awsops-v2-task' });
    const { onboardingGuide } = await import('./eks-access');
    const g = await onboardingGuide('my-c');
    expect(g.commands).toHaveLength(2);
    expect(g.commands[0]).toContain('create-access-entry');
    expect(g.commands[0]).toContain('--cluster-name my-c');
    expect(g.commands[0]).toContain('arn:aws:iam::1:role/awsops-v2-task');
    expect(g.commands[1]).toContain('associate-access-policy');
    expect(g.commands[1]).toContain('AmazonEKSViewPolicy');
    expect(g.note).toContain('make configure');
  });
});
```

- [ ] **Step 3: 구현** — `web/lib/eks-access.ts`:

```ts
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EKSClient, DescribeAccessEntryCommand } from '@aws-sdk/client-eks';

// Access-entry awareness for the EKS page: who am I (task role), does a cluster
// already trust me (DescribeAccessEntry), and the v1-style onboarding guide.

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const ARN_TTL_MS = 10 * 60 * 1000;

let sts: STSClient | null = null;
let eks: EKSClient | null = null;
let arnCache: { arn: string; at: number } | null = null;

export function _resetForTests() { sts = null; eks = null; arnCache = null; }

/** Current task-role ARN (assumed-role STS ARN → IAM role ARN, v1 callerRole transform). */
export async function getTaskRoleArn(): Promise<string> {
  if (arnCache && Date.now() - arnCache.at < ARN_TTL_MS) return arnCache.arn;
  if (!sts) sts = new STSClient({ region: REGION });
  const { Arn = '' } = await sts.send(new GetCallerIdentityCommand({}));
  const m = Arn.match(/^arn:aws:sts::(\d+):assumed-role\/([^/]+)\//);
  const arn = m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : Arn;
  arnCache = { arn, at: Date.now() };
  return arn;
}

/** Does the cluster have an access entry for our task role? null = couldn't determine. */
export async function hasAccessEntry(cluster: string): Promise<boolean | null> {
  const principalArn = await getTaskRoleArn();
  if (!eks) eks = new EKSClient({ region: REGION });
  try {
    await eks.send(new DescribeAccessEntryCommand({ clusterName: cluster, principalArn }));
    return true;
  } catch (e) {
    if (e instanceof Error && e.name === 'ResourceNotFoundException') return false;
    return null;
  }
}

export interface OnboardingGuide { commands: string[]; note: string }

/** v1-parity copy-paste onboarding guide with the role ARN and region filled in. */
export async function onboardingGuide(cluster: string): Promise<OnboardingGuide> {
  const arn = await getTaskRoleArn();
  return {
    commands: [
      `aws eks create-access-entry --cluster-name ${cluster} --region ${REGION} --principal-arn ${arn} --type STANDARD`,
      `aws eks associate-access-policy --cluster-name ${cluster} --region ${REGION} --principal-arn ${arn} --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy --access-scope type=cluster`,
    ],
    note: '명령 실행 후 [조회 등록]을 다시 누르세요. 영구 온보딩(Terraform)은 make configure → onboard_eks_clusters 를 사용하세요.',
  };
}
```

- [ ] **Step 4:** `npx vitest run lib/eks-access.test.ts` → 6 pass. 커밋(3파일: lib+test+package.json[+lock]).

### Task 4: API — access 합성 + register 라우트 + allow-list 교체

**Files:**
- Modify: `web/lib/aws.ts`
- Modify: `web/app/api/eks/route.ts`
- Create: `web/app/api/eks/[cluster]/register/route.ts`
- Modify: `web/app/api/eks/[cluster]/incluster/route.ts`
- Modify: `web/app/api/eks/[cluster]/k8sgpt/route.ts`
- Test: `web/app/api/eks/register.test.ts`
- Modify: `web/app/api/eks/route.test.ts`
- Modify: `web/lib/aws.test.ts`

- [ ] **Step 1:** `aws.ts` — `ClusterInfo`에 `region/vpcId/platformVersion` 추가, `listClusters` 추출 확장:

```ts
export interface ClusterInfo {
  name: string; status: string; version: string; endpoint: string; createdAt: string;
  region: string; vpcId: string; platformVersion: string;
}
```
push 객체에 추가: `region: REGION, vpcId: cluster?.resourcesVpcConfig?.vpcId ?? '', platformVersion: cluster?.platformVersion ?? ''`.

- [ ] **Step 2:** `GET /api/eks` 확장 — `route.ts` 교체:

```ts
import { verifyUser } from '@/lib/auth';
import { listClusters } from '@/lib/aws';
import { getAllowedClusters, isEnvCluster } from '@/lib/eks-registry';
import { hasAccessEntry } from '@/lib/eks-access';
import { isAdmin } from '@/lib/admin';

export const dynamic = 'force-dynamic';

export type AccessState = 'connected' | 'entry-only' | 'no-entry' | 'unknown';

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const [clusters, allowed] = await Promise.all([listClusters(), getAllowedClusters()]);
    const rows = await Promise.all(clusters.map(async (c) => {
      let access: AccessState;
      const isEnv = isEnvCluster(c.name);
      if (allowed.has(c.name) && isEnv) {
        access = 'connected'; // Terraform guarantees the entry — skip the per-row API call
      } else {
        const entry = await hasAccessEntry(c.name);
        if (allowed.has(c.name)) {
          // runtime-registered: re-verify the entry (spec: connected = allowed AND entry) —
          // a revoked entry shows as no-entry again (guide + still unregisterable)
          access = entry === true ? 'connected' : entry === false ? 'no-entry' : 'unknown';
        } else {
          access = entry === true ? 'entry-only' : entry === false ? 'no-entry' : 'unknown';
        }
      }
      return { ...c, access, runtime: allowed.has(c.name) && !isEnv };
    }));
    const admin = await isAdmin(user);
    return Response.json({ clusters: rows, admin });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 3: RED** — `web/app/api/eks/register.test.ts` (register 라우트 + GET access 합성):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const listClusters = vi.fn();
const getAllowedClusters = vi.fn();
const isAllowed = vi.fn();
const isEnvCluster = vi.fn();
const registerCluster = vi.fn();
const unregisterCluster = vi.fn();
const hasAccessEntry = vi.fn();
const onboardingGuide = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/aws', () => ({ listClusters: (...a: unknown[]) => listClusters(...a) }));
vi.mock('@/lib/eks-registry', () => ({
  getAllowedClusters: (...a: unknown[]) => getAllowedClusters(...a),
  isAllowed: (...a: unknown[]) => isAllowed(...a),
  isEnvCluster: (...a: unknown[]) => isEnvCluster(...a),
  registerCluster: (...a: unknown[]) => registerCluster(...a),
  unregisterCluster: (...a: unknown[]) => unregisterCluster(...a),
}));
vi.mock('@/lib/eks-access', () => ({
  hasAccessEntry: (...a: unknown[]) => hasAccessEntry(...a),
  onboardingGuide: (...a: unknown[]) => onboardingGuide(...a),
}));

const req = (method = 'POST') => new Request('http://x/api/eks/c1/register', { method, headers: { cookie: 'awsops_token=t' } });
const P = { params: { cluster: 'c1' } };

describe('GET /api/eks access synthesis', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('env-allowed=connected (no recheck), runtime-allowed=re-verified, entry holders=entry-only, rest=no-entry', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    listClusters.mockResolvedValue([{ name: 'env-a' }, { name: 'rt-ok' }, { name: 'rt-revoked' }, { name: 'b' }, { name: 'c' }]);
    getAllowedClusters.mockResolvedValue(new Set(['env-a', 'rt-ok', 'rt-revoked']));
    isEnvCluster.mockImplementation((n: string) => n === 'env-a');
    hasAccessEntry.mockImplementation(async (n: string) => (n === 'rt-ok' || n === 'b' ? true : false));
    const { GET } = await import('./route');
    const body = await (await GET(req('GET'))).json();
    const by = Object.fromEntries(body.clusters.map((c: { name: string; access: string }) => [c.name, c.access]));
    expect(by).toEqual({ 'env-a': 'connected', 'rt-ok': 'connected', 'rt-revoked': 'no-entry', b: 'entry-only', c: 'no-entry' });
    expect(hasAccessEntry).not.toHaveBeenCalledWith('env-a');
    expect(body.admin).toBe(true);
    const rt = body.clusters.find((c: { name: string }) => c.name === 'rt-ok');
    expect(rt.runtime).toBe(true);
  });
});

describe('POST /api/eks/[cluster]/register', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./[cluster]/register/route');
    expect((await POST(req(), P)).status).toBe(401);
  });

  it('403 non-admin', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./[cluster]/register/route');
    expect((await POST(req(), P)).status).toBe(403);
  });

  it('404 for a cluster that does not exist', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    listClusters.mockResolvedValue([]);
    const { POST } = await import('./[cluster]/register/route');
    expect((await POST(req(), P)).status).toBe(404);
  });

  it('400 for an invalid cluster name', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    const { POST } = await import('./[cluster]/register/route');
    expect((await POST(req(), { params: { cluster: 'bad/../name' } })).status).toBe(400);
  });

  it('200 registers when the access entry exists', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    listClusters.mockResolvedValue([{ name: 'c1' }]);
    hasAccessEntry.mockResolvedValue(true);
    registerCluster.mockResolvedValue(true);
    const { POST } = await import('./[cluster]/register/route');
    const res = await POST(req(), P);
    expect(res.status).toBe(200);
    expect(registerCluster).toHaveBeenCalledWith('c1', 'u');
  });

  it('409 + guide when no access entry', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    listClusters.mockResolvedValue([{ name: 'c1' }]);
    hasAccessEntry.mockResolvedValue(false);
    onboardingGuide.mockResolvedValue({ commands: ['cmd1', 'cmd2'], note: 'n' });
    const { POST } = await import('./[cluster]/register/route');
    const res = await POST(req(), P);
    expect(res.status).toBe(409);
    expect((await res.json()).guide.commands).toHaveLength(2);
  });

  it('503 when the registry has no DB', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    listClusters.mockResolvedValue([{ name: 'c1' }]);
    hasAccessEntry.mockResolvedValue(true);
    registerCluster.mockResolvedValue(false);
    const { POST } = await import('./[cluster]/register/route');
    expect((await POST(req(), P)).status).toBe(503);
  });

  it('DELETE 400 for a Terraform(env) cluster', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    isEnvCluster.mockReturnValue(true);
    const { DELETE } = await import('./[cluster]/register/route');
    expect((await DELETE(req('DELETE'), P)).status).toBe(400);
  });

  it('DELETE 200 removes a runtime registration', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    isEnvCluster.mockReturnValue(false);
    unregisterCluster.mockResolvedValue(true);
    const { DELETE } = await import('./[cluster]/register/route');
    expect((await DELETE(req('DELETE'), P)).status).toBe(200);
  });
});
```

- [ ] **Step 4: register 라우트 구현** — `web/app/api/eks/[cluster]/register/route.ts`:

```ts
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { registerCluster, unregisterCluster, isEnvCluster } from '@/lib/eks-registry';
import { hasAccessEntry, onboardingGuide } from '@/lib/eks-access';
import { listClusters } from '@/lib/aws';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

const CLUSTER_NAME_RE = /^[0-9A-Za-z][A-Za-z0-9-_]{0,99}$/; // EKS cluster-name charset — also guards the CLI guide against injected text

export async function POST(request: Request, { params }: { params: { cluster: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return json({ status: 'error', message: 'admin only' }, 403);
  if (!CLUSTER_NAME_RE.test(params.cluster)) return json({ status: 'error', message: 'invalid cluster name' }, 400);
  // Cluster must actually exist (spec §3.2 ①) — never emit a guide for arbitrary input.
  const known = (await listClusters()).some((c) => c.name === params.cluster);
  if (!known) return json({ status: 'error', message: 'unknown cluster' }, 404);
  const entry = await hasAccessEntry(params.cluster);
  if (entry !== true) {
    // No entry (or undeterminable) — hand back the v1-style guide instead of failing opaquely.
    return json({ registered: false, access: entry === false ? 'no-entry' : 'unknown', guide: await onboardingGuide(params.cluster) }, 409);
  }
  const ok = await registerCluster(params.cluster, user.sub);
  if (!ok) return json({ status: 'error', message: 'registry storage unavailable' }, 503);
  return json({ registered: true }, 200);
}

export async function DELETE(request: Request, { params }: { params: { cluster: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return json({ status: 'error', message: 'admin only' }, 403);
  if (isEnvCluster(params.cluster)) {
    return json({ status: 'error', message: 'Terraform(onboard_eks_clusters) 관할 — tfvars에서 제거하세요' }, 400);
  }
  const ok = await unregisterCluster(params.cluster);
  return ok ? json({ unregistered: true }, 200) : json({ status: 'error', message: 'not registered' }, 404);
}
```

- [ ] **Step 5: allow-list 교체** — `incluster/route.ts`와 `k8sgpt/route.ts`에서:

```ts
// 교체 전
const allow = (process.env.ONBOARDED_EKS_CLUSTERS || '').split(',').filter(Boolean);
if (!allow.includes(params.cluster)) {
// 교체 후
import { isAllowed } from '@/lib/eks-registry';   // (상단 import)
if (!(await isAllowed(params.cluster))) {
```
(k8sgpt 라우트는 flag 503 가드 **뒤**의 allow-list만 교체 — 가드 순서 불변.)

- [ ] **Step 6: 기존 테스트 갱신** (P2 게이트 codex — 깨질 기존 테스트들):
  - `web/lib/aws.test.ts` — `ClusterInfo` 신규 3필드(region/vpcId/platformVersion)로 기대값 갱신.
  - `web/app/api/eks/route.test.ts` — 신규 모듈(`@/lib/eks-registry`·`@/lib/eks-access`·`@/lib/admin`) 모킹 추가 + 기존 케이스 의미 보존.
  - incluster/k8sgpt 라우트 테스트가 env를 직접 세팅한다면 `@/lib/eks-registry` `isAllowed` 모킹으로 갱신.
- [ ] **Step 7:** `npx vitest run app/api/eks lib/aws.test.ts` 전체 GREEN + `npx vitest run` 회귀. 커밋(8파일).

### Task 5: UI — `/eks` 페이지 재작성 (paper+ink)

**Files:**
- Modify: `web/app/eks/page.tsx`
- Create: `web/app/eks/eks-list.test.tsx`
- Modify: `web/vitest.config.ts`

- [ ] **Step 1:** 먼저 READ: `web/app/inventory/[type]/page.tsx`(페이지 골격·Tailwind 토큰), `web/components/ui/DataTable.tsx`, `web/components/ui/Badge.tsx` — 동일 패턴 사용.
- [ ] **Step 2:** `page.tsx` 재작성 골격(디자인 토큰은 Step 1에서 확인한 실제 클래스 사용):
  - `GET /api/eks` 응답의 **`admin: boolean`**(Task 4에서 추가)으로 등록/해제 버튼 노출 제어(스펙 §4) — 서버 403이 최종 게이트, UI는 admin=true일 때만 버튼 렌더.
  - 컬럼: Name / Status(Badge) / Version / Region / VPC / Platform / 연결(배지+액션)
  - `access==='connected'` → 🟢 Badge + Name이 `/eks/[cluster]` Link
  - `entry-only`·`unknown` → 🟡 Badge + [조회 등록] 버튼 → `POST .../register` → 200이면 리스트 재로드 / 409면 guide 패널 표시 / 403 "관리자 전용" / 503 "저장소 미설정"
  - `no-entry` → ⚪ Badge + [온보딩 가이드] 버튼 → 행 아래 확장 패널: `guide.commands` 코드블럭 2개(각각 복사 버튼 `navigator.clipboard.writeText`) + note. 가이드 데이터는 409 응답 재사용 또는 첫 클릭 시 POST(409 기대)로 획득
  - DB 등록 행(connected & !isEnv — GET 응답에 `runtime: boolean` 추가해 구분, route.ts에서 `runtime: allowed.has(c.name) && !isEnvCluster(c.name)`) → [등록 해제]
- [ ] **Step 4: vitest include 수정** — `web/vitest.config.ts` include에 `'app/**/*.test.tsx'` 추가(현재 app은 `.ts`만 잡힘 — P2 게이트 codex 검증). 그 다음 **테스트** `eks-list.test.tsx` (jsdom 프라그마 1행, fetch 모킹): connected 행 링크 활성 / entry-only 행 등록 버튼 → POST 호출(admin=true 응답일 때만 버튼 렌더) / no-entry 가이드 패널 commands 렌더 — 3케이스.
- [ ] **Step 5:** `npx vitest run app/eks && npx vitest run && npm run build` 전부 GREEN. 커밋.

### Task 6: 운영 — migration v11 + deploy (컨트롤러)

**Files:**
- Modify: `terraform/foundation/data/schema.sql` (적용만 — Task 1에서 커밋됨)

- [ ] **Step 1:** in-VPC psql(마스터 `awsops_admin` + `PGSSLMODE=require`, **사용자 승인 후**) → `schema_migrations`에 11 확인.
- [ ] **Step 2:** `make deploy` → smoke 200.
- [ ] **Step 3:** 브라우저: /eks 리스트 강화 확인 → 미온보딩 클러스터 [조회 등록]→409 가이드 → (가능하면 entry 있는 클러스터로 등록→Connected→상세 진입).
