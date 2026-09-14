import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
const api = vi.hoisted(() => ({ pool: null as unknown }));
vi.mock('@/lib/auth', () => ({ verifyUser: async () => ({ sub: 'fixture' }) }));
vi.mock('@/lib/db', () => ({ getPool: () => api.pool }));
import { GET } from '../app/api/graph/route';

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
      '_topology_graph_collection_state.sql', '_topology_inventory_evidence.sql', '_graph_read_indexes.sql']) {
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

  it('keeps a shared-pool slot available and terminates a stalled read below the auth budget', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
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
      const excess = await Promise.all([GET(new Request('http://localhost/api/graph')), GET(new Request('http://localhost/api/graph'))]);
      expect(excess.map(response => response.status)).toEqual([503, 503]);
      expect((await pool.query('SELECT 42 AS value')).rows[0].value).toBe(42);
      expect((await first).status).toBe(500);
      expect((await pool.query('SELECT count(*) FROM topology_nodes')).rows[0].count).toBe('1');
    } finally { vi.restoreAllMocks(); }
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
