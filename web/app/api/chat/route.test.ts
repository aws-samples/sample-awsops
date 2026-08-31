import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

const verifyUser = vi.fn();
const invokeAgent = vi.fn();
const pickGateway = vi.fn();
const getEnabledCustomAgents = vi.fn();
const pickCustomAgent = vi.fn();
const resolveAgent = vi.fn();
const isCustomAgentEnabled = vi.fn();
const recordCustomAgentTrace = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
// container/iac가 2026-08-02 활성화됨(게이트웨이+READY 타깃) — 이 파일의 🔒/degrade 픽스처는
// 'container 비활성'을 전제하므로 여기서만 container를 비활성으로 강제해, 미래의 비활성
// 섹션에도 적용될 §2.3 계약(핀=🔒 유지, 자동 라우팅=Assistant degrade)을 계속 검증한다.
vi.mock('@/lib/sections', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/sections')>();
  return {
    ...real,
    sectionByKey: (k: string) => {
      const sec = real.sectionByKey(k);
      return sec && sec.key === 'container' ? { ...sec, active: false } : sec;
    },
  };
});
// invokeAgentStream (single-route path) delegates to the invokeAgent mock so existing tests —
// which set invokeAgent.mockResolvedValue/mockRejectedValue and assert its call args/count —
// keep working: the stream yields the resolved answer as one delta (the route reassembles it).
async function* invokeAgentStreamImpl(...a: unknown[]): AsyncGenerator<string> {
  const text = await invokeAgent(...a);
  if (text) yield text as string;
}
// invokeAgentDetailed (single-route path, provenance footer) delegates to the same invokeAgent
// mock — existing tests assert call args/count against invokeAgent, so it stays the one spy.
async function invokeAgentDetailedImpl(...a: unknown[]): Promise<{ text: string; tools: string[]; model?: string }> {
  return { text: (await invokeAgent(...a)) as string, tools: [] };
}
type AgentEvent = { delta?: string; tool?: string; model?: string };
// invokeAgentStreamDetailed backs the route's main path (real streaming + provenance). Defaults
// to wrapping the invokeAgent mock as ONE delta event, so every existing invokeAgent.mockResolvedValue
// test keeps working unchanged. A test that needs to assert genuine incremental delivery (multiple
// SSE frames) or tool/model provenance sets `streamDetailedEvents` directly before calling POST.
let streamDetailedEvents: AgentEvent[] | null = null;
// For a test that needs a side effect between yields (e.g. aborting the request mid-stream) —
// checked before the plain-array override above.
let streamDetailedGenerator: (() => AsyncGenerator<AgentEvent>) | null = null;
async function* invokeAgentStreamDetailedImpl(...a: unknown[]): AsyncGenerator<AgentEvent> {
  if (streamDetailedGenerator) { yield* streamDetailedGenerator(); return; }
  if (streamDetailedEvents) { yield* streamDetailedEvents; return; }
  const text = await invokeAgent(...a);
  if (text) yield { delta: text as string };
}
vi.mock('@/lib/agentcore', () => ({
  invokeAgent: (...a: unknown[]) => invokeAgent(...a),
  invokeAgentDetailed: (...a: unknown[]) => invokeAgentDetailedImpl(...a),
  invokeAgentStream: (...a: unknown[]) => invokeAgentStreamImpl(...a),
  invokeAgentStreamDetailed: (...a: unknown[]) => invokeAgentStreamDetailedImpl(...a),
}));
const classifyRoute = vi.fn();
vi.mock('@/lib/route', () => ({
  pickGateway: (...a: unknown[]) => pickGateway(...a),
  classifyRoute: (...a: unknown[]) => classifyRoute(...a),
}));
const classifyPrompt = vi.fn();
// keep the real (pure, no-Bedrock) buildClassifierContext so the wiring test below exercises it.
vi.mock('@/lib/classifier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/classifier')>()),
  classifyPrompt: (...a: unknown[]) => classifyPrompt(...a),
}));
vi.mock('@/lib/catalog-source', () => ({ getEnabledCustomAgents: (...a: unknown[]) => getEnabledCustomAgents(...a) }));
vi.mock('@/lib/agent-resolver', () => ({
  pickCustomAgent: (...a: unknown[]) => pickCustomAgent(...a),
  resolveAgent: (...a: unknown[]) => resolveAgent(...a),
}));
vi.mock('@/lib/catalog', () => ({ isCustomAgentEnabled: (...a: unknown[]) => isCustomAgentEnabled(...a) }));
const getEnabledIntegrations = vi.fn();
vi.mock('@/lib/integrations', () => ({ getEnabledIntegrations: (...a: unknown[]) => getEnabledIntegrations(...a) }));
vi.mock('@/lib/trace', () => ({
  recordCustomAgentTrace: (...a: unknown[]) => recordCustomAgentTrace(...a),
  recordChatInvoke: vi.fn().mockResolvedValue(undefined), // fire-and-forget ops stat — not asserted here
}));
// v1-parity ports (2026-07-19): neutralize the new side-effect modules so existing route tests
// keep exercising the same paths — code route off (no interpreter), no Bedrock-direct fallback.
vi.mock('@/lib/code-interpreter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/code-interpreter')>()), // real isCodeIntent/extractPython
  getInterpreterId: vi.fn().mockResolvedValue(null),                     // never detour into the sandbox
}));
vi.mock('@/lib/bedrock-direct', () => ({
  bedrockDirectStream: vi.fn(() => { throw new Error('bedrock direct disabled in tests'); }),
}));
vi.mock('@/lib/accounts', () => ({
  validateAccountId: (id: string) => /^\d{12}$/.test(id),
  getAccount: vi.fn().mockResolvedValue(undefined), // unregistered ⇒ host default
}));
const recordExchange = vi.fn();
vi.mock('@/lib/chat-store', () => ({ recordExchange: (...a: unknown[]) => recordExchange(...a) }));
const listConfiguredSchemas = vi.fn();
vi.mock('@/lib/datasource-schema', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/datasource-schema')>()), // keep the real renderSchemaForPrompt
  listConfiguredSchemas: (...a: unknown[]) => listConfiguredSchemas(...a),
}));
const listDatasources = vi.fn();
vi.mock('@/lib/datasources', () => ({ listDatasources: (...a: unknown[]) => listDatasources(...a) }));
const synthesizeStream = vi.fn();
vi.mock('@/lib/synthesize', () => ({ synthesizeStream: (...a: unknown[]) => synthesizeStream(...a) }));
const assistantAnswer = vi.fn();
const isProductHelpIntent = vi.fn();
vi.mock('@/lib/assistant', () => ({
  assistantAnswer: (...a: unknown[]) => assistantAnswer(...a),
  isProductHelpIntent: (...a: unknown[]) => isProductHelpIntent(...a),
}));

