// Vendor labels do not exempt administrator-supplied MCP endpoints from these controls.
import { isDatasourceKind } from './integrations-category';
export const CUSTOM_MCP_ATTESTATION = '_customMcpAttestation';
export interface McpRegistration {
  id?: number; kind?: string; direction?: string; capability?: string;
  endpoint?: string | null; transport?: string | null; credentialsRef?: string | null;
  exposedTools?: unknown; invalidToolShape?: boolean; providedContext?: Record<string, unknown>;
}
export interface McpAttestation {
  actorSub: string; attestedAt: string; tools: string[]; endpoint: string;
  transport: string; credentialsRef: string; credentialVersionId: string;
}

/** Activation requires dated ADR acceptance and a separate reviewed runtime release. */
export function customMcpEnabled(): boolean {
  return process.env.CUSTOM_MCP_ENABLED === 'true';
}

export function isMcpRegistration(i: McpRegistration): boolean {
  const tools = i.exposedTools === undefined ? [] : i.exposedTools;
  // Native query connectors have their own credential/SSRF path. A vendor-labelled MCP
  // registration still carries transport, a credential reference or tools and remains governed.
  if (isDatasourceKind(i.kind ?? '') && i.direction === 'egress' &&
      (i.capability ?? 'read') === 'read' && !i.transport && !i.credentialsRef &&
      !i.invalidToolShape && Array.isArray(tools) && tools.length === 0) return false;
  return (!!i.endpoint && !i.direction) || i.kind === 'custom_mcp' || (i.direction === 'egress' &&
    ((!!i.endpoint && (i.capability ?? 'read') === 'read') ||
      i.invalidToolShape || !Array.isArray(tools) || tools.length > 0));
}

export function customMcpSecretName(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid integration id');
  const shared = process.env.INTEGRATIONS_SECRET_NAME || 'ops/awsops-v2/integrations/credentials';
  const match = /^ops\/([a-zA-Z0-9_-]+)\/integrations\/credentials$/.exec(shared);
  if (!match) throw new Error('invalid integrations secret namespace');
  return `ops/${match[1]}/integrations/custom/${id}`;
}

export function mcpRegistrationErrors(i: McpRegistration): string[] {
  const errors: string[] = [];
  if (i.direction !== 'egress' || (i.capability ?? 'read') !== 'read') {
    errors.push('custom MCP connections require egress/read');
  }
  if (!['api_key', 'oauth_client_credentials'].includes(i.transport ?? '')) {
    errors.push('custom MCP requires scoped secret authentication; SigV4 is unavailable');
  }
  if (i.invalidToolShape || !Array.isArray(i.exposedTools) || i.exposedTools.length > 128 ||
      i.exposedTools.some((t) => typeof t !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(t) || t.includes('___')) ||
      new Set(i.exposedTools).size !== i.exposedTools.length) {
    errors.push('exposedTools must be at most 128 unique exact tool names');
  }
  try {
    const url = new URL(i.endpoint ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      errors.push('custom MCP requires an HTTPS endpoint without userinfo or fragment');
    }
  } catch { errors.push('custom MCP requires an HTTPS endpoint'); }
  return errors;
}

export function assertMcpReady(i: McpRegistration): asserts i is McpRegistration & {
  id: number; endpoint: string; transport: string; credentialsRef: string; exposedTools: string[];
} {
  const errors = mcpRegistrationErrors(i);
  if (errors.length) throw new Error(errors.join('; '));
  if (!(i.exposedTools as string[]).length) throw new Error('custom MCP requires a nonempty tool ceiling');
  if (i.credentialsRef !== customMcpSecretName(i.id!)) {
    throw new Error('custom MCP credential reference must match its registration');
  }
}

export function validMcpAttestation(i: McpRegistration): boolean {
  try {
    assertMcpReady(i);
    const a = i.providedContext?.[CUSTOM_MCP_ATTESTATION] as McpAttestation | undefined;
    return !!a && typeof a.actorSub === 'string' && !!a.actorSub.trim() &&
      typeof a.attestedAt === 'string' && Number.isFinite(Date.parse(a.attestedAt)) &&
      typeof a.credentialVersionId === 'string' && /^[A-Za-z0-9-]{32,64}$/.test(a.credentialVersionId) &&
      a.endpoint === i.endpoint && a.transport === i.transport && a.credentialsRef === i.credentialsRef &&
      Array.isArray(a.tools) && a.tools.length === i.exposedTools.length &&
      a.tools.every((t, n) => t === i.exposedTools[n]);
  } catch { return false; }
}
