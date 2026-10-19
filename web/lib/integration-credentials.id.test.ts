import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mock the SM SDK (mirror integration-credentials.test.ts) ----
const smSend = vi.fn();
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = (...a: unknown[]) => smSend(...a);
  },
  GetSecretValueCommand: class {
    kind = 'get';
    constructor(public input: unknown) {}
  },
  PutSecretValueCommand: class {
    kind = 'put';
    constructor(public input: unknown) {}
  },
}));

// ---- mock the pg pool (advisory lock) ----
const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
const clientRelease = vi.fn();
const poolConnect = vi.fn().mockResolvedValue({ query: clientQuery, release: clientRelease });
vi.mock('@/lib/db', () => ({ getPool: () => ({ connect: poolConnect }) }));

import {
  setIntegrationCredentialById,
  getCredentialById,
  mirrorDefaultCredential,
  getKindMirror,
  getConfiguredIds,
  getConfiguredDatasourceIds,
  deleteCredentialKeys,
} from './integration-credentials';

const getReturn = (obj: Record<string, unknown> | null) =>
  obj === null ? { SecretString: undefined } : { SecretString: JSON.stringify(obj) };
const writtenMap = () => JSON.parse(smSend.mock.calls.find((c) => c[0].kind === 'put')![0].input.SecretString);

beforeEach(() => {
  smSend.mockReset();
  clientQuery.mockReset().mockResolvedValue({ rows: [] });
  clientRelease.mockReset();
  poolConnect.mockReset().mockResolvedValue({ query: clientQuery, release: clientRelease });
});

describe('setIntegrationCredentialById', () => {
  it('writes under the bigint id key without clobbering other ids or the kind mirror', async () => {
    smSend.mockImplementation((cmd: any) =>
      cmd.kind === 'get' ? getReturn({ '7': { endpoint: 'http://a' }, prometheus: { endpoint: 'http://def' } }) : {});
    await setIntegrationCredentialById(12, { endpoint: 'http://b', authType: 'none' });
    const w = writtenMap();
    expect(w['7']).toEqual({ endpoint: 'http://a' }); // other id preserved
    expect(w['prometheus']).toEqual({ endpoint: 'http://def' }); // kind mirror untouched
    expect(w['12']).toEqual({ endpoint: 'http://b', authType: 'none' });
  });

  it('two distinct same-kind instances (different ids) coexist — no overwrite', async () => {
    smSend.mockImplementation((cmd: any) => (cmd.kind === 'get' ? getReturn({ '1': { endpoint: 'http://p1' } }) : {}));
    await setIntegrationCredentialById(2, { endpoint: 'http://p2' });
    const w = writtenMap();
    expect(w['1']).toEqual({ endpoint: 'http://p1' });
    expect(w['2']).toEqual({ endpoint: 'http://p2' });
  });

  it('rejects a non-positive-integer id with no SM/DB call', async () => {
    await expect(setIntegrationCredentialById(0, {})).rejects.toThrow();
    await expect(setIntegrationCredentialById(-3, {})).rejects.toThrow();
    expect(smSend).not.toHaveBeenCalled();
    expect(poolConnect).not.toHaveBeenCalled();
  });
});