function req(body: unknown, cookie = 'awsops_token=t', signal?: AbortSignal) {
  return new Request('http://x/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
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
  getEnabledCustomAgents.mockReset();
  pickCustomAgent.mockReset();
  resolveAgent.mockReset();
  isCustomAgentEnabled.mockReset();
  getEnabledIntegrations.mockReset();
  recordCustomAgentTrace.mockReset();
  // default to the built-in no-op shape
  getEnabledCustomAgents.mockResolvedValue([]);
  pickCustomAgent.mockReturnValue(null);
  isCustomAgentEnabled.mockResolvedValue(true); // ADR-039: authoritative re-check passes by default
  getEnabledIntegrations.mockResolvedValue([]); // ADR-039 P2: no integrations by default

  resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'ops', skill: 'ops', agentName: 'ops', skillHashes: [] });
  classifyRoute.mockReset();
  classifyRoute.mockResolvedValue({ primary: 'ops', ranked: [{ key: 'ops', score: 0, active: false }], method: 'regex' });
  classifyPrompt.mockReset();
  recordExchange.mockReset();
  recordExchange.mockResolvedValue(undefined);
  listConfiguredSchemas.mockReset(); listConfiguredSchemas.mockResolvedValue([]);
  listDatasources.mockReset(); listDatasources.mockResolvedValue([]);
  synthesizeStream.mockReset();
  // default: real-shaped async-generator returning a deterministic merged answer
  synthesizeStream.mockImplementation(async function* () { yield '합성된 답변'; });
  assistantAnswer.mockReset();
  assistantAnswer.mockResolvedValue('가이드 답변');
  isProductHelpIntent.mockReset();
  isProductHelpIntent.mockReturnValue(false); // default off so existing routing is unaffected
  delete process.env.HYBRID_ROUTING_ENABLED;
  delete process.env.MULTI_ROUTE_SYNTHESIS_ENABLED;
  streamDetailedEvents = null;
  streamDetailedGenerator = null;
});

afterEach(() => { delete process.env.HYBRID_ROUTING_ENABLED; delete process.env.MULTI_ROUTE_SYNTHESIS_ENABLED; });

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
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'cost', skill: 'cost', agentName: 'cost', skillHashes: [] });
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
  it('does NOT forward a client-supplied agentLoop to the agent (dark-path loop is server-side only)', async () => {
    // ADR-008/BASELINE §2 invariant: the env flag (ANTHROPIC_AGENT_LOOP_ENABLED) + a server-side
    // payload.agentLoop pick the loop — the BFF must never let a client request flip it. The route
    // builds an explicit InvokeInput (no body spread), so agentLoop can't leak; lock that here.
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('ops');
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'x', section: 'ops', sessionId: 's'.repeat(36), agentLoop: 'anthropic' }));
    expect(res.status).toBe(200);
    await readStream(res);
    const input = invokeAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(input).not.toHaveProperty('agentLoop');
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
  it('resolves a custom agent and forwards systemPromptOverride', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('security');
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance', tier: 'custom', enabled: true, routingKeywords: ['cis'], skills: [] }]);
    pickCustomAgent.mockReturnValue('compliance');
    resolveAgent.mockReturnValue({ tier: 'custom', gateway: 'security', systemPromptOverride: 'OVR', agentName: 'compliance', agentVersion: 2, skillHashes: ['h1'] });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'cis check', section: 'security', sessionId: 's'.repeat(36) }));
    expect(res.status).toBe(200);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ systemPromptOverride: 'OVR', agentName: 'compliance' }));
    const body = await readStream(res);
    expect(body).toContain('"agentName":"compliance"');
  });
  it('forwards each agent delta as its own SSE frame as it arrives (real streaming, not buffered-then-rechunked)', async () => {
    // Regression: the route used to await the FULL answer (invokeAgentDetailed) before writing
    // anything, then re-split it into word chunks and enqueue them all in one tick — the user sees
    // the whole answer appear at once regardless of how many chunks the loop produced. Asserting the
    // exact frame count (matching what the upstream agent yielded) forces the fix to forward each
    // delta live instead of buffering first.
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('cost');
    streamDetailedEvents = [{ delta: '이번 ' }, { delta: '달 비용은 ' }, { delta: '$4,210' }];
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: '비용', section: 'cost', sessionId: 's'.repeat(36) }));
    const body = await readStream(res);
    const deltaFrames = body.match(/data: \{"delta":/g) ?? [];
    expect(deltaFrames.length).toBe(3);
    expect(body).toContain('이번 ');
    expect(body).toContain('달 비용은 ');
    expect(body).toContain('$4,210');
  });
  it('surfaces tool/model provenance from the live stream in the footer meta event', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('cost');
    streamDetailedEvents = [
      { model: 'sonnet-4-6' },
      { delta: '답변' },
      { tool: 'get_cost' },
    ];
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: '비용', section: 'cost', sessionId: 's'.repeat(36) }));
    const body = await readStream(res);
    expect(body).toContain('"tools":["get_cost"]');
    expect(body).toContain('"model":"sonnet-4-6"');
  });
  it('does not persist a half-streamed answer when the client aborts mid-stream', async () => {
    // Regression: with live streaming, `text` is the incremental accumulation of deltas seen SO
    // FAR — if record() isn't guarded by the same abort check the sibling assistant/fanout paths
    // already use, a client disconnect persists a truncated "complete" answer to chat history.
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('cost');
    const ac = new AbortController();
    streamDetailedGenerator = async function* () {
      yield { delta: 'partial answer' };
      ac.abort(); // simulate the client disconnecting after the first frame
      yield { delta: ' never sent' };
    };
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: '비용', section: 'cost', sessionId: 's'.repeat(36) }, 'awsops_token=t', ac.signal));
    await readStream(res);
    expect(recordExchange).not.toHaveBeenCalled();
  });
  it('does not drop tool/model provenance when a single event carries multiple fields', async () => {
    // Regression: `if (ev.delta) ... else if (ev.tool) ... else if (ev.model)` assumed the fields
    // are mutually exclusive, but AgentEvent's type doesn't guarantee that — a frame carrying more
    // than one field silently dropped whichever came after the first matched branch.
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('cost');
    streamDetailedEvents = [{ delta: '답변', model: 'sonnet-4-6', tool: 'get_cost' }];
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: '비용', section: 'cost', sessionId: 's'.repeat(36) }));
    const body = await readStream(res);
    expect(body).toContain('"tools":["get_cost"]');
    expect(body).toContain('"model":"sonnet-4-6"');
  });
});

