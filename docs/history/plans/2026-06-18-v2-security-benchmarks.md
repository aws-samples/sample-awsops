# v2 Security Benchmarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port v1's two security features — Security Findings (`/security`) and CIS Compliance benchmark (`/compliance`) — to v2, re-wiring the data path to v2 architecture (Aurora-backed findings derived from `inventory_resources`; Powerpipe run in a Fargate worker with results in Aurora).

**Architecture:** Track A (Findings) derives findings on read in the BFF from already-synced `inventory_resources` JSONB (SG/EBS/IAM), plus one new robust `s3_public_access` inventory sync; a `/security` page renders tabs + charts. Track B (Compliance) adds a `compliance` Fargate job type running Powerpipe against the warm Steampipe FDW, persists run history to two new Aurora tables, and a `/compliance` page runs/polls/renders results.

**Tech Stack:** Next.js 14 thin-BFF (App Router, node-pg, vitest), Aurora PG17 (ULID migrations), Python 3.12 arm64 workers (pg8000, boto3, pytest), Powerpipe + steampipe-mod-aws-compliance, Step Functions, recharts, Tailwind (chrome/paper-ink tokens).

## Global Constraints

- **Root path** — all web fetches use `/api/*` (NO `/awsops` prefix). v2 rule.
- **`export default`** for all page/components; production standalone build.
- **arm64** for any container image change (`buildx --platform linux/arm64`).
- **New Aurora tables** go in `terraform/foundation/migrations/<ULID>_*.sql` — never append to `schema.sql`; the migration file stamps `schema_migrations` itself (do NOT INSERT it); use `CREATE TABLE IF NOT EXISTS` + the existing `touch_updated_at()` trigger guard.
- **SG `description` is immutable** — ingress changes are in-place; never edit a SG `description` (forces replace → ALB hang).
- **ECS task-def `secrets`/valueFrom needs execution-role**; runtime boto3 secret reads use the **task role**. The worker reads the Steampipe secret at runtime (task role), like `sync_lambda`.
- **Fargate worker Dockerfile uses `CMD` (never ENTRYPOINT)** — SFN `containerOverrides.command` replaces CMD.
- **Both features are flag-gated on `steampipe_enabled`** (warm Steampipe FDW). Flag OFF → BFF returns a disabled state; pages show a notice; $0 default.
- **No `-auto-approve` on shared infra** — the controller runs `apply tfplan`. Terraform changes here are authored, not applied, by the implementer.
- **CVE/Trivy is OUT OF SCOPE** (deferred — no Trivy data source in v2).
- Worker job types must stay mirrored: `handlers.py REGISTRY` ⇄ `web/app/api/jobs/route.ts ALLOWED`.
- Test runner: web = `cd web && npx vitest run <path>`; worker = `cd scripts/v2/workers && python -m pytest <path>`.

---

# Phase A — Security Findings (`/security`)

### Task 1: [A1] `security-findings` lib — finding derivation SQL + static metadata

Pure module: the SQL that derives findings from `inventory_resources` and the static severity/remediation metadata. No I/O — unit-testable in isolation. Keep the open-SG cidr regex anchored to the cidr key (IPv4 `0.0.0.0/0` + IPv6 `::/0`, both Steampipe key casings), reusing the pattern already in `inventory/summary/route.ts`.

**Files:**
- Create: `web/lib/security-findings.ts`
- Test: `web/lib/security-findings.test.ts`

**Interfaces:**
- Produces:
  - `type CheckKey = 'public_s3' | 'open_sg' | 'unencrypted_ebs' | 'iam_no_mfa'`
  - `interface Finding { check: CheckKey; resource_id: string; region: string; title: string; severity: 'high'|'medium'|'low'; detail: Record<string,unknown>; remediation: string }`
  - `const CHECK_META: Record<CheckKey, { label: string; severity: Finding['severity']; remediation: string }>`
  - `const FINDING_SQL: Record<CheckKey, string>` — each returns rows `{ resource_id, region, detail }` from `inventory_resources WHERE account_id='self'`.
  - `function rowToFinding(check: CheckKey, row: { resource_id: string; region: string; detail: unknown }): Finding`

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/security-findings.test.ts
import { describe, it, expect } from 'vitest';
import { CHECK_META, FINDING_SQL, rowToFinding } from './security-findings';

