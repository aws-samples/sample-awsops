import { describe, it, expect, beforeEach, vi } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const upsertSkill = vi.fn();
const upsertAgent = vi.fn();
const writeAudit = vi.fn();
const validateToolBindings = vi.fn();
const attachSkill = vi.fn();
const getAgentSpace = vi.fn();
const upsertAgentSpace = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/catalog', () => ({
  upsertSkill: (...a: unknown[]) => upsertSkill(...a),
  upsertAgent: (...a: unknown[]) => upsertAgent(...a),
  attachSkill: (...a: unknown[]) => attachSkill(...a), setEnabled: vi.fn(),
  validateToolBindings: (...a: unknown[]) => validateToolBindings(...a),
  listAgentsWithSkills: vi.fn(async () => []), listSkills: vi.fn(async () => []),
  writeAudit: (...a: unknown[]) => writeAudit(...a),
}));
vi.mock('@/lib/agent-space', () => ({
  getAgentSpace: (...a: unknown[]) => getAgentSpace(...a),
  upsertAgentSpace: (...a: unknown[]) => upsertAgentSpace(...a),
}));
vi.mock('@/lib/account', () => ({ currentAccountId: () => 'acct-123' }));

function req(body: unknown, cookie = 'awsops_token=t') {
  return new Request('http://x/api/customization', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
}
function putReq(body: unknown, cookie = 'awsops_token=t') {
  return new Request('http://x/api/customization', { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
}
function getReq(cookie = 'awsops_token=t') {
  return new Request('http://x/api/customization', { method: 'GET', headers: { cookie } });
}
beforeEach(() => {
  verifyUser.mockReset(); isAdmin.mockReset(); upsertSkill.mockReset(); upsertAgent.mockReset(); writeAudit.mockReset();
  getAgentSpace.mockReset(); upsertAgentSpace.mockReset();
  validateToolBindings.mockReset().mockResolvedValue([]); attachSkill.mockReset();
  verifyUser.mockResolvedValue({ sub: 'a', email: 'admin@x', groups: ['admins'] });
  isAdmin.mockResolvedValue(true);
  getAgentSpace.mockResolvedValue(null);
  process.env.AURORA_ENDPOINT = 'h';
});

describe('POST /api/customization', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({ kind: 'skill' }))).status).toBe(401);
  });
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(req({ kind: 'skill', name: 'cis', description: 'd', instructions: 'i', toolAllowlist: [] }))).status).toBe(403);
  });
  it('400 invalid skill', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ kind: 'skill', name: 'Bad Name', description: 'd', instructions: 'i', toolAllowlist: [] }))).status).toBe(400);
  });
  it('creates a valid skill (disabled-by-default) + audits', async () => {
    upsertSkill.mockResolvedValue(7);
    const { POST } = await import('./route');
    const res = await POST(req({ kind: 'skill', name: 'cis-pack', description: 'd', instructions: 'i', toolAllowlist: [] }));
    expect(res.status).toBe(200);
    expect(upsertSkill).toHaveBeenCalledWith(expect.objectContaining({ tier: 'custom', createdBy: 'admin@x' }));
    expect(writeAudit).toHaveBeenCalled();
  });
});

describe('GET /api/customization', () => {
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { GET } = await import('./route');
    expect((await GET(getReq())).status).toBe(403);
  });
  it('returns accountId + space (null ⇒ Phase-1 global mode) alongside agents/skills', async () => {
    getAgentSpace.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accountId).toBe('acct-123');
    expect(body.space).toBeNull();
    expect(body).toHaveProperty('agents');
    expect(body).toHaveProperty('skills');
    expect(getAgentSpace).toHaveBeenCalledWith('acct-123');
  });
  it('surfaces an existing space', async () => {
    getAgentSpace.mockResolvedValue({ accountId: 'acct-123', enabledAgentIds: [1], enabledSkillIds: [2], toolAllowlist: ['t'], version: 3 });
    const { GET } = await import('./route');
    const body = await (await GET(getReq())).json();
    expect(body.space.version).toBe(3);
  });
});

describe('PUT /api/customization (op:space)', () => {
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { PUT } = await import('./route');
    expect((await PUT(putReq({ op: 'space', enabledAgentIds: [], enabledSkillIds: [], toolAllowlist: [] }))).status).toBe(403);
    expect(upsertAgentSpace).not.toHaveBeenCalled();
  });
  it('admin op:space calls upsertAgentSpace for the current account and returns the version', async () => {
    upsertAgentSpace.mockResolvedValue({ accountId: 'acct-123', enabledAgentIds: [1, 2], enabledSkillIds: [3], toolAllowlist: ['x'], version: 5 });
    const { PUT } = await import('./route');
    const res = await PUT(putReq({ op: 'space', enabledAgentIds: [1, 2], enabledSkillIds: [3], toolAllowlist: ['x'] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 5 });
    expect(upsertAgentSpace).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'acct-123', enabledAgentIds: [1, 2], enabledSkillIds: [3], toolAllowlist: ['x'], actor: 'admin@x',
    }));
  });
  it('coerces ids to finite numbers and allowlist to strings', async () => {
    upsertAgentSpace.mockResolvedValue({ accountId: 'acct-123', enabledAgentIds: [], enabledSkillIds: [], toolAllowlist: [], version: 1 });
    const { PUT } = await import('./route');
    await PUT(putReq({ op: 'space', enabledAgentIds: ['1', 'nan', 4], enabledSkillIds: 'bad', toolAllowlist: [7, 'tool'] }));
    expect(upsertAgentSpace).toHaveBeenCalledWith(expect.objectContaining({
      enabledAgentIds: [1, 4], enabledSkillIds: [], toolAllowlist: ['7', 'tool'],
    }));
  });
});


it('returns unavailable instead of global mode when the Agent Space policy read fails', async () => {
  getAgentSpace.mockRejectedValueOnce(new Error('policy unavailable'));
  const { GET } = await import('./route');
  const res = await GET(getReq());
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: 'Customization policy unavailable' });
});

it('rejects an unknown tool before any catalog write', async () => {
  const { POST } = await import('./route');
  const response = await POST(req({ kind: 'skill', name: 'scoped', description: 'd', instructions: 'i', toolAllowlist: ['typo_tool'] }));
  expect(response.status).toBe(400);
  expect(upsertSkill).not.toHaveBeenCalled();
});
it.each([['invalid', 400], ['unavailable', 503]])('blocks an %s binding without a write', async (mode, status) => {
  if (mode === 'invalid') validateToolBindings.mockResolvedValue(['No effective tool grant for gateway security']);
  else validateToolBindings.mockRejectedValue(new Error('private DB error'));
  const { PUT } = await import('./route');
  const response = await PUT(putReq({ op: 'attach', agentId: 1, skillId: 2 }));
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain('private DB error');
  expect(attachSkill).not.toHaveBeenCalled();
});

it.each(['skill','agent'])('rejects a %s edit that invalidates current bindings before upsert', async kind => {
  validateToolBindings.mockResolvedValue(['No effective tool grant for gateway security']);
  const { POST } = await import('./route');
  const response = await POST(req({ kind, name: 'shared', description: 'd', instructions: 'i', persona: 'p', gateway: 'security', routingKeywords: [], toolAllowlist: ['prometheus_query'] }));
  expect(response.status).toBe(400);
  expect(upsertAgent).not.toHaveBeenCalled(); expect(upsertSkill).not.toHaveBeenCalled();
});