describe('hybrid routing (ADR-038)', () => {
  it('flag off: uses legacy pickGateway path, no classifyRoute call', async () => {
    delete process.env.HYBRID_ROUTING_ENABLED;
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('cost');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'cost', skill: 'cost', agentName: 'cost', skillHashes: [] });
    invokeAgent.mockResolvedValue('answer');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: '이번 달 비용', sessionId: 's'.repeat(36) }));
    const body = await readStream(res);
    expect(pickGateway).toHaveBeenCalled();
    expect(classifyRoute).not.toHaveBeenCalled();
    expect(body).toContain('"gateway":"cost"');
  });

  it('flag on: classifyRoute decides, meta carries ranked+method', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({
      primary: 'network',
      ranked: [
        { key: 'network', score: 0.9, active: true },
        { key: 'data', score: 0.5, active: false },
      ],
      method: 'llm',
    });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockResolvedValue('answer');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'EKS 파드가 RDS 연결 안돼', sessionId: 's'.repeat(36) }));
    const body = await readStream(res);
    expect(body).toContain('"method":"llm"');
    expect(body).toContain('"ranked":[{"key":"network"');
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'network' }));
  });

  it('feeds a bounded excerpt of the client history into the classifier (bug fix: context-blind follow-up misrouting)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({ primary: 'ops', ranked: [{ key: 'ops', score: 1, active: true }], method: 'llm', multiDomain: false, selected: [{ key: 'ops', score: 1, active: true }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'ops', skill: 'ops', agentName: 'ops', skillHashes: [] });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    const history = [
      { role: 'user' as const, content: 'CloudTrail로 모델 호출 조회해줘' },
      { role: 'assistant' as const, content: '3곳에서 호출되고 있습니다' },
    ];
    await readStream(await POST(req({ prompt: '클러스터 안에 어디서 저걸 쓰나', messages: history, sessionId: 's'.repeat(36) })));
    // classifyRoute is mocked (never actually invokes the classify callback), so pull the closure
    // route.ts built and call it directly — this is what proves route.ts wires history through.
    const opts = classifyRoute.mock.calls[0][2] as { classify: (p: string) => Promise<unknown> };
    await opts.classify('클러스터 안에 어디서 저걸 쓰나');
    expect(classifyPrompt).toHaveBeenCalledWith(expect.stringContaining('CloudTrail로 모델 호출 조회해줘'));
    expect(classifyPrompt).toHaveBeenCalledWith(expect.stringContaining('클러스터 안에 어디서 저걸 쓰나'));
  });

  it('flag on: EXPLICIT pin to an inactive section short-circuits with the honest 🔒 (ADR-044 §2)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    // user explicitly pinned /container → method:'pin' (an auto-routed inactive section now degrades
    // to the AWSops Assistant instead — see the 'AWSops Assistant' suite).
    classifyRoute.mockResolvedValue({
      primary: 'container',
      ranked: [{ key: 'container', score: 1, active: false }],
      method: 'pin', multiDomain: false, selected: [{ key: 'container', score: 1, active: false }],
    });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'container', skill: 'container', agentName: 'container', skillHashes: [] });
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: '파드 CrashLoop 원인', section: 'container', sessionId: 's'.repeat(36) }));
    const body = await readStream(res);
    expect(invokeAgent).not.toHaveBeenCalled();
    expect(assistantAnswer).not.toHaveBeenCalled();
    expect(body).toContain('P3'); // guidance delta mentions availability
    expect(body).toContain('[DONE]');
  });

  it('flag on: explicit pin beats custom agent (spec §2.2 precedence)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({ primary: 'security', ranked: [{ key: 'security', score: 1, active: true }], method: 'pin' });
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance' }]);
    pickCustomAgent.mockReturnValue('compliance'); // custom WOULD match...
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'run a CIS benchmark', section: 'security', sessionId: 's'.repeat(36) }));
    await readStream(res);
    // ...but the pin wins: resolveAgent called with the pinned section, not the custom name.
    // Phase 2: third arg is the per-account space (null here — no AURORA_ENDPOINT ⇒ Phase-1).
    expect(resolveAgent).toHaveBeenCalledWith('security', expect.anything(), null, [], []);
  });

  it('logs a structured misroute candidate when the client reports a chip switch (spec §5)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({ primary: 'security', ranked: [{ key: 'security', score: 1, active: true }], method: 'pin' });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('ok');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'q', section: 'security', switchedFrom: 'network', sessionId: 's'.repeat(36) })));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"misroute"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"from":"network"'));
    warn.mockRestore();
  });

  it('flag on: without a pin, custom agent still beats the classifier', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({ primary: 'security', ranked: [{ key: 'security', score: 1, active: true }], method: 'regex' });
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance' }]);
    pickCustomAgent.mockReturnValue('compliance');
    resolveAgent.mockReturnValue({ tier: 'custom', gateway: 'security', agentName: 'compliance', skillHashes: ['h'] });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'run a CIS benchmark', sessionId: 's'.repeat(36) }));
    await readStream(res);
  });

  it('fail-closed revocation: a disabled custom agent is NOT used — falls back to the gateway', async () => {
    delete process.env.HYBRID_ROUTING_ENABLED;            // hybrid off → gateway = pickGateway
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('security');
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance' }]); // 30s-stale cache still lists it
    pickCustomAgent.mockReturnValue('compliance');
    isCustomAgentEnabled.mockResolvedValue(false);        // authoritative Aurora check: revoked
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'run a CIS benchmark', sessionId: 's'.repeat(36) })));
    expect(isCustomAgentEnabled).toHaveBeenCalledWith('compliance');
    expect(resolveAgent).toHaveBeenCalledWith('security', expect.anything(), null, [], []); // gateway, not the revoked custom
  });

  it('ADR-039: passes ONLY enabled egress-READ integrations to resolveAgent, WITH connection details (ingress + READ_WRITE excluded)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({ primary: 'ops', ranked: [{ key: 'ops', score: 1, active: true }], method: 'regex' });
    getEnabledIntegrations.mockResolvedValue([
      { name: 'dd', direction: 'egress', capability: 'read', exposedTools: ['datadog_query'], providedContext: { d: 1 },
        endpoint: 'https://mcp.dd/mcp', transport: 'api_key', credentialsRef: 'arn:dd' },
      { name: 'notion', direction: 'egress', capability: 'read_write', exposedTools: ['notion_write'], providedContext: {}, writeActionRefs: ['notion.create_page'] }, // write → propose-only (5th arg), NOT tool-injected (4th)
      { name: 'pd', direction: 'ingress', capability: 'read', exposedTools: [], providedContext: {} },                       // ingress → excluded
    ]);
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    // 4th arg = ONLY the egress+read integration (with connection details + allowPrivate=false);
    // 5th arg = the READ_WRITE integration as PROPOSE-ONLY (never tool-injected). ADR-040/041.
    expect(resolveAgent).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), null,
      [{ name: 'dd', exposedTools: ['datadog_query'], providedContext: { d: 1 },
         endpoint: 'https://mcp.dd/mcp', transport: 'api_key', credentialsRef: 'arn:dd', allowPrivate: false }],
      [{ name: 'notion', writeActionRefs: ['notion.create_page'] }],
    );
  });

  it('ADR-039 P2-infra inc2: forwards spec.integrations to invokeAgent', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('security');
    const integrations = [{ name: 'dd', endpoint: 'https://mcp.dd/mcp', transport: 'api_key', credentialsRef: 'arn:dd', exposedTools: ['datadog_query'], allowPrivate: false }];
    resolveAgent.mockReturnValue({ tier: 'custom', gateway: 'security', agentName: 'sec-custom', skillHashes: [], systemPromptOverride: 'X', toolAllowlist: ['datadog_query'], integrations });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ integrations }));
  });
});