describe('security-findings', () => {
  it('has metadata + SQL for all four checks', () => {
    for (const k of ['public_s3', 'open_sg', 'unencrypted_ebs', 'iam_no_mfa'] as const) {
      expect(CHECK_META[k].severity).toMatch(/high|medium|low/);
      expect(CHECK_META[k].remediation.length).toBeGreaterThan(0);
      expect(FINDING_SQL[k]).toContain("account_id='self'");
    }
  });
  it('open_sg SQL anchors cidr to the cidr key (ipv4+ipv6, both casings) and excludes egress', () => {
    const sql = FINDING_SQL.open_sg;
    expect(sql).toContain('security_group');
    expect(sql).toMatch(/cidr_ip|CidrIp/);
    expect(sql).toMatch(/0\\.0\\.0\\.0\/0/);
    expect(sql).toMatch(/::\/0/);
  });
  it('rowToFinding stamps check/severity/remediation and passes detail through', () => {
    const f = rowToFinding('unencrypted_ebs', { resource_id: 'vol-1', region: 'ap-northeast-2', detail: { size: 8 } });
    expect(f).toMatchObject({ check: 'unencrypted_ebs', resource_id: 'vol-1', region: 'ap-northeast-2', severity: 'medium' });
    expect(f.remediation).toBe(CHECK_META.unencrypted_ebs.remediation);
    expect(f.detail).toEqual({ size: 8 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run lib/security-findings.test.ts`
Expected: FAIL (cannot find module './security-findings').

- [ ] **Step 3: Write minimal implementation**

```ts
// web/lib/security-findings.ts
export type CheckKey = 'public_s3' | 'open_sg' | 'unencrypted_ebs' | 'iam_no_mfa';

export interface Finding {
  check: CheckKey;
  resource_id: string;
  region: string;
  title: string;
  severity: 'high' | 'medium' | 'low';
  detail: Record<string, unknown>;
  remediation: string;
}

export const CHECK_META: Record<CheckKey, { label: string; severity: Finding['severity']; remediation: string }> = {
  public_s3: { label: 'Public S3 Buckets', severity: 'high',
    remediation: 'Enable S3 Block Public Access (account + bucket) and remove public bucket policies/ACLs.' },
  open_sg: { label: 'Open Security Groups', severity: 'high',
    remediation: 'Restrict 0.0.0.0/0 (or ::/0) ingress to known CIDRs; front public services with an ALB/CloudFront.' },
  unencrypted_ebs: { label: 'Unencrypted EBS Volumes', severity: 'medium',
    remediation: 'Enable EBS encryption by default; recreate/snapshot-copy volumes with a KMS key.' },
  iam_no_mfa: { label: 'IAM Users without MFA', severity: 'medium',
    remediation: 'Require MFA for all console users; enforce via an IAM policy condition (aws:MultiFactorAuthPresent).' },
};

// Each query returns { resource_id, region, detail } over inventory_resources (account_id='self').
// detail carries the JSONB row for the slide-in panel. Casts to text use jsonb path ops.
export const FINDING_SQL: Record<CheckKey, string> = {
  public_s3: `SELECT resource_id, region, data AS detail
    FROM inventory_resources
    WHERE account_id='self' AND resource_type='s3_public_access'
      AND ( (data->>'bucket_policy_is_public')='true'
         OR (data->>'block_public_acls')='false'
         OR (data->>'block_public_policy')='false' )
    ORDER BY resource_id`,
  open_sg: `SELECT resource_id, region, data AS detail
    FROM inventory_resources
    WHERE account_id='self' AND resource_type='security_group'
      AND (data->'ip_permissions')::text ~ '"(cidr_ip|CidrIp|cidr_ipv6|CidrIpv6)"\\s*:\\s*"(0\\.0\\.0\\.0/0|::/0)"'
    ORDER BY resource_id`,
  unencrypted_ebs: `SELECT resource_id, region, data AS detail
    FROM inventory_resources
    WHERE account_id='self' AND resource_type='ebs_volume'
      AND (data->>'encrypted')='false'
    ORDER BY resource_id`,
  iam_no_mfa: `SELECT resource_id, region, data AS detail
    FROM inventory_resources
    WHERE account_id='self' AND resource_type='iam_user'
      AND (data->>'mfa_enabled')='false'
    ORDER BY resource_id`,
};

export function rowToFinding(check: CheckKey, row: { resource_id: string; region: string; detail: unknown }): Finding {
  const meta = CHECK_META[check];
  return {
    check,
    resource_id: row.resource_id,
    region: row.region,
    title: `${meta.label}: ${row.resource_id}`,
    severity: meta.severity,
    detail: (row.detail && typeof row.detail === 'object' ? row.detail : {}) as Record<string, unknown>,
    remediation: meta.remediation,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run lib/security-findings.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/lib/security-findings.ts web/lib/security-findings.test.ts
git commit -m "feat(security): finding derivation SQL + static metadata lib"
```

---

### Task 2: [A2] `GET /api/security` route

Reads counts + per-check finding lists from Aurora using A1's SQL. Auth-gated. Returns `{ enabled:false }` when no security inventory has been synced (proxy for flag-off / not-yet-synced), else `{ enabled:true, summary, findings }`.

**Files:**
- Create: `web/app/api/security/route.ts`
- Test: `web/app/api/security/route.test.ts`

**Interfaces:**
- Consumes: `verifyUser` (`@/lib/auth`), `getPool` (`@/lib/db`), `FINDING_SQL`/`rowToFinding`/`CheckKey` (`@/lib/security-findings`).
- Produces: `GET(req: Request): Promise<Response>` → `{ enabled: boolean, summary: Record<CheckKey, number>, findings: Record<CheckKey, Finding[]> }`.

- [ ] **Step 1: Write the failing test**

```ts
// web/app/api/security/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/security', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); query.mockReset(); });

describe('GET /api/security', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('enabled:false when no security inventory synced', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValueOnce({ rows: [{ n: 0 }] }); // presence probe → 0
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body.enabled).toBe(false);
  });
  it('200 returns summary + findings per check', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query
      .mockResolvedValueOnce({ rows: [{ n: 4 }] })                                   // presence probe
      .mockResolvedValueOnce({ rows: [{ resource_id: 'b1', region: 'us-east-1', detail: { bucket_policy_is_public: true } }] }) // public_s3
      .mockResolvedValueOnce({ rows: [{ resource_id: 'sg-1', region: 'ap-northeast-2', detail: {} }] }) // open_sg
      .mockResolvedValueOnce({ rows: [] })                                           // unencrypted_ebs
      .mockResolvedValueOnce({ rows: [{ resource_id: 'alice', region: 'global', detail: {} }] }); // iam_no_mfa
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.summary).toEqual({ public_s3: 1, open_sg: 1, unencrypted_ebs: 0, iam_no_mfa: 1 });
    expect(body.findings.public_s3[0]).toMatchObject({ check: 'public_s3', resource_id: 'b1', severity: 'high' });
  });
  it('500 on db error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockRejectedValue(new Error('no db'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run app/api/security/route.test.ts`
Expected: FAIL (no ./route).

- [ ] **Step 3: Write minimal implementation**

```ts
// web/app/api/security/route.ts
import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { FINDING_SQL, rowToFinding, CHECK_META, type CheckKey, type Finding } from '@/lib/security-findings';

export const dynamic = 'force-dynamic';

const CHECKS = Object.keys(CHECK_META) as CheckKey[];

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const pool = getPool();
    // Presence probe: any rows for the security-relevant resource types? If none, the inventory
    // sync hasn't run (or steampipe_enabled is OFF) → report disabled so the page shows a notice.
    const probe = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM inventory_resources
       WHERE account_id='self'
         AND resource_type IN ('s3_public_access','security_group','ebs_volume','iam_user')`,
    );
    if (Number(probe.rows[0]?.n ?? 0) === 0) {
      return Response.json({ enabled: false, summary: {}, findings: {} });
    }
    const summary = {} as Record<CheckKey, number>;
    const findings = {} as Record<CheckKey, Finding[]>;
    for (const check of CHECKS) {
      const r = await pool.query<{ resource_id: string; region: string; detail: unknown }>(FINDING_SQL[check]);
      findings[check] = r.rows.map((row) => rowToFinding(check, row));
      summary[check] = findings[check].length;
    }
    return Response.json({ enabled: true, summary, findings });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run app/api/security/route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/app/api/security/route.ts web/app/api/security/route.test.ts
git commit -m "feat(security): GET /api/security findings route"
```

---

### Task 3: [A3] `POST /api/security/refresh` route

Invokes the inventory sync Lambda for the security-relevant types so the page can force a refresh. Mirrors the existing inventory `/refresh` (the web task role already has `lambda:InvokeFunction` on the sync Lambda via `task_inv_sync_invoke`).

**Files:**
- Create: `web/app/api/security/refresh/route.ts`
- Test: `web/app/api/security/refresh/route.test.ts`

**Interfaces:**
- Consumes: `verifyUser`; `@aws-sdk/client-lambda` `LambdaClient`/`InvokeCommand`; `process.env.INVENTORY_SYNC_FUNCTION` (the same env the inventory refresh route uses — verify its exact name in `web/app/api/inventory/**/route.ts` and reuse it verbatim).
- Produces: `POST(req: Request): Promise<Response>` → `202 { status:'refreshing', types:[...] }`, `401`, `503` (unconfigured).

- [ ] **Step 1: Write the failing test**

```ts
// web/app/api/security/refresh/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const send = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = (...a: unknown[]) => send(...a); },
  InvokeCommand: class { constructor(public input: unknown) {} },
}));
const req = () => new Request('http://x/api/security/refresh', { method: 'POST', headers: { cookie: 'awsops_token=t' } });
beforeEach(() => { verifyUser.mockReset(); send.mockReset(); delete process.env.INVENTORY_SYNC_FUNCTION; });

describe('POST /api/security/refresh', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req())).status).toBe(401);
  });
  it('503 when sync function unconfigured', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { POST } = await import('./route');
    expect((await POST(req())).status).toBe(503);
  });
  it('202 invokes sync for each security type', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    process.env.INVENTORY_SYNC_FUNCTION = 'awsops-v2-inv-sync';
    send.mockResolvedValue({});
    const { POST } = await import('./route');
    const res = await POST(req());
    expect(res.status).toBe(202);
    expect(send).toHaveBeenCalledTimes(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run app/api/security/refresh/route.test.ts`
Expected: FAIL (no ./route).

- [ ] **Step 3: Write minimal implementation**

```ts
// web/app/api/security/refresh/route.ts
import { verifyUser } from '@/lib/auth';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export const dynamic = 'force-dynamic';

const TYPES = ['s3_public_access', 'security_group', 'ebs_volume', 'iam_user'] as const;
let client: LambdaClient | null = null;

export async function POST(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const fn = process.env.INVENTORY_SYNC_FUNCTION;
  if (!fn) return Response.json({ status: 'unconfigured', message: 'inventory sync disabled' }, { status: 503 });
  if (!client) client = new LambdaClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  await Promise.all(
    TYPES.map((t) =>
      client!.send(new InvokeCommand({
        FunctionName: fn,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ type: t })),
      })),
    ),
  );
  return Response.json({ status: 'refreshing', types: TYPES }, { status: 202 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run app/api/security/refresh/route.test.ts`
Expected: PASS (3 tests).

> **Implementer note:** before committing, grep `web/app/api/inventory` for the actual inventory-refresh env var name and Lambda invoke pattern; if it differs from `INVENTORY_SYNC_FUNCTION`, use the real name in both the route and the test, and confirm the web task role's `lambda:InvokeFunction` covers it (it should, via `task_inv_sync_invoke`).

- [ ] **Step 5: Commit**

```bash
git add web/app/api/security/refresh/route.ts web/app/api/security/refresh/route.test.ts
git commit -m "feat(security): POST /api/security/refresh re-sync route"
```

---

### Task 4: [A4] `s3_public_access` inventory sync (SDK, denial-safe) + IAM

Add a denial-safe SDK sync producing per-bucket public-access flags. Must NOT touch the existing `s3` sync (the public-access calls can be denied per-bucket and would fail the whole `aws_s3_bucket` query — that's why `s3` omits them).

**Files:**
- Modify: `scripts/v2/steampipe/sync_lambda.py` (add `s3_public_access` to `SDK_SYNCS`)
- Modify: `terraform/foundation/steampipe.tf` (sync Lambda role: add `s3:ListAllMyBuckets`, `s3:GetBucketPolicyStatus`, `s3:GetBucketPublicAccessBlock`)
- Modify: `web/lib/inventory-types.ts` (register `s3_public_access` under `group:'Security'`)
- Test: `scripts/v2/workers/test_s3_public_access.py` (or alongside steampipe tests if a test dir exists there — place next to existing sync tests; if none, create `scripts/v2/steampipe/test_sync_s3_public.py`)

**Interfaces:**
- Consumes: the `SDK_SYNCS` contract in `sync_lambda.py` — verify the exact shape (a callable returning a list of `(region, resource_id, data_dict)` or similar) by reading the existing `cloudfront_vpc_origin`/`alb_listener_rule` entries, and match it exactly.
- Produces: `s3_public_access` rows in `inventory_resources` with `data` keys: `bucket_policy_is_public`, `block_public_acls`, `block_public_policy`, `restrict_public_buckets`, `ignore_public_acls`.

- [ ] **Step 1: Read the existing SDK_SYNCS contract**

Run: `grep -n "SDK_SYNCS\|def _sync_\|cloudfront_vpc_origin\|alb_listener_rule" scripts/v2/steampipe/sync_lambda.py`
Read those functions so the new producer matches the exact return shape and how `sync()` consumes it.

- [ ] **Step 2: Write the failing test**

```python
# scripts/v2/steampipe/test_sync_s3_public.py  (adjust import to the module's location)
import types
import sync_lambda  # ensure PYTHONPATH includes scripts/v2/steampipe

class FakeS3:
    def __init__(self, buckets, denied=()):
        self._buckets = buckets
        self._denied = set(denied)
    def list_buckets(self):
        return {"Buckets": [{"Name": b} for b in self._buckets]}
    def get_bucket_location(self, Bucket):
        return {"LocationConstraint": "ap-northeast-2"}
    def get_public_access_block(self, Bucket):
        if Bucket in self._denied:
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetPublicAccessBlock")
        return {"PublicAccessBlockConfiguration": {
            "BlockPublicAcls": True, "BlockPublicPolicy": True,
            "RestrictPublicBuckets": True, "IgnorePublicAcls": True}}
    def get_bucket_policy_status(self, Bucket):
        if Bucket in self._denied:
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetBucketPolicyStatus")
        return {"PolicyStatus": {"IsPublic": Bucket == "pub"}}

def test_s3_public_access_one_denied_bucket_does_not_fail_sync(monkeypatch):
    fake = FakeS3(buckets=["pub", "priv", "locked"], denied=["locked"])
    rows = sync_lambda.sync_s3_public_access(fake)  # name the producer accordingly
    by_id = {r[1]: r[2] for r in rows}              # (region, resource_id, data)
    assert by_id["pub"]["bucket_policy_is_public"] is True
    assert by_id["priv"]["bucket_policy_is_public"] is False
    # denied bucket still emitted, flags marked unknown (None), sync did not raise
    assert "locked" in by_id
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd scripts/v2/steampipe && PYTHONPATH=. python -m pytest test_sync_s3_public.py -v`
Expected: FAIL (`sync_lambda` has no `sync_s3_public_access`).

- [ ] **Step 4: Implement the producer + register it**

Implement `sync_s3_public_access(s3_client=None)` that lists buckets, resolves each bucket region, and per bucket calls `get_public_access_block` + `get_bucket_policy_status`, catching `ClientError` (AccessDenied / NoSuchPublicAccessBlock / etc.) per bucket → emit the row with `None` for the unknown flags rather than failing. Register `"s3_public_access": sync_s3_public_access` in `SDK_SYNCS` (matching the existing entries' exact contract). Data keys exactly: `bucket_policy_is_public`, `block_public_acls`, `block_public_policy`, `restrict_public_buckets`, `ignore_public_acls`.

(Show the real implementation matching the SDK_SYNCS shape discovered in Step 1 — do not leave a stub.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd scripts/v2/steampipe && PYTHONPATH=. python -m pytest test_sync_s3_public.py -v`
Expected: PASS.

- [ ] **Step 6: Register inventory type + IAM**

- `web/lib/inventory-types.ts`: add `s3_public_access: { label: 'S3 Public Access', group: 'Security', columns: [{key:'bucket_policy_is_public',label:'Policy public'},{key:'block_public_acls',label:'Block ACLs'},{key:'block_public_policy',label:'Block policy'}] }`.
- `terraform/foundation/steampipe.tf`: add `s3:ListAllMyBuckets`, `s3:GetBucketPolicyStatus`, `s3:GetBucketPublicAccessBlock`, `s3:GetBucketLocation` (read-only) to the sync Lambda role policy (find the existing inline policy granting the sync Lambda its describe/list actions and extend its `Action` list; `Resource="*"` consistent with the existing list actions).

- [ ] **Step 7: Commit**

```bash
git add scripts/v2/steampipe/sync_lambda.py scripts/v2/steampipe/test_sync_s3_public.py \
        terraform/foundation/steampipe.tf web/lib/inventory-types.ts
git commit -m "feat(security): denial-safe s3_public_access inventory sync + IAM"
```

---

### Task 5: [A5] `/security` page + nav wiring

Port the v1 `/security` UI to v2 conventions: tabbed table (Public S3 / IAM MFA / Open SG / Unencrypted EBS), StatsCards, severity distribution chart (theme-reactive), per-row detail slide-in with remediation, Refresh button, flag-off notice.

**Files:**
- Create: `web/app/security/page.tsx`
- Modify: `web/components/shell/Sidebar.tsx` (FIXED += Security), `web/lib/i18n.ts` (`nav.security` KO+EN), `web/components/shell/MobileNav.tsx`, `web/components/shell/BottomTabBar.tsx`, `web/lib/mobile-tabs.ts`, `web/components/shell/CommandPalette.tsx` (only the ones that enumerate fixed pages — match how `/datasources` is wired)
- Test: `web/app/security/page.test.tsx`

**Interfaces:**
- Consumes: `GET /api/security`, `POST /api/security/refresh`; reuse existing v2 components (StatsCard, DataTable/table, detail panel/sheet, `useChartColors`) by reading `web/app/inventory/[type]/page.tsx` and other pages for the exact component names/props. Match patterns; do not invent new component APIs.

- [ ] **Step 1: Study the patterns**

Read `web/app/inventory/[type]/page.tsx`, `web/app/datasources/page.tsx`, and one chart-using page to copy: the StatsCard component + `color` prop convention, the table + detail-panel components, `useChartColors`, and the i18n hook usage.

- [ ] **Step 2: Write the failing test**

```tsx
// web/app/security/page.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SecurityPage from './page';

beforeEach(() => { vi.restoreAllMocks(); });

function mockFetch(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: async () => body }));
}

describe('SecurityPage', () => {
  it('renders the disabled notice when enabled:false', async () => {
    mockFetch({ enabled: false, summary: {}, findings: {} });
    render(<SecurityPage />);
    await waitFor(() => expect(screen.getByText(/steampipe|inventory|disabled/i)).toBeTruthy());
  });
  it('renders finding counts when enabled', async () => {
    mockFetch({ enabled: true,
      summary: { public_s3: 2, open_sg: 1, unencrypted_ebs: 0, iam_no_mfa: 3 },
      findings: { public_s3: [], open_sg: [], unencrypted_ebs: [], iam_no_mfa: [] } });
    render(<SecurityPage />);
    await waitFor(() => expect(screen.getByText('Public S3 Buckets')).toBeTruthy());
  });
});
```

(Match the test setup of the closest existing `page.test.tsx`; if none render pages in tests, write a lighter smoke test consistent with the repo — check whether `web` has any `page.test.tsx` first and mirror it.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npx vitest run app/security/page.test.tsx`
Expected: FAIL (no ./page).

- [ ] **Step 4: Implement the page (`'use client'`, `export default`)**

Build the page using the studied components: fetch `/api/security` on mount; if `!enabled` render the notice card; else render StatsCards (one per check, count + severity color), a severity-distribution chart (theme-reactive), and a tabbed table with a detail slide-in per row showing `detail` + `remediation`. A Refresh button POSTs `/api/security/refresh` then re-fetches. Root-path fetches. Show the full implementation (no placeholders), matching v2 component props discovered in Step 1.

- [ ] **Step 5: Wire navigation**

- `Sidebar.tsx`: add `{ href: '/security', tkey: 'nav.security', icon: Shield }` to `FIXED` (import `Shield` already present). (Place it logically, e.g. after `/topology`.)
- `i18n.ts`: add `'nav.security': '보안'` (KO) and `'nav.security': 'Security'` (EN).
- Mirror into `MobileNav.tsx` / `BottomTabBar.tsx` / `mobile-tabs.ts` / `CommandPalette.tsx` exactly as `/datasources` (or another fixed page) is wired there. (Only those that enumerate pages; some may auto-derive from `FIXED`.)

- [ ] **Step 6: Run tests + typecheck**

Run: `cd web && npx vitest run app/security/ && npx tsc --noEmit`
Expected: page tests PASS; no new type errors. (Note: `next build` can fail on pre-existing app type issues; `*.test.ts` type noise is non-blocking — see project memory. Use `tsc --noEmit` scoped sanity + vitest as the gate.)

- [ ] **Step 7: Commit**

```bash
git add web/app/security/ web/components/shell/Sidebar.tsx web/lib/i18n.ts \
        web/components/shell/MobileNav.tsx web/components/shell/BottomTabBar.tsx \
        web/lib/mobile-tabs.ts web/components/shell/CommandPalette.tsx
git commit -m "feat(security): /security findings page + nav wiring"
```

---

# Phase B — CIS Compliance benchmark (`/compliance`)

### Task 6: [B1] Aurora migration — `compliance_runs` + `compliance_results`

**Files:**
- Create: `terraform/foundation/migrations/<NEW_ULID>_compliance.sql`

- [ ] **Step 1: Generate a ULID**

Run: `python3 -c "import time,os,base64; \
ts=int(1750000000*1000); \
print('generate a Crockford-base32 ULID')"`
Practical approach: copy the format of an existing migration filename and generate a fresh 26-char Crockford ULID (use `npx ulid` if available, or any ULID generator). The filename MUST sort AFTER existing migrations. Verify: `ls terraform/foundation/migrations/` and pick a ULID greater than the latest.

- [ ] **Step 2: Write the migration**

```sql
-- since: 2.x.0
-- compliance_runs / compliance_results — CIS benchmark (Powerpipe via Fargate worker) run history.
-- NOTE: stamps schema_migrations itself — do NOT INSERT here.
CREATE TABLE IF NOT EXISTS compliance_runs (
  id             BIGSERIAL PRIMARY KEY,
  worker_job_id  UUID REFERENCES worker_jobs(job_id),
  benchmark      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  requested_by   TEXT NOT NULL,
  pass_rate      NUMERIC,
  total_controls INT, ok INT, alarm INT, info INT, skip INT, error INT,
  error          TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS compliance_results (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES compliance_runs(id) ON DELETE CASCADE,
  control_id TEXT NOT NULL,
  title      TEXT,
  section    TEXT,
  status     TEXT NOT NULL,
  reason     TEXT,
  resource   TEXT,
  region     TEXT,
  severity   TEXT
);
CREATE INDEX IF NOT EXISTS idx_compliance_results_run ON compliance_results(run_id);
CREATE INDEX IF NOT EXISTS idx_compliance_runs_created ON compliance_runs(created_at DESC);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_compliance_runs_touch') THEN
    CREATE TRIGGER trg_compliance_runs_touch BEFORE UPDATE ON compliance_runs
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;
```

(Copy the exact header/trigger-guard idiom from `migrations/01KTVGKN1Q3JQ3EN46PPD708W0_diagnosis_reports.sql`.)

- [ ] **Step 3: Verify it parses against a local PG (if available)**

Run: `cat terraform/foundation/migrations/<NEW_ULID>_compliance.sql` and eyeball; if a local PG17 container is handy, apply it to a scratch DB. Otherwise rely on the migrate step at deploy.

- [ ] **Step 4: Commit**

```bash
git add terraform/foundation/migrations/*_compliance.sql
git commit -m "feat(compliance): compliance_runs + compliance_results migration"
```

---

### Task 7: [B2] worker `_compliance` handler + DB helpers + REGISTRY

Add the Powerpipe-running handler and its Aurora persistence, and register the job type. Mirror the `_report` handler's connection discipline (always `conn.close()` in `finally`; on failure write `status='failed'` + re-raise).

**Files:**
- Modify: `scripts/v2/workers/handlers.py` (`_compliance` + REGISTRY entry)
- Create: `scripts/v2/workers/compliance.py` (Powerpipe invocation + JSON parsing + Aurora writes)
- Test: `scripts/v2/workers/test_compliance.py`

**Interfaces:**
- Consumes: `db.connect()` (pg8000), `os.environ['STEAMPIPE_HOST']`, `os.environ['STEAMPIPE_SECRET_ARN']`.
- Produces:
  - `compliance.parse_powerpipe_json(doc: dict) -> tuple[dict, list[dict]]` → `(totals, controls)` where `totals` has `total_controls,ok,alarm,info,skip,error,pass_rate` and each control has `control_id,title,section,status,reason,resource,region,severity`.
  - `compliance.run_powerpipe(benchmark: str, db_url: str) -> dict` (subprocess; returns parsed JSON; treats exit 2 + valid JSON as success).
  - `_compliance(payload, dry_run)` in handlers, registered as `"compliance": (_compliance, "fargate")`.

- [ ] **Step 1: Write the failing test (JSON parsing — pure, no subprocess)**

```python
# scripts/v2/workers/test_compliance.py
import compliance

SAMPLE = {
  "groups": [
    {"title": "1 IAM", "summary": {"control": {"total": 2, "ok": 1, "alarm": 1, "info": 0, "skip": 0, "error": 0}},
     "controls": [
        {"control_id": "1.1", "title": "MFA", "results": [
            {"status": "ok", "reason": "ok", "resource": "arn:user/a", "dimensions": [{"key": "region", "value": "us-east-1"}]},
            {"status": "alarm", "reason": "no mfa", "resource": "arn:user/b", "dimensions": [{"key": "region", "value": "us-east-1"}]}]}]}
  ]
}

def test_parse_totals_and_controls():
    totals, controls = compliance.parse_powerpipe_json(SAMPLE)
    assert totals["total_controls"] == 2 and totals["ok"] == 1 and totals["alarm"] == 1
    # pass_rate = ok / (ok+alarm+info+skip+error) * 100
    assert round(totals["pass_rate"], 1) == 50.0
    statuses = sorted(c["status"] for c in controls)
    assert statuses == ["alarm", "ok"]
    assert any(c["region"] == "us-east-1" for c in controls)

def test_parse_empty_is_zero_not_crash():
    totals, controls = compliance.parse_powerpipe_json({"groups": []})
    assert totals["total_controls"] == 0 and totals["pass_rate"] == 0
    assert controls == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/v2/workers && python -m pytest test_compliance.py -v`
Expected: FAIL (no `compliance` module).

- [ ] **Step 3: Implement `compliance.py`**

```python
# scripts/v2/workers/compliance.py
"""CIS benchmark via Powerpipe against the warm Steampipe FDW. Parsing is pure (unit-tested);
run_powerpipe shells out; persistence writes compliance_runs/_results in Aurora."""
import json
import os
import subprocess

MOD_DIR = os.environ.get("POWERPIPE_MOD_DIR", "/app/powerpipe")  # baked at image build (Task B3)
ALLOWED = {"cis_v150", "cis_v200", "cis_v300", "cis_v400"}


def _walk_controls(node, section, out):
    title = node.get("title", section)
    for c in node.get("controls", []) or []:
        for r in c.get("results", []) or []:
            dims = {d.get("key"): d.get("value") for d in (r.get("dimensions") or [])}
            out.append({
                "control_id": c.get("control_id") or c.get("name", ""),
                "title": c.get("title", ""),
                "section": title,
                "status": r.get("status", ""),
                "reason": r.get("reason", ""),
                "resource": r.get("resource", ""),
                "region": dims.get("region", ""),
                "severity": (c.get("tags") or {}).get("severity", ""),
            })
    for g in node.get("groups", []) or []:
        _walk_controls(g, g.get("title", section), out)


def parse_powerpipe_json(doc):
    controls = []
    for g in doc.get("groups", []) or []:
        _walk_controls(g, g.get("title", ""), controls)
    agg = {"ok": 0, "alarm": 0, "info": 0, "skip": 0, "error": 0}
    # Prefer leaf-result counts (authoritative); fall back to summary if present.
    for c in controls:
        if c["status"] in agg:
            agg[c["status"]] += 1
    total = sum(agg.values())
    denom = total
    pass_rate = (agg["ok"] / denom * 100) if denom else 0
    totals = {"total_controls": total, **agg, "pass_rate": pass_rate}
    return totals, controls


def run_powerpipe(benchmark, db_url):
    if benchmark not in ALLOWED:
        raise ValueError(f"benchmark not allowed: {benchmark!r}")
    cmd = ["powerpipe", "benchmark", "run", f"aws_compliance.benchmark.{benchmark}",
           "--mod-location", MOD_DIR, "--output", "json", "--progress=false"]
    proc = subprocess.run(cmd, capture_output=True, text=True,
                          env={**os.environ, "POWERPIPE_DATABASE": db_url})
    out = proc.stdout.strip()
    if not out:
        raise RuntimeError(f"powerpipe produced no output (exit {proc.returncode}): {proc.stderr[:2000]}")
    return json.loads(out)  # exit 2 (alarms present) is expected; valid JSON ⇒ success


def steampipe_db_url():
    import boto3
    host = os.environ["STEAMPIPE_HOST"]
    sm = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    pw = sm.get_secret_value(SecretId=os.environ["STEAMPIPE_SECRET_ARN"])["SecretString"].strip()
    return f"postgres://steampipe:{pw}@{host}:9193/steampipe?sslmode=require"


def persist(conn, run_id, totals, controls):
    conn.run("UPDATE compliance_runs SET status='succeeded', finished_at=now(), "
             "pass_rate=:pr, total_controls=:t, ok=:ok, alarm=:al, info=:inf, skip=:sk, error=:er "
             "WHERE id=:id",
             pr=totals["pass_rate"], t=totals["total_controls"], ok=totals["ok"], al=totals["alarm"],
             inf=totals["info"], sk=totals["skip"], er=totals["error"], id=run_id)
    for c in controls:
        conn.run("INSERT INTO compliance_results (run_id, control_id, title, section, status, reason, resource, region, severity) "
                 "VALUES (:r,:cid,:ti,:se,:st,:re,:res,:reg,:sev)",
                 r=run_id, cid=c["control_id"], ti=c["title"], se=c["section"], st=c["status"],
                 re=c["reason"], res=c["resource"], reg=c["region"], sev=c["severity"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/v2/workers && python -m pytest test_compliance.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Add `_compliance` handler + REGISTRY (with a dry_run + failure test)**

Append to `test_compliance.py`:

```python
import handlers

def test_compliance_handler_dry_run():
    out, art = handlers._compliance({"benchmark": "cis_v300", "run_id": 1}, True)
    assert out["dry_run"] is True and out["would_run"] == "cis_v300"
    assert art is None

def test_compliance_registered_as_fargate():
    assert handlers.REGISTRY["compliance"][1] == "fargate"
```

Implement in `handlers.py`:

```python
def _compliance(payload, dry_run):
    """CIS benchmark via Powerpipe (Fargate). payload: {benchmark, run_id, requested_by}.
    The BFF pre-creates the compliance_runs row (run_id) — same pattern as _report."""
    import compliance
    benchmark = str(payload.get("benchmark", ""))
    run_id = payload.get("run_id")
    if dry_run:
        return {"dry_run": True, "would_run": benchmark}, None
    if benchmark not in compliance.ALLOWED:
        raise ValueError(f"benchmark not allowed: {benchmark!r}")
    import db as wdb
    conn = wdb.connect()
    try:
        try:
            doc = compliance.run_powerpipe(benchmark, compliance.steampipe_db_url())
            totals, controls = compliance.parse_powerpipe_json(doc)
            compliance.persist(conn, run_id, totals, controls)
            return {"run_id": run_id, "benchmark": benchmark, **totals}, None
        except Exception as e:  # noqa: BLE001
            if run_id is not None:
                conn.run("UPDATE compliance_runs SET status='failed', finished_at=now(), error=:e WHERE id=:id",
                         e=str(e)[:2000], id=run_id)
            raise
    finally:
        conn.close()
```

Add to REGISTRY: `"compliance": (_compliance, "fargate"),`

- [ ] **Step 6: Run tests**

Run: `cd scripts/v2/workers && python -m pytest test_compliance.py -v`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add scripts/v2/workers/compliance.py scripts/v2/workers/handlers.py scripts/v2/workers/test_compliance.py
git commit -m "feat(compliance): _compliance Fargate handler + Powerpipe parse/persist"
```

---

### Task 8: [B3] worker image — bake Powerpipe + aws_compliance mod

**Files:**
- Modify: `scripts/v2/workers/Dockerfile`
- Modify: `scripts/v2/workers.mjs` (if a build-context `cp` is needed for `compliance.py` — it lives in the context dir already, so likely just ensure it's COPY'd)

- [ ] **Step 1: Add Powerpipe + mod install to the Dockerfile**

After the existing apt/playwright block, before/after the COPY of worker modules, add (arm64-aware):

```dockerfile
# CIS compliance (Task B): Powerpipe runs the aws_compliance benchmark against the warm Steampipe FDW.
# Bake the binary + mod at build time so there is no GitHub egress at run time. arm64.
ARG POWERPIPE_VERSION=0.5.1
RUN apt-get update && apt-get install -y --no-install-recommends curl tar git \
    && curl -fsSL -o /tmp/pp.tar.gz \
       "https://github.com/turbot/powerpipe/releases/download/v${POWERPIPE_VERSION}/powerpipe.linux.arm64.tar.gz" \
    && tar -xzf /tmp/pp.tar.gz -C /usr/local/bin powerpipe \
    && rm /tmp/pp.tar.gz \
    && mkdir -p /app/powerpipe \
    && cd /app/powerpipe \
    && powerpipe mod install github.com/turbot/steampipe-mod-aws-compliance \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
ENV POWERPIPE_MOD_DIR=/app/powerpipe
COPY compliance.py ./
```

> **Implementer note:** verify the exact Powerpipe arm64 release asset name + URL on the turbot/powerpipe releases page and pin `POWERPIPE_VERSION` to a real tag. If `powerpipe mod install` needs a git identity or fails at build, fall back to `git clone --depth 1 https://github.com/turbot/steampipe-mod-aws-compliance` into `/app/powerpipe/.powerpipe/mods/...` per Powerpipe's mod layout. Keep the image arm64 and CMD unchanged.

- [ ] **Step 2: Build the image locally (arm64) to verify it assembles**

Run: `cd scripts/v2/workers && docker buildx build --platform linux/arm64 -t awsops-worker-test --load .`
Expected: build succeeds; `docker run --rm awsops-worker-test powerpipe --version` prints a version.

(If docker/buildx is unavailable in this environment, document the manual verification and proceed — the controller builds/pushes via `make workers`.)

- [ ] **Step 3: Commit**

```bash
git add scripts/v2/workers/Dockerfile scripts/v2/workers.mjs
git commit -m "feat(compliance): bake Powerpipe + aws_compliance mod into worker image (arm64)"
```

---

### Task 9: [B4] Terraform — worker Steampipe reachability + env + secret read

**Files:**
- Modify: `terraform/foundation/steampipe.tf` (Steampipe SG :9193 ingress from the worker task SG)
- Modify: `terraform/foundation/workers.tf` (worker task env `STEAMPIPE_HOST`/`STEAMPIPE_SECRET_ARN` + task-role `secretsmanager:GetSecretValue` on the Steampipe secret)

- [ ] **Step 1: Identify the worker task SG and the Steampipe ingress block**

Run: `grep -n "security_group\|vpc_config\|network_configuration\|securityGroups\|ingress\|9193" terraform/foundation/workers.tf terraform/foundation/steampipe.tf`
Determine which SG the Fargate worker task uses (worker task SG) and locate the Steampipe `:9193` ingress rule.

- [ ] **Step 2: Add worker SG to Steampipe :9193 ingress (in-place; keep description verbatim)**

Extend the existing Steampipe SG ingress (the one allowing the web/lambda service SG on 9193) to also allow the worker task SG. Do NOT change the SG `description`. Prefer a separate `aws_vpc_security_group_ingress_rule` referencing the worker SG, or add the worker SG to the existing `security_groups`/`referenced_security_group_id` list — whichever matches the file's existing style — gated by the same `count`/`local.sp` as the rest of Steampipe.

- [ ] **Step 3: Add worker task env + secret-read IAM**

In `workers.tf` Fargate worker `container_definitions.environment`, add:
```hcl
{ name = "STEAMPIPE_HOST", value = "steampipe.${var.project}.internal" },
{ name = "STEAMPIPE_SECRET_ARN", value = aws_secretsmanager_secret.steampipe[0].arn },
```
(Reference the Steampipe secret only when `steampipe_enabled` — guard with `try(...)`/conditional so a workers-on / steampipe-off plan still validates; match how other optional refs are guarded in the file.) Add to the worker **task role** an inline policy statement allowing `secretsmanager:GetSecretValue` on `aws_secretsmanager_secret.steampipe[0].arn` (the worker reads it via boto3 at runtime — task role, not execution role).

- [ ] **Step 4: Validate the plan compiles**

Run: `terraform -chdir=terraform/foundation validate`
Expected: `Success! The configuration is valid.` (Do NOT apply — the controller runs `apply tfplan`.)

- [ ] **Step 5: Commit**

```bash
git add terraform/foundation/steampipe.tf terraform/foundation/workers.tf
git commit -m "feat(compliance): worker reaches Steampipe :9193 + steampipe secret env/IAM"
```

---

### Task 10: [B5] compliance BFF routes (`run`, `runs`, `runs/[id]`, `benchmarks`)

**Files:**
- Create: `web/app/api/compliance/run/route.ts`, `web/app/api/compliance/runs/route.ts`, `web/app/api/compliance/runs/[id]/route.ts`, `web/app/api/compliance/benchmarks/route.ts`
- Modify: `web/app/api/jobs/route.ts` (`ALLOWED` += `'compliance'`)
- Test: `web/app/api/compliance/run/route.test.ts`, `web/app/api/compliance/runs/route.test.ts`

**Interfaces:**
- Consumes: `verifyUser`, `getPool`, `enqueueJob` (`@/lib/jobs`).
- Produces: `POST /api/compliance/run {benchmark}` → `{ run_id, job_id }`; `GET /api/compliance/runs` → `{ runs: [...] }`; `GET /api/compliance/runs/[id]` → `{ run, results }`; `GET /api/compliance/benchmarks` → `{ benchmarks: [...] }`.

- [ ] **Step 1: Write the failing test for `run`**

```ts
// web/app/api/compliance/run/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const query = vi.fn();
const enqueueJob = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
vi.mock('@/lib/jobs', () => ({ enqueueJob: (...a: unknown[]) => enqueueJob(...a), EnqueueDeliveryError: class extends Error {} }));
const req = (body: unknown) => new Request('http://x/api/compliance/run', {
  method: 'POST', headers: { cookie: 'awsops_token=t', 'content-type': 'application/json' }, body: JSON.stringify(body),
});
beforeEach(() => { verifyUser.mockReset(); query.mockReset(); enqueueJob.mockReset(); });

describe('POST /api/compliance/run', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({ benchmark: 'cis_v300' }))).status).toBe(401);
  });
  it('400 on disallowed benchmark', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'a@b' });
    const { POST } = await import('./route');
    expect((await POST(req({ benchmark: 'evil; rm -rf' }))).status).toBe(400);
  });
  it('202 pre-creates run row then enqueues', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'a@b' });
    query.mockResolvedValueOnce({ rows: [{ id: 42 }] }); // INSERT ... RETURNING id
    enqueueJob.mockResolvedValue({ job_id: 'j1', status: 'queued' });
    const { POST } = await import('./route');
    const res = await POST(req({ benchmark: 'cis_v300' }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ run_id: 42, job_id: 'j1' });
    expect(enqueueJob).toHaveBeenCalledWith('compliance', expect.objectContaining({ benchmark: 'cis_v300', run_id: 42 }), expect.anything());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run app/api/compliance/run/route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the four routes + ALLOWED += compliance**

`run/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { enqueueJob, EnqueueDeliveryError } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
const ALLOWED = new Set(['cis_v150', 'cis_v200', 'cis_v300', 'cis_v400']);

export async function POST(req: NextRequest) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  if (!process.env.JOBS_QUEUE_URL) return NextResponse.json({ status: 'unconfigured' }, { status: 503 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ message: 'invalid JSON' }, { status: 400 }); }
  const benchmark = body?.benchmark;
  if (typeof benchmark !== 'string' || !ALLOWED.has(benchmark)) {
    return NextResponse.json({ message: `unknown benchmark; allowed: ${[...ALLOWED].join(', ')}` }, { status: 400 });
  }
  const requestedBy = (user as any).email || (user as any).sub || 'unknown';
  const ins = await getPool().query(
    `INSERT INTO compliance_runs (benchmark, status, requested_by) VALUES ($1,'running',$2) RETURNING id`,
    [benchmark, requestedBy],
  );
  const runId = ins.rows[0].id;
  try {
    const { job_id } = await enqueueJob('compliance', { benchmark, run_id: runId, requested_by: requestedBy }, {});
    return NextResponse.json({ run_id: runId, job_id }, { status: 202 });
  } catch (e) {
    if (e instanceof EnqueueDeliveryError) return NextResponse.json({ run_id: runId, job_id: e.job_id, enqueue: 'failed' }, { status: 202 });
    return NextResponse.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
```

`runs/route.ts` (GET list), `runs/[id]/route.ts` (GET run + results grouped by section), `benchmarks/route.ts` (static list mirroring v1 `action=list`) — all auth-gated, `getPool`, `dynamic='force-dynamic'`. Implement fully (no stubs); follow `web/app/api/jobs/route.ts` GET for the query+shape idiom and the `[id]` param signature used elsewhere in the repo (check `web/app/api/jobs/[id]/route.ts`).

`jobs/route.ts`: change `const ALLOWED = new Set(['noop', 'noop-heavy', 'report']);` → add `'compliance'`.

- [ ] **Step 4: Write + run a `runs` GET test, then run all compliance route tests**

Run: `cd web && npx vitest run app/api/compliance/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/compliance/ web/app/api/jobs/route.ts
git commit -m "feat(compliance): run/runs/runs[id]/benchmarks BFF routes + jobs ALLOWED"
```

---

### Task 11: [B6] `/compliance` page + nav wiring

Port v1 `/compliance` UI to v2: benchmark selector + Run button → `POST /api/compliance/run`; poll `GET /api/compliance/runs/[id]` every 5s while `running`; render pass-rate StatsCards, status pie, alarms-by-section bar, section cards with pass% bars, control detail slide-in. Color thresholds green≥80/orange≥50/red.

**Files:**
- Create: `web/app/compliance/page.tsx`
- Modify: `web/components/shell/Sidebar.tsx` (FIXED += Compliance, icon `FileSearch` or `ShieldCheck`), `web/lib/i18n.ts` (`nav.compliance`), mobile/command-palette enumerations (as A5)
- Test: `web/app/compliance/page.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// web/app/compliance/page.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import CompliancePage from './page';
beforeEach(() => { vi.restoreAllMocks(); });

describe('CompliancePage', () => {
  it('renders the benchmark selector + run button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ runs: [] }) }));
    render(<CompliancePage />);
    await waitFor(() => expect(screen.getByText(/run|benchmark|CIS/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run app/compliance/page.test.tsx`
Expected: FAIL (no ./page).

- [ ] **Step 3: Implement the page**

`'use client'`, `export default`. Benchmark `<select>` (CIS v3.0.0 default), Run button → `POST /api/compliance/run` → capture `run_id` → poll `GET /api/compliance/runs/${run_id}` every 5s until status !== 'running'. Compute pass% per section client-side. Render with the same StatsCard/chart/detail components used by `/security` (A5) and other v2 pages; recharts theme-reactive; thresholds green≥80/orange≥50/red. Show full implementation.

- [ ] **Step 4: Wire navigation**

- `Sidebar.tsx` FIXED += `{ href: '/compliance', tkey: 'nav.compliance', icon: FileSearch }` (import the icon if not already).
- `i18n.ts`: `'nav.compliance': '컴플라이언스'` (KO) / `'Compliance'` (EN).
- Mirror into mobile/command-palette enumerations as in A5.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd web && npx vitest run app/compliance/ && npx tsc --noEmit`
Expected: page test PASS; no new type errors.

- [ ] **Step 6: Commit**

```bash
git add web/app/compliance/ web/components/shell/Sidebar.tsx web/lib/i18n.ts \
        web/components/shell/MobileNav.tsx web/components/shell/BottomTabBar.tsx \
        web/lib/mobile-tabs.ts web/components/shell/CommandPalette.tsx
git commit -m "feat(compliance): /compliance page + nav wiring"
```

---

### Task 12: [B7] docs — update CLAUDE.md surfaces + ADR note

**Files:**
- Modify: `web/` or root `CLAUDE.md` page/route counts if they're tracked; add the two pages + routes.
- Optionally: a short note under `docs/decisions/` is NOT required (no new architectural decision — this ports existing features under existing ADRs / read-only posture). Skip a new ADR.

- [ ] **Step 1: Update counts/surfaces**

Add `/security` + `/compliance` pages and the new API routes to the relevant CLAUDE.md inventory tables (root `CLAUDE.md` "Key Files" + any page/route count). Keep wording consistent; no 'v2' in user-facing copy (nav labels are "Security"/"Compliance").

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(security): record /security + /compliance surfaces"
```

---

## Self-Review (completed by author)

- **Spec coverage:** Track A (A1 lib, A2 GET, A3 refresh, A4 s3_public_access sync+IAM, A5 page+nav) and Track B (B1 migration, B2 handler, B3 image, B4 terraform, B5 BFF, B6 page+nav, B7 docs) cover every spec section. CVE explicitly out of scope (spec §Scope).
- **Placeholders:** Implementer notes flag the two genuinely environment-dependent lookups (the inventory-sync env var name in A3; the Powerpipe arm64 asset URL + SDK_SYNCS contract in B3/A4) with exact verification steps rather than vague TODOs — these require reading a file/release page the author can't fully pin blind. All code steps include real code.
- **Type/name consistency:** `CheckKey`/`Finding`/`FINDING_SQL`/`rowToFinding`/`CHECK_META` are defined in A1 and consumed verbatim in A2; `compliance.parse_powerpipe_json`/`run_powerpipe`/`steampipe_db_url`/`persist`/`ALLOWED` defined in B2 and used by `_compliance`; `compliance_runs`/`compliance_results` columns match between B1 migration, B2 persist, and B5 routes.
- **Flag-gating:** every new surface degrades gracefully when `steampipe_enabled` is OFF (A2 disabled state, `_compliance` fails fast, terraform refs guarded).

---

# P2 Gate Corrections (AUTHORITATIVE — overrides task bodies where they conflict)

The plan passed a multi-model consensus gate (kiro Opus 4.8 / Kimi K2.5 / GLM-5; codex+agy timed out — not counted). All findings below were **verified against the real repo** before acceptance; `unsupported`/misread findings were dropped. Where a corrected instruction conflicts with a task body above, THIS section wins. No CRITICAL/MAJOR remain open after these corrections.

## C1 — [Task 3 / A3] Inventory-sync invoke uses `INV_SYNC_FUNCTION` + reuse `triggerSync`
**Verified:** `web/lib/inventory.ts:25` exports `triggerSync(type)` reading `process.env.INV_SYNC_FUNCTION` (set in `terraform/foundation/workload.tf:246`). The plan's `INVENTORY_SYNC_FUNCTION` name is wrong → the route would 503 in prod while tests pass.
**Correction:** `web/app/api/security/refresh/route.ts` must NOT reimplement the Lambda client. Instead:
```ts
import { verifyUser } from '@/lib/auth';
import { triggerSync } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
const TYPES = ['s3_public_access', 'security_group', 'ebs_volume', 'iam_user'] as const;

export async function POST(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie'))))
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  if (!process.env.INV_SYNC_FUNCTION)
    return Response.json({ status: 'unconfigured', message: 'inventory sync disabled' }, { status: 503 });
  await Promise.all(TYPES.map((t) => triggerSync(t).catch(() => null))); // fire-and-forget; never fail the refresh
  return Response.json({ status: 'refreshing', types: TYPES }, { status: 202 });
}
```
Test: mock `@/lib/inventory`'s `triggerSync` (not `@aws-sdk/client-lambda`); assert 401 unauth, 503 when `INV_SYNC_FUNCTION` unset, 202 + `triggerSync` called 4× when set. `task_inv_sync_invoke` (steampipe.tf:330) already grants the web task role `lambda:InvokeFunction` on the inv_sync function — no IAM change.

## C2 — [Task 4 / A4] SDK_SYNCS contract: no-arg fetcher returning `(rows, id_col, region_col)`
**Verified:** `scripts/v2/steampipe/sync_lambda.py:405` unpacks `recs, id_col, region_col = SDK_SYNCS[resource_type]()` — fetchers take **no args** and return `(rows: list[dict], id_col: str, region_col: str)` where each row is a dict whose keys include the id_col and region_col plus the columns to store. The plan's `(region, resource_id, data)` tuple shape is wrong.
**Correction:** name the producer `_fetch_s3_public_access()` (no args), returning `(rows, "name", "region")` where each row dict = `{"name": <bucket>, "region": <region>, "bucket_policy_is_public": bool|None, "block_public_acls": bool|None, "block_public_policy": bool|None, "restrict_public_buckets": bool|None, "ignore_public_acls": bool|None}`. Register `"s3_public_access": _fetch_s3_public_access` in `SDK_SYNCS`. Per-bucket `get_public_access_block`/`get_bucket_policy_status` wrapped in try/except `ClientError` (AccessDenied / NoSuchPublicAccessBlock) → emit the row with `None` flags rather than failing the whole sync. Update the test to unpack `rows, id_col, region_col = sync_lambda._fetch_s3_public_access(...)` and index dict rows by `row["name"]`. (Inject the boto3 client via a default-arg or module-level seam so the test can pass a fake.)

## C3 — [Task 9 / B4] NO Steampipe SG ingress change needed
**Verified:** the Fargate worker task reuses `aws_security_group.service` (`workers.tf:444/473/499`, C8 comment line 7), and `steampipe.tf:64` ingress already allows `aws_security_group.service` on 9193. **Delete Task 9 Step 1–2 (SG identification + ingress add).** No `steampipe.tf` SG change. Task 9 reduces to: add worker-task env + secret-read IAM (C8 below). This removes the SG-description-immutability risk entirely.

## C8b — [Task 9 / B4] Worker task: Steampipe env + secret read, guarded for `steampipe_enabled`
**Verified:** worker task role grants only the Aurora secret (`workers.tf:228`); `aws_secretsmanager_secret.steampipe[0]` is count-gated on `steampipe_enabled`.
**Correction:** in `workers.tf` Fargate worker `container_definitions.environment`, add (guard the optional ref so a steampipe-OFF plan still validates):
```hcl
{ name = "STEAMPIPE_HOST",       value = "steampipe.${var.project}.internal" },
{ name = "STEAMPIPE_SECRET_ARN", value = try(aws_secretsmanager_secret.steampipe[0].arn, "") },
```
and add a statement to `aws_iam_role_policy.worker_task` allowing `secretsmanager:GetSecretValue` on `try(aws_secretsmanager_secret.steampipe[0].arn, ...)` — use a `for`/conditional or a separate `count = local.sp`-gated `aws_iam_role_policy` resource so the policy only references the steampipe secret when it exists. (`_compliance` fails fast with a clear error when STEAMPIPE_SECRET_ARN is empty.)

## C4 — [Task 4 / A4] S3 IAM goes on the inv_sync Lambda role
**Verified:** the SDK syncs run in the **sync Lambda** whose role is `aws_iam_role_policy.inv_sync` (`steampipe.tf:258`), which currently grants only cloudfront + elb actions (NOT S3). The `steampipe_task` role (S3 perms at line 114) is the Fargate FDW role, not the Lambda.
**Correction:** add to `aws_iam_role_policy.inv_sync` a statement: `Action = ["s3:ListAllMyBuckets","s3:GetBucketPolicyStatus","s3:GetBucketPublicAccessBlock","s3:GetBucketLocation"], Resource = "*"` (read-only; these list/describe APIs don't support resource scoping, consistent with the existing cloudfront/elb statements).

## C5 — [Task 8 / B3] Powerpipe needs a mod workspace before `mod install`
**Verified:** `powerpipe mod install <url>` installs a *dependency* into the current mod; an empty dir has no `mod.pp` workspace, so install + `benchmark run aws_compliance.benchmark.*` cannot resolve.
**Correction:** in the Dockerfile, before installing the dependency, create a workspace mod:
```dockerfile
RUN mkdir -p /app/powerpipe && cd /app/powerpipe \
    && printf 'mod "local" {\n  title = "awsops compliance runner"\n}\n' > mod.pp \
    && powerpipe mod install github.com/turbot/steampipe-mod-aws-compliance
```
(If `mod install` still fails at build, fall back to `git clone --depth 1 https://github.com/turbot/steampipe-mod-aws-compliance .powerpipe/mods/github.com/turbot/steampipe-mod-aws-compliance@latest` per Powerpipe's mod layout, then verify `powerpipe benchmark list --mod-location /app/powerpipe` shows `aws_compliance.benchmark.cis_v300`.) Keep `ENV POWERPIPE_MOD_DIR=/app/powerpipe` and CMD unchanged.

## C6 — [Task 10 / B5] Implement GET /api/compliance/benchmarks (do not just describe it)
Add an explicit step creating `web/app/api/compliance/benchmarks/route.ts`:
```ts
import { verifyUser } from '@/lib/auth';
export const dynamic = 'force-dynamic';
const BENCHMARKS = [
  { id: 'cis_v400', name: 'CIS AWS v4.0.0', description: 'CIS AWS Foundations Benchmark v4.0.0' },
  { id: 'cis_v300', name: 'CIS AWS v3.0.0', description: 'CIS AWS Foundations Benchmark v3.0.0' },
  { id: 'cis_v200', name: 'CIS AWS v2.0.0', description: 'CIS AWS Foundations Benchmark v2.0.0' },
  { id: 'cis_v150', name: 'CIS AWS v1.5.0', description: 'CIS AWS Foundations Benchmark v1.5.0' },
];
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie'))))
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  return Response.json({ benchmarks: BENCHMARKS });
}
```

## C7 — [Task 7 / B2] SECURITY: scrub the Steampipe password from Powerpipe errors
**Issue:** `run_powerpipe` raises `RuntimeError(proc.stderr[...])` and `_compliance` persists `str(e)` to `compliance_runs.error` (surfaced via `GET /api/compliance/runs/[id]`). A connection error can echo `POWERPIPE_DATABASE=postgres://steampipe:<password>@...` → password leak.
**Correction:** in `run_powerpipe`, before raising, scrub: `safe = re.sub(r'(postgres://[^:]+:)[^@]+(@)', r'\1***\2', proc.stderr)[:2000]`. Persist/return only `safe`. Never log the raw `db_url`.

## C9 — [Task 7 / B2] Count at control level (v1 parity), not per-result
**Issue:** counting each leaf `results[]` entry as a control makes `total_controls`/`pass_rate` resource-level, mislabeled.
**Correction:** in `parse_powerpipe_json`, prefer the group rollups when present — sum `groups[].summary.control.{total,ok,alarm,info,skip,error}` recursively (v1 did `g.summary.control.*`); fall back to leaf-result counts only when no `summary.control` exists. `pass_rate = ok / (ok+alarm+info+skip+error) * 100` over the control totals. Keep `compliance_results` rows at the leaf-result granularity (for the control detail list), but compute the run-level totals from control summaries. Update the Task 7 test fixture/assertions accordingly.

## Accepted-as-is (verified non-issues / minor, documented)
- **pg8000 param style** (`conn.run("... :name", name=val)`) in `compliance.persist` is CORRECT — matches `scripts/v2/workers/db.py` and `sync_lambda.py` usage. No change.
- **`touch_updated_at()`** exists in baseline `schema.sql` — the Task 6 trigger guard is valid.
- **Track-A data path confirmed:** `inventory_resources` already stores `security_group.ip_permissions`, `iam_user.mfa_enabled`, `ebs_volume.encrypted` (sync_lambda.py QUERIES); the `s3` query deliberately omits public-access fields → the new `s3_public_access` type is justified.
- **[Task 2 / A2]** `enabled:false` from a presence probe conflates "not yet synced" with "steampipe OFF" and a partial sync reads as enabled with empty checks — ACCEPTABLE for v1-parity; document in the route comment. (MINOR)
- **[Task 4]** AccessDenied buckets emit `None` flags and are treated as non-public by `FINDING_SQL.public_s3` (`='true'/'false'`) — ACCEPTABLE; the row is still stored so the inventory viewer shows it. (MINOR)
