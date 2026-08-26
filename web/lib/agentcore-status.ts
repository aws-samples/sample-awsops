// v1-parity AgentCore status (v1 /api/agentcore). v1 shelled out to the AWS CLI on the EC2 host;
// v2 runs on Fargate, so this uses the control-plane SDK. Read-only: GetAgentRuntime + its DEFAULT
// endpoint, ListGateways (+ ListGatewayTargets per gateway), ListMemories, ListCodeInterpreters.
// 5-min in-process cache (matches v1's NodeCache TTL). Never throws — degrades to nulls/empties so
// the page renders a partial view instead of 500-ing.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  ListAgentRuntimeEndpointsCommand,
  ListGatewaysCommand,
  ListGatewayTargetsCommand,
  ListMemoriesCommand,
  ListCodeInterpretersCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const ARN_PARAM = process.env.SSM_RUNTIME_ARN_PARAM || '/ops/awsops-v2/agentcore/runtime_arn';
const TTL_MS = 5 * 60 * 1000;

// Only surface gateways for THIS deployment. v2 gateways are named awsops-v2-<x>-gateway; during
// the v1↔v2 coexistence window a shared account also holds v1 awsops-<x>-gateway — exclude those.
const GW_PREFIX = 'awsops-v2-';

export interface GatewayStatus { id: string; name: string; shortName: string; status: string; targets: number }
export interface AgentCoreStatus {
  runtime: { id: string; status: string; endpointStatus: string | null; version: string | null; createdAt: string | null; lastUpdatedAt: string | null } | null;
  gateways: GatewayStatus[];
  memory: { id: string; status: string } | null;
  interpreter: { id: string; status: string } | null;
  region: string;
  timestamp: string;
  fetchDurationSec: number;
}

let ssm: SSMClient | null = null;
let ctrl: BedrockAgentCoreControlClient | null = null;
let cache: { at: number; value: AgentCoreStatus } | null = null;

function runtimeIdFromArn(arn: string): string {
  const m = arn.match(/runtime\/(.+)$/);
  return m ? m[1] : '';
}

async function getRuntimeId(): Promise<string> {
  if (!ssm) ssm = new SSMClient({ region: REGION });
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: ARN_PARAM }));
    return runtimeIdFromArn(r.Parameter?.Value ?? '');
  } catch {
    return '';
  }
}

async function paginate<T>(fn: (token?: string) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const { items, next } = await fn(token);
    out.push(...items);
    token = next;
  } while (token);
  return out;
}

export async function getAgentCoreStatus(bustCache = false): Promise<AgentCoreStatus> {
  if (!bustCache && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const start = Date.now();
  if (!ctrl) ctrl = new BedrockAgentCoreControlClient({ region: REGION });
  const client = ctrl;
  const runtimeId = await getRuntimeId();

  // Runtime + its DEFAULT endpoint status (endpoint READY is what actually gates invocation).
  const runtimeP = (async () => {
    if (!runtimeId) return null;
    try {
      const rt = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
      let endpointStatus: string | null = null;
      try {
        const eps = await client.send(new ListAgentRuntimeEndpointsCommand({ agentRuntimeId: runtimeId }));
        endpointStatus = eps.runtimeEndpoints?.find((e) => e.name === 'DEFAULT')?.status
          ?? eps.runtimeEndpoints?.[0]?.status ?? null;
      } catch { /* endpoint list optional */ }
      return {
        id: rt.agentRuntimeId ?? runtimeId,
        status: rt.status ?? 'UNKNOWN',
        endpointStatus,
        version: rt.agentRuntimeVersion ?? null,
        createdAt: rt.createdAt ? new Date(rt.createdAt).toISOString() : null,
        lastUpdatedAt: rt.lastUpdatedAt ? new Date(rt.lastUpdatedAt).toISOString() : null,
      };
    } catch {
      return null;
    }
  })();

  // Gateways (this deployment only) + per-gateway target counts.
  const gatewaysP = (async () => {
    let items: { gatewayId?: string; name?: string; status?: string }[] = [];
    try {
      items = await paginate(async (token) => {
        const r = await client.send(new ListGatewaysCommand(token ? { nextToken: token } : {}));
        return { items: r.items ?? [], next: r.nextToken };
      });
    } catch {
      return [];
    }
    const mine = items.filter((g) => g.name?.startsWith(GW_PREFIX));
    const gateways = await Promise.all(mine.map(async (g): Promise<GatewayStatus> => {
      let targets = 0;
      try {
        const t = await client.send(new ListGatewayTargetsCommand({ gatewayIdentifier: g.gatewayId! }));
        targets = t.items?.length ?? 0;
      } catch { /* target count best-effort */ }
      return {
        id: g.gatewayId ?? '',
        name: g.name ?? '',
        shortName: (g.name ?? '').replace(GW_PREFIX, '').replace('-gateway', ''),
        status: g.status ?? 'UNKNOWN',
        targets,
      };
    }));
    return gateways.sort((a, b) => a.shortName.localeCompare(b.shortName));
  })();

  // Memory + Code Interpreter (name-matched to this project's provisioned resources).
  const memoryP = (async () => {
    try {
      const r = await client.send(new ListMemoriesCommand({}));
      const m = (r.memories ?? []).find((x) => (x.id ?? '').startsWith('awsops_v2_memory'));
      return m ? { id: m.id ?? '', status: m.status ?? 'UNKNOWN' } : null;
    } catch {
      return null;
    }
  })();
  const interpreterP = (async () => {
    try {
      const r = await client.send(new ListCodeInterpretersCommand({}));
      const list = r.codeInterpreterSummaries ?? [];
      const ci = list.find((x) => (x.codeInterpreterId ?? x.name ?? '').startsWith('awsops_v2_code_interpreter'));
      return ci ? { id: ci.codeInterpreterId ?? ci.name ?? '', status: ci.status ?? 'UNKNOWN' } : null;
    } catch {
      return null;
    }
  })();

  const [runtime, gateways, memory, interpreter] = await Promise.all([runtimeP, gatewaysP, memoryP, interpreterP]);
  const value: AgentCoreStatus = {
    runtime, gateways, memory, interpreter, region: REGION,
    timestamp: new Date().toISOString(),
    fetchDurationSec: Math.round((Date.now() - start) / 100) / 10,
  };
  cache = { at: Date.now(), value };
  return value;
}
