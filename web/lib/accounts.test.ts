import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
const connect = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({
  query: (...a: unknown[]) => query(...a), connect: () => connect(),
}) }));
vi.mock('@/lib/account', () => ({ currentAccountId: () => '123456789012' }));

import { validateAccountId, listAccounts, getAccount, getHostAccount, isMultiAccount, ensureHostRow } from './accounts';

const row = (over: Record<string, unknown> = {}) => ({
  account_id: '210987654321', alias: 'Prod', region: 'ap-northeast-2', is_host: false,
  role_name: 'AWSopsReadOnlyRole', external_id: 'ext-1', enabled: true, status: 'verified',
  last_verified_at: null, ...over,
});

beforeEach(() => { connect.mockReset(); query.mockReset(); query.mockResolvedValue({ rows: [] }); });

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

  const client = () => Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [row()] }), release: vi.fn(),
  });

  it('releases a cancellable successful lookup with the same account mapping', async () => {
    const connection = client();
    connect.mockResolvedValue(connection);
    expect(await getAccount('210987654321', new AbortController().signal)).toMatchObject({
      accountId: '210987654321', alias: 'Prod', enabled: true, isHost: false,
    });
    expect(connection.query).toHaveBeenCalledWith('SELECT * FROM accounts WHERE account_id = $1', ['210987654321']);
    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledWith(false);
    expect(connection.listenerCount('error')).toBe(0);
  });

  it('discards a connection whose registry read hangs and never releases it twice', async () => {
    const connection = client();
    let finish!: (result: { rows: unknown[] }) => void;
    connection.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    connect.mockResolvedValue(connection);
    const controller = new AbortController();
    const lookup = getAccount('210987654321', controller.signal);
    const rejected = lookup.catch(error => error);
    await vi.waitFor(() => expect(connection.query).toHaveBeenCalledOnce());
    controller.abort();
    expect(await rejected).toEqual(new Error('Account lookup cancelled'));
    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledWith(true);
    finish({ rows: [row()] });
    await Promise.resolve();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('releases a late checkout without starting an abandoned registry query', async () => {
    const connection = client();
    let finish!: (value: typeof connection) => void;
    connect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const lookup = getAccount('210987654321', controller.signal);
    const rejected = lookup.catch(error => error);
    controller.abort();
    expect(await rejected).toEqual(new Error('Account lookup cancelled'));
    finish(connection);
    await vi.waitFor(() => expect(connection.release).toHaveBeenCalledOnce());
    expect(connection.query).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledWith(false);
  });

  it('does not acquire a connection for an already-cancelled lookup', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getAccount('210987654321', controller.signal)).rejects.toThrow('Account lookup cancelled');
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('discards a failed connection and removes its temporary error handler', async () => {
    const connection = client();
    connection.query.mockImplementationOnce(() => new Promise(() => {}));
    connect.mockResolvedValue(connection);
    const lookup = getAccount('210987654321', new AbortController().signal);
    const rejected = lookup.catch(error => error);
    await vi.waitFor(() => expect(connection.query).toHaveBeenCalledOnce());
    connection.emit('error', new Error('PRIVATE socket failure'));
    expect(await rejected).toEqual(new Error('Account lookup cancelled'));
    expect(connection.release).toHaveBeenCalledWith(true);
    expect(connection.listenerCount('error')).toBe(0);
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
