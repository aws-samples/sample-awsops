import { afterEach, describe, expect, it } from 'vitest';
import { DATASOURCE_KINDS } from './integrations-category';
import { CUSTOM_MCP_ATTESTATION, assertMcpReady, customMcpSecretName, isMcpRegistration,
  customMcpEnabled, mcpRegistrationErrors, validMcpAttestation } from './custom-mcp-policy';
const registration = { id: 7, kind: 'custom_mcp', direction: 'egress', capability: 'read',
  endpoint: 'https://example.com/mcp', transport: 'api_key', credentialsRef: 'ops/awsops-v2/integrations/custom/7',
  exposedTools: ['query'] };
const a = { actorSub: 'immutable-sub', attestedAt: '2026-10-18T12:00:00.000Z', tools: ['query'],
  endpoint: registration.endpoint, transport: registration.transport, credentialsRef: registration.credentialsRef,
  credentialVersionId: 'a'.repeat(32) };
afterEach(() => { delete process.env.INTEGRATIONS_SECRET_NAME; delete process.env.CUSTOM_MCP_ENABLED; });
describe('administrator MCP policy', () => {
  it('defaults activation off and accepts only an explicit true value', () => {
    delete process.env.CUSTOM_MCP_ENABLED;
    expect(customMcpEnabled()).toBe(false);
    process.env.CUSTOM_MCP_ENABLED = '1';
    expect(customMcpEnabled()).toBe(false);
    process.env.CUSTOM_MCP_ENABLED = 'true';
    expect(customMcpEnabled()).toBe(true);
  });
  it('binds exact positive IDs to the configured namespace', () => {
    expect(customMcpSecretName(7)).toBe(registration.credentialsRef);
    process.env.INTEGRATIONS_SECRET_NAME = 'ops/project-dev/integrations/credentials';
    expect(customMcpSecretName(8)).toBe('ops/project-dev/integrations/custom/8');
  });
  it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid id %s', id => {
    expect(() => customMcpSecretName(id)).toThrow('invalid integration id');
  });
  it('rejects a shared-secret ARN or malformed namespace instead of deriving another secret', () => {
    process.env.INTEGRATIONS_SECRET_NAME = 'arn:aws:secretsmanager:region:account:secret:other';
    expect(() => customMcpSecretName(7)).toThrow('namespace');
  });
  it.each([
    { direction: 'ingress' }, { capability: 'read_write' }, { transport: 'sigv4' },
    { transport: 'oauth_3lo' }, { exposedTools: ['query', 'query'] },
    { exposedTools: ['gateway___mutate'] }, { exposedTools: ['*'] },
    { exposedTools: {} }, { endpoint: 'https://user:pass@example.com/mcp' },
    { endpoint: 'http://example.com/mcp' },
  ])('rejects an unsafe registration %j', edit => {
    expect(mcpRegistrationErrors({ ...registration, ...edit }).length).toBeGreaterThan(0);
  });
  it('treats a vendor kind with exposed MCP tools as the same governed registration', () => {
    expect(isMcpRegistration({ ...registration, kind: 'grafana' })).toBe(true);
    expect(isMcpRegistration({ kind: 'grafana', direction: 'egress', exposedTools: [] })).toBe(false);
    expect(isMcpRegistration({ ...registration, kind: 'grafana', exposedTools: [] })).toBe(true);
    expect(isMcpRegistration({ ...registration, kind: 'slack', capability: 'read_write', exposedTools: [] })).toBe(false);
  });
  it.each(DATASOURCE_KINDS)('keeps the native %s connector out of MCP enablement', kind => {
    const native = { kind, direction: 'egress', capability: 'read',
      endpoint: 'https://example.com/query', transport: null, credentialsRef: null, exposedTools: [] };
    expect(isMcpRegistration(native)).toBe(false);
    expect(isMcpRegistration({ ...native, transport: 'api_key' })).toBe(true);
    expect(isMcpRegistration({ ...native, credentialsRef: 'assigned' })).toBe(true);
    expect(isMcpRegistration({ ...native, exposedTools: ['query'] })).toBe(true);
    expect(isMcpRegistration({ ...native, exposedTools: { legacy: true } })).toBe(true);
  });
  it('permits a disabled empty registration but never enables its connection', () => {
    expect(mcpRegistrationErrors({ ...registration, exposedTools: [] })).toEqual([]);
    expect(() => assertMcpReady({ ...registration, exposedTools: [] })).toThrow('nonempty');
  });
  it.each(['ops/awsops-v2/integrations/custom/8', 'ops/awsops-v2/integrations/credentials',
    'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:ops/awsops-v2/integrations/custom/7-abcdef'])(
    'rejects a credential reference outside the exact row: %s', credentialsRef => {
      expect(() => assertMcpReady({ ...registration, credentialsRef })).toThrow('reference');
    });
  it('requires an attestation matching every current field', () => {
    const i = { ...registration, providedContext: { [CUSTOM_MCP_ATTESTATION]: a } };
    expect(validMcpAttestation(i)).toBe(true);
    expect(validMcpAttestation({ ...i, endpoint: 'https://changed.example/mcp' })).toBe(false);
    expect(validMcpAttestation({ ...i, exposedTools: ['other'] })).toBe(false);
    expect(validMcpAttestation({ ...registration })).toBe(false);
    expect(validMcpAttestation({ ...i, providedContext: { [CUSTOM_MCP_ATTESTATION]: { ...a, actorSub: '' } } })).toBe(false);
  });
});
