import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query, invoke, record, help } = vi.hoisted(() => ({
  query: vi.fn(), invoke: vi.fn(), record: vi.fn(), help: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
vi.mock('@/lib/auth', () => ({ verifyUser: async () => ({ sub: 'policy-test-user' }) }));
vi.mock('@/lib/agentcore', () => ({
  invokeAgent: invoke,
  invokeAgentStreamDetailed: async function* (input: unknown) {
    invoke(input);
    yield { delta: 'local answer' };
  },
}));
vi.mock('@/lib/code-interpreter', () => ({ isCodeIntent: () => false }));
vi.mock('@/lib/classifier', () => ({
  buildClassifierContext: (_history: unknown, prompt: string) => prompt,
  classifyPrompt: async () => { throw new Error('Unexpected model call'); },
}));
vi.mock('@/lib/trace', () => ({
  recordCustomAgentTrace: async () => {}, recordChatInvoke: async () => {},
}));
vi.mock('@/lib/chat-store', () => ({ recordExchange: record }));
vi.mock('@/lib/assistant', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/assistant')>()),
  assistantAnswer: help,
}));
import { POST } from './route';
import * as sections from '@/lib/sections';

let policyFailure: 'space' | 'catalog' | undefined;
let enablement: 'enabled' | 'disabled' | 'unavailable';
const reads: string[] = [];
beforeEach(() => {
  vi.stubEnv('AURORA_ENDPOINT', 'local-fixture');
  vi.stubEnv('HYBRID_ROUTING_ENABLED', 'true');
  vi.stubEnv('MULTI_ROUTE_SYNTHESIS_ENABLED', 'false');
  enablement = 'enabled';
  policyFailure = undefined;
  reads.length = 0;
  invoke.mockReset();
  record.mockReset().mockResolvedValue(undefined);
  help.mockReset().mockResolvedValue('Product help without custom execution');
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT 1 FROM agents')) {
      reads.push('enablement');
      if (enablement === 'unavailable') throw new Error('final query failed');
      return { rows: enablement === 'enabled' ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('FROM integrations i')) {
      reads.push('integrations');
      return { rows: [] };
    }
    if (sql.includes('FROM agent_spaces')) {
      reads.push('space');
      if (policyFailure === 'space') throw new Error('private policy error');
      return { rows: [{ account_id: 'self', enabled_agent_ids: [1], enabled_skill_ids: [],
        enabled_integration_ids: [], tool_allowlist: ['get_role_details'], version: 1 }] };
    }
    if (sql.includes('FROM agents a')) {
      reads.push('catalog');
      if (policyFailure === 'catalog') throw new Error('private policy error');
      return { rows: [{ id: 1, name: 'compliance', description: 'Compliance', persona: 'CUSTOM_POLICY',
        gateway: 'security', gateways: ['security'], tier: 'custom', enabled: true, version: 1,
        routing_keywords: ['IAM'], tool_policy_configured: true,
        skills: [{ name: 'audit', instructions: 'CUSTOM_SKILL', content_hash: 'hash', ord: 0,
          tool_allowlist: ['list_users'] }] }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function chat(section?: string, prompt = 'IAM users') {
  const response = await POST(new Request('http://localhost/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: 'awsops_token=test' },
    body: JSON.stringify({ prompt, section, lang: 'en' }),
  }));
  const text = await response.text();
  const answer = text.split('\n').filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice(6)).delta ?? '').join('');
  return { response, text, answer };
}

describe('final custom-agent enablement availability', () => {
  it('denies an unavailable automatic custom candidate and discloses independent builtin routing', async () => {
    enablement = 'unavailable';
    const { response, text } = await chat();
    expect(response.status).toBe(200);
    expect(text).toContain('using built-in routing');
    expect(text).toContain('"tier":"builtin"');
    expect(text).not.toMatch(/final query failed|CUSTOM_POLICY|CUSTOM_SKILL/);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'security', gateway: 'security', toolAllowlist: undefined,
      systemPromptOverride: undefined,
    }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      assistantContent: expect.stringContaining('using built-in routing'),
      gateway: 'security',
    }));
    expect(record.mock.calls[0][0].meta).not.toHaveProperty('customAgent');
  });

  it('does not substitute an unavailable explicit custom pin', async () => {
    enablement = 'unavailable';
    const { response, text } = await chat('compliance');
    expect(response.status).toBe(200);
    expect(text).toContain('temporarily unavailable');
    expect(text).toContain('[DONE]');
    expect(text).not.toContain('using built-in routing');
    expect(text).not.toContain('final query failed');
    expect(invoke).not.toHaveBeenCalled();
    expect(help).not.toHaveBeenCalled();
  });

  it('answers product help before consulting final custom enablement', async () => {
    enablement = 'unavailable';
    const { response, text, answer } = await chat(undefined, 'IAM custom agent setup');
    expect(response.status).toBe(200);
    expect(answer).toBe('Product help without custom execution');
    expect(text).toContain('AWSops Assistant');
    expect(reads).not.toContain('enablement');
    expect(invoke).not.toHaveBeenCalled();
    expect(help).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'compliance'])('keeps the custom deny-all policy when the read succeeds (pin=%s)', async section => {
    const { response } = await chat(section);
    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'compliance', gateway: 'security', toolAllowlist: [],
      systemPromptOverride: expect.stringContaining('CUSTOM_SKILL'),
    }));
  });

  it('keeps confirmed-disabled keyword routing on its established builtin fallback', async () => {
    enablement = 'disabled';
    const { response } = await chat();
    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'security', toolAllowlist: undefined, systemPromptOverride: undefined,
    }));
  });

  it('keeps a confirmed-disabled custom pin honest and does not dispatch', async () => {
    enablement = 'disabled';
    const { response, text } = await chat('compliance');
    expect(response.status).toBe(200);
    expect(text).toContain('compliance');
    expect(text).toContain('[DONE]');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not consult custom enablement for an intentional builtin pin', async () => {
    enablement = 'unavailable';
    const { response } = await chat('security');
    expect(response.status).toBe(200);
    expect(reads).not.toContain('enablement');
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'security' }));
  });
});

