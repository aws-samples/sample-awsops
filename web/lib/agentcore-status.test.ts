import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ssm: vi.fn(), control: vi.fn(), ssmCreated: vi.fn() }));
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = mocks.ssm; constructor() { mocks.ssmCreated(); } },
  GetParameterCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => {
  class Command { constructor(public input: unknown) {} }
  return {
    BedrockAgentCoreControlClient: class { send = mocks.control; },
    GetAgentRuntimeCommand: Command, ListAgentRuntimeEndpointsCommand: Command,
    ListGatewaysCommand: Command, ListGatewayTargetsCommand: Command,
    ListMemoriesCommand: Command, ListCodeInterpretersCommand: Command,
  };
});

const original = process.env.SSM_RUNTIME_ARN_PARAM;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  delete process.env.SSM_RUNTIME_ARN_PARAM;
  mocks.control.mockResolvedValue({});
  mocks.ssm.mockResolvedValue({ Parameter: { Value:
    'arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:runtime/awsops_v2_agent-fixture' } });
});
afterEach(() => {
  if (original === undefined) delete process.env.SSM_RUNTIME_ARN_PARAM;
  else process.env.SSM_RUNTIME_ARN_PARAM = original;
});

describe('AgentCore status runtime parameter', () => {
  it('treats an explicit empty parameter as disabled without creating or calling SSM', async () => {
    process.env.SSM_RUNTIME_ARN_PARAM = '';
    const { getAgentCoreStatus } = await import('./agentcore-status');
    expect((await getAgentCoreStatus(true)).runtime).toBeNull();
    expect(mocks.ssmCreated).not.toHaveBeenCalled();
    expect(mocks.ssm).not.toHaveBeenCalled();
  });

  it.each([undefined, '/ops/fixture/agentcore/runtime_arn'])('preserves the configured or legacy path: %s', async parameter => {
    if (parameter !== undefined) process.env.SSM_RUNTIME_ARN_PARAM = parameter;
    const { getAgentCoreStatus } = await import('./agentcore-status');
    expect((await getAgentCoreStatus(true)).runtime?.id).toBe('awsops_v2_agent-fixture');
    expect(mocks.ssm.mock.calls[0][0].input.Name).toBe(parameter ?? '/ops/awsops-v2/agentcore/runtime_arn');
  });
});
