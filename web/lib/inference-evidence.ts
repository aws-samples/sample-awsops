import type { TraceSpan } from './trace-source';

/** These are reported destination identities, never verified inventory ownership. */
export function runtimeClaim(value: unknown) {
  if (typeof value !== 'string' || value.length > 512) return null;
  const match = /^arn:(aws(?:-[a-z0-9-]+)?):bedrock-agentcore:([a-z]{2,8}(?:-[a-z0-9]+)+-\d+):(\d{12}):runtime\/([A-Za-z0-9_][A-Za-z0-9_-]{0,255})$/.exec(value);
  return match ? {
    arn: value, name: match[4], claimedAccountId: match[3], claimedRegion: match[2],
    identityProvenance: 'telemetry_claim' as const,
  } : null;
}

export function reportingRuntime(span: TraceSpan) {
  const claim = runtimeClaim(span.runtimeResourceArn ?? span.cloudResourceId);
  if (!claim || (span.accountId && span.accountId !== claim.claimedAccountId)
      || (span.region && span.region !== claim.claimedRegion)
      || (span.cloudResourceId && span.cloudResourceId !== claim.arn)) return null;
  return claim;
}

export function modelClaim(span: TraceSpan) {
  if (span.kind !== 'CLIENT' || span.runtimeArn !== undefined) return null;
  const provider = span.genAiProvider
    ?? (/^(?:Amazon )?Bedrock Runtime$/i.test(span.rpcService ?? '')
      || span.rpcService === 'bedrock-runtime' ? 'aws.bedrock' : undefined);
  const model = span.genAiModel;
  if (!provider || !/^[a-z][a-z0-9._-]{0,63}$/.test(provider) || !model
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model) || model.includes('://')) return null;
  const endpoint = span.inferenceEndpoint?.toLowerCase().replace(/\.$/, '');
  if (endpoint !== undefined && (endpoint.length > 253 || !endpoint.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) return null;
  return { provider, model, endpoint: endpoint ?? null, port: span.inferencePort ?? null,
    identityProvenance: 'telemetry_claim' as const };
}
