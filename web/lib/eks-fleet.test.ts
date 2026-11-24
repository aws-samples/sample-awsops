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

  it('reads one listing per account and merges them, deduped by ARN', async () => {
    const arn = 'arn:aws:eks:ap-northeast-2:123456789012:cluster/shop';
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(u);
      return json({ clusters: [{ id: 'shop', name: 'shop', arn }, ...(u.includes('111111111111')
        ? [{ id: 'arn:aws:eks:us-east-1:111111111111:cluster/api', name: 'api', arn: 'arn:aws:eks:us-east-1:111111111111:cluster/api' }] : [])],
      errors: u.includes('self') ? [{ accountId: 'self', region: '__all__', message: 'note' }] : [] });
    }));
    const fleet = await readFleet({ accounts: [{ accountId: '123456789012', isHost: true, enabled: true },
      { accountId: '111111111111', isHost: false, enabled: true }] }, new AbortController().signal);
    expect(urls.sort()).toEqual([fleetUrl('111111111111'), fleetUrl('self')]);
    expect(fleet).toEqual({ clusters: expect.any(Array), names: ['shop', 'arn:aws:eks:us-east-1:111111111111:cluster/api'],
      incomplete: false, wildcard: ['self'] });
  });
});
