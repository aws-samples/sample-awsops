# P3-A Right-Docking Chat UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A right-docking slide-over chat drawer in the v2 Next.js web that lets an authed user converse with the 9 AgentCore section agents — hybrid routing (auto + pin), per-section preset chips, server-side typewriter SSE.

**Architecture:** Browser drawer → `POST /api/chat` (Next.js BFF on Fargate) → verify the Cognito `awsops_token` cookie (JWKS) → `@aws-sdk/client-bedrock-agentcore` `InvokeAgentRuntime` (runtime ARN from SSM, TTL-cached) → AgentCore Runtime (VPC) routes by the `gateway` field → final text → BFF re-emits as SSE chunks (typewriter). Conversation history is client-held and sent as `messages` (server-side AgentCore Memory deferred to P3-B).

**Tech Stack:** Next.js 14 (App Router), TypeScript, React 18, `@aws-sdk/client-bedrock-agentcore` + `@aws-sdk/client-ssm`, `jose` (JWKS), `vitest`. Terraform (IAM + web task env). Spec: `docs/superpowers/specs/2026-06-04-awsops-v2-p3a-chat-ui-design.md`.

**Spec deltas discovered in planning (intentional, MVP):**
- `agent.py` already routes by the `gateway` field and reads history from `payload.messages` — so **no agent.py change**. "Pin" = pass `gateway=<section>`; "Auto" = the BFF picks `gateway` via a keyword classifier (`lib/route.ts`).
- **Memory** is client-held (drawer thread → `messages`); server-side AgentCore Memory + `messageId` idempotency move to **P3-B**.
- **ALB** `idle_timeout` is already 120s and the **CloudFront** default behavior is already CachingDisabled + AllViewer (forwards `Authorization`/cookies) with `origin_read_timeout=60` — SSE survives via an immediate heartbeat, so the only Terraform change is the **IAM invoke permission** + **two Cognito env vars** on the web task.

**Operating constraints:** branch must be `feat/v2-architecture-design` (verify before infra). Do NOT `git add -A` (untracked `graphify-out/`, `AGENTS.md`, `GEMINI.md`, `.superpowers/`, parallel-session docs) — stage explicit paths. Task 11 is real-infra (controller; pause for go-ahead). All non-infra tasks have $0 AWS cost.

---

### Task 1: Test harness + dependencies

**Files:**
- Modify: `web/package.json`
- Create: `web/vitest.config.ts`
- Create: `web/lib/smoke.test.ts`

- [ ] **Step 1: Add deps + test script to `web/package.json`**

Add to `dependencies`: `"@aws-sdk/client-bedrock-agentcore": "^3.1060.0"`, `"@aws-sdk/client-ssm": "^3.1060.0"`, `"jose": "^5.9.6"`.
Add to `devDependencies`: `"vitest": "^2.1.8"`.
Add to `scripts`: `"test": "vitest run"`.

```bash
cd /home/atomoh/awsops/web
npm install --save @aws-sdk/client-bedrock-agentcore @aws-sdk/client-ssm jose
npm install --save-dev vitest
```

- [ ] **Step 2: Create `web/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': new URL('.', import.meta.url).pathname.replace(/\/$/, '') },
  },
});
```

- [ ] **Step 3: Create `web/lib/smoke.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';

describe('test harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Run the test harness**

Run: `cd /home/atomoh/awsops/web && npm run test`
Expected: 1 passed (`smoke.test.ts`).

- [ ] **Step 5: Commit**

```bash
cd /home/atomoh/awsops
git add web/package.json web/package-lock.json web/vitest.config.ts web/lib/smoke.test.ts
git commit -m "chore(v2-p3a): test harness (vitest) + deps (bedrock-agentcore, ssm, jose)"
```

---

### Task 2: `web/lib/sections.ts` — section catalog + preset prompts

**Files:**
- Create: `web/lib/sections.ts`
- Test: `web/lib/sections.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// web/lib/sections.test.ts
import { describe, it, expect } from 'vitest';
import { SECTIONS, AUTO_PRESETS, sectionByKey, activeSections } from './sections';

