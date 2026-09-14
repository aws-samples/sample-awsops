import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const { sts, ssm, invoke } = vi.hoisted(() => ({ sts: vi.fn(), ssm: vi.fn(), invoke: vi.fn() }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = sts; }, GetCallerIdentityCommand: class {},
}));
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = ssm; }, GetParameterCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: class { send = invoke; },
  InvokeAgentRuntimeCommand: class { constructor(public input: unknown) {} },
}));
const account = '123456789012';
const input = { nonce: 'a'.repeat(32), expectedAccountId: account, expectedCloudfrontId: 'E123EXAMPLE' };
const arn = `arn:aws:bedrock-agentcore:ap-northeast-2:${account}:runtime/awsops_v2_agent-abcdefghij`;
const agentResult = () => ({
  schemaVersion: 1, mode: 'deployment_readiness', nonce: input.nonce, accountId: account,
  status: 'ready', reason: 'ok',
  checks: { identity: true, inventorySummary: true, inventoryQuery: true, knownResource: true, freshInventory: true, model: true },
  inventory: { count: 1, ageMinutes: 0 },
});
function response(value: unknown = agentResult()) {
  return { contentType: 'text/event-stream', response: Readable.from([`data: ${JSON.stringify(value)}\n\n`]) };
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv('AWS_REGION', 'ap-northeast-2'); vi.stubEnv('PROJECT', 'awsops-dev');
  vi.stubEnv('HOST_ACCOUNT_ID', account);
  vi.stubEnv('SSM_RUNTIME_ARN_PARAM', '/ops/awsops-dev/agentcore/runtime_arn');
  vi.stubEnv('SSM_INTERPRETER_ID_PARAM', '/ops/awsops-dev/agentcore/interpreter_id');
  sts.mockResolvedValue({ Account: account, Arn: `arn:aws:sts::${account}:assumed-role/awsops-dev-task/session` });
  ssm.mockImplementation(async ({ input: command }) => ({ Parameter: { Value:
    command.Name.endsWith('runtime_arn') ? arn : command.Name.endsWith('memory_id')
      ? 'awsops_v2_memory-abcdefghij' : 'awsops_v2_code_interpreter-abcdefghij',
  } }));
  invoke.mockImplementation(async () => response());
});

