import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const topicArn = vi.fn();
const listSubscribers = vi.fn();
const subscribeEmail = vi.fn();
const unsubscribe = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/http-body', () => ({ readJsonBounded: (req: { json: () => unknown }) => req.json() }));
vi.mock('@/lib/diagnosis-notify', () => ({
  topicArn: () => topicArn(),
  listSubscribers: (...a: unknown[]) => listSubscribers(...a),
  subscribeEmail: (...a: unknown[]) => subscribeEmail(...a),
  unsubscribe: (...a: unknown[]) => unsubscribe(...a),
  isValidEmail: (e: unknown) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e),
  belongsToTopic: (s: string, t: string) => s.startsWith(t + ':'),
}));

import { GET, POST, DELETE } from './route';

const ARN = 'arn:aws:sns:ap-northeast-2:1:topic';
function req(body?: unknown): Request {
  return { headers: { get: () => 'awsops_token=x' }, json: async () => body } as unknown as Request;
}

beforeEach(() => {
  verifyUser.mockReset();
  isAdmin.mockReset();
  topicArn.mockReset();
  listSubscribers.mockReset();
  subscribeEmail.mockReset();
  unsubscribe.mockReset();
});

describe('GET /api/diagnosis/subscribers', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it('enabled:false when no topic configured', async () => {
    verifyUser.mockResolvedValue({ email: 'a@x.io', groups: [] });
    topicArn.mockReturnValue(null);
    const j = await (await GET(req())).json();
    expect(j).toEqual({ enabled: false, canManage: false, subscribers: [] });
    expect(listSubscribers).not.toHaveBeenCalled();
  });

  it('lists subscribers + canManage reflects admin', async () => {
    verifyUser.mockResolvedValue({ email: 'a@x.io', groups: ['awsops-admins'] });
    isAdmin.mockResolvedValue(true);
    topicArn.mockReturnValue(ARN);
    listSubscribers.mockResolvedValue([{ email: 'a@x.io', status: 'Confirmed', subscriptionArn: ARN + ':1' }]);
    const j = await (await GET(req())).json();
    expect(j.enabled).toBe(true);
    expect(j.canManage).toBe(true);
    expect(j.subscribers).toHaveLength(1);
  });
});

describe('POST /api/diagnosis/subscribers', () => {
  it('403 for non-admin', async () => {
    verifyUser.mockResolvedValue({ email: 'a@x.io', groups: [] });
    isAdmin.mockResolvedValue(false);
    expect((await POST(req({ email: 'b@x.io' }))).status).toBe(403);
    expect(subscribeEmail).not.toHaveBeenCalled();
  });

  it('400 on invalid email', async () => {
    verifyUser.mockResolvedValue({ email: 'a@x.io', groups: [] });
    isAdmin.mockResolvedValue(true);
    topicArn.mockReturnValue(ARN);
    expect((await POST(req({ email: 'nope' }))).status).toBe(400);
    expect(subscribeEmail).not.toHaveBeenCalled();
  });

  it('subscribes a valid email (lowercased) for an admin', async () => {
    verifyUser.mockResolvedValue({ email: 'a@x.io', groups: [] });
    isAdmin.mockResolvedValue(true);
    topicArn.mockReturnValue(ARN);
    subscribeEmail.mockResolvedValue(undefined);
    const r = await POST(req({ email: 'NEW@X.IO' }));
    expect(r.status).toBe(200);
    expect(subscribeEmail).toHaveBeenCalledWith(ARN, 'new@x.io');
  });
});

describe('DELETE /api/diagnosis/subscribers', () => {
  it('400 when the subscription ARN is not under our topic', async () => {
    verifyUser.mockResolvedValue({ email: 'a@x.io', groups: [] });
    isAdmin.mockResolvedValue(true);
    topicArn.mockReturnValue(ARN);
    expect((await DELETE(req({ subscriptionArn: 'arn:aws:sns:x:1:other:z' }))).status).toBe(400);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes an ARN that belongs to our topic', async () => {
    verifyUser.mockResolvedValue({ email: 'a@x.io', groups: [] });
    isAdmin.mockResolvedValue(true);
    topicArn.mockReturnValue(ARN);
    unsubscribe.mockResolvedValue(undefined);
    const r = await DELETE(req({ subscriptionArn: ARN + ':abc' }));
    expect(r.status).toBe(200);
    expect(unsubscribe).toHaveBeenCalledWith(ARN + ':abc');
  });
});