describe('thread persistence', () => {
  it('emits threadId in meta and records the exchange after a successful invoke', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    pickGateway.mockReturnValue('security');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('answer');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: '질문', sessionId: 's'.repeat(36) })));
    expect(body).toContain('"threadId":"');
    expect(recordExchange).toHaveBeenCalledWith(expect.objectContaining({
      userSub: 'u1', userContent: '질문', assistantContent: 'answer', gateway: 'security',
    }));
  });

  it('reuses a provided threadId', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    pickGateway.mockReturnValue('security');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('ok');
    const tid = '123e4567-e89b-42d3-a456-426614174000';
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'q', threadId: tid, sessionId: 's'.repeat(36) })));
    expect(body).toContain(`"threadId":"${tid}"`);
    expect(recordExchange).toHaveBeenCalledWith(expect.objectContaining({ threadId: tid }));
  });

  it('does not record when the agent invoke fails, and chat still streams the error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    pickGateway.mockReturnValue('security');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockRejectedValue(new Error('boom'));
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(body).toContain('[DONE]');
    expect(recordExchange).not.toHaveBeenCalled();
  });

  it('records the inactive-section 🔒 guidance exchange too (explicit pin, spec §3)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u1' });
    classifyRoute.mockResolvedValue({ primary: 'container', ranked: [{ key: 'container', score: 1, active: false }], method: 'pin', multiDomain: false, selected: [{ key: 'container', score: 1, active: false }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'container', skill: 'container', agentName: 'container', skillHashes: [] });
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: '파드 CrashLoop 원인', section: 'container', sessionId: 's'.repeat(36) })));
    expect(invokeAgent).not.toHaveBeenCalled();
    expect(recordExchange).toHaveBeenCalledWith(expect.objectContaining({
      userContent: '파드 CrashLoop 원인',
      assistantContent: expect.stringContaining('P3'),
    }));
  });

  it('a rejecting recordExchange does not break the SSE stream (defensive)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    pickGateway.mockReturnValue('security');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('answer');
    recordExchange.mockRejectedValue(new Error('store blew up'));
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(body).toContain('answer');
    expect(body).toContain('[DONE]');
  });
});

describe('ADR-031 Phase 2 — per-account space wiring', () => {
  it('resolves the account and threads accountId into the custom-agent loader, resolver, and invoke', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('ops');
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'status', sessionId: 's'.repeat(36) })));
    // account resolves to the single-account default ('self') with no HOST_ACCOUNT_ID set.
    expect(getEnabledCustomAgents).toHaveBeenCalledWith('self');
    // no AURORA_ENDPOINT ⇒ getAgentSpace returns null ⇒ resolver gets null (Phase-1 behavior).
    expect(resolveAgent).toHaveBeenCalledWith('ops', expect.anything(), null, [], []);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'self' }));
  });

  it('built-in path is unchanged: no spaceVersion in meta, PONG-style passthrough still streams', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('ops');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'ops', skill: 'ops', agentName: 'ops', skillHashes: [] });
    invokeAgent.mockResolvedValue('PONG');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'ping', sessionId: 's'.repeat(36) })));
    expect(body).toContain('PONG');
    expect(body).toContain('[DONE]');
    expect(body).not.toContain('spaceVersion'); // built-in meta carries no space influence
    expect(body).not.toContain('customAgent');
  });

  it('custom path surfaces spaceVersion in meta and the trace (when the resolver carries one)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('security');
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance', tier: 'custom', enabled: true, routingKeywords: ['cis'], skills: [] }]);
    pickCustomAgent.mockReturnValue('compliance');
    resolveAgent.mockReturnValue({ tier: 'custom', gateway: 'security', systemPromptOverride: 'OVR', agentName: 'compliance', agentVersion: 2, skillHashes: ['h1'], spaceVersion: 7 });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'cis check', section: 'security', sessionId: 's'.repeat(36) })));
    expect(body).toContain('"spaceVersion":7');
    expect(recordCustomAgentTrace).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'compliance', spaceVersion: 7 }));
  });
});


describe('request body bound (OOM guard)', () => {
  it('413 on an oversized body before parse', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
    const { POST } = await import('./route');
    const resp = await POST(req({ prompt: 'x'.repeat(600_000) })); // > 512KB chat cap
    expect(resp.status).toBe(413);
    expect(invokeAgent).not.toHaveBeenCalled();
  });
});