describe('sections', () => {
  it('has 9 sections with the expected keys', () => {
    expect(SECTIONS.map((s) => s.key)).toEqual([
      'network', 'container', 'data', 'security', 'cost', 'monitoring', 'iac', 'ops', 'observability',
    ]);
  });
  it('marks only security + network active (wired today)', () => {
    expect(activeSections().map((s) => s.key).sort()).toEqual(['network', 'security']);
  });
  it('every section has label, icon, color, and >=3 presets', () => {
    for (const s of SECTIONS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.icon.length).toBeGreaterThan(0);
      expect(s.color).toMatch(/^#/);
      expect(s.presets.length).toBeGreaterThanOrEqual(3);
    }
  });
  it('sectionByKey returns the section or undefined', () => {
    expect(sectionByKey('cost')?.label).toBeDefined();
    expect(sectionByKey('nope')).toBeUndefined();
  });
  it('exposes an Auto preset mix', () => {
    expect(AUTO_PRESETS.length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/atomoh/awsops/web && npx vitest run lib/sections.test.ts`
Expected: FAIL (Cannot find module './sections').

- [ ] **Step 3: Create `web/lib/sections.ts`**

```typescript
export interface Section {
  key: string;
  label: string;
  icon: string;
  color: string; // navy-theme accent (hex)
  active: boolean; // wired to a real gateway/tool today
  presets: string[]; // frequently-used starter questions
}

// Order = section-picker order. Colors from the v2 navy palette accents.
export const SECTIONS: Section[] = [
  { key: 'network', label: 'Network', icon: '🌐', color: '#00d4ff', active: true, presets: [
    '두 리소스 간 통신이 안 되는 원인 (Reachability)',
    'SG/NACL에서 막힌 포트 찾기',
    'TGW/피어링 라우트 점검',
    '비정상 Flow Log 트래픽',
  ] },
  { key: 'container', label: 'Container', icon: '📦', color: '#00ff88', active: false, presets: [
    '파드가 Pending/CrashLoop인 이유',
    'ECS 태스크 반복 재시작 진단',
    '네임스페이스 리소스 상태',
    'Istio 트래픽/사이드카 문제',
  ] },
  { key: 'data', label: 'Data', icon: '🗄️', color: '#a855f7', active: false, presets: [
    'RDS 느린 쿼리 진단',
    'DynamoDB 스로틀링 원인',
    'ElastiCache Evictions/메모리',
    'MSK 컨슈머 랙',
  ] },
  { key: 'security', label: 'Security', icon: '🔒', color: '#ef4444', active: true, presets: [
    '이 IAM 역할의 과다권한 점검',
    '특정 액션이 거부되는 이유 (정책 시뮬)',
    '퍼블릭 노출된 리소스 찾기',
    '최근 90일 미사용 역할/키',
  ] },
  { key: 'cost', label: 'Cost', icon: '💰', color: '#f59e0b', active: false, presets: [
    '이번 달 비용 추세와 가장 많이 오른 서비스',
    '다음 달 비용 예측',
    'RDS·EKS 절감 제안 (Top 5)',
    '계정/태그별 비용 분해',
  ] },
  { key: 'monitoring', label: 'Monitoring', icon: '📊', color: '#00d4ff', active: false, presets: [
    '최근 알람 요약',
    '특정 리소스 지표 이상 탐지',
    '누가 이 리소스를 변경했나 (CloudTrail)',
    '오류 급증 구간',
  ] },
  { key: 'iac', label: 'IaC', icon: '🏗️', color: '#a855f7', active: false, presets: [
    '드리프트 난 스택 찾기',
    '이 스택의 최근 변경 이력',
    '삭제보호/위험 리소스 점검',
    '미관리(IaC 밖) 리소스',
  ] },
  { key: 'ops', label: 'Ops', icon: '⚙️', color: '#00d4ff', active: false, presets: [
    '오늘 운영 이슈 요약',
    '리소스 인벤토리 현황',
    '태그 누락 리소스',
    '만료 임박 인증서/시크릿',
  ] },
  { key: 'observability', label: 'Observability', icon: '🔭', color: '#00ff88', active: false, presets: [
    '서비스 p99 레이턴시',
    '에러율 급증 분석',
    '최근 로그 에러 패턴 (Loki)',
    '트레이스로 느린 구간 (Tempo)',
  ] },
];

export const AUTO_PRESETS: string[] = [
  '이번 달 비용 추세와 가장 많이 오른 서비스',
  '두 리소스 간 통신이 안 되는 원인',
  '이 IAM 역할의 과다권한 점검',
  '최근 알람 요약',
];

export function sectionByKey(key: string): Section | undefined {
  return SECTIONS.find((s) => s.key === key);
}

export function activeSections(): Section[] {
  return SECTIONS.filter((s) => s.active);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /home/atomoh/awsops/web && npx vitest run lib/sections.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/atomoh/awsops
git add web/lib/sections.ts web/lib/sections.test.ts
git commit -m "feat(v2-p3a): sections.ts — 9 section catalog + preset prompts + active flags"
```

---

### Task 3: `web/lib/route.ts` — Auto-mode gateway classifier (pin override)

**Files:**
- Create: `web/lib/route.ts`
- Test: `web/lib/route.test.ts`

**Context:** `agent.py` routes by the `gateway` field. "Pin" passes the section key directly. "Auto" picks a gateway from the prompt via keyword heuristics (the v1 router pattern, MVP). Unknown → `ops` (the general fallback agent.py also defaults to).

- [ ] **Step 1: Write the failing test**

```typescript
// web/lib/route.test.ts
import { describe, it, expect } from 'vitest';
import { pickGateway } from './route';

describe('pickGateway', () => {
  it('honors an explicit pin over keywords', () => {
    expect(pickGateway('이번 달 비용 알려줘', 'security')).toBe('security');
  });
  it('routes cost keywords', () => {
    expect(pickGateway('이번 달 비용 추세')).toBe('cost');
    expect(pickGateway('show me the billing forecast')).toBe('cost');
  });
  it('routes security keywords', () => {
    expect(pickGateway('이 IAM 역할 권한 점검')).toBe('security');
    expect(pickGateway('why is this action denied by policy')).toBe('security');
  });
  it('routes network keywords', () => {
    expect(pickGateway('두 인스턴스 통신이 안 돼요')).toBe('network');
    expect(pickGateway('check the security group ports')).toBe('network');
  });
  it('falls back to ops for unknown prompts', () => {
    expect(pickGateway('안녕하세요')).toBe('ops');
  });
  it('ignores a pin that is not a known section', () => {
    expect(pickGateway('이번 달 비용', 'bogus')).toBe('cost');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/atomoh/awsops/web && npx vitest run lib/route.test.ts`
Expected: FAIL (Cannot find module './route').

- [ ] **Step 3: Create `web/lib/route.ts`**

```typescript
import { sectionByKey } from './sections';

// MVP keyword heuristics per section (KO + EN). First match wins, in this order.
const RULES: { key: string; re: RegExp }[] = [
  { key: 'cost', re: /비용|요금|예산|절감|billing|cost|budget|forecast|spend/i },
  { key: 'security', re: /보안|권한|역할|정책|iam|policy|role|denied|permission|public|노출/i },
  { key: 'network', re: /통신|연결|네트워크|포트|라우트|reachab|network|connectivity|security ?group|\bsg\b|nacl|tgw|vpn|peering|flow ?log/i },
  { key: 'container', re: /파드|컨테이너|eks|ecs|kubernetes|k8s|pod|istio|namespace|sidecar/i },
  { key: 'data', re: /쿼리|데이터베이스|rds|aurora|dynamo|elasticache|redis|msk|kafka|database|slow query|throttl/i },
  { key: 'cost', re: /\$\d/i },
  { key: 'monitoring', re: /알람|지표|로그변경|cloudwatch|cloudtrail|alarm|metric|who changed|audit/i },
  { key: 'iac', re: /드리프트|스택|terraform|cloudformation|\bcdk\b|drift|stack|iac/i },
  { key: 'observability', re: /레이턴시|트레이스|p99|latency|trace|loki|tempo|prometheus|jaeger|grafana/i },
];

/** Choose the agent gateway. A valid pin always wins; otherwise keyword-match; else 'ops'. */
export function pickGateway(prompt: string, pinned?: string): string {
  if (pinned && sectionByKey(pinned)) return pinned;
  for (const r of RULES) {
    if (r.re.test(prompt)) return r.key;
  }
  return 'ops';
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /home/atomoh/awsops/web && npx vitest run lib/route.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/atomoh/awsops
git add web/lib/route.ts web/lib/route.test.ts
git commit -m "feat(v2-p3a): route.ts — Auto-mode gateway classifier (pin overrides; ops fallback)"
```

---

### Task 4: `web/lib/auth.ts` — Cognito JWT (cookie) re-verification

**Files:**
- Create: `web/lib/auth.ts`
- Test: `web/lib/auth.test.ts`

**Context:** Lambda@Edge sets the Cognito **id_token** in the `awsops_token` cookie and verifies it at the edge. CloudFront AllViewer forwards the cookie to the BFF. The BFF re-verifies (defense-in-depth, co-agent) via Cognito JWKS using `jose`, checking `iss`/`aud`(client id)/`token_use=id`/`exp`. Env: `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `AWS_REGION` (added to the web task in Task 9).

- [ ] **Step 1: Write the failing test** (mock `jose`)

```typescript
// web/lib/auth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const jwtVerify = vi.fn();
vi.mock('jose', () => ({
  createRemoteJWKSet: () => () => ({}),
  jwtVerify: (...a: unknown[]) => jwtVerify(...a),
}));

beforeEach(() => {
  jwtVerify.mockReset();
  process.env.COGNITO_USER_POOL_ID = 'ap-northeast-2_TEST';
  process.env.COGNITO_CLIENT_ID = 'client123';
  process.env.AWS_REGION = 'ap-northeast-2';
});

describe('verifyUser', () => {
  it('returns null when no cookie', async () => {
    const { verifyUser } = await import('./auth');
    expect(await verifyUser(null)).toBeNull();
  });
  it('returns null when awsops_token cookie absent', async () => {
    const { verifyUser } = await import('./auth');
    expect(await verifyUser('foo=bar; baz=1')).toBeNull();
  });
  it('returns {sub,email} for a valid id token', async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', email: 'a@b.com', token_use: 'id' } });
    const { verifyUser } = await import('./auth');
    expect(await verifyUser('awsops_token=eyJ...; x=1')).toEqual({ sub: 'u-1', email: 'a@b.com' });
  });
  it('returns null when token_use is not id', async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'u-1', token_use: 'access' } });
    const { verifyUser } = await import('./auth');
    expect(await verifyUser('awsops_token=eyJ...')).toBeNull();
  });
  it('returns null when verification throws (expired/forged)', async () => {
    jwtVerify.mockRejectedValue(new Error('expired'));
    const { verifyUser } = await import('./auth');
    expect(await verifyUser('awsops_token=eyJ...')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/atomoh/awsops/web && npx vitest run lib/auth.test.ts`
Expected: FAIL (Cannot find module './auth').

- [ ] **Step 3: Create `web/lib/auth.ts`**

```typescript
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface User {
  sub: string;
  email?: string;
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) {
    const region = process.env.AWS_REGION || 'ap-northeast-2';
    const pool = process.env.COGNITO_USER_POOL_ID;
    jwks = createRemoteJWKSet(
      new URL(`https://cognito-idp.${region}.amazonaws.com/${pool}/.well-known/jwks.json`),
    );
  }
  return jwks;
}

/** Re-verify the edge-set Cognito id_token (awsops_token cookie). Returns the user or null. */
export async function verifyUser(cookieHeader: string | null): Promise<User | null> {
  const token = parseCookie(cookieHeader, 'awsops_token');
  if (!token) return null;
  const region = process.env.AWS_REGION || 'ap-northeast-2';
  const pool = process.env.COGNITO_USER_POOL_ID;
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: `https://cognito-idp.${region}.amazonaws.com/${pool}`,
      audience: process.env.COGNITO_CLIENT_ID,
    });
    if (payload.token_use !== 'id' || !payload.sub) return null;
    return { sub: String(payload.sub), email: payload.email ? String(payload.email) : undefined };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /home/atomoh/awsops/web && npx vitest run lib/auth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/atomoh/awsops
git add web/lib/auth.ts web/lib/auth.test.ts
git commit -m "feat(v2-p3a): auth.ts — re-verify Cognito id_token (awsops_token cookie) via JWKS (jose)"
```

---

### Task 5: `web/lib/agentcore.ts` — SSM ARN cache + InvokeAgentRuntime wrapper

**Files:**
- Create: `web/lib/agentcore.ts`
- Test: `web/lib/agentcore.test.ts`

**Context:** Reads the runtime ARN from SSM `/ops/awsops-v2/agentcore/runtime_arn` (TTL-cached 5 min), invokes via `@aws-sdk/client-bedrock-agentcore` `InvokeAgentRuntimeCommand`, sends `{gateway, messages}` (matches `agent.py`), returns the final text. 1 short retry on transient failure.

- [ ] **Step 1: Write the failing test** (mock the SDK clients)

```typescript
// web/lib/agentcore.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ssmSend = vi.fn();
const acSend = vi.fn();
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = ssmSend; },
  GetParameterCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: class { send = acSend; },
  InvokeAgentRuntimeCommand: class { constructor(public input: unknown) {} },
}));

beforeEach(() => {
  ssmSend.mockReset();
  acSend.mockReset();
  process.env.SSM_RUNTIME_ARN_PARAM = '/ops/awsops-v2/agentcore/runtime_arn';
});

function streamOf(s: string) {
  return { transformToString: async () => s };
}

describe('agentcore', () => {
  it('caches the runtime ARN (SSM hit once)', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    const { getRuntimeArn } = await import('./agentcore');
    expect(await getRuntimeArn()).toBe('arn:rt');
    expect(await getRuntimeArn()).toBe('arn:rt');
    expect(ssmSend).toHaveBeenCalledTimes(1);
  });
  it('invokes and returns the agent text', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue({ response: streamOf(JSON.stringify('이번 달 비용은 $4,210입니다')) });
    const { invokeAgent } = await import('./agentcore');
    const text = await invokeAgent({ gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) });
    expect(text).toContain('$4,210');
  });
  it('retries once on transient failure', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockRejectedValueOnce(new Error('throttle')).mockResolvedValueOnce({ response: streamOf('"ok"') });
    const { invokeAgent } = await import('./agentcore');
    const text = await invokeAgent({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) });
    expect(text).toBe('ok');
    expect(acSend).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/atomoh/awsops/web && npx vitest run lib/agentcore.test.ts`
Expected: FAIL (Cannot find module './agentcore').

- [ ] **Step 3: Create `web/lib/agentcore.ts`**

```typescript
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const ARN_PARAM = process.env.SSM_RUNTIME_ARN_PARAM || '/ops/awsops-v2/agentcore/runtime_arn';
const TTL_MS = 5 * 60 * 1000;

let ssm: SSMClient | null = null;
let ac: BedrockAgentCoreClient | null = null;
let arnCache: { value: string; at: number } | null = null;

export async function getRuntimeArn(): Promise<string> {
  if (arnCache && Date.now() - arnCache.at < TTL_MS) return arnCache.value;
  if (!ssm) ssm = new SSMClient({ region: REGION });
  const r = await ssm.send(new GetParameterCommand({ Name: ARN_PARAM }));
  const value = r.Parameter?.Value;
  if (!value) throw new Error('runtime ARN not found in SSM');
  arnCache = { value, at: Date.now() };
  return value;
}

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

export interface InvokeInput {
  gateway: string;
  messages: ChatMsg[];
  sessionId: string; // >=33 chars (a UUID works)
}

async function readResponse(resp: unknown): Promise<string> {
  const body = (resp as { response?: { transformToString?: () => Promise<string> } }).response;
  const raw = body?.transformToString ? await body.transformToString() : String(body ?? '');
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}

/** Invoke the AgentCore runtime with the chosen gateway + thread. Returns final text. */
export async function invokeAgent(input: InvokeInput): Promise<string> {
  const arn = await getRuntimeArn();
  if (!ac) ac = new BedrockAgentCoreClient({ region: REGION });
  const payload = new TextEncoder().encode(JSON.stringify({ gateway: input.gateway, messages: input.messages }));
  const cmd = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: arn,
    qualifier: 'DEFAULT',
    runtimeSessionId: input.sessionId,
    payload,
  });
  try {
    return await readResponse(await ac.send(cmd));
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return await readResponse(await ac.send(cmd));
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /home/atomoh/awsops/web && npx vitest run lib/agentcore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/atomoh/awsops
git add web/lib/agentcore.ts web/lib/agentcore.test.ts
git commit -m "feat(v2-p3a): agentcore.ts — SSM ARN TTL cache + InvokeAgentRuntime wrapper (gateway+messages, 1 retry)"
```

---

### Task 6: `web/app/api/chat/route.ts` — SSE typewriter BFF

**Files:**
- Create: `web/app/api/chat/route.ts`
- Test: `web/app/api/chat/route.test.ts`

**Context:** `POST` verifies the user, picks the gateway (pin/auto), invokes the agent, then re-emits the final text as SSE chunks (typewriter) after an immediate heartbeat. 401/413/503 envelopes. `maxDuration` raised for long agent calls.

- [ ] **Step 1: Write the failing test** (mock auth + agentcore + route)

```typescript
// web/app/api/chat/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const invokeAgent = vi.fn();
const pickGateway = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/agentcore', () => ({ invokeAgent: (...a: unknown[]) => invokeAgent(...a) }));
vi.mock('@/lib/route', () => ({ pickGateway: (...a: unknown[]) => pickGateway(...a) }));

function req(body: unknown, cookie = 'awsops_token=t') {
  return new Request('http://x/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}
async function readStream(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

beforeEach(() => {
  verifyUser.mockReset();
  invokeAgent.mockReset();
  pickGateway.mockReset();
});

describe('POST /api/chat', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'hi', sessionId: 's'.repeat(36) }));
    expect(res.status).toBe(401);
  });
  it('413 on oversize prompt', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'x'.repeat(60000), sessionId: 's'.repeat(36) }));
    expect(res.status).toBe(413);
  });
  it('streams a typewriter SSE on the happy path + passes the gateway', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('cost');
    invokeAgent.mockResolvedValue('비용은 $10 입니다');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: '비용', section: 'cost', sessionId: 's'.repeat(36) }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await readStream(res);
    expect(body).toContain('"gateway":"cost"');
    expect(body).toContain('비용은');
    expect(body).toContain('[DONE]');
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'cost' }));
  });
  it('emits an error frame when invoke fails', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('ops');
    invokeAgent.mockRejectedValue(new Error('boom'));
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'x', sessionId: 's'.repeat(36) }));
    const body = await readStream(res);
    expect(body).toContain('"error"');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/atomoh/awsops/web && npx vitest run app/api/chat/route.test.ts`
Expected: FAIL (Cannot find module './route').

- [ ] **Step 3: Create `web/app/api/chat/route.ts`**

```typescript
import { verifyUser } from '@/lib/auth';
import { invokeAgent, type ChatMsg } from '@/lib/agentcore';
import { pickGateway } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const maxDuration = 120; // long agent calls

