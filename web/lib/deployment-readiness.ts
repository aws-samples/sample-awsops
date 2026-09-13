import { randomUUID } from 'node:crypto';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { runtimeParameter, validRuntimeArn } from './agentcore-config';

export interface ReadinessInput { nonce: string; expectedAccountId: string; expectedCloudfrontId: string }
type ParameterState = 'uninspected' | 'ready' | 'disabled' | 'pending' | 'missing' | 'denied' | 'invalid' | 'unavailable';
const keys = ['runtime_arn', 'interpreter_id', 'memory_id'] as const;
const checks = ['identity', 'inventorySummary', 'inventoryQuery', 'knownResource', 'freshInventory', 'model'] as const;
const agentReasons = ['ok', 'invalid_request', 'identity_failed', 'account_mismatch', 'gateway_unavailable',
  'tools_unavailable', 'inventory_unavailable', 'inventory_stale', 'known_resource_missing', 'model_failed', 'timeout'] as const;
type AgentReason = typeof agentReasons[number];
export interface AgentReadiness {
  schemaVersion: 1; mode: 'deployment_readiness'; nonce: string; accountId: string;
  status: 'ready' | 'not_ready'; reason: AgentReason;
  checks: Record<typeof checks[number], boolean>;
  inventory: { count: number | null; ageMinutes: number | null };
}
export interface DeploymentReadiness {
  schemaVersion: 1; nonce: string; accountId: string; status: 'ready' | 'not_ready';
  reason: string; webIdentity: boolean; parameters: Record<typeof keys[number], ParameterState>;
  agent: AgentReadiness | null;
}
const region = process.env.AWS_REGION || 'ap-northeast-2';
const clientConfig = { region, maxAttempts: 1 };
const sts = new STSClient(clientConfig);
const ssm = new SSMClient(clientConfig);
const runtime = new BedrockAgentCoreClient(clientConfig);
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const exactKeys = (v: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const count = (n: unknown) => n === null || (Number.isSafeInteger(n) && Number(n) >= 0);
function validAgentEvent(v: unknown, input: ReadinessInput): v is AgentReadiness {
  if (!record(v) || !exactKeys(v, ['schemaVersion', 'mode', 'nonce', 'accountId', 'status', 'reason', 'checks', 'inventory'])
      || v.schemaVersion !== 1 || v.mode !== 'deployment_readiness' || v.nonce !== input.nonce
      || v.accountId !== input.expectedAccountId || !['ready', 'not_ready'].includes(String(v.status))
      || !agentReasons.some(r => r === v.reason)) return false;
  const evidence = v.checks;
  const inventory = v.inventory;
  if (!record(evidence) || !exactKeys(evidence, checks) || !checks.every(k => typeof evidence[k] === 'boolean')
      || !record(inventory) || !exactKeys(inventory, ['count', 'ageMinutes'])
      || !count(inventory.count) || Number(inventory.count) > 500
      || !count(inventory.ageMinutes) || Number(inventory.ageMinutes) > 1440) return false;
  if (v.status === 'ready' && (v.reason !== 'ok' || !Object.values(evidence).every(x => x === true)
      || inventory.count === null || Number(inventory.count) < 1
      || inventory.ageMinutes === null || Number(inventory.ageMinutes) > 1440)) return false;
  return !(v.status === 'not_ready' && v.reason === 'ok');
}

export function validReadinessInput(value: unknown): value is ReadinessInput {
  return record(value) && exactKeys(value, ['nonce', 'expectedAccountId', 'expectedCloudfrontId'])
    && typeof value.nonce === 'string' && /^[a-zA-Z0-9_-]{32,64}$/.test(value.nonce)
    && typeof value.expectedAccountId === 'string' && /^[0-9]{12}$/.test(value.expectedAccountId)
    && typeof value.expectedCloudfrontId === 'string' && /^[A-Z0-9]{5,32}$/.test(value.expectedCloudfrontId);
}

/** Accept exactly the readiness protocol. Chat text, extra fields and duplicate events fail closed. */
export function parseReadinessEvent(raw: string, input: ReadinessInput): AgentReadiness {
  if (Buffer.byteLength(raw) > 16_384) throw new Error();
  const payloads: string[] = [];
  let data: string[] = [];
  const flush = () => {
    const payload = data.join('\n').trim();
    if (payload && payload !== '[DONE]') payloads.push(payload);
    data = [];
  };
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (!line) { flush(); continue; }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (!['event', 'id', 'retry'].includes(field)) throw new Error();
  }
  flush();
  if (payloads.length !== 1) throw new Error();
  const v: unknown = JSON.parse(payloads[0]);
  if (!validAgentEvent(v, input)) throw new Error();
  return v;
}