describe('getCredentialById', () => {
  it('returns the id entry when present', async () => {
    smSend.mockImplementation(() => getReturn({ '5': { endpoint: 'http://id5' }, prometheus: { endpoint: 'http://def' } }));
    expect(await getCredentialById(5, 'prometheus')).toEqual({ endpoint: 'http://id5' });
  });

  it('does not lend an unstamped kind mirror to an explicit instance', async () => {
    smSend.mockImplementation(() => getReturn({ prometheus: { endpoint: 'http://def' } }));
    expect(await getCredentialById(99, 'prometheus')).toBeNull();
  });

  it('uses only a mirror stamped for the requested id', async () => {
    const mirror = { endpoint: 'http://def', instanceId: '5' };
    smSend.mockImplementation(() => getReturn({ prometheus: mirror }));
    expect(await getCredentialById(5, 'prometheus')).toEqual(mirror);
    expect(await getCredentialById(99, 'prometheus', 'http://def')).toBeNull();
  });

  it('recovers a legacy current default only at its verified exact endpoint', async () => {
    smSend.mockImplementation(() => getReturn({ prometheus: { endpoint: 'http://def', token: 'fixture' } }));
    expect(await getCredentialById(5, 'prometheus', 'http://def')).toEqual({ endpoint: 'http://def', token: 'fixture' });
    expect(await getCredentialById(5, 'prometheus', 'http://def/another-tenant')).toBeNull();
  });

  it('backfills a verified legacy default with no sibling credential inheritance', async () => {
    let map: Record<string, unknown> = { prometheus: { endpoint: 'http://def', token: 'fixture' } };
    smSend.mockImplementation((cmd: any) => {
      if (cmd.kind === 'get') return getReturn(map);
      map = JSON.parse(cmd.input.SecretString);
      return {};
    });
    const old = await getCredentialById(5, 'prometheus', 'http://def');
    await setIntegrationCredentialById(5, old!);
    await mirrorDefaultCredential('prometheus', old!, undefined, 5);
    expect(await getCredentialById(5)).toEqual(old);
    expect(await getCredentialById(99, 'prometheus')).toBeNull();
    expect(map.prometheus).toMatchObject({ token: 'fixture', instanceId: '5' });
  });

  it('returns null when neither id nor kind mirror exists', async () => {
    smSend.mockImplementation(() => getReturn({}));
    expect(await getCredentialById(99, 'prometheus')).toBeNull();
    expect(await getCredentialById(99)).toBeNull();
  });
});

describe('mirrorDefaultCredential', () => {
  it('writes the kind-mirror key (managed default mirror) preserving id entries', async () => {
    smSend.mockImplementation((cmd: any) => (cmd.kind === 'get' ? getReturn({ '3': { endpoint: 'http://id3' } }) : {}));
    await mirrorDefaultCredential('loki', { endpoint: 'http://loki', authType: 'bearer', token: 't' });
    const w = writtenMap();
    expect(w['3']).toEqual({ endpoint: 'http://id3' });
    expect(w['loki']).toEqual({ endpoint: 'http://loki', authType: 'bearer', token: 't' });
  });

  it('stamps the mirror with the default instance id when given one', async () => {
    smSend.mockImplementation((cmd: any) => (cmd.kind === 'get' ? getReturn({}) : {}));
    await mirrorDefaultCredential('loki', { endpoint: 'http://loki', authType: 'none' }, undefined, 3);
    expect(writtenMap()['loki']).toEqual({ endpoint: 'http://loki', authType: 'none', instanceId: '3' });
    await expect(mirrorDefaultCredential('loki', { endpoint: 'http://loki' }, undefined, 0)).rejects.toThrow(/invalid integration id/);
  });
});

describe('getConfiguredIds', () => {
  it('returns numeric id keys only (not kind-mirror keys)', async () => {
    smSend.mockImplementation(() => getReturn({ '11': {}, '12': {}, prometheus: {}, notion: {} }));
    expect(new Set(await getConfiguredIds())).toEqual(new Set(['11', '12']));
  });
  it('degrades to [] on a Secrets Manager read failure', async () => {
    smSend.mockImplementation(() => { const e: any = new Error('denied'); e.name = 'AccessDeniedException'; throw e; });
    expect(await getConfiguredIds()).toEqual([]);
  });
});

