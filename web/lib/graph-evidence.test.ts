import { describe, expect, it } from 'vitest';
import { rebuildTraceGraph } from './graph-store';

function database() {
  const writes: { sql: string; args: unknown[] }[] = [];
  const client = {
    query: async (sql: string, args: unknown[] = []) => {
      writes.push({ sql, args });
      return { rows: sql.includes('to_regclass') ? [{ ready: true }] : sql.includes('pg_try_advisory') ? [{ acquired: true }] : [] };
    },
    release() {},
  };
  return {
    pool: { connect: async () => client, query: client.query } as never,
    writes,
    nodes: () => writes.filter((w) => w.sql.includes('INSERT INTO topology_nodes'))
      .flatMap((w) => JSON.parse(String(w.args[3]))),
    edges: () => writes.filter((w) => w.sql.includes('INSERT INTO topology_edges'))
      .flatMap((w) => JSON.parse(String(w.args[3]))),
  };
}

const span = (extra: Record<string, unknown>) => ({
  traceId: 'trace-a', spanId: 'span-a', service: 'checkout', sourceId: 'tempo:1',
  kind: 'SERVER', startMs: 1000, durationMs: 25, ...extra,
});

function source(items: ReturnType<typeof span>[], status = 'ok') {
  return {
    available: async () => status !== 'unavailable',
    recentSpans: async () => ({
      items, status, sourceId: 'tempo:1', reasons: [],
      windowStartMs: 0, windowEndMs: 3600000,
    }),
  } as never;
}

describe('trace graph evidence', () => {
  it('does not query backends before the collection-state migration exists', async () => {
    let reads = 0;
    const pool = { query: async () => ({ rows: [{ ready: false }] }) };
    const backend = {
      available: async () => true,
      recentSpans: async () => { reads++; throw new Error('must not query'); },
    };
    await expect(rebuildTraceGraph(pool as never, [backend])).resolves.toMatchObject({ nodes: 0, edges: 0, published: 0, skipped: 1, reasons: ['state_schema_missing'] });
    expect(reads).toBe(0);
  });
  it('keeps identical service names in prod and staging separate', async () => {
    const db = database();
    await rebuildTraceGraph(db.pool, [source([
      span({ environment: 'prod', k8sCluster: 'cluster-a' }),
      span({ environment: 'staging', k8sCluster: 'cluster-b', spanId: 'span-b' }),
    ])]);
    const services = db.nodes().filter((n) => n.kind === 'service');
    expect(services).toHaveLength(2);
    expect(new Set(services.map((n) => n.id)).size).toBe(2);
    expect(services.map((n) => n.meta.environment).sort()).toEqual(['prod', 'staging']);
  });

  it('does not connect a child to an equal span ID from another trace', async () => {
    const db = database();
    await rebuildTraceGraph(db.pool, [source([
      span({ traceId: 'trace-a', spanId: 'parent', service: 'api' }),
      span({ traceId: 'trace-b', spanId: 'parent', service: 'unrelated' }),
      span({ traceId: 'trace-a', spanId: 'child', parentSpanId: 'parent', service: 'worker' }),
    ])]);
    const labels = new Map(db.nodes().map((n) => [n.id, n.meta.service]));
    const calls = db.edges().filter((e) => e.rel === 'calls')
      .map((e) => [labels.get(e.source), labels.get(e.target)]);
    expect(calls).toEqual([['api', 'worker']]);
  });

  it('preserves async span links across different trace IDs', async () => {
    const db = database();
    await rebuildTraceGraph(db.pool, [source([
      span({ traceId: 'producer-trace', spanId: 'send', service: 'api', kind: 'PRODUCER' }),
      span({ traceId: 'consumer-trace', spanId: 'process', service: 'worker', kind: 'CONSUMER',
        links: [{ traceId: 'producer-trace', spanId: 'send' }] }),
    ])]);
    expect(db.edges().map((e) => e.rel)).toContain('linked');
  });

  it('retains the previous graph when a datasource query fails', async () => {
    const db = database();
    await rebuildTraceGraph(db.pool, [source([], 'error')]);
    expect(db.writes.some((w) => w.sql.startsWith('DELETE FROM topology_'))).toBe(false);
    const state = db.writes.find((w) => w.sql.includes('INSERT INTO topology_graph_state'));
    expect(state).toBeDefined();
    expect(state!.args).toContain('error');
  });

  it('records unavailable collection without sweeping the last successful graph', async () => {
    const db = database();
    await rebuildTraceGraph(db.pool, [source([], 'unavailable')]);
    expect(db.writes.some((w) => w.sql.startsWith('DELETE FROM topology_'))).toBe(false);
    expect(db.writes.some((w) => w.sql.includes('topology_graph_state'))).toBe(true);
  });

  it('distinguishes a successful empty read from a failed read', async () => {
    const db = database();
    await rebuildTraceGraph(db.pool, [source([])]);
    expect(db.writes.some((w) => w.sql.startsWith('DELETE FROM topology_nodes'))).toBe(true);
    const state = db.writes.find((w) => w.sql.includes('INSERT INTO topology_graph_state'));
    expect(state).toBeDefined();
    expect(state!.args).toContain('empty');
  });

  it('bounds database graph keys even when a telemetry label is long', async () => {
    const db = database();
    await rebuildTraceGraph(db.pool, [source([span({ service: 'x'.repeat(5000) })])]);
    expect(String(db.nodes()[0].id).length).toBeLessThan(200);
  });

  it('connects producers and consumers through a globally qualified queue', async () => {
    const db = database();
    await rebuildTraceGraph(db.pool, [source([
      span({ spanId: 'send', service: 'api', kind: 'PRODUCER', k8sNamespace: 'frontend',
        messagingSystem: 'aws_sqs', messagingDestination: 'arn:aws:sqs:ap-northeast-2:111122223333:orders' }),
      span({ spanId: 'consume', service: 'worker', kind: 'CONSUMER', k8sNamespace: 'backend',
        messagingSystem: 'aws_sqs', messagingDestination: 'arn:aws:sqs:ap-northeast-2:111122223333:orders' }),
    ])]);
    expect(db.nodes().filter((n) => n.kind === 'queue')).toHaveLength(1);
    expect(db.edges().map((e) => e.rel).sort()).toEqual(['consumes', 'publishes']);
  });
  it('does not join equal topic names on independent brokers', async () => {
    const db = database();
    await rebuildTraceGraph(db.pool, [source([
      span({ spanId: 'send', service: 'orders', kind: 'PRODUCER', messagingSystem: 'kafka',
        messagingDestination: 'orders', messagingBroker: 'kafka-a.internal:9092' }),
      span({ spanId: 'consume', service: 'billing', kind: 'CONSUMER', messagingSystem: 'kafka',
        messagingDestination: 'orders', messagingBroker: 'kafka-b.internal:9092' }),
    ])]);
    expect(db.nodes().filter((n) => n.kind === 'queue')).toHaveLength(2);
  });
  it('marks unqualified messaging destinations incomplete instead of inventing a shared queue', async () => {
    const db = database();
    await rebuildTraceGraph(db.pool, [source([
      span({ messagingSystem: 'kafka', messagingDestination: 'orders', kind: 'PRODUCER' }),
    ])]);
    expect(db.nodes().filter((n) => n.kind === 'queue')).toHaveLength(0);
    const state = db.writes.find((w) => w.sql.includes('INSERT INTO topology_graph_state'));
    expect(state!.args).toContain('partial');
    expect(JSON.parse(String(state!.args[4])).unresolvedMessaging).toBe(1);
  });
});