const MAX_PROMPT = 50_000;
const TYPE_DELAY_MS = 12;

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
function chunk(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);

  let body: { prompt?: string; messages?: ChatMsg[]; section?: string; sessionId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ status: 'error', message: 'invalid JSON' }, 400);
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt) return json({ status: 'error', message: 'prompt required' }, 400);
  if (prompt.length > MAX_PROMPT) return json({ status: 'error', message: 'prompt too large' }, 413);

  const sessionId = (body.sessionId && body.sessionId.length >= 33) ? body.sessionId : `awsops-${user.sub}-000000000000000000000000`;
  const gateway = pickGateway(prompt, body.section);
  const messages: ChatMsg[] = [...(Array.isArray(body.messages) ? body.messages : []), { role: 'user', content: prompt }];

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(': heartbeat\n\n')); // open immediately (CloudFront/ALB keepalive)
      let text: string;
      try {
        text = await invokeAgent({ gateway, messages, sessionId });
      } catch (e) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: e instanceof Error ? e.message : 'invoke failed' })}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(`event: meta\ndata: ${JSON.stringify({ gateway })}\n\n`));
      for (const c of chunk(text)) {
        if (request.signal.aborted) break;
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta: c })}\n\n`));
        await new Promise((r) => setTimeout(r, TYPE_DELAY_MS));
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /home/atomoh/awsops/web && npx vitest run app/api/chat/route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full unit suite + commit**

```bash
cd /home/atomoh/awsops/web && npm run test
```
Expected: all tests pass (sections, route, auth, agentcore, chat route).
```bash
cd /home/atomoh/awsops
git add web/app/api/chat/route.ts web/app/api/chat/route.test.ts
git commit -m "feat(v2-p3a): /api/chat BFF — auth verify -> pickGateway -> invoke -> SSE typewriter (heartbeat, abort, 401/413)"
```

---

### Task 7: App shell — TopNav + drawer mount

**Files:**
- Create: `web/components/shell/TopNav.tsx`
- Modify: `web/app/layout.tsx`
- Modify: `web/app/page.tsx`

**Context:** Minimal navy shell that hosts the chat drawer (built in Task 8). No unit test (presentational) — verified by `npm run build` + E2E.

- [ ] **Step 1: Create `web/components/shell/TopNav.tsx`**

```tsx
export default function TopNav() {
  return (
    <header style={{ height: 48, display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', background: '#0f1629', borderBottom: '1px solid #1a2540', color: '#7da2c9', fontSize: 13 }}>
      <span style={{ color: '#00d4ff', fontWeight: 700 }}>AWSops</span>
      <span>Overview</span>
      <span style={{ marginLeft: 'auto' }}>◷ admin</span>
    </header>
  );
}
```

- [ ] **Step 2: Replace `web/app/page.tsx` with a minimal home placeholder**

```tsx
export default function Home() {
  return (
    <main style={{ padding: 24, color: '#9db8d8' }}>
      <h1 style={{ color: '#e6eefb', fontSize: 20 }}>AWSops v2</h1>
      <p>우측 하단 ✦ 버튼으로 AI 어시스턴트를 여세요.</p>
    </main>
  );
}
```

- [ ] **Step 3: Update `web/app/layout.tsx` to mount the shell + drawer**

```tsx
import TopNav from '@/components/shell/TopNav';
import ChatDrawer from '@/components/chat/ChatDrawer';

export const metadata = { title: 'AWSops v2' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ margin: 0, background: '#0a0e1a', color: '#e6eefb', fontFamily: 'system-ui, sans-serif' }}>
        <TopNav />
        {children}
        <ChatDrawer />
      </body>
    </html>
  );
}
```

- [ ] **Step 4: Commit** (build happens after Task 8 when ChatDrawer exists)

```bash
cd /home/atomoh/awsops
git add web/components/shell/TopNav.tsx web/app/layout.tsx web/app/page.tsx
git commit -m "feat(v2-p3a): minimal app shell (TopNav + home) mounting the chat drawer"
```

---

### Task 8: Chat drawer components (FAB, picker, chips, composer, message list, typewriter)

**Files:**
- Create: `web/components/chat/ChatDrawer.tsx`
- Create: `web/components/chat/SectionPicker.tsx`
- Create: `web/components/chat/PresetChips.tsx`
- Create: `web/components/chat/Composer.tsx`
- Create: `web/components/chat/MessageList.tsx`

**Context:** Client components. ChatDrawer owns state (open, pinned section, messages, sessionId in localStorage, streaming). It POSTs to `/api/chat` and reads the SSE stream via `fetch` + `getReader()` (EventSource can't POST), rendering the typewriter deltas. AbortController cancels on close/reset. Verified by `npm run build` + E2E.

- [ ] **Step 1: Create `web/components/chat/SectionPicker.tsx`**

```tsx
'use client';
import { SECTIONS } from '@/lib/sections';

