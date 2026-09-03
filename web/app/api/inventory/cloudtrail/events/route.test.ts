import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verifyUser, isAdmin, send } = vi.hoisted(() => ({ verifyUser: vi.fn(), isAdmin: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@aws-sdk/client-cloudtrail', () => ({
  CloudTrailClient: class { send = (...a: unknown[]) => send(...a); },
  LookupEventsCommand: class { constructor(public input: unknown) {} },
}));

import { GET } from './route';

const req = (q = '') => new Request(`http://x/api/inventory/cloudtrail/events${q}`, {
  headers: { cookie: 'awsops_token=t' },
});

beforeEach(() => {
  verifyUser.mockReset(); isAdmin.mockReset(); send.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u1' });
  isAdmin.mockResolvedValue(true); // async, matching the real signature
});

describe('GET /api/inventory/cloudtrail/events', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('maps the drill-down fields from the same LookupEvents response (gap L62)', async () => {
    send.mockResolvedValue({ Events: [{
      EventId: 'ev-1', EventName: 'RunInstances', EventSource: 'ec2.amazonaws.com',
      Username: 'alice', EventTime: new Date('2026-09-01T00:00:00Z'),
      Resources: [
        { ResourceType: 'AWS::EC2::Instance', ResourceName: 'i-1' },
        { ResourceType: 'AWS::EC2::Volume', ResourceName: 'vol-1' },
      ],
      CloudTrailEvent: JSON.stringify({
        readOnly: false, awsRegion: 'ap-northeast-2', sourceIPAddress: '10.0.0.1',
        userAgent: 'aws-cli/2', errorCode: 'AccessDenied', requestParameters: { x: 1 },
        userIdentity: {
          type: 'IAMUser', arn: 'arn:aws:iam::1:user/alice', accountId: '1', userName: 'alice',
          accessKeyId: 'AKIAEXAMPLE', principalId: 'AIDAPRIV', sessionContext: { attributes: { mfaAuthenticated: 'true' } },
        },
      }),
    }] });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const e = (await res.json()).events[0];
    expect(e).toMatchObject({
      eventId: 'ev-1', readOnly: false, awsRegion: 'ap-northeast-2',
      sourceIPAddress: '10.0.0.1', userAgent: 'aws-cli/2', errorCode: 'AccessDenied',
    });
    // ALL resources survive (the table shows only the first; the panel lists every one)
    expect(e.resources).toEqual([
      { type: 'EC2::Instance', name: 'i-1' }, { type: 'EC2::Volume', name: 'vol-1' },
    ]);
    expect(e.raw.requestParameters).toEqual({ x: 1 });
    // v1 parity: access key id is a first-class Event field…
    expect(e.accessKeyId).toBe('AKIAEXAMPLE');
    // …but the raw blob's userIdentity is projected to identity NAMES only — no credential/
    // session detail leaves the server as a bulk-copyable payload (repo redaction precedent).
    expect(e.raw.userIdentity).toEqual({
      type: 'IAMUser', arn: 'arn:aws:iam::1:user/alice', accountId: '1', userName: 'alice',
    });
    expect(JSON.stringify(e.raw)).not.toContain('AKIAEXAMPLE');
    expect(JSON.stringify(e.raw)).not.toContain('sessionContext');
  });

  it('recursively redacts credential-adjacent values inside request/response params', async () => {
    send.mockResolvedValue({ Events: [{
      EventId: 'ev-3', EventName: 'AssumeRole', EventSource: 'sts.amazonaws.com',
      CloudTrailEvent: JSON.stringify({
        readOnly: true,
        requestParameters: {
          roleArn: 'arn:aws:iam::1:role/x', environment: { variables: { DB_PW: 'hunter2' } }, userData: 'IyEvYmlu',
          'x-api-key': 'XKEY', access_key: 'UKEY', authParameters: { u: 'p' }, keyMaterial: 'PEM',
        },
        responseElements: {
          credentials: { accessKeyId: 'ASIAEXAMPLE', sessionToken: 'FwoGZXIv' },
          accessKey: { accessKeyId: 'AKIANEW', status: 'Active' },
          assumedRoleUser: { arn: 'arn:aws:sts::1:assumed-role/x/s' },
        },
      }),
    }] });
    const e = (await (await GET(req())).json()).events[0];
    const blob = JSON.stringify(e.raw);
    // presence survives (forensics: the call returned credentials), values never do
    expect(e.raw.responseElements.credentials).toBe('[REDACTED]');
    expect(e.raw.requestParameters.environment).toBe('[REDACTED]');
    expect(e.raw.requestParameters.userData).toBe('[REDACTED]');
    // separator/family variants must hit the normalized deny-list too (round-3 review)
    for (const secret of ['ASIAEXAMPLE', 'FwoGZXIv', 'hunter2', 'IyEvYmlu', 'XKEY', 'UKEY', 'PEM', 'AKIANEW', '"u":"p"']) {
      expect(blob).not.toContain(secret);
    }
    expect(e.raw.requestParameters['x-api-key']).toBe('[REDACTED]');
    expect(e.raw.responseElements.accessKey).toBe('[REDACTED]');
    // non-sensitive forensic detail stays
    expect(e.raw.requestParameters.roleArn).toBe('arn:aws:iam::1:role/x');
    expect(e.raw.responseElements.assumedRoleUser.arn).toContain('assumed-role');
  });

  it('non-admins get the flat Event fields but never the forensic raw block or access key', async () => {
    isAdmin.mockResolvedValue(false);
    send.mockResolvedValue({ Events: [{
      EventId: 'ev-4', EventName: 'RunInstances', EventSource: 'ec2.amazonaws.com',
      CloudTrailEvent: JSON.stringify({ readOnly: false, awsRegion: 'ap-northeast-2',
        userIdentity: { userName: 'alice', accessKeyId: 'AKIAEXAMPLE' }, requestParameters: { x: 1 } }),
    }] });
    const e = (await (await GET(req())).json()).events[0];
    expect(e.name).toBe('RunInstances');
    expect(e.awsRegion).toBe('ap-northeast-2'); // flat fields stay
    expect(e.raw).toBeNull();
    expect(e.accessKeyId).toBe('');
  });

  it('malformed CloudTrailEvent JSON → row still renders (raw null, readOnly defaults true)', async () => {
    send.mockResolvedValue({ Events: [{
      EventId: 'ev-2', EventName: 'X', EventSource: 's', CloudTrailEvent: 'not json {',
    }] });
    const e = (await (await GET(req())).json()).events[0];
    expect(e.raw).toBeNull();
    expect(e.readOnly).toBe(true);
    expect(e.eventId).toBe('ev-2');
  });

  it('?write=1 adds the ReadOnly=false lookup attribute', async () => {
    send.mockResolvedValue({ Events: [] });
    await GET(req('?write=1'));
    const cmd = send.mock.calls[0][0] as { input: { LookupAttributes?: unknown[] } };
    expect(cmd.input.LookupAttributes).toEqual([{ AttributeKey: 'ReadOnly', AttributeValue: 'false' }]);
  });
});
