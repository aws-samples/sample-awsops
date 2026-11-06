import { describe, it, expect } from 'vitest';
import {
  AUTO_REGISTER_SUPPRESS_KEY, autoRegisterCandidates, clearAutoRegisterSuppression,
  readAutoRegisterSuppressed, suppressAutoRegister,
} from './eks-auto-register';

const memStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
};
const ARN = 'arn:aws:eks:us-east-1:222222222222:cluster/a';

describe('eks auto-registration helpers', () => {
  it('selects only admin-visible, verified, unregistered, unsuppressed, untried member rows', () => {
    const rows = [
      { id: ARN, name: 'a', access: 'entry-only', accessEntryVerified: true },
      { id: 'b-arn', name: 'b', access: 'entry-only', accessEntryVerified: true },
      { id: 'c-arn', name: 'c', access: 'entry-only', accessEntryVerified: true },
      { id: 'd-arn', name: 'd', access: 'entry-only' },
      { id: 'e-arn', name: 'e', access: 'connected', accessEntryVerified: true },
      { id: 'f-arn', name: 'f', access: 'entry-only', accessEntryVerified: true, runtime: true },
    ];
    const opts = { admin: true, suppressed: new Set(['b-arn']), attempted: new Set(['c-arn']) };
    expect(autoRegisterCandidates(rows, opts)).toEqual([ARN]);
    expect(autoRegisterCandidates(rows, { ...opts, admin: false })).toEqual([]);
  });

  it('persists DELETE suppression until a manual registration clears it', () => {
    const s = memStorage();
    suppressAutoRegister(ARN, s);
    suppressAutoRegister(ARN, s);
    expect([...readAutoRegisterSuppressed(s)]).toEqual([ARN]);
    clearAutoRegisterSuppression(ARN, s);
    expect(readAutoRegisterSuppressed(s).size).toBe(0);
  });

  it('degrades to no suppression on missing, corrupt or throwing storage', () => {
    const s = memStorage();
    s.m.set(AUTO_REGISTER_SUPPRESS_KEY, '{not json');
    expect(readAutoRegisterSuppressed(s).size).toBe(0);
    s.m.set(AUTO_REGISTER_SUPPRESS_KEY, JSON.stringify({ a: 1 }));
    expect(readAutoRegisterSuppressed(s).size).toBe(0);
    expect(readAutoRegisterSuppressed(null).size).toBe(0);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readAutoRegisterSuppressed(throwing).size).toBe(0);
    expect(() => suppressAutoRegister(ARN, throwing)).not.toThrow();
    expect(() => clearAutoRegisterSuppression(ARN, throwing)).not.toThrow();
  });
});
