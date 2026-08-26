import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
vi.mock('@/lib/account', () => ({ currentAccountId: () => '123456789012' }));

import { validateAccountId, listAccounts, getAccount, getHostAccount, isMultiAccount, ensureHostRow } from './accounts';

const row = (over: Record<string, unknown> = {}) => ({
  account_id: '210987654321', alias: 'Prod', region: 'ap-northeast-2', is_host: false,
  role_name: 'AWSopsReadOnlyRole', external_id: 'ext-1', enabled: true, status: 'verified',
  last_verified_at: null, ...over,
});

beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

describe('validateAccountId', () => {
  it('accepts 12 digits, rejects others', () => {
    expect(validateAccountId('123456789012')).toBe(true);
    expect(validateAccountId('12345')).toBe(false);
    expect(validateAccountId('abcdefghijkl')).toBe(false);
    expect(validateAccountId('1234567890123')).toBe(false);
  });
});

describe('listAccounts', () => {
  it('maps snake_case rows to camelCase Account', async () => {
    query.mockResolvedValue({ rows: [row(), row({ account_id: '123456789012', is_host: true, alias: 'Host', external_id: null })] });
    const list = await listAccounts();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ accountId: '210987654321', alias: 'Prod', isHost: false, roleName: 'AWSopsReadOnlyRole', externalId: 'ext-1', enabled: true, status: 'verified' });
    expect(list[1]).toMatchObject({ accountId: '123456789012', isHost: true, externalId: null });
  });
});

describe('getAccount', () => {
  it('returns one account or undefined', async () => {
    query.mockResolvedValueOnce({ rows: [row()] });
    expect((await getAccount('210987654321'))?.alias).toBe('Prod');
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getAccount('999999999999')).toBeUndefined();
  });
});

describe('getHostAccount', () => {
  it('returns the is_host row', async () => {
    query.mockResolvedValue({ rows: [row({ account_id: '123456789012', is_host: true, alias: 'Host' })] });
    const h = await getHostAccount();
    expect(h?.isHost).toBe(true);
    expect(h?.accountId).toBe('123456789012');
  });
});

describe('isMultiAccount', () => {
  it('true when >1 enabled account', async () => {
    query.mockResolvedValue({ rows: [{ n: '2' }] });
    expect(await isMultiAccount()).toBe(true);
    query.mockResolvedValue({ rows: [{ n: '1' }] });
    expect(await isMultiAccount()).toBe(false);
  });
});

describe('ensureHostRow', () => {
  it('seeds both the host account and its deployment region target', async () => {
    await ensureHostRow();

    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0][0])).toContain('INSERT INTO accounts');
    expect(String(query.mock.calls[1][0])).toContain('INSERT INTO account_regions');
    expect(query.mock.calls[1][1]).toEqual(['123456789012', 'ap-northeast-2']);
  });
});
