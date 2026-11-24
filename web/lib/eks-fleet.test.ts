import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleetAccounts, fleetUrl, parseFleet, parseRegistrations, readFleet } from './eks-fleet';
import { buildTraceOverlay } from './k8s-trace-overlay';

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

  it('registrations: an ARN id must agree with the row name/account/region (`self` only for the known host id)', () => {
    const arn = 'arn:aws:eks:us-west-2:111111111111:cluster/orders';
    const row = { id: arn, name: 'orders', accountId: '111111111111', region: 'us-west-2' };
    expect(parseRegistrations({ clusters: [row, { id: 'shop', name: 'shop', accountId: 'self', region: 'ap-northeast-2' }] }))
      .toEqual([row, { id: 'shop', name: 'shop', accountId: 'self', region: 'ap-northeast-2' }]);
    for (const bad of [
      { ...row, name: 'cart' }, // ARN names another cluster
      { ...row, accountId: '222222222222' }, // ARN names another account
      { ...row, region: 'us-east-1' }, // ARN names another region
      { ...row, id: 'arn:aws:eks:us-west-2:111111111111:cluster/' }, // unparseable ARN
      { ...row, accountId: 'self' }, // `self` without a known host id
    ]) expect(parseRegistrations({ clusters: [row, bad] }), JSON.stringify(bad)).toBeNull();
    // A host ARN registered as `self` agrees only when the host's numeric id is known and matches.
    const hostArn = { id: 'arn:aws:eks:ap-northeast-2:123456789012:cluster/shop', name: 'shop', accountId: 'self', region: 'ap-northeast-2' };
    expect(parseRegistrations({ clusters: [hostArn] }, '123456789012')).toEqual([hostArn]);
    expect(parseRegistrations({ clusters: [hostArn] }, '111111111111')).toBeNull();
    expect(parseRegistrations({ clusters: [hostArn] })).toBeNull();
    // The server's flag for dropped unparseable registry ids is an incomplete registry.
    expect(parseRegistrations({ clusters: [row], truncated: true, unparsed: 1 })).toBeNull();
  });

  it('per-account fleet URL asks for all regions only (includeGlobal is ignored by /api/eks)', () => {
    expect(fleetUrl('111111111111')).toBe('/api/eks?accounts=111111111111&regions=__all__');
  });

  describe('registered clusters join the uniqueness set', () => {
    const ACCOUNTS_BODY = { accounts: [{ accountId: '123456789012', isHost: true, enabled: true },
      { accountId: '111111111111', isHost: false, enabled: true }, { accountId: '222222222222', isHost: false, enabled: true }] };
    const A_ORDERS = { id: 'arn:aws:eks:ap-northeast-2:111111111111:cluster/orders', name: 'orders',
      arn: 'arn:aws:eks:ap-northeast-2:111111111111:cluster/orders', accountId: '111111111111', region: 'ap-northeast-2', access: 'connected' };
    const HOST_SHOP = { id: 'shop', name: 'shop', accountId: '123456789012', region: 'ap-northeast-2', access: 'connected' };
    const serve = (registrations: () => Response, seen: string[] = []) => vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      seen.push(u);
      if (u === '/api/eks/registrations') return registrations();
      const account = new URL(u, 'http://x').searchParams.get('accounts');
      return json({ clusters: account === 'self' ? [HOST_SHOP] : account === '111111111111' ? [A_ORDERS] : [],
        errors: account === 'self' ? [{ accountId: 'self', region: '__all__', message: 'note' }] : [] });
    }));

    it('a registered same-named cluster in a region the non-wildcard account\'s listing does not cover makes the name ambiguous', async () => {
      // B (non-wildcard) registered `orders` in us-west-2, outside its configured regions: its listing is empty.
      const B_ORDERS = 'arn:aws:eks:us-west-2:222222222222:cluster/orders';
      const seen: string[] = [];
      serve(() => json({ clusters: [
        { id: 'shop', name: 'shop', accountId: '123456789012', region: 'ap-northeast-2' },
        { id: A_ORDERS.id, name: 'orders', accountId: '111111111111', region: 'ap-northeast-2' },
        { id: B_ORDERS, name: 'orders', accountId: '222222222222', region: 'us-west-2' },
      ] }), seen);
      const fleet = await readFleet(ACCOUNTS_BODY, new AbortController().signal);
      expect(seen).toContain('/api/eks/registrations');
      expect(fleet.incomplete).toBe(false);
      expect(fleet.clusters.map((c) => c.id).sort()).toEqual([A_ORDERS.id, 'shop'].sort()); // scope/veto set unchanged
      // Listed and registered copies of the same cluster count once; B's registered twin is added.
      expect(fleet.names.sort()).toEqual([A_ORDERS.id, B_ORDERS, 'shop'].sort());
      // The trace join for A's `orders` is refused as ambiguous (gate runs before any snapshot is read).
      expect(buildTraceOverlay([], { id: A_ORDERS.id, registeredNames: fleet.names, listingIncomplete: fleet.incomplete }))
        .toMatchObject({ available: false, reason: 'ambiguous_cluster' });
      expect(buildTraceOverlay([], { id: 'shop', registeredNames: fleet.names, listingIncomplete: fleet.incomplete }).reason)
        .not.toBe('ambiguous_cluster');
    });

    it.each([
      ['numeric host id', '123456789012'],
      ['`self` (HOST_ACCOUNT_ID unset on the server)', 'self'],
    ])('a host cluster listed by numeric id and registered as %s counts once (no spurious ambiguity)', async (_l, regAccount) => {
      serve(() => json({ clusters: [{ id: 'shop', name: 'shop', accountId: regAccount, region: 'ap-northeast-2' },
        { id: A_ORDERS.id, name: 'orders', accountId: '111111111111', region: 'ap-northeast-2' }] }));
      const fleet = await readFleet(ACCOUNTS_BODY, new AbortController().signal);
      expect(fleet.names.filter((n) => n === 'shop')).toHaveLength(1);
      expect(buildTraceOverlay([], { id: 'shop', registeredNames: fleet.names, listingIncomplete: fleet.incomplete }).reason)
        .not.toBe('ambiguous_cluster');
    });

    it('without a known host id a `self` registration cannot be tied to the numeric listed host row: counted twice (fail closed)', async () => {
      serve(() => json({ clusters: [{ id: 'shop', name: 'shop', accountId: 'self', region: 'ap-northeast-2' }] }));
      const fleet = await readFleet({ accounts: ACCOUNTS_BODY.accounts.map((a) => ({ ...a, isHost: false })) }, new AbortController().signal);
      expect(fleet.names.filter((n) => n === 'shop')).toHaveLength(2);
      expect(buildTraceOverlay([], { id: 'shop', registeredNames: fleet.names, listingIncomplete: fleet.incomplete }).reason)
        .toBe('ambiguous_cluster');
    });

    it.each([
      ['truncated', () => json({ clusters: [], truncated: true })],
      ['status error with rows', () => json({ clusters: [], status: 'error' })],

      ['malformed (no clusters array)', () => json({ rows: [] })],
      ['malformed row', () => json({ clusters: [{ id: 'arn:aws:eks:us-west-2:222222222222:cluster/orders', name: 'orders', accountId: '222222222222' }] })],
      ['non-JSON', () => new Response('<html>', { status: 200 })],
      ['ARN/row mismatch', () => json({ clusters: [{ id: 'arn:aws:eks:us-west-2:222222222222:cluster/orders', name: 'cart', accountId: '222222222222', region: 'us-west-2' }] })],
      ['dropped unparseable ids', () => json({ clusters: [], truncated: true, unparsed: 1 })],
    ])('a %s registrations read makes the fleet incomplete', async (_l, registrations) => {
      serve(registrations);
      expect((await readFleet(ACCOUNTS_BODY, new AbortController().signal)).incomplete).toBe(true);
    });

    it('counts the registrations read in the 4-request concurrency budget', async () => {
      let inFlight = 0, peak = 0;
      const many = { accounts: [{ accountId: '123456789012', isHost: true, enabled: true },
        ...Array.from({ length: 6 }, (_, i) => ({ accountId: `33333333330${i}`, isHost: false, enabled: true }))] };
      vi.stubGlobal('fetch', vi.fn(async (u: string) => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return u === '/api/eks/registrations' ? json({ clusters: [] }) : json({ clusters: [], errors: [] });
      }));
      await readFleet(many, new AbortController().signal);
      expect(peak).toBe(4);
    });
  });

  it('reads one listing per account and merges them, deduped by ARN', async () => {
    const arn = 'arn:aws:eks:ap-northeast-2:123456789012:cluster/shop';
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(u);
      if (u === '/api/eks/registrations') return json({ clusters: [] });
      return json({ clusters: [{ id: 'shop', name: 'shop', arn, accountId: '123456789012', region: 'ap-northeast-2', access: 'connected' },
        ...(u.includes('111111111111') ? [{ id: 'arn:aws:eks:us-east-1:111111111111:cluster/api', name: 'api',
          arn: 'arn:aws:eks:us-east-1:111111111111:cluster/api', accountId: '111111111111', region: 'us-east-1', access: 'no-entry' }] : [])],
      errors: u.includes('self') ? [{ accountId: 'self', region: '__all__', message: 'note' }] : [] });
    }));
    const fleet = await readFleet({ accounts: [{ accountId: '123456789012', isHost: true, enabled: true },
      { accountId: '111111111111', isHost: false, enabled: true }] }, new AbortController().signal);
    expect(urls.sort()).toEqual(['/api/eks/registrations', fleetUrl('111111111111'), fleetUrl('self')].sort());
    expect(fleet).toEqual({ clusters: expect.any(Array), names: ['shop', 'arn:aws:eks:us-east-1:111111111111:cluster/api'],
      incomplete: false, wildcard: ['self'] });
  });
});