describe('malformed body.messages (bug fix, PR #138 review MINOR)', () => {
  it('a non-array `messages` is dropped, not forwarded, and does not break the request', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('ops');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'ops', skill: 'ops', agentName: 'ops', skillHashes: [] });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'q', messages: 'not-an-array', sessionId: 's'.repeat(36) }));
    expect(res.status).toBe(200);
    await readStream(res);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ messages: [{ role: 'user', content: 'q' }] }));
  });

  it('an entry with non-string content is dropped, the rest of the array survives', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('ops');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'ops', skill: 'ops', agentName: 'ops', skillHashes: [] });
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    const res = await POST(req({
      prompt: 'q',
      messages: [{ role: 'user', content: 'fine' }, { role: 'user', content: 12345 }],
      sessionId: 's'.repeat(36),
    }));
    expect(res.status).toBe(200);
    await readStream(res);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: 'user', content: 'fine' }, { role: 'user', content: 'q' }],
    }));
  });
});

describe('datasource schema injection', () => {
  it('injects cached schemas as extraContext for the monitoring gateway', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'monitoring', skill: 'monitoring', agentName: 'monitoring', skillHashes: [] });
    classifyRoute.mockResolvedValue({ primary: 'monitoring', ranked: [{ key: 'monitoring', score: 1, active: true }], method: 'regex' });
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 1, kind: 'prometheus', schema: { metrics: ['up'], labels: ['job'] }, fetched_at: 't' }]);
    listDatasources.mockResolvedValue([{ id: 1, name: 'prod-prom', kind: 'prometheus', endpoint: 'http://p', authType: 'none', isDefault: true, enabled: true }]);
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'what is up' })));
    const arg = invokeAgent.mock.calls.at(-1)![0] as { extraContext?: string };
    expect(arg.extraContext).toContain('Datasource schemas');
    expect(arg.extraContext).toContain('prometheus'); // kind label
    expect(arg.extraContext).toContain('prod-prom');  // instance name label
  });

  it('injects ONLY the default instance per kind (no duplicate same-kind instances)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'monitoring', skill: 'monitoring', agentName: 'monitoring', skillHashes: [] });
    classifyRoute.mockResolvedValue({ primary: 'monitoring', ranked: [{ key: 'monitoring', score: 1, active: true }], method: 'regex' });
    // two prometheus instances cached; only id=1 is the default
    listConfiguredSchemas.mockResolvedValue([
      { integrationId: 1, kind: 'prometheus', schema: { metrics: ['up'] }, fetched_at: 't' },
      { integrationId: 2, kind: 'prometheus', schema: { metrics: ['down'] }, fetched_at: 't' },
    ]);
    listDatasources.mockResolvedValue([
      { id: 1, name: 'prod-prom', kind: 'prometheus', endpoint: 'http://p1', authType: 'none', isDefault: true, enabled: true },
      { id: 2, name: 'stg-prom', kind: 'prometheus', endpoint: 'http://p2', authType: 'none', isDefault: false, enabled: true },
    ]);
    invokeAgent.mockResolvedValue('ok');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'what is up' })));
    const ctx = (invokeAgent.mock.calls.at(-1)![0] as { extraContext?: string }).extraContext ?? '';
    expect(ctx).toContain('prod-prom');     // default injected
    expect(ctx).not.toContain('stg-prom');  // non-default NOT injected
  });
});

