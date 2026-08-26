import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { rebuildGraph, rebuildInfraGraph } from './graph-store';

// ADR-043 Step 1 — Task 1: the topology_graph migration exists and declares the expected shape.
const MIG_DIR = join(process.cwd(), '..', 'terraform', 'v2', 'foundation', 'migrations');

describe('topology_graph migration', () => {
  const file = readdirSync(MIG_DIR).find((f) => f.endsWith('_topology_graph.sql'));
  it('exists', () => { expect(file, 'topology_graph migration present').toBeTruthy(); });

  it('declares topology_nodes + topology_edges with the upsert keys + indexes', () => {
    const sql = readFileSync(join(MIG_DIR, file!), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS topology_nodes/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS topology_edges/);
    expect(sql).toMatch(/PRIMARY KEY \(account_id, id\)/);              // node upsert key
    expect(sql).toMatch(/UNIQUE \(account_id, source, target, rel\)/);  // edge upsert key
    expect(sql).toMatch(/confidence/);                                  // observed|inferred carried
    expect(sql).toMatch(/run_id/);                                      // mark-sweep stamp
    expect(sql).toMatch(/topology_edges_source_idx/);
    expect(sql).toMatch(/topology_edges_target_idx/);
  });
});

// ADR-043 Step 2 — Task 1: the class-namespace migration (flow|infra) on the graph tables.
describe('topology_class migration', () => {
  const file = readdirSync(MIG_DIR).find((f) => f.endsWith('_topology_class.sql'));
  it('exists', () => { expect(file, 'topology_class migration present').toBeTruthy(); });

  it('adds class to both tables and puts class in the node PK + edge UNIQUE', () => {
    const sql = readFileSync(join(MIG_DIR, file!), 'utf8');
    expect(sql).toMatch(/ALTER TABLE topology_nodes ADD COLUMN IF NOT EXISTS class/);
    expect(sql).toMatch(/ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS class/);
    expect(sql).toMatch(/PRIMARY KEY \(account_id, id, class\)/);                   // node sweep is class-correct
    expect(sql).toMatch(/UNIQUE \(account_id, source, target, rel, class\)/);       // edge sweep is class-correct
    expect(sql).toMatch(/topology_edges_class_source_idx/);                         // traversal index
  });
});

function mockPool(invRows: unknown[]) {
  const calls: string[] = [];
  const params: unknown[][] = [];
  const client = {
    query: vi.fn((sql: string, p?: unknown[]) => { calls.push(String(sql)); if (p) params.push(p); return Promise.resolve({ rows: [] }); }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(() => Promise.resolve({ rows: invRows })), // inventory SELECT
    connect: vi.fn(() => Promise.resolve(client)),
  };
  return { pool, client, calls, params };
}

describe('rebuildGraph', () => {
  const inv = [
    { resource_type: 'alb', resource_id: 'web', region: 'r', data: { arn: 'arn:alb', dns_name: 'x.elb.amazonaws.com' } },
    { resource_type: 'target_group', resource_id: 'arn:tg', region: 'r', data: { target_group_name: 'tg', target_type: 'ip', load_balancer_arns: ['arn:alb'], target_health_descriptions: [{ Target: { Id: '10.0.0.1' }, TargetHealth: { State: 'healthy' } }] } },
  ];

  it('runs one tx: advisory lock → upserts → mark-sweep → commit', async () => {
    const { pool, calls } = mockPool(inv);
    const res = await rebuildGraph(pool as never, 'RUN1');
    expect(calls[0]).toContain('BEGIN');
    expect(calls.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(calls.some((s) => s.includes('INSERT INTO topology_nodes') && s.includes('ON CONFLICT (account_id, id, class)'))).toBe(true);
    expect(calls.some((s) => s.includes('INSERT INTO topology_edges') && s.includes('ON CONFLICT (account_id, source, target, rel, class)'))).toBe(true);
    // class-scoped mark-sweep (class = $1 AND run_id <> $2) — never wipes the other class's rows
    expect(calls.some((s) => s.includes('DELETE FROM topology_edges') && s.includes('class = $1') && s.includes('run_id <> $2'))).toBe(true);
    expect(calls.some((s) => s.includes('DELETE FROM topology_nodes') && s.includes('class = $1') && s.includes('run_id <> $2'))).toBe(true);
    expect(calls.at(-1)).toContain('COMMIT');
    expect(res.nodes).toBeGreaterThan(0);
    expect(res.edges).toBeGreaterThan(0);
  });

  it("writes class='flow'", async () => {
    const { pool, params } = mockPool(inv);
    await rebuildGraph(pool as never, 'RUN1');
    expect(params.some((p) => p.includes('flow'))).toBe(true);
    expect(params.some((p) => p.includes('infra'))).toBe(false);
  });

  it('preserves the last-good graph on an empty/failed inventory read (NO sweep)', async () => {
    // empty inventory → empty build. Sweeping now would wipe the last-good materialized graph,
    // so rebuildGraph must skip the destructive delete entirely. (consensus gate MAJOR finding)
    const { pool, calls } = mockPool([]);
    const res = await rebuildGraph(pool as never, 'RUN_EMPTY');
    expect(res.nodes).toBe(0);
    expect(res.edges).toBe(0);
    expect(calls.some((s) => s.includes('DELETE FROM topology_edges'))).toBe(false);
    expect(calls.some((s) => s.includes('DELETE FROM topology_nodes'))).toBe(false);
  });

  it('rolls back on a write error and releases the client', async () => {
    const { pool, client } = mockPool(inv);
    client.query.mockImplementation((sql: string) => {
      if (String(sql).includes('INSERT INTO topology_nodes')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [] });
    });
    await expect(rebuildGraph(pool as never, 'RUN2')).rejects.toThrow('boom');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('ROLLBACK'));
    expect(client.release).toHaveBeenCalled();
  });
});

