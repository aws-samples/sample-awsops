import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { verifyUser, isAdmin, topicArn, publishTest } = vi.hoisted(() => ({
  verifyUser: vi.fn(), isAdmin: vi.fn(), topicArn: vi.fn(), publishTest: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/diagnosis-notify', () => ({
  topicArn: (...a: unknown[]) => topicArn(...a),
  publishTest: (...a: unknown[]) => publishTest(...a),
}));

import { POST } from './route';

const req = () => new Request('http://x/api/diagnosis/subscribers/test', {
  method: 'POST', headers: { cookie: 'awsops_token=t' },
});

let clock = Date.parse('2026-08-31T00:00:00Z');
beforeEach(() => {
  // The route keeps a module-level cooldown timestamp — advance a fake clock past it per test.
  clock += 300_000;
  vi.useFakeTimers();
  vi.setSystemTime(clock);
  verifyUser.mockReset(); isAdmin.mockReset(); topicArn.mockReset(); publishTest.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u1', email: 'admin@x.io' });
  // ASYNC mock — isAdmin returns Promise<boolean>; a sync mock would mask a missing await
  // (a Promise is always truthy), which is exactly the regression this file must catch.
  isAdmin.mockResolvedValue(true);
  topicArn.mockReturnValue('arn:aws:sns:ap-northeast-2:1:t');
  publishTest.mockResolvedValue('m1');
});

afterEach(() => { vi.useRealTimers(); });

describe('POST /api/diagnosis/subscribers/test', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(401);
    expect(publishTest).not.toHaveBeenCalled();
  });
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    expect((await POST(req())).status).toBe(403);
    expect(publishTest).not.toHaveBeenCalled();
  });
  it('404 when notifications are disabled (no topic ARN)', async () => {
    topicArn.mockReturnValue(null);
    expect((await POST(req())).status).toBe(404);
    expect(publishTest).not.toHaveBeenCalled();
  });
  it('publishes and returns the message id', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messageId: 'm1' });
    // Topic ARN only — the admin's identity must NOT reach the message (broadcast to subscribers).
    expect(publishTest).toHaveBeenCalledWith('arn:aws:sns:ap-northeast-2:1:t');
  });
  it('429 within the server-side cooldown window (client busy flag is not a rate limit)', async () => {
    expect((await POST(req())).status).toBe(200); // first send arms the cooldown
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(publishTest).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000); // past the 60s cooldown
    expect((await POST(req())).status).toBe(200);
  });
  it('502 with a SANITIZED message on a publish failure — never a silent success, never ARN leakage', async () => {
    publishTest.mockRejectedValue(new Error('boom arn:aws:iam::1:role/x'));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect((await res.json()).message).toBe('publish failed'); // SDK detail stays server-side
  });
});