describe('cross-domain auto-synthesis (ADR-044)', () => {
  const multiRoute = {
    primary: 'network',
    ranked: [{ key: 'network', score: 0.9, active: true }, { key: 'data', score: 0.6, active: true }],
    method: 'llm' as const,
    multiDomain: true,
    selected: [{ key: 'network', score: 0.9, active: true }, { key: 'data', score: 0.6, active: true }],
  };

  it('flag OFF: multiDomain route still uses the single path (regression lock)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    // MULTI_ROUTE_SYNTHESIS_ENABLED intentionally unset
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue(multiRoute);
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockResolvedValue('single answer');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'EKS 파드가 RDS 연결 안돼', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(invokeAgent).toHaveBeenCalledTimes(1);
    expect(body).not.toContain('합성된 답변'); // single path, not the synth output
  });

  it('flag ON + multiDomain: fans out per-gateway and synthesizes', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue(multiRoute);
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockImplementation(async ({ gateway }: { gateway: string }) => `ans-${gateway}`);
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'EKS 파드가 RDS 연결 안돼', sessionId: 's'.repeat(36) })));
    // gate CRITICAL: one invoke per selected gateway, each with its OWN gateway
    expect(invokeAgent).toHaveBeenCalledTimes(2);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'network' }));
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'data' }));
    // synthesize gets BOTH survivors (3rd arg is the {abortSignal} opts)
    expect(synthesizeStream.mock.calls[0][0]).toBe('EKS 파드가 RDS 연결 안돼');
    expect(synthesizeStream.mock.calls[0][1]).toEqual([
      { gateway: 'network', text: 'ans-network' },
      { gateway: 'data', text: 'ans-data' },
    ]);
    expect(body).toContain('합성된 답변');
    expect(body).toContain('"via":"multi:network+data"'); // gate MINOR: via in meta
    expect(body).toContain('[DONE]');
  });

  it('threads cached datasource schema into the monitoring/data fan-out invokes only', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue(multiRoute); // selected [network, data] — data is an observability gateway
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 1, kind: 'prometheus', schema: { metrics: ['up'] }, fetched_at: 't' }]);
    listDatasources.mockResolvedValue([{ id: 1, name: 'prod-prom', kind: 'prometheus', endpoint: 'http://p', authType: 'none', isDefault: true, enabled: true }]);
    invokeAgent.mockImplementation(async ({ gateway }: { gateway: string }) => `ans-${gateway}`);
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'x', sessionId: 's'.repeat(36) })));
    const calls = invokeAgent.mock.calls.map((c) => c[0] as { gateway: string; extraContext?: string });
    expect(calls.find((c) => c.gateway === 'data')!.extraContext).toContain('prometheus'); // obs gateway gets the cache
    expect(calls.find((c) => c.gateway === 'network')!.extraContext).toBeUndefined();        // non-obs does not
  });

  it('one gateway fails: synthesize runs over the survivor only', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue(multiRoute);
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockImplementation(async ({ gateway }: { gateway: string }) =>
      gateway === 'data' ? Promise.reject(new Error('data down')) : 'ans-network');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream.mock.calls[0][1]).toEqual([{ gateway: 'network', text: 'ans-network' }]);
  });

  it('all gateways fail: emits an error frame, no synthesis', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue(multiRoute);
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockRejectedValue(new Error('all down'));
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(body).toContain('"error"');
  });

  it('custom-agent pick suppresses fan-out even on a multiDomain route', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue(multiRoute);
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance', tier: 'custom', enabled: true, routingKeywords: ['cis'], skills: [] }]);
    pickCustomAgent.mockReturnValue('compliance');
    resolveAgent.mockReturnValue({ tier: 'custom', gateway: 'security', systemPromptOverride: 'OVR', agentName: 'compliance', skillHashes: [] });
    invokeAgent.mockResolvedValue('custom answer');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'cis check', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(invokeAgent).toHaveBeenCalledTimes(1);
    expect(body).not.toContain('합성된 답변'); // single path, not the synth output
  });

  it('gate MAJOR: recomputes multiDomain from ACTIVE selected — a stale inactive entry is dropped', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({
      primary: 'network',
      ranked: [{ key: 'network', score: 0.9, active: true }, { key: 'container', score: 0.6, active: false }],
      method: 'llm', multiDomain: true,
      selected: [{ key: 'network', score: 0.9, active: true }, { key: 'container', score: 0.6, active: false }],
    });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockResolvedValue('single');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled(); // only network is active ⇒ <2 ⇒ no synthesis
    expect(invokeAgent).toHaveBeenCalledTimes(1);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'network' }));
  });

  it('pin wins over fan-out: a pinned route never synthesizes', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({
      primary: 'cost', ranked: [{ key: 'cost', score: 1, active: true }], method: 'pin',
      multiDomain: false, selected: [{ key: 'cost', score: 1, active: true }],
    });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'cost', skill: 'cost', agentName: 'cost', skillHashes: [] });
    invokeAgent.mockResolvedValue('pinned');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'EKS RDS 연결', section: 'cost', switchedFrom: 'network', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(invokeAgent).toHaveBeenCalledTimes(1);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'cost' }));
  });

  it('explicit pin to an ENABLED custom agent is honored (ADR-044 §2 — pin > keyword/classifier)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    getEnabledCustomAgents.mockResolvedValue([{ name: 'compliance', tier: 'custom', enabled: true, routingKeywords: [], skills: [] }]);
    isCustomAgentEnabled.mockResolvedValue(true);
    // classifier would pick something else, and there is no keyword match — the pin must still win
    classifyRoute.mockResolvedValue({ primary: 'network', ranked: [{ key: 'network', score: 0.9, active: true }, { key: 'data', score: 0.6, active: true }], method: 'llm', multiDomain: true, selected: [{ key: 'network', score: 0.9, active: true }, { key: 'data', score: 0.6, active: true }] });
    resolveAgent.mockReturnValue({ tier: 'custom', gateway: 'security', systemPromptOverride: 'OVR', agentName: 'compliance', skillHashes: [] });
    invokeAgent.mockResolvedValue('custom pinned answer');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'EKS RDS 연결 안돼', section: 'compliance', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled();         // explicit pin suppresses fan-out
    expect(resolveAgent.mock.calls[0][0]).toBe('compliance'); // pin routed to the custom agent (not the classifier's 'network')
    expect(invokeAgent).toHaveBeenCalledTimes(1);
    expect(invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'compliance' }));
    expect(body).toContain('"agentName":"compliance"');
  });

  it('explicit pin to a DISABLED/absent custom agent ⇒ honest message, no silent fallback (ADR-044 §2)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    getEnabledCustomAgents.mockResolvedValue([]); // 'ghost' is not an enabled agent in this space
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: '아무거나', section: 'ghost', sessionId: 's'.repeat(36) })));
    expect(invokeAgent).not.toHaveBeenCalled();      // no silent fallback to keyword/classifier
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(body).toContain('ghost');
    expect(body).toContain('사용할 수 없습니다');
    expect(body).toContain('[DONE]');
  });

  it('thread is agent-agnostic: same threadId across two turns to different gateways (ADR-044 §4)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    const tid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    invokeAgent.mockResolvedValue('a');
    const { POST } = await import('./route');
    // turn 1 → cost
    classifyRoute.mockResolvedValue({ primary: 'cost', ranked: [{ key: 'cost', score: 1, active: true }], method: 'pin', multiDomain: false, selected: [{ key: 'cost', score: 1, active: true }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'cost', skill: 'cost', agentName: 'cost', skillHashes: [] });
    await readStream(await POST(req({ prompt: '비용', section: 'cost', threadId: tid, sessionId: 's'.repeat(36) })));
    // turn 2 → network, SAME thread
    classifyRoute.mockResolvedValue({ primary: 'network', ranked: [{ key: 'network', score: 1, active: true }], method: 'pin', multiDomain: false, selected: [{ key: 'network', score: 1, active: true }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    await readStream(await POST(req({ prompt: '연결', section: 'network', threadId: tid, sessionId: 's'.repeat(36) })));
    const calls = recordExchange.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ threadId: tid, gateway: 'cost' });
    expect(calls[1]).toMatchObject({ threadId: tid, gateway: 'network' }); // same thread, different agent
  });

  it('only one active selected route: no fan-out (single path)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    classifyRoute.mockResolvedValue({
      primary: 'network',
      ranked: [{ key: 'network', score: 0.9, active: true }, { key: 'container', score: 0.6, active: false }],
      method: 'llm', multiDomain: false,
      selected: [{ key: 'network', score: 0.9, active: true }],
    });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'network', skill: 'network', agentName: 'network', skillHashes: [] });
    invokeAgent.mockResolvedValue('single');
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(invokeAgent).toHaveBeenCalledTimes(1);
  });
});