export default function SectionPicker({ pinned, onPin }: { pinned: string | null; onPin: (key: string | null) => void }) {
  return (
    <div style={{ display: 'flex', gap: 5, padding: '8px 12px', borderBottom: '1px solid #1a2540', flexWrap: 'wrap' }}>
      <button onClick={() => onPin(null)} title="Auto" style={chip(pinned === null, '#00d4ff')}>🧭</button>
      {SECTIONS.map((s) => (
        <button key={s.key} title={s.active ? s.label : `${s.label} (준비중)`} disabled={!s.active && false}
          onClick={() => onPin(s.key)} style={{ ...chip(pinned === s.key, s.color), opacity: s.active ? 1 : 0.4 }}>
          {s.icon}
        </button>
      ))}
    </div>
  );
}
function chip(on: boolean, color: string): React.CSSProperties {
  return { width: 28, height: 28, borderRadius: 7, fontSize: 14, cursor: 'pointer',
    background: on ? `${color}1a` : '#0a0e1a', border: `1px solid ${on ? color : '#21314e'}`, color: '#e6eefb' };
}
```

- [ ] **Step 2: Create `web/components/chat/PresetChips.tsx`**

```tsx
'use client';
import { sectionByKey, AUTO_PRESETS } from '@/lib/sections';

