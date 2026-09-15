import { describe, expect, it } from 'vitest';
import { redactInventorySecrets } from './inventory-redaction';

describe('recognized inventory secret projection', () => {
  it('preserves harmless routing/configuration fields and does not mutate the input', () => {
    const input = { origins: [{ Id: 'main', DomainName: 'origin.example.test',
      VpcOriginConfig: { VpcOriginId: 'vo-fixture' }, CustomHeaders: [{ HeaderValue: 'SECRET' }] }],
      actions: [{ ForwardConfig: { TargetGroups: [{ TargetGroupArn: 'tg-fixture' }] },
        AuthenticateOidcConfig: { ClientId: 'public-id', Issuer: 'issuer.example.test', ClientSecret: 'SECRET' } }] };
    const before = JSON.stringify(input), result = redactInventorySecrets(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(result.origins[0]).toMatchObject({ DomainName: 'origin.example.test', VpcOriginConfig: { VpcOriginId: 'vo-fixture' } });
    expect(result.actions[0]).toMatchObject({ ForwardConfig: input.actions[0].ForwardConfig,
      AuthenticateOidcConfig: { ClientId: 'public-id', Issuer: 'issuer.example.test' } });
  });
  it.each(['CustomHeaders', 'custom_headers', 'OriginCustomHeaders', 'client-secret', 'ClientSecret'])(
    'redacts %s through nested JSON encoding while retaining string representation', key => {
      const input = JSON.stringify(JSON.stringify({ public: 'kept', [key]: 'SECRET' }));
      const result = redactInventorySecrets(input);
      expect(typeof result).toBe('string');
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(JSON.parse(JSON.parse(result))).toEqual({ public: 'kept' });
    });
  it('recognizes Unicode-escaped field names and cannot pollute object prototypes', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true,"ClientSecret":"SECRET"},"encoded":"{\\"Cus\\\\u0074omHeaders\\":\\"SECRET\\",\\"safe\\":1}"}');
    const result = redactInventorySecrets(input);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.parse(result.encoded)).toEqual({ safe: 1 });
  });
  it('fails closed on unsafe encoded containers without exposing a credential prefix', () => {
    for (const origins of ['{"ClientSecret":"SECRET", broken', JSON.stringify({ ClientSecret: 'SECRET'.repeat(50000) })]) {
      expect(() => redactInventorySecrets({ origins })).toThrow('Inventory metadata cannot be safely projected');
    }
    expect(redactInventorySecrets({ description: '{ordinary text' })).toEqual({ description: '{ordinary text' });
    expect(redactInventorySecrets('ordinary label')).toBe('ordinary label');
    expect(() => redactInventorySecrets('{"CustomHeaders":"SECRET", broken')).toThrow('Inventory metadata cannot be safely projected');
    expect(() => redactInventorySecrets({ origins: { Items: '{"CustomHeaders":"SECRET", broken' } }))
      .toThrow('Inventory metadata cannot be safely projected');
  });
});