describe('AWSops Assistant (product help + inactive fallback)', () => {
  it('product-help intent → AWSops Assistant, not an AWS section agent', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    process.env.MULTI_ROUTE_SYNTHESIS_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    isProductHelpIntent.mockReturnValue(true);
    classifyRoute.mockResolvedValue({ primary: 'observability', ranked: [{ key: 'observability', score: 0.9, active: false }], method: 'regex', multiDomain: false, selected: [{ key: 'observability', score: 0.9, active: false }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'observability', skill: 'observability', agentName: 'observability', skillHashes: [] });
    assistantAnswer.mockResolvedValue('1) Integrations에서 Prometheus 등록 2) Skill 작성 3) Agent 생성');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'prometheus 분석 agent 만들기 /customization', sessionId: 's'.repeat(36) })));
    expect(assistantAnswer).toHaveBeenCalledWith('prometheus 분석 agent 만들기 /customization', { history: [] });
    expect(invokeAgent).not.toHaveBeenCalled();
    expect(synthesizeStream).not.toHaveBeenCalled();
    expect(body).toContain('Prometheus'); // single token survives typewriter chunk()
    expect(body).toContain('"assistant":true');
    expect(body).toContain('"gateway":"assistant"');
    expect(body).not.toContain('🔒');
  });

  it('auto-routed INACTIVE section degrades to the Assistant (no 🔒 dead-end)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    isProductHelpIntent.mockReturnValue(false);
    // classifier auto-routed (method:'regex') to an inactive section (container)
    classifyRoute.mockResolvedValue({ primary: 'container', ranked: [{ key: 'container', score: 0.9, active: false }], method: 'regex', multiDomain: false, selected: [{ key: 'container', score: 0.9, active: false }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'container', skill: 'container', agentName: 'container', skillHashes: [] });
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: '파드 CrashLoop 원인', sessionId: 's'.repeat(36) })));
    expect(assistantAnswer).toHaveBeenCalled();
    expect(body).toContain('답변'); // chunk() splits on spaces
    expect(body).not.toContain('🔒'); // no dead-end
    expect(invokeAgent).not.toHaveBeenCalled();
  });

  it('EXPLICIT pin to an inactive section keeps the honest 🔒 message (not the Assistant)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    isProductHelpIntent.mockReturnValue(false);
    // user pinned an inactive section (/container) → classifyRoute returns method:'pin'
    classifyRoute.mockResolvedValue({ primary: 'container', ranked: [{ key: 'container', score: 1, active: false }], method: 'pin', multiDomain: false, selected: [{ key: 'container', score: 1, active: false }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'container', skill: 'container', agentName: 'container', skillHashes: [] });
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: '아무거나', section: 'container', sessionId: 's'.repeat(36) })));
    expect(assistantAnswer).not.toHaveBeenCalled();
    expect(body).toContain('🔒'); // explicit choice → honest unavailable message
  });

  it('degrade-to-assistant fallback forwards the client history (bug fix: was context-blind)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    isProductHelpIntent.mockReturnValue(false);
    classifyRoute.mockResolvedValue({ primary: 'container', ranked: [{ key: 'container', score: 0.9, active: false }], method: 'regex', multiDomain: false, selected: [{ key: 'container', score: 0.9, active: false }] });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'container', skill: 'container', agentName: 'container', skillHashes: [] });
    const history = [{ role: 'user' as const, content: '이전 질문' }, { role: 'assistant' as const, content: '이전 답변' }];
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: '파드 CrashLoop 원인', messages: history, sessionId: 's'.repeat(36) })));
    expect(assistantAnswer).toHaveBeenCalledWith('파드 CrashLoop 원인', { history });
  });
});

describe('typewriter delay and progressive status events', () => {
  it('has no artificial playback delay by default when env is unset', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('ops');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'ops', skill: 'ops', agentName: 'ops', skillHashes: [] });
    invokeAgent.mockResolvedValue('Hello World');

    const { POST } = await import('./route');
    const t0 = Date.now();
    const res = await POST(req({ prompt: 'hello', sessionId: 's'.repeat(36) }));
    await readStream(res);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(20);
  });

  it('emits event: status phase: analyzing frame before content delta and carries no delta key', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    pickGateway.mockReturnValue('ops');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'ops', skill: 'ops', agentName: 'ops', skillHashes: [] });
    invokeAgent.mockResolvedValue('Hello World');

    const { POST } = await import('./route');
    const res = await POST(req({ prompt: 'hello', sessionId: 's'.repeat(36) }));
    expect(res.status).toBe(200);

    const body = await readStream(res);

    expect(body).toContain('event: status\ndata: {"phase":"analyzing"}');

    const frames = body.split('\n\n').filter(Boolean);
    const statusFrames = frames.filter(f => f.includes('event: status'));
    expect(statusFrames.length).toBeGreaterThanOrEqual(1);

    for (const frame of statusFrames) {
      expect(frame).not.toContain('"delta"');
    }

    const deltaFrames = frames.filter(f => f.includes('data: {"delta":'));
    expect(deltaFrames.length).toBeGreaterThan(0);
    expect(body).toContain('[DONE]');
  });
});

