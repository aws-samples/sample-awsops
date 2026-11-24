/** The unique host row's 12-digit account id from `GET /api/accounts`, or null when it is absent,
 *  ambiguous (more than one host row) or malformed. Never guessed. Client-safe. */
export function hostAccountOf(body: unknown): string | null {
  const accounts = (body as { accounts?: unknown } | null)?.accounts;
  const hosts = Array.isArray(accounts)
    ? accounts.filter((a): a is { accountId?: unknown } => !!a && typeof a === 'object' && (a as { isHost?: unknown }).isHost === true)
    : [];
  const id = hosts.length === 1 ? hosts[0].accountId : undefined;
  return typeof id === 'string' && /^\d{12}$/.test(id) ? id : null;
}