export default function PresetChips({ pinned, onPick }: { pinned: string | null; onPick: (q: string) => void }) {
  const sec = pinned ? sectionByKey(pinned) : null;
  const prompts = sec ? sec.presets : AUTO_PRESETS;
  const head = sec ? `${sec.icon} ${sec.label} — 무엇을 도와드릴까요?` : '무엇을 도와드릴까요?';
  return (
    <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ fontSize: 12.5, color: '#9db8d8', textAlign: 'center', marginBottom: 4 }}>{head}</div>
      {prompts.map((p) => (
        <button key={p} onClick={() => onPick(p)} style={{ fontSize: 12, color: '#dcebff', background: '#13233b', border: '1px solid #2a3f60', borderRadius: 18, padding: '8px 12px', cursor: 'pointer', textAlign: 'left' }}>
          <span style={{ color: '#f59e0b', marginRight: 6 }}>▸</span>{p}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create `web/components/chat/MessageList.tsx`**

```tsx
'use client';
import { sectionByKey } from '@/lib/sections';

export interface Msg { role: 'user' | 'assistant'; content: string; gateway?: string; streaming?: boolean }

export default function MessageList({ msgs }: { msgs: Msg[] }) {
  return (
    <div style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', gap: 9, overflowY: 'auto' }}>
      {msgs.map((m, i) => {
        const sec = m.gateway ? sectionByKey(m.gateway) : null;
        const me = m.role === 'user';
        return (
          <div key={i} style={{ alignSelf: me ? 'flex-end' : 'flex-start', maxWidth: '88%', background: me ? '#1d3350' : '#12203a', border: me ? 'none' : '1px solid #21314e', borderRadius: 10, padding: '8px 10px', fontSize: 12.5, lineHeight: 1.5, color: me ? '#dcebff' : '#bcd6f2' }}>
            {sec && (
              <div style={{ fontSize: 9.5, color: sec.color, marginBottom: 5 }}>{sec.icon} {sec.label}</div>
            )}
            <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
            {m.streaming && <span style={{ display: 'inline-block', width: 7, height: 13, background: '#00d4ff', marginLeft: 2, verticalAlign: -2 }} />}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Create `web/components/chat/Composer.tsx`**

```tsx
'use client';
import { useState } from 'react';

export default function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const send = () => { const t = text.trim(); if (t && !disabled) { onSend(t); setText(''); } };
  return (
    <div style={{ padding: '10px 12px', borderTop: '1px solid #1a2540', display: 'flex', gap: 7 }}>
      <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()}
        placeholder="메시지를 입력하세요…" disabled={disabled}
        style={{ flex: 1, height: 32, background: '#0a0e1a', border: '1px solid #2a3a5c', borderRadius: 8, color: '#e6eefb', padding: '0 10px' }} />
      <button onClick={send} disabled={disabled} style={{ width: 32, height: 32, borderRadius: 8, background: '#00d4ff', color: '#06121f', border: 'none', fontWeight: 800, cursor: 'pointer' }}>➤</button>
    </div>
  );
}
```

- [ ] **Step 5: Create `web/components/chat/ChatDrawer.tsx`** (orchestrator + SSE reader)

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import SectionPicker from './SectionPicker';
import PresetChips from './PresetChips';
import Composer from './Composer';
import MessageList, { type Msg } from './MessageList';

function newSessionId(): string {
  const s = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`);
  return s.length >= 33 ? s : s.padEnd(36, '0');
}

