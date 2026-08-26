// web/lib/mcp-lambda-invoke.ts
// Invoke a connector MCP Lambda's tool from the BFF, passing an optional INLINE connection config
// (endpoint + auth) in the payload. This is what enables multi-instance datasources (the BFF resolves
// the instance → connConfig) and the pre-save Test (a candidate connConfig that isn't stored yet).
// When connConfig is omitted the Lambda falls back to its slug/env credential map (the AgentCore
// gateway no-inline path). The Lambda still owns SSRF/VPC/auth; the BFF SSRF-guards too (defense in depth).
//
// "MCP Lambda" = the transport mechanism (per-kind `${PROJECT}-agent-${kind}-mcp`). Distinct from the
// user-facing "Connector" category (an external service). connector-invoke.ts is a thin compat shim.
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const PROJECT = process.env.PROJECT || 'awsops-v2';

/** Kinds that have a per-kind connector MCP Lambda (the invoke transport allowlist). Kept independent
 *  of integration-credentials so the invoke transport doesn't pull the Secrets Manager SDK into its
 *  import graph (mirrors integration-credentials.KNOWN_CONNECTOR_SLUGS). */
export const KNOWN_MCP_LAMBDA_KINDS = ['notion', 'clickhouse', 'prometheus', 'loki', 'tempo', 'mimir', 'jaeger', 'dynatrace', 'datadog'] as const;

// The connection config is the FLAT secret blob the routes resolve (getCredentialById) and the
// connector Lambda reads verbatim (creds.get("authType"), creds.get("username"), …) — NOT nested.
export interface ConnConfig {
  endpoint?: string;
  authType?: string;
  username?: string;
  password?: string;
  token?: string;
  headerName?: string;
  headerValue?: string;
  org_id?: string;
  [field: string]: unknown;
}

let lc: LambdaClient | null = null;
function client(): LambdaClient {
  if (!lc) lc = new LambdaClient({ region: REGION });
  return lc;
}

/** Invoke `${PROJECT}-agent-${kind}-mcp` with {tool_name, arguments, conn_config?}; return the parsed body. */
export async function invokeMcpLambdaTool(opts: {
  kind: string;
  tool: string;
  args?: Record<string, unknown>;
  connConfig?: ConnConfig;
}): Promise<unknown> {
  const { kind, tool, args = {}, connConfig } = opts;
  if (!(KNOWN_MCP_LAMBDA_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown integration slug/kind: ${kind}`);
  }
  const payload: Record<string, unknown> = { tool_name: tool, arguments: args };
  if (connConfig) payload.conn_config = connConfig;

  const resp = await client().send(new InvokeCommand({
    FunctionName: `${PROJECT}-agent-${kind}-mcp`,
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
  if (resp.FunctionError) throw new Error(`mcp lambda ${kind} invoke failed: ${resp.FunctionError}`);
  const raw = resp.Payload ? Buffer.from(resp.Payload).toString('utf8') : '';
  let env: { statusCode?: number; body?: string };
  try { env = JSON.parse(raw); } catch { throw new Error(`mcp lambda ${kind} returned non-JSON`); }
  const body = typeof env?.body === 'string' ? JSON.parse(env.body) : env;
  if (env?.statusCode && env.statusCode >= 400) {
    throw new Error((body && (body as { error?: string }).error) || `mcp lambda ${kind} error`);
  }
  return body;
}
