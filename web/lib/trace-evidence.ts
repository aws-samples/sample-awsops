/** Queue attribution is a telemetry claim, including when it names the configured host.
 * Apply on reads too: retained snapshots may still contain the old accountId/region keys. */
export function queueClaimMeta(meta: Record<string, unknown> = {}): Record<string, unknown> {
  const { accountId, region, infra_ref, claimedAccountId, claimedRegion, ...rest } = meta;
  const claim = (value: unknown, legacy: unknown) =>
    typeof value === 'string' && value ? value : typeof legacy === 'string' && legacy ? legacy : null;
  return {
    ...rest,
    claimedAccountId: claim(claimedAccountId, accountId),
    claimedRegion: claim(claimedRegion, region),
    identityProvenance: 'telemetry_claim',
  };
}