describe('datasource configuration evidence', () => {
  it('supports no-auth endpoints and never treats a kind mirror as another instance credential', async () => {
    smSend.mockImplementation(() => getReturn({
      prometheus: { authType: 'bearer', token: 'synthetic-default' },
      '12': { token: 'synthetic-instance' },
    }));
    expect(await getConfiguredDatasourceIds([
      { id: 11, endpoint: 'https://no-auth.example.test', authType: 'none' },
      { id: 12, endpoint: 'https://auth.example.test', authType: 'bearer' },
      { id: 13, endpoint: 'https://other.example.test', authType: 'bearer' },
    ])).toEqual(['11', '12']);
  });

  it('rejects absent auth material, invalid endpoints and malformed custom headers', async () => {
    smSend.mockImplementation(() => getReturn({
      '11': {}, '12': { token: '' }, '13': { headerName: 'Host', headerValue: 'synthetic' },
      '14': { username: 'configured-user', password: 'synthetic' },
      '15': { headerName: 'X-API-Key', headerValue: 'synthetic' },
      '18': { headerName: 'X-API-Key' },
    }));
    expect(await getConfiguredDatasourceIds([
      { id: 11, endpoint: 'https://a.example.test', authType: 'basic' },
      { id: 12, endpoint: 'https://a.example.test', authType: 'bearer' },
      { id: 13, endpoint: 'https://a.example.test', authType: 'custom_header' },
      { id: 14, endpoint: 'https://a.example.test', authType: 'basic' },
      { id: 15, endpoint: 'https://a.example.test', authType: 'custom_header' },
      { id: 16, endpoint: null, authType: 'none' },
      { id: 17, endpoint: 'http://169.254.169.254', authType: 'none' },
      { id: 18, endpoint: 'https://a.example.test', authType: 'custom_header' },
    ])).toEqual(['14', '15']);
  });

  it('keeps no-auth configuration but withholds authenticated configuration when secret reads fail', async () => {
    smSend.mockRejectedValue(Object.assign(new Error('PRIVATE'), { name: 'AccessDeniedException' }));
    const result = await getConfiguredDatasourceIds([
      { id: 11, endpoint: 'https://a.example.test', authType: 'none' },
      { id: 12, endpoint: 'https://b.example.test', authType: 'bearer' },
    ]);
    expect(result).toEqual(['11']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});

describe('getConfiguredDatasourceIds — legacy Datadog key pair', () => {
  it('counts a Datadog instance whose blob holds the legacy apiKey/appKey pair as configured', async () => {
    smSend.mockImplementation((cmd: any) => (cmd.kind === 'get'
      ? getReturn({ '9': { endpoint: 'https://api.datadoghq.com', authType: 'custom_header', apiKey: 'synthetic-api', appKey: 'synthetic-app' } })
      : {}));
    const rows = [{ id: 9, endpoint: 'https://api.datadoghq.com', authType: 'custom_header', kind: 'datadog' },
                  { id: 10, endpoint: 'https://api.datadoghq.com', authType: 'custom_header', kind: 'prometheus' }];
    // the same blob shape on a non-Datadog kind is still unconfigured (no header value)
    expect(await getConfiguredDatasourceIds(rows)).toEqual(['9']);
  });
});

describe('getKindMirror', () => {
  it('returns the stored kind mirror object (stamped or not) and null when absent', async () => {
    smSend.mockImplementation((cmd: any) => (cmd.kind === 'get'
      ? getReturn({ loki: { endpoint: 'http://legacy', authType: 'none' }, prometheus: { endpoint: 'http://p', authType: 'none', instanceId: '3' } })
      : {}));
    expect(await getKindMirror('loki')).toEqual({ endpoint: 'http://legacy', authType: 'none' });
    expect((await getKindMirror('prometheus'))?.instanceId).toBe('3');
    expect(await getKindMirror('tempo')).toBeNull();
  });
});

describe('deleteCredentialKeys', () => {
  it('removes the given keys and preserves the rest', async () => {
    smSend.mockImplementation((cmd: any) =>
      cmd.kind === 'get' ? getReturn({ '4': { a: 1 }, prometheus: { b: 2 }, '5': { c: 3 } }) : {});
    await deleteCredentialKeys(['4', 'prometheus']);
    const w = writtenMap();
    expect(w['4']).toBeUndefined();
    expect(w['prometheus']).toBeUndefined();
    expect(w['5']).toEqual({ c: 3 });
  });
});
