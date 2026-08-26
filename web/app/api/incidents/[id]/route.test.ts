import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const getIncident = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/incident', () => ({ getIncident: (...a: unknown[]) => getIncident(...a) }));

const ID = '11111111-1111-1111-1111-111111111111';

function get(id = ID, cookie = 'awsops_token=t') {
  return new Request(`http://x/api/incidents/${id}`, { headers: { cookie } }) as any;
}

beforeEach(() => {
  vi.resetModules();
  verifyUser.mockReset(); isAdmin.mockReset(); getIncident.mockReset();
  verifyUser.mockResolvedValue({ sub: 'a', email: 'admin@x', groups: ['admins'] });
  isAdmin.mockResolvedValue(true);
});

describe('GET /api/incidents/[id] (detail, admin-gated, read-only)', () => {
  it('403 for non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { GET } = await import('./route');
    expect((await GET(get(), { params: { id: ID } })).status).toBe(403);
  });

  it('400 on a non-UUID id', async () => {
    const { GET } = await import('./route');
    expect((await GET(get('not-a-uuid'), { params: { id: 'not-a-uuid' } })).status).toBe(400);
    expect(getIncident).not.toHaveBeenCalled();
  });

  it('404 when the incident is not found', async () => {
    getIncident.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(get(), { params: { id: ID } })).status).toBe(404);
  });

  it('200 returns stages/findings/rca + mitigation as recommended catalog action NAMES only', async () => {
    getIncident.mockResolvedValue({
      id: ID,
      status: 'mitigation_planned',
      stages: [{ stage: 'triage' }, { stage: 'lead' }],
      findings: [{ sub_agent: 'network' }],
      rca: { summary: 'root cause text' },
      mitigation_plan: {
        // recommendation-only: catalog action NAMES (refs), NOT an execution call.
        recommended_actions: ['ec2-create-tags', 'asg-set-desired-capacity'],
      },
    });
    const { GET } = await import('./route');
    const res = await GET(get(), { params: { id: ID } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.incident.id).toBe(ID);
    expect(j.incident.stages.length).toBe(2);
    expect(j.incident.findings[0].sub_agent).toBe('network');
    expect(j.incident.rca.summary).toBe('root cause text');
    // BINDING: mitigation is recommendation-only — names/refs, never an execute call.
    expect(j.incident.mitigation_plan.recommended_actions).toEqual(['ec2-create-tags', 'asg-set-desired-capacity']);
    // The serialized response must contain NO execute/op directive (no /api/actions execute call shape).
    expect(JSON.stringify(j)).not.toMatch(/"op"\s*:\s*"execute"/);
    expect(JSON.stringify(j)).not.toMatch(/idempotencyToken|setApprovedAndExecuting/);
  });
});
