import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/datasources', () => ({}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({}));
import { mapOtelRow, mapTempoTrace, type TraceSpan } from './trace-source';
import { buildTraceGraph } from './trace-graph';

describe('messaging span identity', () => {
  it.each(['Producer', 'SPAN_KIND_PRODUCER', 4])('normalizes exporter span kind %s', (kind) => {
    const span = mapOtelRow({
      TraceId: 'trace', SpanId: 'span', ServiceName: 'orders', SpanKind: kind,
      Timestamp: '2026-09-11T00:00:00Z', Duration: 1000000,
      SpanAttributes: { 'messaging.system': 'kafka', 'messaging.destination.name': 'orders',
        'server.address': 'Kafka-A.internal', 'server.port': 9092 },
    });
    expect(span.kind).toBe('PRODUCER');
    expect(span.messagingBroker).toBe('kafka-a.internal:9092');
  });
  it('does not invent an endpoint port when broker identity is incomplete', () => {
    expect(mapOtelRow({ SpanAttributes: {
      'messaging.system': 'kafka', 'server.address': 'kafka-a.internal',
    } }).messagingBroker).toBeUndefined();
  });
});

describe('Tempo wire identity', () => {
  const producer = '00112233445566778899aabbccddeeff';
  const consumer = 'ffeeddccbbaa99887766554433221100';
  const parent = '1122334455667788';
  const child = '8877665544332211';
  const base64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
  const trace = (service: string, spans: Record<string, unknown>[]) => ({
    batches: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scopeSpans: [{ spans: spans.map(s => ({
        startTimeUnixNano: '1000000000', endTimeUnixNano: '1100000000', ...s,
      })) }],
    }],
  });

  it('joins base64 OTLP links to hexadecimal searched traces and mixed parent IDs', () => {
    const spans = [
      ...mapTempoTrace(producer.toUpperCase(), trace('publisher', [
        { traceId: base64(producer), spanId: base64(parent), kind: 4 },
      ])),
      ...mapTempoTrace(consumer, trace('consumer', [
        { spanId: parent.toUpperCase(), kind: 5,
          links: [{ traceId: base64(producer), spanId: parent.toUpperCase() }] },
      ])),
      ...mapTempoTrace(consumer, trace('database-client', [
        { spanId: base64(child), parentSpanId: base64(parent), kind: 3 },
      ])),
    ].map(s => ({ ...s, sourceId: 'tempo:7' }));
    const graph = buildTraceGraph(spans, [], []);
    expect(graph.edges.map(e => e.rel).sort()).toEqual(['calls', 'linked']);
    expect(graph.orphanSpans).toBe(0);
    expect(spans[0]).toMatchObject({ traceId: producer, spanId: parent });
    expect(spans[2]).toMatchObject({ spanId: child, parentSpanId: parent });
  });

  it('does not decode malformed or noncanonical base64 into a valid linked identity', () => {
    // Node's permissive decoder ignores garbage and unused pad bits. Neither spelling is canonical.
    for (const bad of [`!${base64(producer)}`, `${base64(producer).slice(0, -3)}x==`]) {
      const spans = [
        ...mapTempoTrace(producer, trace('publisher', [{ spanId: parent }])),
        ...mapTempoTrace(consumer, trace('consumer', [
          { spanId: child, links: [{ traceId: bad, spanId: parent }] },
        ])),
      ].map(s => ({ ...s, sourceId: 'tempo:7' }));
      const graph = buildTraceGraph(spans, [], []);
      expect(graph.edges).toEqual([]);
      expect(graph.orphanSpans).toBe(1);
    }
  });

  it('keeps a link from another datasource unresolved after ID normalization', () => {
    const spans = [
      ...mapTempoTrace(producer, trace('publisher', [{ spanId: base64(parent) }]))
        .map(s => ({ ...s, sourceId: 'tempo:7' })),
      ...mapTempoTrace(consumer, trace('consumer', [
        { spanId: child, links: [{ traceId: base64(producer), spanId: base64(parent) }] },
      ])).map(s => ({ ...s, sourceId: 'tempo:8' })),
    ];
    const graph = buildTraceGraph(spans, [], []);
    expect(graph.edges).toEqual([]);
    expect(graph.orphanSpans).toBe(1);
  });
});

