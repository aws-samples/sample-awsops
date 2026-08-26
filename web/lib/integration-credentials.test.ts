import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mock the SM SDK (mirror admin.test.ts's client-ssm mock) ----
const smSend = vi.fn();
class ResourceNotFoundException extends Error {
  name = 'ResourceNotFoundException';
}
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
  setIntegrationCredential,
  getConfiguredSlugs,
  KNOWN_CONNECTOR_SLUGS,
} from './integration-credentials';

function getReturn(obj: Record<string, unknown> | null) {
  return obj === null ? { SecretString: undefined } : { SecretString: JSON.stringify(obj) };
}

beforeEach(() => {
  smSend.mockReset();
  clientQuery.mockReset().mockResolvedValue({ rows: [] });
  clientRelease.mockReset();
  poolConnect.mockReset().mockResolvedValue({ query: clientQuery, release: clientRelease });
});

describe('setIntegrationCredential', () => {
  it('merges into the existing map (does not clobber other slugs)', async () => {
    smSend.mockImplementation((cmd: any) =>
      cmd.kind === 'get' ? getReturn({ datadog: { api_key: 'dd' } }) : {});
    await setIntegrationCredential('notion', { token: 'secret_x' });
    const put = smSend.mock.calls.find((c) => c[0].kind === 'put')![0];
    const written = JSON.parse(put.input.SecretString);
    expect(written.datadog).toEqual({ api_key: 'dd' }); // preserved
    expect(written.notion).toEqual({ token: 'secret_x' }); // added
  });

  it('treats a missing secret version (ResourceNotFound) as {}', async () => {
    smSend.mockImplementation((cmd: any) => {
      if (cmd.kind === 'get') throw new ResourceNotFoundException('no version');
      return {};
    });
    await setIntegrationCredential('notion', { token: 't' });
    const put = smSend.mock.calls.find((c) => c[0].kind === 'put')![0];
    expect(JSON.parse(put.input.SecretString)).toEqual({ notion: { token: 't' } });
  });

  it('rejects an unknown slug with NO SM call', async () => {
    await expect(setIntegrationCredential('evil', { token: 't' })).rejects.toThrow(/slug/i);
    expect(smSend).not.toHaveBeenCalled();
    expect(poolConnect).not.toHaveBeenCalled();
  });

  it('holds a pg advisory lock around the read-modify-write', async () => {
    smSend.mockImplementation((cmd: any) => (cmd.kind === 'get' ? getReturn({}) : {}));
    await setIntegrationCredential('notion', { token: 't' });
    const lockCall = clientQuery.mock.calls.find((c) => String(c[0]).includes('pg_advisory_xact_lock'));
    expect(lockCall).toBeTruthy();
  });

  it('rejects an oversized payload (no PUT)', async () => {
    smSend.mockImplementation((cmd: any) => (cmd.kind === 'get' ? getReturn({}) : {}));
    const huge = { token: 'x'.repeat(70000) };
    await expect(setIntegrationCredential('notion', huge)).rejects.toThrow(/size|limit|large/i);
    expect(smSend.mock.calls.some((c) => c[0].kind === 'put')).toBe(false);
  });
});

describe('getConfiguredSlugs', () => {
  it('returns KEYS only — never values', async () => {
    smSend.mockImplementation((cmd: any) =>
      cmd.kind === 'get' ? getReturn({ datadog: { api_key: 'dd' }, notion: { token: 'n' } }) : {});
    const slugs = await getConfiguredSlugs();
    expect(new Set(slugs)).toEqual(new Set(['datadog', 'notion']));
    expect(JSON.stringify(slugs)).not.toContain('dd');
    expect(JSON.stringify(slugs)).not.toContain('token');
  });

  it('returns [] when the secret has no version yet', async () => {
    smSend.mockImplementation(() => {
      throw new ResourceNotFoundException('no version');
    });
    expect(await getConfiguredSlugs()).toEqual([]);
  });
});

