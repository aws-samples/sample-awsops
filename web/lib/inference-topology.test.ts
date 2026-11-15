import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/datasources', () => ({}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({}));
import { mapOtelRow } from './trace-source';
import { buildTraceGraph } from './trace-graph';

const runtimeArn = 'arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:runtime/insurance_analysis-AbCd012345';
function span(attributes: Record<string, string | undefined> = {}, resource: Record<string, string> = {}, kind = 'Client') {
  return mapOtelRow({
    TraceId: 'trace-a', SpanId: 'span-a', ServiceName: 'orchestrator', SpanKind: kind,
    Timestamp: '2026-11-15T00:00:00Z', Duration: 5_000_000,
    ResourceAttributes: { 'cloud.account.id': '123456789012', 'cloud.region': 'ap-northeast-2',
      'service.namespace': 'agents', 'deployment.environment': 'demo', ...resource },
    SpanAttributes: attributes,
  });
}

describe('inference dependency observations', () => {
  it('normalizes provider case and does not let an invalid runtime annotation suppress a model', () => {
    const graph = buildTraceGraph([span({
      'gen_ai.system': 'AWS.Bedrock', 'gen_ai.request.model': 'vendor.model',
      'agentcore.runtime.arn': 'invalid-annotation',
    })], [], []);
    expect(graph.nodes.find(node => node.kind === 'model')?.meta.provider).toBe('aws.bedrock');
    expect(graph.nodes.filter(node => node.kind === 'runtime')).toEqual([]);
  });

  it('keeps an exact runtime destination from an isolated client span without claiming inventory ownership', () => {
    const graph = buildTraceGraph([span({
      'agentcore.runtime.arn': runtimeArn, 'agentcore.runtime.name': 'untrusted-display-name',
    })], [], []);
    const runtime = graph.nodes.find(node => node.kind === 'runtime');
    expect(runtime).toMatchObject({
      label: 'insurance_analysis-AbCd012345',
      meta: { arn: runtimeArn, claimedAccountId: '123456789012', claimedRegion: 'ap-northeast-2',
        identityProvenance: 'telemetry_claim' },
    });
    expect(runtime!.meta).not.toHaveProperty('infra_ref');
    expect(runtime!.meta).not.toHaveProperty('accountId');
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: graph.nodes.find(node => node.kind === 'service')!.id, target: runtime!.id, rel: 'calls',
    }));
  });

  it('links the same runtime claim to its reporting service and that service to its model', () => {
    const request = span({ 'agentcore.runtime.arn': runtimeArn });
    const modelCall = { ...span({
      'gen_ai.system': 'aws.bedrock', 'gen_ai.request.model': 'global.anthropic.example-v1',
      'server.address': 'bedrock-runtime.ap-northeast-2.amazonaws.com',
      'gen_ai.prompt': 'private prompt', 'gen_ai.completion': 'private response',
    }, { 'cloud.resource_id': runtimeArn }), service: 'insurance_analysis', spanId: 'model-call' };
    const graph = buildTraceGraph([request, modelCall], [], []);
    const runtime = graph.nodes.find(node => node.kind === 'runtime')!;
    const model = graph.nodes.find(node => node.kind === 'model')!;
    const service = graph.nodes.find(node => node.label === 'insurance_analysis')!;
    expect(graph.nodes.filter(node => node.kind === 'runtime')).toHaveLength(1);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: runtime.id, target: service.id, rel: 'hosts' }),
      expect.objectContaining({ source: service.id, target: model.id, rel: 'calls' }),
    ]));
    expect(model.meta).toMatchObject({ model: 'global.anthropic.example-v1', provider: 'aws.bedrock',
      endpoint: 'bedrock-runtime.ap-northeast-2.amazonaws.com', identityProvenance: 'telemetry_claim' });
    expect(JSON.stringify(graph)).not.toContain('private prompt');
    expect(JSON.stringify(graph)).not.toContain('private response');
  });

  it('retains distinct GPU model endpoints and weighted aggregate call counts', () => {
    const first = { ...span({ 'gen_ai.provider.name': 'vllm', 'gen_ai.request.model': 'vendor/model',
      'server.address': 'gpu-a.sllm.svc.cluster.local' }), weight: 7 };
    const second = { ...span({ 'gen_ai.provider.name': 'vllm', 'gen_ai.request.model': 'vendor/model',
      'server.address': 'gpu-b.sllm.svc.cluster.local' }), spanId: 'second', weight: 2 };
    const graph = buildTraceGraph([first, second], [], []);
    expect(graph.nodes.filter(node => node.kind === 'model')).toHaveLength(2);
    expect(graph.edges.filter(edge => edge.rel === 'calls').map(edge => edge.meta.spanCount).sort())
      .toEqual([2, 7]);
  });

  it('recognizes Bedrock SDK model attributes without requiring a remote server span', () => {
    const graph = buildTraceGraph([span({
      'rpc.service': 'Bedrock Runtime', 'rpc.method': 'InvokeModel',
      'aws.bedrock.model_id': 'vendor.model-v1', 'server.address': 'bedrock-runtime.us-east-1.amazonaws.com',
    })], [], []);
    expect(graph.nodes.find(node => node.kind === 'model')?.meta).toMatchObject({
      model: 'vendor.model-v1', provider: 'aws.bedrock',
    });
  });

  it('keeps model servers on different ports distinct', () => {
    const graph = buildTraceGraph([8000, 8080].map(port => ({
      ...span({ 'gen_ai.system': 'vllm', 'gen_ai.request.model': 'vendor/model',
        'server.address': 'gpu.internal', 'server.port': String(port) }), spanId: `span-${port}`,
    })), [], []);
    expect(graph.nodes.filter(node => node.kind === 'model')).toHaveLength(2);
  });

  it('does not join identical cluster-local model names across clusters', () => {
    const graph = buildTraceGraph(['cluster-a', 'cluster-b'].map(cluster => ({
      ...span({ 'gen_ai.system': 'vllm', 'gen_ai.request.model': 'vendor/model',
        'server.address': 'gpu.sllm.svc.cluster.local' }, { 'k8s.cluster.name': cluster }),
      spanId: cluster,
    })), [], []);
    expect(graph.nodes.filter(node => node.kind === 'model')).toHaveLength(2);
  });

  it('does not infer a direct model call from model annotations on a runtime invocation', () => {
    const graph = buildTraceGraph([span({ 'agentcore.runtime.arn': runtimeArn,
      'gen_ai.system': 'aws.bedrock', 'gen_ai.request.model': 'example.model' })], [], []);
    expect(graph.nodes.filter(node => node.kind === 'runtime')).toHaveLength(1);
    expect(graph.nodes.filter(node => node.kind === 'model')).toHaveLength(0);
  });

  it.each([
    { 'agentcore.runtime.arn': 'arn:aws:s3:::not-a-runtime' },
    { 'agentcore.runtime.arn': `${runtimeArn}?token=private` },
    { 'agentcore.runtime.name': 'same-name-without-arn' },
    { 'gen_ai.request.model': 'model-without-provider' },
    { 'gen_ai.provider.name': 'vllm', 'gen_ai.request.model': 'https://private@example.test/model' },
  ])('rejects incomplete or malformed destination claims: %j', attributes => {
    const graph = buildTraceGraph([span(attributes)], [], []);
    expect(graph.nodes.filter(node => ['runtime', 'model'].includes(node.kind))).toEqual([]);
  });

  it('does not turn server or internal annotations into outgoing model calls', () => {
    const graph = buildTraceGraph(['Server', 'Internal'].map((kind, index) => ({
      ...span({ 'gen_ai.system': 'aws.bedrock', 'gen_ai.request.model': 'example.model',
        'agentcore.runtime.arn': runtimeArn }, {}, kind), spanId: `span-${index}`,
    })), [], []);
    expect(graph.edges.filter(edge => edge.rel === 'calls')).toEqual([]);
  });

  it('does not bind a runtime resource whose account conflicts with the reporting resource', () => {
    const graph = buildTraceGraph([span({}, {
      'cloud.resource_id': runtimeArn, 'cloud.account.id': '999999999999',
    })], [], []);
    expect(graph.edges.filter(edge => edge.rel === 'hosts')).toEqual([]);
  });

  it('isolates claims across telemetry sources and environments', () => {
    const graph = buildTraceGraph([
      { ...span({ 'agentcore.runtime.arn': runtimeArn }), sourceId: 'clickhouse:1' },
      { ...span({ 'agentcore.runtime.arn': runtimeArn }), sourceId: 'clickhouse:2', spanId: 'b' },
      { ...span({ 'agentcore.runtime.arn': runtimeArn }, { 'deployment.environment': 'prod' }),
        sourceId: 'clickhouse:1', spanId: 'c' },
    ], [], []);
    expect(graph.nodes.filter(node => node.kind === 'runtime')).toHaveLength(3);
  });
});