export default function ChatDrawer() {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let sid = localStorage.getItem('awsops_chat_session');
    if (!sid) { sid = newSessionId(); localStorage.setItem('awsops_chat_session', sid); }
    sessionRef.current = sid;
  }, []);

  function newChat() {
    abortRef.current?.abort();
    const sid = newSessionId();
    localStorage.setItem('awsops_chat_session', sid);
    sessionRef.current = sid;
    setMsgs([]); setBusy(false);
  }

  async function send(prompt: string) {
    if (busy) return;
    const history = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: 'user', content: prompt }, { role: 'assistant', content: '', streaming: true }]);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, messages: history, section: pinned, sessionId: sessionRef.current }),
      });
      if (!res.ok || !res.body) {
        patchLast((m) => ({ ...m, content: res.status === 401 ? '세션이 만료되었습니다. 새로고침해 주세요.' : 'AI 응답을 받지 못했습니다.', streaming: false }));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const f of frames) handleFrame(f);
      }
    } catch {
      patchLast((m) => ({ ...m, streaming: false }));
    } finally {
      patchLast((m) => ({ ...m, streaming: false }));
      setBusy(false);
    }
  }

  function handleFrame(frame: string) {
    const isMeta = frame.startsWith('event: meta');
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return;
    try {
      const obj = JSON.parse(data);
      if (isMeta && obj.gateway) patchLast((m) => ({ ...m, gateway: obj.gateway }));
      else if (obj.delta) patchLast((m) => ({ ...m, content: m.content + obj.delta }));
      else if (obj.error) patchLast((m) => ({ ...m, content: `⚠️ ${obj.error}`, streaming: false }));
    } catch { /* heartbeat / non-JSON */ }
  }
  function patchLast(fn: (m: Msg) => Msg) {
    setMsgs((arr) => arr.map((m, i) => (i === arr.length - 1 && m.role === 'assistant' ? fn(m) : m)));
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} aria-label="AI 어시스턴트 열기"
        style={{ position: 'fixed', right: 16, bottom: 16, width: 46, height: 46, borderRadius: '50%', background: '#00d4ff', color: '#06121f', border: 'none', fontSize: 20, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 14px #00d4ff55' }}>✦</button>
    );
  }
  return (
    <div style={{ position: 'fixed', right: 0, top: 0, height: '100vh', width: 460, background: '#0f1629', borderLeft: '2px solid #00d4ff', boxShadow: '-12px 0 28px #000a', display: 'flex', flexDirection: 'column', zIndex: 50 }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #1a2540', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>AWSops Assistant</span>
        <span>
          <button onClick={newChat} title="새 대화" style={iconBtn}>＋</button>
          <button onClick={() => { abortRef.current?.abort(); setOpen(false); }} title="닫기" style={iconBtn}>✕</button>
        </span>
      </div>
      <SectionPicker pinned={pinned} onPin={setPinned} />
      {msgs.length === 0 ? <PresetChips pinned={pinned} onPick={send} /> : <MessageList msgs={msgs} />}
      <Composer disabled={busy} onSend={send} />
    </div>
  );
}
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#7da2c9', fontSize: 15, cursor: 'pointer', marginLeft: 8 };
```

- [ ] **Step 6: Build the web (verifies all components compile)**

Run: `cd /home/atomoh/awsops/web && npm run build`
Expected: "✓ Compiled successfully"; route manifest lists `/api/chat` and `/` (the shell).

- [ ] **Step 7: Commit**

```bash
cd /home/atomoh/awsops
git add web/components/chat/
git commit -m "feat(v2-p3a): chat drawer — FAB, section picker(pin), preset chips, composer, typewriter SSE reader, new-chat/abort"
```

---

### Task 9: Terraform — web task env (Cognito IDs) + IAM InvokeAgentRuntime

**Files:**
- Modify: `terraform/foundation/workload.tf` (web container env)
- Modify: `terraform/foundation/ai.tf` (task-role invoke policy)

- [ ] **Step 1: Add Cognito + SSM-param env to the web container**

In `workload.tf`, the web container `environment` `concat([...])` base array (the block that already has PORT/HOSTNAME/AURORA_*), add these entries to the base list:

```hcl
        { name = "AWS_REGION", value = var.region },
        { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.main.id },
        { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.main.id },
        { name = "SSM_RUNTIME_ARN_PARAM", value = "/ops/${var.project}/agentcore/runtime_arn" },
