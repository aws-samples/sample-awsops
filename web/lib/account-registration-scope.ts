/** Absent preserves legacy scope. An explicit malformed deployment allowlist fails closed. */
export function registrationTargetAccountIds(raw: string | undefined, hostAccountId: string): string[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value: unknown = JSON.parse(raw);
  if (!/^\d{12}$/.test(hostAccountId) || !Array.isArray(value) || value.length > 5 ||
      value.some(id => typeof id !== 'string' || !/^\d{12}$/.test(id) || id === hostAccountId) ||
      new Set(value).size !== value.length) {
    throw new Error('Invalid deployment account scope');
  }
  return value;
}