describe.each(['space', 'catalog'] as const)('initial %s policy failure', source => {
  it.each(['true', 'false'])('keeps ordinary routing and builtin pins usable (hybrid=%s)', async hybrid => {
    vi.stubEnv('HYBRID_ROUTING_ENABLED', hybrid);
    policyFailure = source;
    const auto = await chat();
    expect(auto.response.status).toBe(200);
    expect(auto.answer).toContain('using built-in routing');
    expect(auto.text).not.toMatch(/CUSTOM_POLICY|private policy error/);
    expect(record.mock.calls[0][0].assistantContent).toBe(auto.answer);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'security', toolAllowlist: undefined }));
    const pin = await chat('security');
    expect(pin.response.status).toBe(200);
    expect(pin.answer).not.toContain('using built-in routing');
  });
  it('refuses an explicit custom pin without a substitute or invocation', async () => {
    policyFailure = source;
    const result = await chat('compliance');
    expect(result.response.status).toBe(200);
    expect(result.answer).toContain('temporarily unavailable');
    expect(invoke).not.toHaveBeenCalled();
    expect(help).not.toHaveBeenCalled();
  });
  it('product help bypasses custom policy completely', async () => {
    policyFailure = source;
    const result = await chat(undefined, 'IAM custom agent setup');
    expect(result.answer).toBe('Product help without custom execution');
    expect(reads).not.toContain('space');
    expect(reads).not.toContain('catalog');
    expect(invoke).not.toHaveBeenCalled();
  });
});

it('streams and persists the policy notice once when independent routing falls back to Assistant', async () => {
  policyFailure = 'space';
  const original = sections.sectionByKey;
  vi.spyOn(sections, 'sectionByKey').mockImplementation(key => {
    const section = original(key);
    return section && key === 'security' ? { ...section, active: false } : section;
  });
  const { answer } = await chat();
  expect(help).toHaveBeenCalledOnce();
  expect(answer.match(/using built-in routing/g)).toHaveLength(1);
  expect(answer).toContain('Product help without custom execution');
  expect(record.mock.calls[0][0].assistantContent).toBe(answer);
  expect(record.mock.calls[0][0].gateway).toBe('assistant');
  expect(invoke).not.toHaveBeenCalled();
});
