// web/lib/account.ts
// ADR-031 Phase 2 — minimal account-context. v2 has one live account and no
// selector UI; the web tier already uses the literal 'self' as its single-account
// convention (inventory.ts). HOST_ACCOUNT_ID is wired from data.aws_caller_identity
// in workload.tf. Forward-ready: agent_spaces is account-keyed, so multi-account is a
// data concern (add a row), not a code change.

/** The account the dashboard is operating on today. Never throws; never empty. */
export function currentAccountId(): string {
  const id = process.env.HOST_ACCOUNT_ID?.trim();
  return id && id.length > 0 ? id : 'self';
}

/** Optional human alias for the system-prompt account directive (agent.py). */
export function currentAccountAlias(): string | undefined {
  const a = process.env.HOST_ACCOUNT_ALIAS?.trim();
  return a && a.length > 0 ? a : undefined;
}
