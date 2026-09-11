import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/datasources', () => ({}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({}));
import { mapOtelRow } from './trace-source';

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