describe('KNOWN_CONNECTOR_SLUGS', () => {
  it('includes notion', () => {
    expect(KNOWN_CONNECTOR_SLUGS).toContain('notion');
  });
});

describe('mimir multi-field credential', () => {
  it('stores {endpoint,org_id} under mimir and merges', async () => {
    smSend.mockImplementation((cmd: any) => cmd.kind === 'get' ? getReturn({ tempo: { endpoint: 'http://t:3200' } }) : {});
    await setIntegrationCredential('mimir', { endpoint: 'http://mimir:8080', org_id: 't1' });
    const put = smSend.mock.calls.find((c) => c[0].kind === 'put')![0];
    const w = JSON.parse(put.input.SecretString);
    expect(w.tempo).toEqual({ endpoint: 'http://t:3200' });
    expect(w.mimir).toEqual({ endpoint: 'http://mimir:8080', org_id: 't1' });
  });
});

describe('tempo multi-field credential', () => {
  it('stores {endpoint,org_id} under tempo and merges', async () => {
    smSend.mockImplementation((cmd: any) => cmd.kind === 'get' ? getReturn({ loki: { endpoint: 'http://loki:3100' } }) : {});
    await setIntegrationCredential('tempo', { endpoint: 'http://tempo:3200', org_id: 't9' });
    const put = smSend.mock.calls.find((c) => c[0].kind === 'put')![0];
    const w = JSON.parse(put.input.SecretString);
    expect(w.loki).toEqual({ endpoint: 'http://loki:3100' });
    expect(w.tempo).toEqual({ endpoint: 'http://tempo:3200', org_id: 't9' });
  });
});

describe('loki multi-field credential', () => {
  it('stores {endpoint,org_id,token} under loki and merges', async () => {
    smSend.mockImplementation((cmd: any) => cmd.kind === 'get' ? getReturn({ prometheus: { endpoint: 'http://p:9090' } }) : {});
    await setIntegrationCredential('loki', { endpoint: 'http://loki:3100', org_id: 't7', token: 'k' });
    const put = smSend.mock.calls.find((c) => c[0].kind === 'put')![0];
    const w = JSON.parse(put.input.SecretString);
    expect(w.prometheus).toEqual({ endpoint: 'http://p:9090' });
    expect(w.loki).toEqual({ endpoint: 'http://loki:3100', org_id: 't7', token: 'k' });
  });
});

describe('prometheus multi-field credential', () => {
  it('stores {endpoint,token} under prometheus and merges', async () => {
    smSend.mockImplementation((cmd: any) =>
      cmd.kind === 'get' ? getReturn({ clickhouse: { endpoint: 'http://ch:8123' } }) : {});
    await setIntegrationCredential('prometheus', { endpoint: 'http://prometheus:9090', token: 't' });
    const put = smSend.mock.calls.find((c) => c[0].kind === 'put')![0];
    const written = JSON.parse(put.input.SecretString);
    expect(written.clickhouse).toEqual({ endpoint: 'http://ch:8123' });
    expect(written.prometheus).toEqual({ endpoint: 'http://prometheus:9090', token: 't' });
  });
});

describe('clickhouse multi-field credential', () => {
  it('stores a {endpoint,username,password} object and merges with other slugs', async () => {
    smSend.mockImplementation((cmd: any) =>
      cmd.kind === 'get' ? getReturn({ notion: { token: 'n' } }) : {});
    await setIntegrationCredential('clickhouse', { endpoint: 'http://ch:8123', username: 'u', password: 'p' });
    const put = smSend.mock.calls.find((c) => c[0].kind === 'put')![0];
    const written = JSON.parse(put.input.SecretString);
    expect(written.notion).toEqual({ token: 'n' });            // preserved
    expect(written.clickhouse).toEqual({ endpoint: 'http://ch:8123', username: 'u', password: 'p' });
  });
});
