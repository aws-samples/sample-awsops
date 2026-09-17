import { describe, expect, it } from 'vitest';
import { registrationTargetAccountIds } from './account-registration-scope';

const host = '111111111111';

describe('deployment registration scope', () => {
  it.each([undefined, ''])('preserves legacy scope only for absent/empty input (%j)', raw => {
    expect(registrationTargetAccountIds(raw, host)).toBeUndefined();
  });

  it.each([' ', '\t', '\n'])('does not turn an explicitly malformed allowlist into unrestricted scope (%j)', raw => {
    expect(() => registrationTargetAccountIds(raw, host)).toThrow();
  });

  it('keeps an explicit empty allowlist distinct from absence', () => {
    expect(registrationTargetAccountIds('[]', host)).toEqual([]);
  });
});