describe('deployment readiness under the web task role', () => {
  it('reads all three own parameters afresh and invokes only the fixed readiness mode', async () => {
    const { deploymentReadiness } = await import('./deployment-readiness');
    for (let i = 0; i < 2; i++) expect((await deploymentReadiness(input)).status).toBe('ready');
    expect(ssm.mock.calls.map(([c]) => c.input.Name)).toEqual(Array(2).fill([
      '/ops/awsops-dev/agentcore/runtime_arn', '/ops/awsops-dev/agentcore/interpreter_id', '/ops/awsops-dev/agentcore/memory_id',
    ]).flat());
    const command = invoke.mock.calls[0][0].input;
    expect(command.agentRuntimeArn).toBe(arn);
    expect(JSON.parse(new TextDecoder().decode(command.payload))).toEqual({ mode: 'deployment_readiness', ...input });
  });
  it('explicit empty means disabled, with no discovery or invocation', async () => {
    vi.stubEnv('SSM_RUNTIME_ARN_PARAM', '');
    const { deploymentReadiness } = await import('./deployment-readiness');
    expect((await deploymentReadiness(input)).reason).toBe('disabled');
    expect(ssm).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
  it.each(['wrong-account', 'wrong-role', 'missing-host'])('rejects %s before SSM', async kind => {
    if (kind === 'wrong-account') sts.mockResolvedValue({ Account: '999999999999' });
    if (kind === 'wrong-role') sts.mockResolvedValue({ Account: account, Arn: `arn:aws:sts::${account}:assumed-role/admin/session` });
    if (kind === 'missing-host') vi.stubEnv('HOST_ACCOUNT_ID', '');
    const { deploymentReadiness } = await import('./deployment-readiness');
    expect((await deploymentReadiness(input)).status).toBe('not_ready');
    expect(ssm).not.toHaveBeenCalled();
  });
  it.each([
    ['PENDING', 'pending'], ['', 'missing'], ['arn:rt', 'invalid'],
    [arn.replace(account, '999999999999'), 'invalid'], [arn.replace('ap-northeast-2', 'us-east-1'), 'invalid'],
    [arn.replace('awsops_v2_agent', 'foreign_agent'), 'invalid'],
  ])('rejects parameter value %s', async (value, state) => {
    ssm.mockResolvedValue({ Parameter: { Value: value } });
    const { deploymentReadiness } = await import('./deployment-readiness');
    const result = await deploymentReadiness(input);
    expect(result.parameters.runtime_arn).toBe(state); expect(invoke).not.toHaveBeenCalled();
  });
  it.each([['ParameterNotFound', 'missing'], ['AccessDeniedException', 'denied'], ['Error', 'unavailable']])(
    'projects %s without exposing exception text', async (name, state) => {
      ssm.mockRejectedValue(Object.assign(new Error('SECRET'), { name }));
      const { deploymentReadiness } = await import('./deployment-readiness');
      const result = await deploymentReadiness(input);
      expect(result.parameters.runtime_arn).toBe(state);
      expect(JSON.stringify(result)).not.toContain('SECRET'); expect(invoke).not.toHaveBeenCalled();
    });
  it.each(['nonce', 'account', 'fallback', 'duplicate', 'oversize', 'false-check', 'extra-field'])(
    'rejects malformed or unbound runtime evidence: %s', async kind => {
      const event = agentResult();
      if (kind === 'nonce') event.nonce = 'b'.repeat(32);
      if (kind === 'account') event.accountId = '999999999999';
      if (kind === 'false-check') event.checks.model = false;
      if (kind === 'extra-field') Object.assign(event, { secret: 'SECRET' });
      invoke.mockResolvedValue(kind === 'fallback' ? response({ delta: 'role ready SECRET' })
        : kind === 'duplicate' ? { contentType: 'text/event-stream', response: Readable.from([
          `data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(event)}\n\n`,
        ]) } : kind === 'oversize' ? response('x'.repeat(17000)) : response(event));
      const { deploymentReadiness } = await import('./deployment-readiness');
      const result = await deploymentReadiness(input);
      expect(result.reason).toBe('runtime_protocol'); expect(JSON.stringify(result)).not.toContain('SECRET');
    });
  it('bounds an idle runtime stream and closes it on timeout', async () => {
    vi.useFakeTimers();
    const body = new Readable({ read() {} });
    invoke.mockResolvedValue({ contentType: 'text/event-stream', response: body });
    try {
      const { deploymentReadiness } = await import('./deployment-readiness');
      const pending = deploymentReadiness(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(50_001);
      expect((await pending).status).toBe('not_ready');
      expect(body.destroyed).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('uses one 50-second deadline including STS/SSM preflight and the runtime stream', async () => {
    vi.useFakeTimers();
    const body = new Readable({ read() {} });
    sts.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({
      Account: account, Arn: `arn:aws:sts::${account}:assumed-role/awsops-dev-task/session`,
    }), 4000)));
    ssm.mockImplementation(({ input: command }) => new Promise(resolve => setTimeout(() => resolve({
      Parameter: { Value: command.Name.endsWith('runtime_arn') ? arn : command.Name.endsWith('memory_id')
        ? 'awsops_v2_memory-abcdefghij' : 'awsops_v2_code_interpreter-abcdefghij' },
    }), 4000)));
    invoke.mockResolvedValue({ contentType: 'text/event-stream', response: body });
    try {
      const { deploymentReadiness } = await import('./deployment-readiness');
      const pending = deploymentReadiness(input);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(invoke).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(34_001);
      const result = await pending;
      expect(result.reason).toBe('timeout');
      expect(result.webIdentity).toBe(true);
      expect(Object.values(result.parameters)).toEqual(['ready', 'ready', 'ready']);
      expect(body.destroyed).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('returns partial parameter evidence at the deadline even if an SDK promise ignores abort', async () => {
    vi.useFakeTimers();
    let finish: (value: unknown) => void = () => {};
    ssm.mockResolvedValueOnce({ Parameter: { Value: arn } })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
      const { deploymentReadiness } = await import('./deployment-readiness');
      const pending = deploymentReadiness(input);
      await vi.advanceTimersByTimeAsync(50_001);
      const result = await pending;
      expect(result.reason).toBe('timeout');
      expect(result.parameters).toEqual({ runtime_arn: 'ready', interpreter_id: 'unavailable', memory_id: 'uninspected' });
      const saved = JSON.stringify(result);
      finish({ Parameter: { Value: 'awsops_v2_code_interpreter-abcdefghij' } });
      await vi.advanceTimersByTimeAsync(1);
      expect(JSON.stringify(result)).toBe(saved);
      expect(ssm).toHaveBeenCalledTimes(2);
      expect(invoke).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each(['disabled', 'inventory_incomplete'])('retains the structured runtime %s reason', async reason => {
    invoke.mockResolvedValue(response({ ...agentResult(), status: 'not_ready', reason,
      inventory: { count: null, ageMinutes: null } }));
    const { deploymentReadiness } = await import('./deployment-readiness');
    expect((await deploymentReadiness(input)).reason).toBe(reason);
  });
  it.each([
    (json: string) => `: keepalive\nevent: readiness\nid: 42\ndata:${json}\n\ndata: [DONE]\n\n`,
    (json: string) => `id:42\r\nevent:result\r\ndata: ${json}\r\n\r\ndata:[DONE]\r\n\r\n`,
  ])('accepts standard SSE metadata and DONE framing around exactly one payload', async frame => {
    invoke.mockResolvedValue({ contentType: 'text/event-stream', response: Readable.from([frame(JSON.stringify(agentResult()))]) });
    const { deploymentReadiness } = await import('./deployment-readiness');
    expect((await deploymentReadiness(input)).status).toBe('ready');
  });
  it.each([16, 120, 1440])('treats %i minutes as a bounded protocol value, not a freshness threshold', async ageMinutes => {
    const event = agentResult(); event.inventory.ageMinutes = ageMinutes;
    invoke.mockResolvedValue(response(event));
    const { deploymentReadiness } = await import('./deployment-readiness');
    expect((await deploymentReadiness(input)).status).toBe('ready');
  });
  it('rejects ages outside the supported protocol bound', async () => {
    const event = agentResult(); event.inventory.ageMinutes = 1441;
    invoke.mockResolvedValue(response(event));
    const { deploymentReadiness } = await import('./deployment-readiness');
    expect((await deploymentReadiness(input)).reason).toBe('runtime_protocol');
  });
});