```

- [ ] **Step 2: Add the InvokeAgentRuntime task-role policy in `ai.tf`** (after `aws_iam_role_policy.task_agentcore_ssm`)

```hcl
# web task role may invoke the AgentCore runtime (P3-A chat). Scoped to our runtime name prefix
# (the runtime ID suffix is provisioner-generated) + its DEFAULT endpoint. No wildcard actions.
resource "aws_iam_role_policy" "task_agentcore_invoke" {
  count = local.ac_count
  name  = "${var.project}-task-agentcore-invoke"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["bedrock-agentcore:InvokeAgentRuntime"]
      Resource = [
        "arn:aws:bedrock-agentcore:${var.region}:${data.aws_caller_identity.current.account_id}:runtime/${replace(var.project, "-", "_")}_agent-*",
        "arn:aws:bedrock-agentcore:${var.region}:${data.aws_caller_identity.current.account_id}:runtime/${replace(var.project, "-", "_")}_agent-*/runtime-endpoint/*"
      ]
    }]
  })
}
```

- [ ] **Step 3: fmt + validate + plan**

```bash
cd /home/atomoh/awsops/terraform/foundation
export PATH="$HOME/.local/bin:$PATH"
terraform fmt workload.tf ai.tf
terraform validate
terraform plan -no-color -input=false -lock=false 2>&1 | grep -E "will be|must be|Plan:|task-agentcore-invoke|task_definition.web"
```
Expected: `aws_iam_role_policy.task_agentcore_invoke[0]` will be created; `aws_ecs_task_definition.web` must be replaced (new env → new revision); `aws_ecs_service.web` updated in place. No other resource changes.

- [ ] **Step 4: Commit**

```bash
cd /home/atomoh/awsops
git add terraform/foundation/workload.tf terraform/foundation/ai.tf
git commit -m "feat(v2-p3a): web task env (Cognito pool/client + SSM ARN param) + task-role bedrock-agentcore:InvokeAgentRuntime (runtime ARN scope)"
```

---

### Task 10: Full build + unit gate

**Files:** none (verification)

- [ ] **Step 1: Run the full unit suite**

Run: `cd /home/atomoh/awsops/web && npm run test`
Expected: all pass (sections, route, auth, agentcore, chat route).

- [ ] **Step 2: Production build (standalone traces new deps)**

Run: `cd /home/atomoh/awsops/web && npm run build`
Expected: "✓ Compiled successfully"; `/api/chat` (ƒ) + `/` present; no type errors. Confirm `@aws-sdk/client-bedrock-agentcore`, `@aws-sdk/client-ssm`, `jose` are in `dependencies` (standalone output tracing needs them).

- [ ] **Step 3: Commit** (only if any lockfile/config changed; otherwise skip)

```bash
cd /home/atomoh/awsops
git add -- web/package-lock.json 2>/dev/null && git commit -m "chore(v2-p3a): lockfile" || echo "nothing to commit"
```

---

### Task 11: Deploy + verify (CONTROLLER — real infra; PAUSE for go-ahead)

**Files:** none (deploy)

> **Do not run without explicit user go-ahead.** Creates a web task-def revision + IAM policy and rolls the web service.

- [ ] **Step 1: Verify branch + apply infra**

```bash
cd /home/atomoh/awsops && git rev-parse --abbrev-ref HEAD   # must be feat/v2-architecture-design
cd terraform/foundation && export PATH="$HOME/.local/bin:$PATH"
terraform plan -out=/tmp/p3a.tfplan -input=false
terraform apply -input=false /tmp/p3a.tfplan
```
Expected: invoke policy created; web task-def replaced; service updated.

- [ ] **Step 2: Build + push the web image + roll the service**

```bash
cd /home/atomoh/awsops && make deploy
```
Expected: buildx arm64 push → ECS force-new-deployment → services-stable → `/api/health` 200.

- [ ] **Step 3: E2E in the browser** (`https://awsops-v2.example.com`)

