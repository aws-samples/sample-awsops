/** Empty is an explicit feature-off sentinel; only absence retains the legacy default. */
export function runtimeParameter(): string {
  return process.env.SSM_RUNTIME_ARN_PARAM ?? '/ops/awsops-v2/agentcore/runtime_arn';
}

export function validRuntimeArn(value: string, region: string, account?: string): boolean {
  const match = /^arn:aws:bedrock-agentcore:([a-z0-9-]+):([0-9]{12}):runtime\/awsops_v2_agent-[a-zA-Z0-9]{1,64}$/.exec(value);
  return Boolean(match && match[1] === region && (!account || match[2] === account));
}
