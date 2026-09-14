import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
const api = vi.hoisted(() => ({ pool: null as unknown }));
vi.mock('@/lib/auth', () => ({ verifyUser: async () => ({ sub: 'fixture' }) }));
vi.mock('@/lib/db', () => ({ getPool: () => api.pool }));
import { GET } from '../app/api/graph/route';
import { graphTransaction } from './graph-transaction';
import { projectGraphDetails } from './graph-state';
import { buildInfraGraph } from './infra-topology';

const socket = process.env.GRAPH_TEST_POSTGRES_SOCKET;
describe.skipIf(!socket)('graph read contract on disposable PostgreSQL', () => {
  let pool: Pool;
  const marker = 'awsops-disposable-graph-read-test';
  beforeAll(async () => {
    expect(socket?.startsWith('/')).toBe(true);
    expect(statSync(join(socket!, '.s.PGSQL.5432')).isSocket()).toBe(true);
    const admin = new Pool({ host: socket, user: 'postgres', database: 'awsops' });
    try {
      const check = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
      expect(check.rows[0]?.marker).toBe('awsops-disposable-graph-test');
      const existing = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname='awsops_graph_read_test'");
      if (!existing.rowCount) {
        await admin.query('CREATE DATABASE awsops_graph_read_test');
        await admin.query("COMMENT ON DATABASE awsops_graph_read_test IS 'awsops-disposable-graph-read-test'");
      } else expect(existing.rows[0].marker).toBe(marker);
    } finally { await admin.end(); }
    pool = new Pool({ host: socket, user: 'postgres', database: 'awsops_graph_read_test', max: 3 });
    const check = await pool.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
    expect(check.rows[0]?.marker).toBe(marker);
    expect((await pool.query('SHOW server_version')).rows[0].server_version).toMatch(/^17\./);
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE SCHEMA IF NOT EXISTS sql_reader;
      DO $$ BEGIN CREATE ROLE awsops_web; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE awsops_worker; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE awsops_sql_reader LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    const migrations = resolve('../terraform/foundation/migrations');
    // Bootstrap the existing reader-role prerequisite from its actual migration.
    const baseline = readFileSync(resolve(migrations, '01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql'), 'utf8');
    await pool.query(baseline.match(/GRANT USAGE ON SCHEMA sql_reader TO awsops_sql_reader;/)![0]);
    for (const suffix of ['_topology_graph.sql', '_topology_class.sql',
      '_topology_graph_collection_state.sql', '_topology_inventory_evidence.sql', '_graph_attempt_disclosure.sql', '_graph_read_indexes.sql', '_graph_projection_parity.sql']) {
      const file = readdirSync(migrations).find(name => name.endsWith(suffix))!;
      await pool.query(readFileSync(resolve(migrations, file), 'utf8'));
    }
  });
  beforeEach(async () => {
    api.pool = pool;
    await pool.query('TRUNCATE topology_nodes, topology_edges, topology_graph_state');
    await pool.query(`INSERT INTO topology_nodes(account_id,id,kind,label,class,run_id) VALUES ('self','old','vpc','old','infra','read-fixture');
      INSERT INTO topology_graph_state(account_id,class,status,attempted_at,captured_at,details)
      VALUES ('self','infra','partial',now(),'2026-09-14T10:00:00Z',
        '{"retainedPrevious":true,"secret":"PRIVATE","sources":[{"sourceId":"inventory:vpc","status":"partial","producerStatus":"succeeded","itemCount":1,"secret":"PRIVATE","reasons":["unknown_attributes","PRIVATE"]}]}')`);
  });
  afterAll(async () => { await pool?.end(); });

  it('keeps nodes and collection on one snapshot while another connection publishes', async () => {
    api.pool = { connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client);
      return { on: client.on.bind(client), removeListener: client.removeListener.bind(client),
        release: client.release.bind(client), query: async (sql: string, args?: unknown[]) => {
          const result = await query(sql, args);
          if (sql.includes('FROM topology_graph_state')) await pool.query(
            "UPDATE topology_nodes SET id='new'; UPDATE topology_graph_state SET captured_at='2026-09-14T11:00:00Z'");
          return result;
        } };
    } };
    const response = await GET(new Request('http://localhost/api/graph?class=infra'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.nodes[0].id).toBe('old');
    expect(JSON.stringify(body)).not.toContain('PRIVATE');
    expect(body.collection.captured_at).toBe('2026-09-14T10:00:00.000Z');
    expect((await pool.query('SELECT id FROM topology_nodes')).rows[0].id).toBe('new');
  });

  it('bounds a class-wide graph and discloses omitted rows without changing collector status', async () => {
    await pool.query(`INSERT INTO topology_nodes(account_id,id,kind,label,class,run_id)
      SELECT 'self','n:'||i,'vpc','node','infra','read-fixture' FROM generate_series(1,4001) i`);
    const body = await (await GET(new Request('http://localhost/api/graph?class=infra'))).json();
    expect(body.nodes).toHaveLength(4000);
    expect(body.collection).toMatchObject({ status: 'partial', readStatus: 'partial', readReason: 'row_limit', readTruncated: true });
  });

  it('preserves actual infra placement containers and connectivity above the class node cap', async () => {
    const graph = buildInfraGraph({
      resources: Array.from({ length: 4001 }, (_, i) => ({
        resource_type: 'ec2', resource_id: `i-${i}`, data: { vpc_id: 'vpc-1' },
      })),
      vpcs: [{ resource_id: 'vpc-1' }], subnets: [{ resource_id: 'subnet-1' }],
      securityGroups: [{ resource_id: 'sg-1' }],
    });
    await pool.query(`INSERT INTO topology_nodes(account_id,id,kind,label,class,run_id)
      SELECT 'self',n.id,n.kind,n.label,'infra','read-fixture'
      FROM jsonb_to_recordset($1::jsonb) n(id text,kind text,label text)`, [JSON.stringify(graph.nodes)]);
    await pool.query(`INSERT INTO topology_edges(account_id,source,target,rel,class,run_id)
      SELECT 'self',e.source,e.target,e.rel,'infra','read-fixture'
      FROM jsonb_to_recordset($1::jsonb) e(source text,target text,rel text)`, [JSON.stringify(graph.edges)]);
    const response = await GET(new Request('http://localhost/api/graph?class=infra'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.nodes).toHaveLength(4000);
    const ids = new Set(body.nodes.map((n: { id: string }) => n.id));
    for (const id of ['vpc:vpc-1', 'subnet:subnet-1', 'sg:sg-1']) expect(ids.has(id)).toBe(true);
    const connected = new Set(body.edges.filter((e: { target: string }) => e.target === 'vpc:vpc-1')
      .map((e: { source: string }) => e.source));
    expect(body.nodes.filter((n: { kind: string }) => n.kind === 'ec2')).toHaveLength(3996);
    expect(body.nodes.every((n: { id: string; kind: string }) => n.kind !== 'ec2' || connected.has(n.id))).toBe(true);
    expect(body.collection).toMatchObject({ readStatus: 'partial', readTruncated: true });
  });

  it('retains the requested root when a reachable subgraph exceeds the node cap', async () => {
    await pool.query(`INSERT INTO topology_nodes(account_id,id,kind,label,class,run_id)
      SELECT 'self',CASE WHEN i=1 THEN 'zz:root' WHEN i<=18 THEN 'z:near:'||i WHEN i<=307 THEN 'm:mid:'||i ELSE 'a:far:'||i END,'vpc','node','infra','read-fixture'
      FROM generate_series(1,5220) i;
      INSERT INTO topology_edges(account_id,source,target,class,run_id)
      SELECT 'self',CASE WHEN ((i-2)/17)+1=1 THEN 'zz:root' WHEN ((i-2)/17)+1<=18 THEN 'z:near:'||(((i-2)/17)+1) ELSE 'm:mid:'||(((i-2)/17)+1) END,
        CASE WHEN i<=18 THEN 'z:near:'||i WHEN i<=307 THEN 'm:mid:'||i ELSE 'a:far:'||i END,'infra','read-fixture' FROM generate_series(2,5220) i`);
    const response = await GET(new Request('http://localhost/api/graph?class=infra&from=zz%3Aroot&depth=3'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.nodes).toHaveLength(4000);
    expect(body.nodes[0].id).toBe('zz:root');
    expect(body.nodes.filter((node: { id: string }) => node.id.startsWith('z:near:'))).toHaveLength(17);
    expect(body.nodes.filter((node: { id: string }) => node.id.startsWith('m:mid:'))).toHaveLength(289);
    expect(body.nodes.slice(1,18).every((node: { id: string }) => node.id.startsWith('z:near:'))).toBe(true);
    expect(body.collection.readTruncated).toBe(true);
    expect(body.capped).toBe(false); // 17 neighbors do not exceed the per-hop fan-out cap.
    const ids = new Set(body.nodes.map((node: { id: string }) => node.id));
    expect(body.edges.every((edge: { source: string; target: string }) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
  });

  it('keeps a shared-pool slot available and terminates a stalled read below the auth budget', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    api.pool = { connect: async () => {
      const client = await pool.connect(), query = client.query.bind(client);
      return { on: client.on.bind(client), removeListener: client.removeListener.bind(client),
        release: client.release.bind(client), query: async (sql: string, args?: unknown[]) => {
          if (sql.includes('FROM topology_nodes')) { started(); await query('SELECT pg_sleep(4)'); }
          return query(sql, args);
        } };
    } };
    const first = GET(new Request('http://localhost/api/graph?class=infra'));
    await ready;
    try {
      const second = GET(new Request('http://localhost/api/graph'));
      expect((await GET(new Request('http://localhost/api/graph'))).status).toBe(503);
      expect((await pool.query('SELECT 42 AS value')).rows[0].value).toBe(42);
      for (const response of await Promise.all([first, second])) {
        expect(response.status).toBe(500);
        expect((await response.json()).collection.readReason).toBe('timeout');
      }
      expect((await pool.query('SELECT count(*) FROM topology_nodes')).rows[0].count).toBe('1');
    } finally { vi.restoreAllMocks(); }
  });

  it('retains the fatal transaction SQLSTATE when the next query only reports an unusable client', async () => {
    await expect(graphTransaction(pool, true, async client => {
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '20ms'");
      await new Promise(resolve => setTimeout(resolve, 120));
      await client.query('SELECT 1');
    })).rejects.toMatchObject({ code: '25P03' });
    expect((await pool.query('SELECT 42 AS value')).rows[0].value).toBe(42);
  });

  it.each([Object.assign(new Error('fixture original query'), { code: '42501' }), new TypeError('fixture application error')])('preserves the original query/application error ahead of a later client error: %s', async original => {
    await expect(graphTransaction(pool, true, async client => {
      client.emit('error', new Error('fixture later socket event'));
      throw original;
    })).rejects.toBe(original);
  });

  it.each([
    { sources: Array.from({ length: 129 }, (_, i) => ({ sourceId: `tempo:${i}`, status: 'ok' })),
      sourceAttempted: false, failureReason: 'not_attempted', publishedSources: [{ sourceId: 'inventory:vpc',
        status: 'partial', producerStatus: 'succeeded', capturedAtMs: null, reasons: ['count_not_confirmed'] }] },
    { sources: [null, { sourceId: 'invalid PRIVATE' }, { sourceId: 'tempo:1', status: 'partial', reasons: ['PRIVATE','query_failed'] }] },
    { sources: 'PRIVATE', publishedSources: null },
    ...['status','producerStatus','scope'].flatMap(key => [null,false,{},'future_value']
      .map(value => ({ sources: [{ sourceId: 'inventory:vpc', [key]: value }] }))),
    ...['itemCount','windowStartMs','windowEndMs','capturedAtMs','lastSuccessAtMs','attemptedAtMs','finishedAtMs']
      .flatMap(key => [-1,'123',8640000000000001].map(value => ({ publishedSources: [{ sourceId: 'inventory:vpc', [key]: value }] }))),
    { windowStartMs: -1 }, { nodeDrops: '3' }, { infraUnavailable: 'true' },
    { failureReason: 'future_value' }, { metadataTruncated: null },
  ])('SQL and HTTP expose the same bounded metadata and omission flag', async details => {
    await pool.query("UPDATE topology_graph_state SET details=$1 WHERE account_id='self' AND class='infra'", [details]);
    const projected = (await pool.query("SELECT details FROM sql_reader.topology_graph_state WHERE account_id='self' AND class='infra'")).rows[0].details;
    expect(projected).toEqual(projectGraphDetails(details));
    expect(projected.metadataTruncated).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE');
  });
  it('reason deduplication alone does not claim missing metadata in either projection', async () => {
    const details = { sources: [{ sourceId: 'tempo:1', status: 'partial', reasons: ['cap_reached','cap_reached'] }] };
    await pool.query("UPDATE topology_graph_state SET details=$1", [details]);
    const projected = (await pool.query('SELECT details FROM sql_reader.topology_graph_state')).rows[0].details;
    expect(projected).toEqual(projectGraphDetails(details));
    expect(projected).not.toHaveProperty('metadataTruncated');
    expect(projected.sources[0].reasons).toEqual(['cap_reached']);
  });

  it('exposes only the narrow collection projection to the SQL reader', async () => {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE awsops_sql_reader');
      const row = (await client.query('SELECT details FROM sql_reader.topology_graph_state')).rows[0];
      expect(row.details.sources[0]).toMatchObject({ sourceId: 'inventory:vpc', producerStatus: 'succeeded' });
      expect(JSON.stringify(row)).not.toContain('PRIVATE');
      await expect(client.query('SELECT * FROM public.topology_graph_state')).rejects.toMatchObject({ code: '42501' });
    } finally { await client.query('RESET ROLE'); client.release(); }
  });
});


// These cases are within the same guarded disposable database; no application connection.