describe('rebuildInfraGraph', () => {
  const inv = [
    { resource_type: 'vpc', resource_id: 'vpc-1', region: 'r', data: { tags: { Name: 'mgmt-vpc' } } },
    { resource_type: 'security_group', resource_id: 'sg-1', region: 'r', data: { group_name: 'web-sg' } },
    { resource_type: 'alb', resource_id: 'my-lb', region: 'r', data: { vpc_id: 'vpc-1', security_groups: [{ GroupId: 'sg-1' }] } },
  ];

  it("upserts class='infra' with the class-scoped sweep (never wipes flow rows)", async () => {
    const { pool, calls, params } = mockPool(inv);
    const res = await rebuildInfraGraph(pool as never, 'RUNI');
    expect(params.some((p) => p.includes('infra'))).toBe(true);
    expect(params.some((p) => p.includes('flow'))).toBe(false);
    expect(calls.some((s) => s.includes('DELETE FROM topology_edges') && s.includes('class = $1') && s.includes('run_id <> $2'))).toBe(true);
    expect(res.edges).toBeGreaterThan(0);
  });

  it('preserves the last-good infra graph on an empty/failed inventory (NO sweep)', async () => {
    const { pool, calls } = mockPool([]);
    const res = await rebuildInfraGraph(pool as never, 'RUNI2');
    expect(res.nodes).toBe(0);
    expect(calls.some((s) => s.includes('DELETE FROM topology_'))).toBe(false);
  });
});

// T2.5 — the empty-build guard is preserved for flow/infra (default allowEmpty=false), proving the
// trace layer's allowEmpty=true sweep (covered in graph-store-trace.test.ts) is an opt-in exception
// and does NOT regress the flow/infra "don't wipe a live graph on a transient empty fetch" guarantee.
describe('writeGraph empty-build guard (T2.5)', () => {
  it('flow empty build keeps its guard (no sweep) — allowEmpty defaults false', async () => {
    const { pool, calls } = mockPool([]);
    await rebuildGraph(pool as never, 'GUARD_FLOW');
    expect(calls.some((s) => s.includes('DELETE FROM topology_'))).toBe(false);
  });
  it('infra empty build keeps its guard (no sweep)', async () => {
    const { pool, calls } = mockPool([]);
    await rebuildInfraGraph(pool as never, 'GUARD_INFRA');
    expect(calls.some((s) => s.includes('DELETE FROM topology_'))).toBe(false);
  });
});