Verify manually:
1. Log in (Cognito). Click the ✦ FAB → drawer opens with Auto preset chips.
2. Click a **Security** preset (e.g., "퍼블릭 노출된 리소스 찾기") → typewriter streams a real answer + a `🔒 Security` badge.
3. Pin **Network** → its presets appear; ask "막힌 포트 점검" → routed to network, typewriter renders.
4. Type a free-form cost question in Auto → routed to `cost` (or graceful "준비중" since cost gateway is not wired — acceptable).
5. "＋" (새 대화) clears the thread; closing/reopening the drawer keeps `sessionId` (localStorage).
6. Confirm no 504 / no buffered burst (SSE streams smoothly through CloudFront + ALB).

- [ ] **Step 4: Confirm GREEN + report** (no commit — deploy only). If E2E reveals issues, file follow-up tasks.

---

## Self-Review

**Spec coverage:** drawer (T7,T8) · hybrid routing pin (T3,T6,T8) · typewriter SSE (T6,T8) · preset chips (T2,T8) · auth re-verify (T4) · agentcore invoke + SSM cache (T5) · IAM invoke perm (T9) · Cognito env (T9) · sections+presets content (T2) · error handling 401/413/503/invoke-fail (T4,T6,T8) · testing (T1-T6,T10) · deploy/E2E (T11). Spec's server-side Memory + messageId idempotency + agent.py `section` bypass are explicitly deferred (agent.py already routes by `gateway`; client-held history) — noted in the header. CloudFront/ALB SSE timeout is satisfied by existing config + heartbeat (header note) — no task needed.

**Placeholder scan:** none — every step has full code/commands.

**Type consistency:** `Section`/`SECTIONS`/`sectionByKey`/`activeSections`/`AUTO_PRESETS` (T2) used in T3/T8. `pickGateway(prompt,pinned)` (T3) used in T6. `verifyUser(cookie)→User|null` (T4) used in T6. `invokeAgent({gateway,messages,sessionId})→string` + `ChatMsg` (T5) used in T6. `Msg` (T8 MessageList) used in ChatDrawer. SSE frame shape (`event: meta` + `data:{gateway}`, `data:{delta}`, `data:{error}`, `[DONE]`) consistent between route (T6) and reader (T8). `/api/chat` body `{prompt,messages,section,sessionId}` consistent T6↔T8.