// pentest-remediation P3-1: the client-supplied sessionId used to flow straight into the AgentCore
// Memory runtimeSessionId with only a length check — a client that knew (or guessed) another user's
// sub could attach to that user's memory session. (Finding 6 itself was a false positive — see
// web/lib/chat-store.test.ts / lib/chat-store.ts, correctly scoped by user_sub everywhere — but this
// sessionId-trust gap was real and separate.) The runtimeSessionId actually used must always be
// namespaced under the CALLER's own sub, never the raw client value.
describe('chat sessionId — bound to the caller, never client-trusted', () => {
  beforeEach(() => {
    pickGateway.mockReturnValue('ops');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'ops', skill: 'ops', agentName: 'ops', skillHashes: [] });
    invokeAgent.mockResolvedValue('ok');
  });

  it('never forwards the raw client-supplied sessionId as the runtime session id', async () => {
    verifyUser.mockResolvedValue({ sub: 'victim-sub' });
    const { POST } = await import('./route');
    // An attacker who somehow obtained another principal's sessionId string cannot make the
    // server use it verbatim — it must always be re-namespaced under the CALLER's own sub.
    const smuggled = 'awsops-someone-elses-sub-000000000000000000000000';
    await readStream(await POST(req({ prompt: 'hi', sessionId: smuggled })));
    const used = invokeAgent.mock.calls.at(-1)?.[0]?.sessionId as string;
    expect(used).not.toBe(smuggled);
    expect(used.startsWith('awsops-victim-sub-')).toBe(true);
  });

  it('is deterministic per client value (session continuity across turns for the same tab)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    const { POST } = await import('./route');
    const clientSid = 'abc123-def456-tab-uuid-0000000000000000';
    await readStream(await POST(req({ prompt: 'turn 1', sessionId: clientSid })));
    const first = invokeAgent.mock.calls.at(-1)?.[0]?.sessionId;
    await readStream(await POST(req({ prompt: 'turn 2', sessionId: clientSid })));
    const second = invokeAgent.mock.calls.at(-1)?.[0]?.sessionId;
    expect(first).toBe(second);
  });

  it('two different users supplying the SAME client sessionId never collide', async () => {
    const { POST } = await import('./route');
    const sharedClientSid = 'guessable-or-leaked-session-id-000000000';
    verifyUser.mockResolvedValue({ sub: 'user-a' });
    await readStream(await POST(req({ prompt: 'hi', sessionId: sharedClientSid })));
    const a = invokeAgent.mock.calls.at(-1)?.[0]?.sessionId;
    verifyUser.mockResolvedValue({ sub: 'user-b' });
    await readStream(await POST(req({ prompt: 'hi', sessionId: sharedClientSid })));
    const b = invokeAgent.mock.calls.at(-1)?.[0]?.sessionId;
    expect(a).not.toBe(b);
  });

  it('falls back to the deterministic per-user default when sessionId is absent', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-2' });
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'hi' })));
    const used = invokeAgent.mock.calls.at(-1)?.[0]?.sessionId as string;
    const expectedEntropy = createHash('sha256').update('').digest('hex').slice(0, 32);
    expect(used).toBe(`awsops-u-2-${expectedEntropy}`);
  });

  // PR #200 review MAJOR-1 (2nd round, confirmed against a real-length sub): the old derivation
  // sliced the first 32 chars of the RAW input string rather than hashing it. A real Cognito sub
  // is a 36-char UUID, so OWN_PREFIX alone is 44 chars — longer than that slice — meaning any
  // "awsops-"-prefixed-but-invalid input collapsed onto a constant made only of prefix text,
  // regardless of what came after character 32. A hash-based derivation must never do this: two
  // inputs sharing a long common prefix but differing later must still derive different sessions.
  it('does not collapse distinct inputs that share a long common prefix (realistic 36-char sub)', async () => {
    const realSub = 'a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c'; // 36 chars, like a real Cognito sub
    verifyUser.mockResolvedValue({ sub: realSub });
    const { POST } = await import('./route');
    const prefix = `awsops-${realSub}-`; // 44 chars — longer than the old slice(0, 32)
    await readStream(await POST(req({ prompt: 'hi', sessionId: `${prefix}thread-one-distinguishing-tail` })));
    const first = invokeAgent.mock.calls.at(-1)?.[0]?.sessionId as string;
    await readStream(await POST(req({ prompt: 'hi', sessionId: `${prefix}thread-two-distinguishing-tail` })));
    const second = invokeAgent.mock.calls.at(-1)?.[0]?.sessionId as string;
    expect(first).not.toBe(second);
  });

  // PR #200 review (confirmed against base): recordExchange() persists the derived sessionId into
  // chat_threads.session_id, and useChat.ts's selectThread() echoes data.thread.sessionId straight
  // back as the NEXT request's body.sessionId — not the original raw client UUID. A naive
  // "always re-prefix" derivation double-prefixes on that round-trip and, after enough thread
  // resumes, collapses every thread for a user onto one fixed runtimeSessionId. This simulates the
  // real round-trip (server output → next input), not just resending the same raw client value.
  it('is idempotent across a thread-resume round-trip: feeding the SERVER-DERIVED id back as the next sessionId must not re-prefix it', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-3' });
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'turn 1', sessionId: 'fresh-client-uuid-0000000000000' })));
    const derived = invokeAgent.mock.calls.at(-1)?.[0]?.sessionId as string;
    // This is exactly what selectThread() + the next send() does: the stored/returned composite
    // comes back as body.sessionId verbatim.
    await readStream(await POST(req({ prompt: 'turn 2 (thread resumed)', sessionId: derived })));
    const afterResume = invokeAgent.mock.calls.at(-1)?.[0]?.sessionId as string;
    expect(afterResume).toBe(derived);
    // And it stays stable across many resumes (no convergence toward a per-user fixed point).
    await readStream(await POST(req({ prompt: 'turn 3 (resumed again)', sessionId: afterResume })));
    expect(invokeAgent.mock.calls.at(-1)?.[0]?.sessionId).toBe(derived);
  });

  it('reuses a client-supplied own-prefix value verbatim when its entropy is a valid 32-hex derivation shape (still scoped to the caller)', async () => {
    // Belt-and-suspenders: even a client that HAND-CRAFTS a string starting with its own
    // `awsops-<own-sub>-` prefix only ever reuses ITS OWN namespace — never another user's.
    verifyUser.mockResolvedValue({ sub: 'u-4' });
    const { POST } = await import('./route');
    const handCrafted = `awsops-u-4-${'ab12'.repeat(8)}`; // 32 lowercase hex chars
    await readStream(await POST(req({ prompt: 'hi', sessionId: handCrafted })));
    expect(invokeAgent.mock.calls.at(-1)?.[0]?.sessionId).toBe(handCrafted);
  });

  // PR #200 review MAJOR-1 (confirmed against base): the own-prefix fast path used to accept ANY
  // value starting with OWN_PREFIX verbatim, with zero length/charset validation — contradicting
  // agentcore.ts's own "never pass a raw client-supplied value through untouched" contract. An
  // authenticated caller could suffix its own prefix with megabytes/newlines/unicode straight into
  // InvokeAgentRuntime + the Aurora session_id column (self-DoS + row bloat).
  it('rejects an own-prefixed value whose remainder is not charset/length-safe, re-deriving instead', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-5' });
    const { POST } = await import('./route');
    const tooLong = `awsops-u-5-${'a'.repeat(500)}`;
    await readStream(await POST(req({ prompt: 'hi', sessionId: tooLong })));
    const used = invokeAgent.mock.calls.at(-1)?.[0]?.sessionId as string;
    expect(used).not.toBe(tooLong);
    expect(used.startsWith('awsops-u-5-')).toBe(true);
    expect(used.length).toBeLessThan(tooLong.length);

    const badCharset = 'awsops-u-5-has spaces and\nnewlines';
    await readStream(await POST(req({ prompt: 'hi', sessionId: badCharset })));
    const used2 = invokeAgent.mock.calls.at(-1)?.[0]?.sessionId as string;
    expect(used2).not.toBe(badCharset);
    expect(used2.startsWith('awsops-u-5-')).toBe(true);
  });
});

