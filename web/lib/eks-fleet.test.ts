import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleetAccounts, fleetUrl, parseFleet, readFleet } from './eks-fleet';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

describe('eks-fleet', () => {
  it('lists the host as self plus enabled members; a row without a boolean enabled is malformed', () => {
    expect(fleetAccounts({ accounts: [{ accountId: '123456789012', isHost: true, enabled: true },
      { accountId: '111111111111', isHost: false, enabled: true }, { accountId: '222222222222', isHost: false, enabled: false }] }))
      .toEqual(['self', '111111111111']);
    expect(fleetAccounts({ accounts: [{ accountId: '123456789012', isHost: true }] })).toBeNull();
    expect(fleetAccounts({ accounts: [{ accountId: '123456789012', isHost: true, enabled: 'yes' }] })).toBeNull();
    expect(fleetAccounts({ accounts: [{ accountId: 'self', isHost: true, enabled: true }] })).toBeNull();
    expect(fleetAccounts(null)).toBeNull();
  });

  it('reports wildcard accounts from the reason-less all-region note; a reasoned error is incomplete', () => {
    expect(parseFleet({ clusters: [], errors: [{ accountId: 'self', region: '__all__', message: 'note' }] }))
      .toMatchObject({ incomplete: false, wildcard: ['self'] });
    expect(parseFleet({ clusters: [], errors: [{ accountId: '111111111111', region: 'us-east-1', message: 'x', reason: 'denied' }] }))
      .toMatchObject({ incomplete: true, wildcard: [] });
    expect(parseFleet({ clusters: [], truncated: true }).incomplete).toBe(true);
  });

  it('fails closed on a listing shape it cannot fully validate', () => {
    const ok = { id: 'arn:aws:eks:us-east-1:111111111111:cluster/api', name: 'api', arn: 'arn:aws:eks:us-east-1:111111111111:cluster/api',
      accountId: '111111111111', region: 'us-east-1', access: 'connected' };
    const host = { id: 'shop', name: 'shop', accountId: '123456789012', region: 'ap-northeast-2', access: 'connected' };
    expect(parseFleet({ clusters: [ok, host], errors: [] }).incomplete).toBe(false);
    // errors: must be an array of exactly the reason-less `__all__` discovery note
    expect(parseFleet({ clusters: [ok], errors: 'oops' }).incomplete).toBe(true);
    expect(parseFleet({ clusters: [ok], errors: { accountId: 'self', region: '__all__' } }).incomplete).toBe(true);
    expect(parseFleet({ clusters: [ok], errors: [{ accountId: '111111111111', region: 'us-east-1', message: 'no reason' }] }).incomplete).toBe(true);
    expect(parseFleet({ clusters: [ok], errors: [{ region: '__all__', message: 'no account' }] }).incomplete).toBe(true);
    expect(parseFleet({ clusters: [ok], errors: ['note'] }).incomplete).toBe(true);
    // cluster rows: id, region, access and the owning account must all be valid
    for (const bad of [
      { ...ok, id: undefined }, { ...ok, region: undefined }, { ...ok, region: 'Not-A-Region' }, { ...ok, access: undefined },
      { ...ok, access: 7 }, { ...ok, accountId: undefined }, { ...ok, accountId: 'nope' },
      { ...ok, accountId: '222222222222' }, // ARN id names another account
      { ...ok, arn: 'arn:aws:eks:us-east-1:222222222222:cluster/api' }, // ARN names another account
      { ...ok, arn: 'arn:aws:eks:eu-west-1:111111111111:cluster/api' }, // ARN names another region
      { ...host, accountId: undefined }, { ...host, accountId: 'self' },
    ]) expect(parseFleet({ clusters: [bad], errors: [] }).incomplete, JSON.stringify(bad)).toBe(true);
  });

  it('reads one listing per account and merges them, deduped by ARN', async () => {
    const arn = 'arn:aws:eks:ap-northeast-2:123456789012:cluster/shop';
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(u);
      return json({ clusters: [{ id: 'shop', name: 'shop', arn, accountId: '123456789012', region: 'ap-northeast-2', access: 'connected' },
        ...(u.includes('111111111111') ? [{ id: 'arn:aws:eks:us-east-1:111111111111:cluster/api', name: 'api',
          arn: 'arn:aws:eks:us-east-1:111111111111:cluster/api', accountId: '111111111111', region: 'us-east-1', access: 'no-entry' }] : [])],
      errors: u.includes('self') ? [{ accountId: 'self', region: '__all__', message: 'note' }] : [] });
    }));
    const fleet = await readFleet({ accounts: [{ accountId: '123456789012', isHost: true, enabled: true },
      { accountId: '111111111111', isHost: false, enabled: true }] }, new AbortController().signal);
    expect(urls.sort()).toEqual([fleetUrl('111111111111'), fleetUrl('self')]);
    expect(fleet).toEqual({ clusters: expect.any(Array), names: ['shop', 'arn:aws:eks:us-east-1:111111111111:cluster/api'],
      incomplete: false, wildcard: ['self'] });
  });
});