describe('qualified messaging destinations', () => {
  const queue = 'arn:aws:sqs:us-east-1:111122223333:orders';
  const span = (over: Partial<TraceSpan>): TraceSpan => ({
    sourceId: 'tempo:7', traceId: 'trace', spanId: 'send', service: 'publisher', kind: 'PRODUCER',
    startMs: 1000, durationMs: 10, accountId: '111122223333', region: 'us-west-2', environment: 'prod',
    messagingSystem: 'aws_sqs', messagingDestination: queue, ...over,
  });

  it('joins one ARN across caller accounts and regions within the same environment', () => {
    const graph = buildTraceGraph([
      span({}),
      span({ spanId: 'receive', service: 'consumer', kind: 'CONSUMER',
        accountId: '444455556666', region: 'us-east-1' }),
    ], [], []);
    const queues = graph.nodes.filter(n => n.kind === 'queue');
    expect(queues).toHaveLength(1);
    expect(graph.edges.find(e => e.rel === 'publishes')?.target).toBe(queues[0].id);
    expect(graph.edges.find(e => e.rel === 'consumes')?.source).toBe(queues[0].id);
    expect(queues[0].meta).toMatchObject({ claimedAccountId: '111122223333', claimedRegion: 'us-east-1', identityProvenance: 'telemetry_claim' });
    expect(queues[0].meta).not.toHaveProperty('accountId');
    expect(queues[0].meta).not.toHaveProperty('region');
    expect(queues[0].meta.environment).toBe('prod');
  });

  it.each([
    { messagingDestination: 'arn:aws:sqs:us-east-1:444455556666:orders' },
    { messagingDestination: 'arn:aws:sqs:us-west-2:111122223333:orders' },
    { messagingDestination: 'arn:aws:sqs:us-east-1:111122223333:Orders' },
    { sourceId: 'tempo:8' },
    { environment: 'staging' },
  ])('keeps distinct destination ARNs and datasource identities separate: %j', difference => {
    const graph = buildTraceGraph([span({}), span({ spanId: 'receive', kind: 'CONSUMER', ...difference })], [], []);
    expect(graph.nodes.filter(n => n.kind === 'queue')).toHaveLength(2);
  });

  it('retains local namespace/broker isolation and unknown-destination coverage', () => {
    const local = { messagingDestination: 'orders', messagingSystem: 'kafka', messagingBroker: 'kafka:9092' };
    const graph = buildTraceGraph([
      span({ ...local, k8sNamespace: 'shop' }),
      span({ ...local, spanId: 'receive', kind: 'CONSUMER', k8sNamespace: 'billing' }),
      span({ ...local, spanId: 'unknown', messagingBroker: undefined }),
    ], [], []);
    expect(graph.nodes.filter(n => n.kind === 'queue')).toHaveLength(2);
    expect(graph.unresolvedMessaging).toBe(1);
  });
});

it('never promotes a queue ARN claiming the host account into verified AWS inventory', () => {
  const graph = buildTraceGraph([{
    sourceId: 'tempo:1', traceId: 'trace', spanId: 'span', service: 'untrusted', kind: 'PRODUCER',
    startMs: 1, durationMs: 1, messagingSystem: 'aws_sqs',
    messagingDestination: 'arn:aws:sqs::111122223333:orders',
  }], [], [{ id: 'queue:inventory', kind: 'queue', meta: { accountId: '111122223333' } }], '111122223333');
  const queue = graph.nodes.find(n => n.kind === 'queue')!;
  expect(queue.meta).toMatchObject({ claimedAccountId: '111122223333', claimedRegion: null, identityProvenance: 'telemetry_claim' });
  expect(queue.meta).not.toHaveProperty('accountId');
  expect(queue.meta).not.toHaveProperty('region');
  expect(queue.meta).not.toHaveProperty('infra_ref');
  expect(queue.id).not.toBe('queue:inventory');
});

it('normalizes local destination whitespace without removing broker scope', () => {
  const span: TraceSpan = { sourceId: 'tempo:1', traceId: 't', spanId: 'p', service: 'publisher',
    kind: 'PRODUCER', startMs: 1, durationMs: 1, messagingSystem: 'kafka',
    messagingBroker: 'broker.example', messagingDestination: 'orders ' };
  const graph = buildTraceGraph([span, { ...span, spanId: 'c', service: 'consumer', kind: 'CONSUMER', messagingDestination: 'orders' }], [], []);
  expect(graph.nodes.filter(n => n.kind === 'queue')).toHaveLength(1);
  expect(graph.edges.map(e => e.rel)).toEqual(['publishes', 'consumes']);
});
