/** Parse only the destination's qualifiers, never the reporting workload's identity.
 * Keep this grammar aligned with inventory_read_mcp and the SQL-reader projection. */
export function queueDestinationArn(value: unknown): { accountId: string; region: string | null } | null {
  if (typeof value !== 'string') return null;
  const match = /^arn:[a-z0-9-]+:[a-z0-9-]+:([a-z0-9-]*):([0-9]{12}):\S+$/.exec(value.trim());
  return match ? { accountId: match[2], region: match[1] || null } : null;
}

/** Re-derive even retained claims: legacy/current fields may describe the reporter.
 * A destination ARN is still unverified telemetry, including when it names the host. */
export function queueClaimMeta(meta: Record<string, unknown> = {}): Record<string, unknown> {
  const { accountId, region, infra_ref, claimedAccountId, claimedRegion, ...rest } = meta;
  const destination = queueDestinationArn(meta.destination);
  return {
    ...rest,
    claimedAccountId: destination?.accountId ?? null,
    claimedRegion: destination?.region ?? null,
    identityProvenance: 'telemetry_claim',
  };
}