export async function deploymentReadiness(input: ReadinessInput): Promise<DeploymentReadiness> {
  const result: DeploymentReadiness = {
    schemaVersion: 1, nonce: input.nonce, accountId: input.expectedAccountId,
    status: 'not_ready', reason: 'configuration_invalid', webIdentity: false,
    parameters: { runtime_arn: 'uninspected', interpreter_id: 'uninspected', memory_id: 'uninspected' }, agent: null,
  };
  const project = process.env.PROJECT || 'awsops-v2';
  const host = process.env.HOST_ACCOUNT_ID;
  if (!validReadinessInput(input) || host !== input.expectedAccountId || !/^[a-z][a-z0-9-]{1,62}$/.test(project)) return result;
  if (runtimeParameter() === '') {
    result.reason = 'disabled';
    for (const key of keys) result.parameters[key] = 'disabled';
    return result;
  }
  const prefix = `/ops/${project}/agentcore/`;
  if (runtimeParameter() !== `${prefix}runtime_arn`
      || (process.env.SSM_INTERPRETER_ID_PARAM ?? `${prefix}interpreter_id`) !== `${prefix}interpreter_id`
      || (process.env.SSM_MEMORY_ID_PARAM ?? `${prefix}memory_id`) !== `${prefix}memory_id`) return result;
  try {
    result.reason = 'identity_failed';
    const identity = await sts.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(5000) });
    const expected = `arn:aws:sts::${host}:assumed-role/${project}-task/`;
    if (identity.Account !== host || !identity.Arn?.startsWith(expected) || identity.Arn.length <= expected.length) return result;
    result.webIdentity = true;
    const values: Partial<Record<typeof keys[number], string>> = {};
    for (const key of keys) {
      try {
        const response = await ssm.send(new GetParameterCommand({ Name: `${prefix}${key}` }), { abortSignal: AbortSignal.timeout(5000) });
        const value = response.Parameter?.Value;
        const valid = typeof value === 'string' && (key === 'runtime_arn'
          ? validRuntimeArn(value, region, host)
          : (key === 'memory_id' ? /^awsops_v2_memory-[a-zA-Z0-9]{1,64}$/ : /^awsops_v2_code_interpreter-[a-zA-Z0-9]{1,64}$/).test(value));
        result.parameters[key] = !value ? 'missing' : value === 'PENDING' ? 'pending' : valid ? 'ready' : 'invalid';
        if (valid) values[key] = value;
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        result.parameters[key] = name === 'ParameterNotFound' ? 'missing'
          : ['AccessDeniedException', 'AccessDenied'].includes(name) ? 'denied' : 'unavailable';
      }
    }
    result.reason = 'parameters_not_ready';
    if (!keys.every(k => result.parameters[k] === 'ready')) return result;
    result.reason = 'runtime_unavailable';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55_000);
    let destroy: (() => void) | undefined;
    const abort = () => destroy?.();
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await runtime.send(new InvokeAgentRuntimeCommand({
        agentRuntimeArn: values.runtime_arn, qualifier: 'DEFAULT',
        runtimeSessionId: `readiness-${randomUUID()}`,
        contentType: 'application/json', accept: 'text/event-stream',
        payload: new TextEncoder().encode(JSON.stringify({ mode: 'deployment_readiness', ...input })),
      }), { abortSignal: controller.signal });
      const body = response.response;
      result.reason = 'runtime_protocol';
      if (!body || !(Symbol.asyncIterator in body)) throw new Error();
      if ('destroy' in body && typeof body.destroy === 'function') {
        const close = body.destroy.bind(body);
        destroy = () => { close(); };
      }
      try {
        if (!response.contentType?.startsWith('text/event-stream')) throw new Error();
        if (controller.signal.aborted) throw new Error();
        result.reason = 'runtime_unavailable';
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for await (const chunk of body) {
          const value = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          bytes += value.byteLength;
          if (bytes > 16_384) { result.reason = 'runtime_protocol'; throw new Error(); }
          if (controller.signal.aborted) throw new Error();
          chunks.push(value);
        }
        if (controller.signal.aborted) throw new Error();
        result.reason = 'runtime_protocol';
        result.agent = parseReadinessEvent(Buffer.concat(chunks).toString('utf8'), input);
      } finally { destroy?.(); }
      result.status = result.agent.status;
      result.reason = result.agent.reason;
    } catch {
      if (controller.signal.aborted) result.reason = 'timeout';
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
    }
  } catch { /* Only fixed stage codes cross the authenticated boundary. */ }
  return result;
}
