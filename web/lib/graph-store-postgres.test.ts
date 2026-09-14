import tempoContracts from '../../agent/fixtures/tempo-topology-contract.json';
import { TempoTraceSource } from './trace-source';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebuildGraph, rebuildInfraGraph, rebuildTraceGraph } from './graph-store';
import { inventorySnapshot, inventoryAccounts, recordUnattempted, INFRA_TYPES } from './graph-inventory';
import { HOST_ONLY_TREND_TYPES } from './trend-utils';
import { readGraphState, writeGraphState } from './graph-state';
import type { ServiceGraphCall, SourceRead } from './trace-source';
const api = vi.hoisted(() => ({ pool: null as unknown }));
const producer = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/lib/datasources', () => ({ getDatasource: async () => ({ id: 7, kind: 'tempo' }), getDefaultDatasource: async () => ({ id: 7, kind: 'tempo' }), resolveConnConfig: async () => ({ endpoint: 'http://fixture.invalid' }) }));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: (...args: unknown[]) => producer.invoke(...args) }));
vi.mock('@/lib/auth', () => ({ verifyUser: async () => ({ sub: 'fixture' }) }));
vi.mock('@/lib/db', () => ({ getPool: () => api.pool }));
import { GET } from '../app/api/graph/route';

// Opt-in, disposable PG17 server only. The Unix socket is mounted in a private task directory;
// no host port, AWS endpoint, or product dependency is needed.
const socket = process.env.GRAPH_TEST_POSTGRES_SOCKET;
describe.skipIf(!socket)('inventory graph publication on PostgreSQL', () => {
  let pool: Pool;
  const migrations = resolve('../terraform/foundation/migrations');
  const flowTypes = ['route53', 'cloudfront', 'alb', 'nlb', 'target_group', 'waf', 'ec2',
    'lambda', 'ecs_task', 's3', 'subnet', 'apigatewayv2_api', 'apigatewayv2_integration', 'cloudfront_vpc_origin'];
  const requiredTypes = [...new Set([...flowTypes, ...INFRA_TYPES])];
  const now = Date.now();
  const recent = new Date(now - 60_000).toISOString();
  const old = new Date(now - 3_600_000).toISOString();
  beforeAll(async () => {
    const admin = new Pool({ host: socket, user: 'postgres', database: 'awsops' });
    const sentinel = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
    if (sentinel.rows[0]?.marker !== 'awsops-disposable-graph-test') {
      await admin.end();
      throw new Error('Refusing graph fixtures without disposable database sentinel');
    }
    expect((await admin.query('SHOW server_version')).rows[0].server_version).toMatch(/^17\./);
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='awsops_graph_task3'")).rowCount)
      await admin.query('CREATE DATABASE awsops_graph_task3');
    await admin.end();
    pool = new Pool({ host: socket, user: 'postgres', database: 'awsops_graph_task3' });
    api.pool = pool;
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE SCHEMA IF NOT EXISTS sql_reader;
      DO $$ BEGIN CREATE ROLE awsops_web; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE awsops_worker; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE awsops_sql_reader LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    const schema = readFileSync(resolve('../terraform/foundation/data/schema.sql'), 'utf8');
    for (const table of ['inventory_resources', 'inventory_sync_runs', 'inventory_snapshots', 'account_regions'])
      await pool.query(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0]);
    for (const suffix of ['_accounts.sql', '_accounts_all_regions.sql'])
      await pool.query(readFileSync(resolve(migrations, readdirSync(migrations).find(f => f.endsWith(suffix))!), 'utf8'));
    for (const suffix of ['_topology_graph.sql', '_topology_class.sql', '_inventory_sync_freshness.sql',
      '_inventory_sync_unknown_attrs.sql', '_topology_graph_collection_state.sql',
      '_topology_inventory_evidence.sql', '_graph_attempt_disclosure.sql', '_graph_read_indexes.sql', '_graph_projection_parity.sql'])
      await pool.query(readFileSync(resolve(migrations, readdirSync(migrations).find(f => f.endsWith(suffix))!), 'utf8'));
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    api.pool = pool;
    await pool.query(`TRUNCATE inventory_resources, inventory_sync_runs, topology_nodes, topology_edges, topology_graph_state, inventory_snapshots, accounts, account_regions;
      DROP TRIGGER IF EXISTS reject_publication ON topology_nodes;
      DROP TRIGGER IF EXISTS reject_publication ON topology_edges;
      DROP TRIGGER IF EXISTS reject_publication ON topology_graph_state;`);
    await pool.query(`INSERT INTO inventory_sync_runs
      (resource_type, status, started_at, finished_at, last_success_at, row_count, unknown_attribute_count)
      SELECT t, 'succeeded', $2, $2, $2, 0, 0 FROM unnest($1::text[]) t`, [requiredTypes, recent]);
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool?.end(); });
  async function seed(cls: string, captured = recent, account = 'self') {
    const type = cls === 'flow' ? 'alb' : 'vpc';
    await pool.query(`INSERT INTO inventory_resources(resource_type, account_id, resource_id, data, captured_at)
      VALUES ($1,$2,'one','{"arn":"arn:alb","dns_name":"web.example.test"}',$3)`, [type, account, captured]);
    await pool.query(`INSERT INTO inventory_sync_runs(resource_type,status,started_at,finished_at,last_success_at,row_count,unknown_attribute_count)
      VALUES ($1,'succeeded',$2,$2,$2,1,0) ON CONFLICT(resource_type,account_id)
      DO UPDATE SET row_count=1`, [type, recent]);
    if (account !== 'self') {
      await pool.query(`INSERT INTO accounts(account_id,alias,external_id,all_regions)
        VALUES ($1,'fixture','fixture-only',true) ON CONFLICT(account_id) DO NOTHING`, [account]);
      // This is the real sync producer's per-account snapshot contract, not a member job ledger.
      await pool.query(`INSERT INTO inventory_snapshots(account_id,captured_at,resource_type,resource_count)
        SELECT $1,$2,t,CASE WHEN t=$3 THEN 1 ELSE 0 END FROM unnest($4::text[]) t`,
      [account, recent, type, requiredTypes.filter(t => !HOST_ONLY_TREND_TYPES.has(t))]);
    }
  }
  const build = (cls: string) => cls === 'flow' ? rebuildGraph(pool) : rebuildInfraGraph(pool);
  const state = (cls: string, account = 'self') => readGraphState(pool, account, cls as never);
  const trace = (items: ServiceGraphCall[] = [{ client: 'api', server: 'db', count: 7 }],
    status: SourceRead<ServiceGraphCall>['status'] = 'ok', target = pool) =>
    rebuildTraceGraph(target, [], undefined, [{
      available: async () => true,
      calls: async (mins, endMs = Date.now()) => ({ sourceId: 'metrics:test', items, status,
        reasons: [], windowStartMs: endMs - mins * 60_000, windowEndMs: endMs }),
    }]);

  it.each(tempoContracts)('Tempo producer $name preserves the graph unless empty is confirmed', async fixture => {
    await trace();
    const previous = await state('trace');
    const nodes = (await pool.query("SELECT id FROM topology_nodes WHERE class='trace' ORDER BY id")).rows;
    expect(nodes.length).toBeGreaterThan(0);
    producer.invoke.mockReset().mockResolvedValue(fixture.body);
    const source = new TempoTraceSource(7);
    const observed = vi.spyOn(source, 'recentSpans');
    await rebuildTraceGraph(pool, [source]);
    expect((await observed.mock.results[0].value).status).toBe(fixture.readStatus);
    const after = await state('trace');
    const remaining = (await pool.query("SELECT id FROM topology_nodes WHERE class='trace' ORDER BY id")).rows;
    if (fixture.readStatus === 'ok') {
      expect(after).toMatchObject({ status: 'empty', retainedPrevious: false });
      expect(remaining).toEqual([]);
    } else {
      expect(after).toMatchObject({ retainedPrevious: true, captured_at: previous.captured_at });
      expect(remaining).toEqual(nodes);
    }
  });

  it.each(['flow', 'infra'])('%s confirms host empty from a succeeded aggregate with member-only rows', async cls => {
    await seed(cls, recent, '111122223333');
    await build(cls);
    const result = await state(cls);
    expect(result).toMatchObject({ status: 'empty', retainedPrevious: false, stale: false });
    expect(result.sources).toContainEqual(expect.objectContaining({
      sourceId: `inventory:${cls === 'flow' ? 'alb' : 'vpc'}`, itemCount: 0, status: 'empty',
    }));
    expect((await pool.query("SELECT * FROM topology_nodes WHERE account_id='111122223333'")).rowCount).toBeGreaterThan(0);
  });
  it.each([1, null])('publishes succeeded enumeration with unknown attributes %s after pruning', async unknown => {
    await seed('infra');
    await build('infra');
    await pool.query("UPDATE inventory_resources SET resource_id='replacement'");
    await pool.query("UPDATE inventory_sync_runs SET unknown_attribute_count=$1 WHERE resource_type='vpc'", [unknown]);
    const result = await build('infra');
    expect(result).toMatchObject({ published: 1, retained: 0, degraded: 1 });
    expect(await state('infra')).toMatchObject({ status: 'partial', retainedPrevious: false, stale: true });
    expect((await pool.query("SELECT id FROM topology_nodes WHERE class='infra'")).rows)
      .toEqual([{ id: 'vpc:replacement' }]);
    await pool.query('DELETE FROM inventory_resources; UPDATE inventory_sync_runs SET row_count=0');
    await build('infra');
    expect(await state('infra')).toMatchObject({ status: 'partial', retainedPrevious: false });
    expect((await pool.query("SELECT * FROM topology_nodes WHERE class='infra'")).rows).toEqual([]);
  });
  it.each([2, null])('retains a prior graph when nonempty input cannot reconcile producer count %s', async count => {
    await seed('infra');
    await build('infra');
    const previous = await state('infra');
    await pool.query("UPDATE inventory_resources SET resource_id='replacement'");
    await pool.query("UPDATE inventory_sync_runs SET row_count=$1 WHERE resource_type='vpc'", [count]);
    expect(await build('infra')).toMatchObject({ published: 0, retained: 1 });
    expect(await state('infra')).toMatchObject({ status: 'partial', retainedPrevious: true, captured_at: previous.captured_at });
    expect((await state('infra')).sources).toContainEqual(expect.objectContaining({
      sourceId: 'inventory:vpc', reasons: expect.arrayContaining(['count_not_confirmed']),
    }));
    expect((await pool.query("SELECT id FROM topology_nodes WHERE class='infra'")).rows).toEqual([{ id: 'vpc:one' }]);
  });
  it('reconciles the aggregate count across accounts rather than treating it as a host count', async () => {
    await seed('infra');
    await pool.query(`INSERT INTO inventory_resources(resource_type,account_id,resource_id,data,captured_at)
      VALUES ('vpc','111122223333','member','{}',$1)`, [recent]);
    await pool.query("UPDATE inventory_sync_runs SET row_count=2 WHERE resource_type='vpc'");
    await build('infra');
    expect(await state('infra')).toMatchObject({ status: 'ok', retainedPrevious: false });
    expect((await pool.query("SELECT id FROM topology_nodes WHERE account_id='self' AND class='infra'")).rows).toEqual([{ id: 'vpc:one' }]);
  });

  it('ignores unrelated failed inventory sources without dropping contributing failure guards', async () => {
    await seed('infra');
    await pool.query(`INSERT INTO inventory_sync_runs(resource_type,status) VALUES ('iam_role','failed')`);
    expect((await build('infra')).nodes).toBeGreaterThan(0);
    expect(await state('infra')).toMatchObject({ status: 'ok', retainedPrevious: false });
    await pool.query(`UPDATE inventory_sync_runs SET status='failed' WHERE resource_type='vpc'`);
    expect(await build('infra')).toMatchObject({ published: 0, retained: 1 });
    expect(await state('infra')).toMatchObject({ status: 'error', retainedPrevious: true });
  });
  it.each(['flow', 'infra'].flatMap(cls => ['failed', 'partial', 'running'].map(status => [cls, status])))(
    '%s member first publication includes aggregate %s with no member rows/history for that type', async (cls, status) => {
      await seed(cls, recent, '111122223333');
      await pool.query("UPDATE inventory_sync_runs SET status=$1 WHERE resource_type='lambda'", [status]);
      await build(cls);
      const result = await state(cls, '111122223333');
      expect(result).toMatchObject({ stale: true, retainedPrevious: true, captured_at: null });
      expect(result.sources).toContainEqual(expect.objectContaining({
        sourceId: 'inventory:lambda', scope: 'aggregate', producerStatus: status, itemCount: 0,
        status: status === 'failed' ? 'error' : 'unavailable',
      }));
      expect((await pool.query("SELECT * FROM topology_nodes WHERE account_id='111122223333'")).rowCount).toBe(0);
    });
  it('skips a contended publication without holding a pool connection in a lock wait', async () => {
    await seed('infra');
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1)', [0x696e6672]);
    try {
      const result = await Promise.race([build('infra'), new Promise(resolve => setTimeout(() => resolve('waited'), 800))]);
      expect(result).toMatchObject({ published: 0, skipped: 1, reasons: ['publication_busy'] });
      expect((await pool.query('SELECT * FROM topology_nodes')).rowCount).toBe(0);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  });
  it('bounds an account snapshot and retains its graph with explicit truncation', async () => {
    await seed('infra');
    await build('infra');
    await pool.query(`INSERT INTO inventory_resources(resource_type,resource_id,data,captured_at)
      SELECT 'vpc', 'vpc-'||n, '{}', $1 FROM generate_series(1,2000) n`, [recent]);
    expect(await build('infra')).toMatchObject({ published: 0, retained: 1, reasons: ['snapshot_limit'] });
    expect(await state('infra')).toMatchObject({ status: 'partial', retainedPrevious: true, inputTruncated: true });
    expect((await pool.query("SELECT id FROM topology_nodes WHERE class='infra'")).rows).toEqual([{ id: 'vpc:one' }]);
  });
  it('reads ledger and rows in one snapshot, then releases that connection before publication', async () => {
    await seed('infra');
    let changed = false;
    const wrapped = { connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client);
      return { on: client.on.bind(client), removeListener: client.removeListener.bind(client),
        release: client.release.bind(client), query: async (sql: string, args?: unknown[]) => {
        const result = await query(sql, args);
        if (sql.includes('FROM inventory_sync_runs') && !sql.includes('UNION') && !changed) {
          changed = true;
          const freeLock = await pool.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [0x696e6672]);
          expect(freeLock.rows[0].acquired).toBe(true);
          await pool.query(`DELETE FROM inventory_resources; UPDATE inventory_sync_runs SET row_count=0`);
        }
        return result;
      } };
    }, query: pool.query.bind(pool) };
    await rebuildInfraGraph(wrapped as never);
    expect(changed).toBe(true);
    expect((await pool.query("SELECT id FROM topology_nodes WHERE class='infra'")).rows).toEqual([{ id: 'vpc:one' }]);
    expect(await state('infra')).toMatchObject({ status: 'ok', retainedPrevious: false });
  });
  it('does not leave trace publication waiting on a class lock in the web pool', async () => {
    await trace();
    const previous = await state('trace');
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1)', [0x74726163]);
    try {
      expect(await Promise.race([trace([]),
        new Promise(resolve => setTimeout(() => resolve('waited'), 800))]))
        .toMatchObject({ published: 0, skipped: 1, reasons: ['publication_busy'], nodes: 0, edges: 0 });
      expect(await state('trace')).toEqual(previous);
      expect((await pool.query("SELECT * FROM topology_nodes WHERE class='trace'")).rowCount).toBe(2);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  });
  it('publishes a cap-sized trace in bounded batches with edge metadata and scoped sweeps', async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ client: `svc-${i % 200}`,
      server: `svc-${(i % 200 + 1 + Math.floor(i / 200)) % 200}`, count: 7 }));
    await seed('infra');
    await build('infra');
    let statements = 0;
    const delayed = { query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect();
      return { on: client.on.bind(client), removeListener: client.removeListener.bind(client),
        release: client.release.bind(client), query: async (sql: string, args?: unknown[]) => {
        statements++;
        await new Promise(resolve => setTimeout(resolve, 8));
        return client.query(sql, args);
      } };
    } } as unknown as Pool;
    const start = performance.now();
    const result = await trace(items, 'ok', delayed);
    console.info('trace-cap', JSON.stringify({ nodes: result.nodes, edges: result.edges, statements,
      elapsedMs: Math.round(performance.now() - start), delayPerStatementMs: 8 }));
    expect(result).toMatchObject({ published: 1, retained: 0, skipped: 0, degraded: 0, nodes: 200, edges: 500 });
    expect(statements).toBeLessThan(20);
    expect(performance.now() - start).toBeLessThan(4000);
    expect((await pool.query("SELECT count(*)::int AS n FROM topology_nodes WHERE class='trace'")).rows[0].n).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS n FROM topology_edges WHERE class='trace' AND meta='{\"spanCount\":0,\"metricCount\":7}'")).rows[0].n).toBe(500);
    await trace(items.map(item => ({ ...item, count: 9 })));
    expect((await pool.query("SELECT count(*)::int AS n FROM topology_edges WHERE class='trace' AND meta->>'metricCount'='9'")).rows[0].n).toBe(500);
    expect((await pool.query("SELECT * FROM topology_nodes WHERE class='infra'")).rowCount).toBe(1);
    expect(await trace([...items, { client: 'extra', server: 'svc-0', count: 1 }]))
      .toMatchObject({ published: 1, degraded: 1, nodes: 200, edges: 500 });
    expect(await state('trace')).toMatchObject({ status: 'partial', nodeDrops: 1, edgeDrops: 1, retainedPrevious: false });
  }, 10_000);
  it.each(['error', 'unavailable', 'partial'] as const)('trace %s retains its prior graph and reports no publication', async status => {
    await trace();
    const previous = await state('trace');
    expect(await trace([], status)).toMatchObject({ published: 0, retained: 1, skipped: 0, nodes: 0, edges: 0 });
    expect(await state('trace')).toMatchObject({ status, stale: true, retainedPrevious: true, captured_at: previous.captured_at });
    expect((await pool.query("SELECT * FROM topology_nodes WHERE class='trace'")).rowCount).toBe(2);
  });
  it('trace publishes degraded evidence and confirmed empty with distinct outcomes', async () => {
    expect(await trace(undefined, 'partial')).toMatchObject({ published: 1, degraded: 1, nodes: 2, edges: 1 });
    expect(await state('trace')).toMatchObject({ status: 'partial', retainedPrevious: false });
    expect(await trace([])).toMatchObject({ published: 1, degraded: 0, retained: 0, skipped: 0, nodes: 0, edges: 0 });
    expect(await state('trace')).toMatchObject({ status: 'empty', stale: false });
    expect((await pool.query("SELECT * FROM topology_nodes WHERE class='trace'")).rowCount).toBe(0);
  });
  it.each([0, -1000])('trace discloses superseded attempts (%s ms) without changing graph or state', async offset => {
    await trace();
    const previous = await state('trace');
    const attemptClock = vi.spyOn(Date, 'now').mockReturnValue(new Date(previous.attempted_at).getTime() + offset);
    expect(await trace([])).toMatchObject({ published: 0, skipped: 1, reasons: ['superseded'] });
    attemptClock.mockRestore(); // Compare freshness with the real read clock, not an older attempt clock.
    expect(await state('trace')).toEqual(previous);
    expect((await pool.query("SELECT * FROM topology_nodes WHERE class='trace'")).rowCount).toBe(2);
  });
  it.each(['raise', 'timeout'])('trace rolls back an edge write %s and records failure without renewing publication', async mode => {
    await trace();
    const previous = await state('trace');
    const nodes = (await pool.query("SELECT * FROM topology_nodes WHERE class='trace' ORDER BY id")).rows;
    const edges = (await pool.query("SELECT * FROM topology_edges WHERE class='trace' ORDER BY id")).rows;
    await pool.query(`CREATE OR REPLACE FUNCTION reject_graph() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN ${mode === 'timeout' ? 'PERFORM pg_sleep(2.1); RETURN NEW;' : "RAISE EXCEPTION 'credential=do-not-expose';"} END $$;
      CREATE TRIGGER reject_publication BEFORE INSERT OR UPDATE ON topology_edges FOR EACH ROW EXECUTE FUNCTION reject_graph();`);
    await expect(trace([{ client: 'new', server: 'other', count: 3 }])).rejects.toThrow();
    expect(await state('trace')).toMatchObject({ status: 'error', stale: true, retainedPrevious: true,
      failureReason: 'publication_failed', captured_at: previous.captured_at });
    expect(JSON.stringify(await state('trace'))).not.toContain('credential');
    expect((await pool.query("SELECT * FROM topology_nodes WHERE class='trace' ORDER BY id")).rows).toEqual(nodes);
    expect((await pool.query("SELECT * FROM topology_edges WHERE class='trace' ORDER BY id")).rows).toEqual(edges);
  }, 10_000);
  it.each([
    ['helper', 'available'], ['helper', 'fatal'], ['idle', 'available'], ['idle-query', 'available'], ['rollback', 'available'],
    ...['cli', 'timer'].flatMap(mode => ['available', 'sql-error', 'fatal', 'connect-error'].map(recording => [mode, recording])),
  ])('fatal PG recovery through %s with %s failure recording survives in an isolated child', async (mode, recording) => {
    await trace();
    const previous = await state('trace');
    const nodes = (await pool.query("SELECT * FROM topology_nodes WHERE class='trace' ORDER BY id")).rows;
    const edges = (await pool.query("SELECT * FROM topology_edges WHERE class='trace' ORDER BY id")).rows;
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', 'lib/fixtures/graph-fatal-child.mjs', mode, recording],
      { encoding: 'utf8', timeout: 15_000, env: process.env });
    expect(child.status, child.stderr).toBe(0);
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.stderr).not.toMatch(/Unhandled|credential=|Connection terminated|uncaught/i);
    const result = JSON.parse(child.stdout);
    expect(result.removed).toBeGreaterThanOrEqual(recording === 'fatal' ? 2 : 1);
    const afterFailure = mode === 'timer' ? result.afterFailure : await state('trace');
    if (mode.startsWith('idle') || mode === 'rollback' || recording !== 'available') {
      expect(JSON.parse(JSON.stringify(afterFailure))).toEqual(JSON.parse(JSON.stringify(previous)));
    } else {
      expect(afterFailure).toMatchObject({ status: 'error', stale: true, retainedPrevious: true,
        failureReason: 'publication_failed' });
      expect(new Date(afterFailure.captured_at).getTime()).toBe(new Date(previous.captured_at).getTime());
    }
    if (mode === 'timer') {
      expect(result.scheduled).toEqual([['timeout', 60000], ['interval', 60000]]);
      expect(result.logs).toHaveLength(5); // first cycle fails at trace; overlap skips; next cycle succeeds
      expect(result.logs.at(-1)).toContain('"published":1');
      expect(result.closed).toBe(0); // timer keeps the shared pool open for the next cycle
      expect(await state('trace')).toMatchObject({ status: 'ok', retainedPrevious: false });
    } else {
      expect((await pool.query("SELECT * FROM topology_nodes WHERE class='trace' ORDER BY id")).rows).toEqual(nodes);
      expect((await pool.query("SELECT * FROM topology_edges WHERE class='trace' ORDER BY id")).rows).toEqual(edges);
    }
    if (mode === 'cli') expect(result).toMatchObject({ code: 1, closed: 1 });
    if (!mode.startsWith('idle') && mode !== 'rollback')
      expect(result).toMatchObject({ originalCode: '25P04', failureAttempts: 1 });
  }, 20_000);
  it('trace still rejects if even its failure state cannot be recorded', async () => {
    await trace();
    const previous = await state('trace');
    await pool.query(`CREATE OR REPLACE FUNCTION reject_graph() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'credential=do-not-expose'; END $$;
      CREATE TRIGGER reject_publication BEFORE INSERT OR UPDATE ON topology_graph_state FOR EACH ROW EXECUTE FUNCTION reject_graph();`);
    await expect(trace([])).rejects.toThrow();
    expect(await state('trace')).toEqual(previous);
    expect((await pool.query("SELECT * FROM topology_nodes WHERE class='trace'")).rowCount).toBe(2);
  });
  it('sends neither oversized flow payloads nor oversized identifiers to the web process', async () => {
    await seed('flow');
    await pool.query(`UPDATE inventory_resources SET resource_id=repeat('x',100000),
      data=jsonb_build_object('name', repeat('p',100000))`);
    const snapshot = await inventorySnapshot(pool, 'flow', 'self', ['alb']);
    expect(snapshot.truncated).toBe(true);
    expect(JSON.stringify(snapshot.rows).length).toBeLessThan(2048);
  });
  it('does not transfer irrelevant infra raw payloads or confuse them with missing required attributes', async () => {
    await seed('infra');
    await pool.query(`UPDATE inventory_resources SET data=jsonb_build_object(
      'name','fixture','raw_unused',repeat('x',1000000))`);
    const snapshot = await inventorySnapshot(pool, 'infra', 'self', ['vpc']);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.rows[0].data).toEqual({ name: 'fixture' });
    expect((await build('infra')).published).toBe(1);
  });
  it('projects unused flow fields before byte limits while preserving its real graph inputs', async () => {
    await seed('flow');
    await pool.query(`UPDATE inventory_resources SET data=data || jsonb_build_object(
      'raw_unused',repeat('x',1000000),'resource_id','spoofed','region','spoofed')`);
    const snapshot = await inventorySnapshot(pool, 'flow', 'self', ['alb']);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.rows[0].data).toEqual({ arn: 'arn:alb', dns_name: 'web.example.test' });
    expect((await build('flow')).published).toBe(1);
    const nodes = (await pool.query("SELECT id,meta FROM topology_nodes WHERE class='flow'")).rows;
    expect(nodes[0].id).toBe('alb:arn:alb');
    expect(nodes[0].meta.row.resource_id).toBe('one');
    expect(JSON.stringify(nodes)).not.toContain('raw_unused');
  });
  it('retains every row when aggregate projected input exceeds the byte budget', async () => {
    await seed('infra');
    await build('infra');
    await pool.query(`INSERT INTO inventory_resources(resource_type,resource_id,data,captured_at)
      SELECT 'vpc','vpc-'||n,jsonb_build_object('name', repeat('a',60000)),$1
      FROM generate_series(1,150) n`, [recent]);
    const snapshot = await inventorySnapshot(pool, 'infra', 'self', ['vpc']);
    expect(snapshot.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(snapshot.rows))).toBeLessThan(8 * 1024 * 1024 + 100000);
    expect(await build('infra')).toMatchObject({ retained: 1, reasons: ['snapshot_limit'] });
    expect((await pool.query("SELECT id FROM topology_nodes WHERE class='infra'")).rows).toEqual([{ id: 'vpc:one' }]);
  });
  it('continues a small account after retaining an oversized account', async () => {
    await pool.query(`INSERT INTO inventory_resources(resource_type,account_id,resource_id,data,captured_at)
      SELECT 'vpc','self','vpc-'||n,'{}',$1 FROM generate_series(1,2001) n`, [recent]);
    await seed('infra', recent, '111122223333');
    await pool.query("UPDATE inventory_sync_runs SET row_count=2002 WHERE resource_type='vpc'");
    expect(await build('infra')).toMatchObject({ published: 1, retained: 1, reasons: ['snapshot_limit'] });
    expect(await state('infra', '111122223333')).toMatchObject({ retainedPrevious: false, status: 'ok' });
  });
  it('projects skip/count reasons without widening reader metadata', async () => {
    const projection = readFileSync(resolve(migrations, readdirSync(migrations).find(f => f.endsWith('_graph_projection_parity.sql'))!), 'utf8');
    await pool.query(projection); await pool.query(projection);
    await pool.query(`INSERT INTO topology_graph_state(account_id,class,status,attempted_at,details)
      VALUES ('self','infra','unavailable',now(),$1)`, [{ sourceAttempted: false,
      failureReason: 'not_attempted', secret: 'PRIVATE', sources: [{ sourceId: 'inventory:vpc',
        status: 'partial', producerStatus: 'succeeded', itemCount: 1, reasons: ['count_not_confirmed','PRIVATE'] }] }]);
    const row = (await pool.query('SELECT details FROM sql_reader.topology_graph_state')).rows[0];
    expect(row.details).toMatchObject({ sourceAttempted: false, failureReason: 'not_attempted' });
    expect(row.details.sources[0].reasons).toEqual(['count_not_confirmed']);
    expect(JSON.stringify(row)).not.toContain('PRIVATE');
  });

  it('does not overwrite a newer collection attempt with older skip evidence', async () => {
    await seed('infra'); await build('infra');
    const previous = await state('infra');
    await recordUnattempted(pool, 'infra', 0x696e6672, ['self'], old);
    expect(await state('infra')).toEqual(previous);
  });

  it('prioritizes accounts whose source reads were not attempted', async () => {
    const member = '111122223333';
    await seed('infra'); await seed('infra', recent, member);
    await pool.query(`INSERT INTO topology_graph_state(account_id,class,status,attempted_at,details)
      VALUES ('self','infra','ok',$1,'{}'),($2,'infra','unavailable',$1,'{"sourceAttempted":false}')`, [recent, member]);
    expect((await inventoryAccounts(pool, 'infra', INFRA_TYPES))?.[0]).toBe(member);
  });
  it('continues later accounts after a source read fails and preserves the original failure', async () => {
    const member = '111122223333';
    await seed('infra'); await seed('infra', recent, member);
    await pool.query("UPDATE inventory_sync_runs SET row_count=2 WHERE resource_type='vpc'");
    const failure = Object.assign(new Error('fixture source failure'), { code: '42501' });
    const wrapped = { connect: async () => {
      const client = await pool.connect(), query = client.query.bind(client);
      return { on: client.on.bind(client), removeListener: client.removeListener.bind(client),
        release: client.release.bind(client), query: (sql: string, args?: unknown[]) => {
          if (sql.includes('WITH bounded') && args?.[0] === 'self') return Promise.reject(failure);
          return query(sql, args);
        } };
    } };
    await expect(rebuildInfraGraph(wrapped as never)).rejects.toBe(failure);
    expect(await state('infra', member)).toMatchObject({ status: 'ok', retainedPrevious: false });
    expect((await pool.query("SELECT id FROM topology_nodes WHERE account_id=$1", [member])).rows).toEqual([{ id: 'vpc:one' }]);
  });
  it('records budget-skipped source reads without changing the saved graph', async () => {
    await seed('infra'); await build('infra');
    const previous = await state('infra');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(previous.attempted_at).getTime() + 1000);
    const timer = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(31_000);
    try {
      expect(await build('infra')).toMatchObject({ skipped: 1, reasons: ['time_limit'] });
      expect(await state('infra')).toMatchObject({ status: 'unavailable', sourceAttempted: false,
        failureReason: 'not_attempted', retainedPrevious: true, captured_at: previous.captured_at });
      expect((await pool.query("SELECT id FROM topology_nodes WHERE class='infra'")).rows).toEqual([{ id: 'vpc:one' }]);
    } finally { timer.mockRestore(); clock.mockRestore(); }
  });

  it('uses one per-pool rebuild admission slot and leaves request reads available', async () => {
    await seed('infra');
    let unblock!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let once = false;
    const wrapped = { connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client);
      return { on: client.on.bind(client), removeListener: client.removeListener.bind(client),
        release: client.release.bind(client), query: async (sql: string, args?: unknown[]) => {
        const result = await query(sql, args);
        if (sql.includes('FROM inventory_sync_runs') && !once) {
          once = true; entered(); await blocked;
        }
        return result;
      } };
    } };
    const first = rebuildInfraGraph(wrapped as never);
    await ready;
    try {
      expect(await rebuildInfraGraph(wrapped as never)).toMatchObject({ skipped: 1, reasons: ['rebuild_busy'] });
      expect((await rebuildGraph(wrapped as never)).reasons).not.toContain('rebuild_busy');
      expect((await pool.query('SELECT 42 AS value')).rows[0].value).toBe(42);
    } finally { unblock(); await first; }
  });
  it('discloses undiscovered accounts when the bounded account budget is exceeded', async () => {
    await pool.query(`INSERT INTO accounts(account_id,alias,external_id,all_regions)
      SELECT lpad(n::text,12,'0'),'fixture','fixture-only',true FROM generate_series(1,102) n;
      INSERT INTO inventory_resources(resource_type,account_id,resource_id,data,captured_at)
      SELECT 'vpc',lpad(n::text,12,'0'),'one','{}',now() FROM generate_series(1,102) n;
      UPDATE inventory_sync_runs SET row_count=102 WHERE resource_type='vpc'`);
    await pool.query(`INSERT INTO inventory_snapshots(account_id,captured_at,resource_type,resource_count)
      SELECT a.account_id,$1,t,CASE WHEN t='vpc' THEN 1 ELSE 0 END
      FROM accounts a CROSS JOIN unnest($2::text[]) t`,
    [recent, requiredTypes.filter(t => !HOST_ONLY_TREND_TYPES.has(t))]);
    const result = await build('infra');
    expect(result).toMatchObject({ published: 100, skipped: 1, accountsTruncated: true, reasons: ['account_limit'] });
    expect((await pool.query('SELECT count(*)::int AS n FROM topology_graph_state')).rows[0].n).toBe(100);
  });
  it('rolls back graph expansion beyond its budget and discloses the retained snapshot', async () => {
    await seed('infra');
    await build('infra');
    await pool.query(`INSERT INTO inventory_resources(resource_type,resource_id,data,captured_at)
      SELECT 'ec2','instance-'||n,jsonb_build_object('security_group_ids',
        (SELECT jsonb_agg('sg-'||n||'-'||m) FROM generate_series(1,500) m)), $1
      FROM generate_series(1,9) n`, [recent]);
    await pool.query("UPDATE inventory_sync_runs SET row_count=9 WHERE resource_type='ec2'");
    expect(await build('infra')).toMatchObject({ retained: 1, reasons: ['graph_limit'] });
    expect(await state('infra')).toMatchObject({ status: 'partial', retainedPrevious: true, graphTruncated: true });
    expect((await pool.query("SELECT id FROM topology_nodes WHERE class='infra'")).rows).toEqual([{ id: 'vpc:one' }]);
  });
  it('bounds relation-lock waits and records a failed collection without sweeping', async () => {
    await seed('infra');
    await build('infra');
    const previous = await state('infra');
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE inventory_resources IN ACCESS EXCLUSIVE MODE');
    try {
      const outcome = await Promise.race([
        build('infra').then(() => 'unexpected success', () => 'failed'),
        new Promise(resolve => setTimeout(() => resolve('waited'), 800)),
      ]);
      expect(outcome).toBe('failed');
      expect(await state('infra')).toMatchObject({ status: 'error', captured_at: previous.captured_at,
        retainedPrevious: true, failureReason: 'source_read_failed' });
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  });
  it.each(['flow', 'infra'])('%s does not renew stale source data with a fresh publication', async cls => {
    await seed(cls, old);
    expect((await build(cls)).nodes).toBeGreaterThan(0);
    const result = await state(cls);
    expect(result).toMatchObject({ status: 'ok', stale: true });
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({
      sourceId: `inventory:${cls === 'flow' ? 'alb' : 'vpc'}`, capturedAtMs: Date.parse(old),
      lastSuccessAtMs: Date.parse(recent), scope: 'aggregate',
    })]));
  });
  it.each(['flow', 'infra'])('%s retains graph and original publication evidence after collection failure', async cls => {
    await seed(cls);
    await build(cls);
    const previous = await state(cls);
    await pool.query(`DELETE FROM inventory_resources;
      UPDATE inventory_sync_runs SET status='failed', finished_at=now();`);
    await build(cls);
    const result = await state(cls);
    expect(result).toMatchObject({ status: 'error', stale: true, retainedPrevious: true,
      captured_at: previous.captured_at, publishedSources: previous.publishedSources });
    expect((await pool.query('SELECT count(*)::int AS n FROM topology_nodes WHERE class=$1', [cls])).rows[0].n).toBeGreaterThan(0);
  });
  it('retains a vanished host infra source until explicit successful-empty evidence arrives', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await pool.query(`INSERT INTO inventory_resources(resource_type, resource_id, data, captured_at) VALUES
      ('vpc','vpc-kept','{}',$1), ('subnet','subnet-lost','{"vpc_id":"vpc-kept"}',$1)`, [recent]);
    await pool.query(`INSERT INTO inventory_sync_runs
      (resource_type, status, started_at, finished_at, last_success_at, row_count, unknown_attribute_count)
      SELECT t, 'succeeded', $1, $1, $1, 1, 0 FROM unnest(ARRAY['vpc','subnet']) t
      ON CONFLICT(resource_type,account_id) DO UPDATE SET row_count=1`, [recent]);
    await build('infra');
    clock.mockImplementation(() => new Date().getTime()); // PostgreSQL publication uses its real clock.
    const previous = await state('infra');
    const nodes = (await pool.query("SELECT * FROM topology_nodes WHERE account_id='self' AND class='infra' ORDER BY id")).rows;
    expect(nodes.map(node => node.id)).toEqual(['subnet:subnet-lost', 'vpc:vpc-kept']);
    expect(previous).toMatchObject({ status: 'ok', stale: false, retainedPrevious: false });
    expect(previous.publishedSources).toHaveLength(INFRA_TYPES.length);

    await pool.query(`DELETE FROM inventory_resources WHERE resource_type='subnet';
      DELETE FROM inventory_sync_runs WHERE resource_type='subnet';`);
    for (const offset of [1_000, 2_000]) {
      clock.mockReturnValue(now + offset);
      await build('infra');
      expect((await pool.query("SELECT * FROM topology_nodes WHERE account_id='self' AND class='infra' ORDER BY id")).rows).toEqual(nodes);
      const result = await state('infra');
      expect(result).toMatchObject({ status: 'unavailable', stale: true, retainedPrevious: true,
        captured_at: previous.captured_at, publishedSources: previous.publishedSources });
      expect(new Date(result.attempted_at).getTime()).toBe(now + offset);
      expect(result.sources).toContainEqual(expect.objectContaining({
        sourceId: 'inventory:subnet', status: 'unavailable', producerStatus: 'unknown', reasons: ['missing_ledger'],
      }));
    }

    await pool.query(`INSERT INTO inventory_sync_runs
      (resource_type, status, started_at, finished_at, last_success_at, row_count, unknown_attribute_count)
      VALUES ('subnet', 'succeeded', $1, $1, $1, 0, 0)`, [recent]);
    clock.mockReturnValue(now + 3_000);
    await build('infra');
    clock.mockImplementation(() => new Date().getTime());
    const confirmed = await state('infra');
    expect(confirmed).toMatchObject({ status: 'ok', stale: false, retainedPrevious: false });
    expect(new Date(confirmed.captured_at).getTime()).toBeGreaterThan(new Date(previous.captured_at).getTime());
    expect(confirmed.publishedSources).toContainEqual(expect.objectContaining({
      sourceId: 'inventory:subnet', status: 'empty', producerStatus: 'succeeded', itemCount: 0, reasons: [],
    }));
    expect((await pool.query("SELECT id FROM topology_nodes WHERE account_id='self' AND class='infra' ORDER BY id")).rows)
      .toEqual([{ id: 'vpc:vpc-kept' }]);
  });
  it.each(['flow', 'infra'])('%s publishes a confirmed successful zero and sweeps the old graph', async cls => {
    await seed(cls);
    await build(cls);
    await pool.query(`DELETE FROM inventory_resources; UPDATE inventory_sync_runs SET row_count=0;`);
    await build(cls);
    expect(await state(cls)).toMatchObject({ status: 'empty', stale: false, retainedPrevious: false });
    expect((await pool.query('SELECT * FROM topology_nodes WHERE class=$1', [cls])).rows).toEqual([]);
  });
  it.each([1, null])('missing rows with producer count %s are not a confirmed successful zero', async count => {
    await seed('infra');
    await build('infra');
    await pool.query('DELETE FROM inventory_resources');
    await pool.query("UPDATE inventory_sync_runs SET row_count=$1 WHERE resource_type='vpc'", [count]);
    await build('infra');
    expect(await state('infra')).toMatchObject({ status: 'partial', stale: true, retainedPrevious: true });
    expect((await pool.query('SELECT * FROM topology_nodes')).rowCount).toBeGreaterThan(0);
  });
  it.each(['partial', 'running', 'missing', 'unknown_attributes'])('does not sweep an empty %s collection', async mode => {
    await seed('infra');
    await build('infra');
    await pool.query('DELETE FROM inventory_resources');
    if (mode === 'missing') await pool.query('DELETE FROM inventory_sync_runs');
    else if (mode === 'unknown_attributes') await pool.query('UPDATE inventory_sync_runs SET unknown_attribute_count=NULL');
    else await pool.query('UPDATE inventory_sync_runs SET status=$1', [mode]);
    await build('infra');
    expect(await state('infra')).toMatchObject({ stale: true, retainedPrevious: true });
    expect((await pool.query('SELECT * FROM topology_nodes')).rowCount).toBeGreaterThan(0);
  });
  it('keeps unknown capture/ledger distinct from successful empty', async () => {
    await pool.query('DELETE FROM inventory_sync_runs');
    await build('flow');
    expect(await state('flow')).toMatchObject({ status: 'unavailable', stale: true });
    expect(await state('infra')).toMatchObject({ status: 'unknown', stale: true });
  });
  it('does not use fresh inventory to certify an old graph', async () => {
    await seed('infra');
    await build('infra');
    await pool.query(`UPDATE topology_graph_state SET captured_at=$1`, [old]);
    expect(await state('infra')).toMatchObject({ stale: true });
  });
  it('retains publication and records a failed write without leaking provider errors', async () => {
    await seed('infra');
    await build('infra');
    const previous = await state('infra');
    await pool.query(`CREATE OR REPLACE FUNCTION reject_graph() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'credential=do-not-expose'; END $$;
      CREATE TRIGGER reject_publication BEFORE INSERT OR UPDATE ON topology_nodes
      FOR EACH ROW EXECUTE FUNCTION reject_graph();`);
    await expect(build('infra')).rejects.toThrow();
    expect(await state('infra')).toMatchObject({ status: 'error', retainedPrevious: true,
      captured_at: previous.captured_at, publishedSources: previous.publishedSources });
    expect(JSON.stringify(await state('infra'))).not.toContain('credential');
  });
  it('older and equal attempts cannot replace graph or state', async () => {
    await seed('infra');
    await build('infra');
    const previous = await state('infra');
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(old));
    await pool.query(`DELETE FROM inventory_resources; UPDATE inventory_sync_runs SET row_count=0`);
    await build('infra');
    vi.restoreAllMocks();
    expect(await state('infra')).toEqual(previous);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [0x696e6672]);
      expect(await writeGraphState(client, 'self', {
        status: 'error', publish: false, attemptedAt: new Date(previous.attempted_at).toISOString(), details: {},
      }, 'infra' as never)).toBe(false);
      await client.query('COMMIT');
    } finally { client.release(); }
    expect((await pool.query('SELECT * FROM topology_nodes')).rowCount).toBeGreaterThan(0);
  });
  it('aggregate API scope is unknown; a vanished member keeps its own last-good graph', async () => {
    await seed('infra', recent, '111122223333');
    await build('infra');
    expect(await state('infra', '__all__')).toMatchObject({ status: 'unknown', stale: true, coverage: 'unknown' });
    await pool.query(`DELETE FROM inventory_resources; UPDATE inventory_sync_runs SET status='failed'`);
    await build('infra');
    expect(await state('infra', '111122223333')).toMatchObject({ status: 'error', retainedPrevious: true });
  });
  it('confirms member emptiness from current participation snapshots, with only the real aggregate ledger', async () => {
    const account = '111122223333';
    await seed('infra', recent, account); await build('infra');
    await pool.query("DELETE FROM inventory_resources WHERE account_id=$1", [account]);
    await pool.query("UPDATE inventory_sync_runs SET row_count=0 WHERE resource_type='vpc'");
    await pool.query("UPDATE inventory_snapshots SET resource_count=0 WHERE account_id=$1 AND resource_type='vpc'", [account]);
    await build('infra');
    expect(await state('infra', account)).toMatchObject({ status: 'empty', retainedPrevious: false });
    expect((await pool.query("SELECT * FROM topology_nodes WHERE account_id=$1", [account])).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM inventory_sync_runs WHERE account_id<>'self'")).rows).toEqual([]);
  });
  it.each(['disabled', 'excluded', 'older_run'])('does not treat %s member snapshots as current participation', async reason => {
    const account = '111122223333';
    await seed('infra', recent, account); await build('infra');
    await pool.query("DELETE FROM inventory_resources WHERE account_id=$1", [account]);
    await pool.query("UPDATE inventory_sync_runs SET row_count=0 WHERE resource_type='vpc'");
    await pool.query("UPDATE inventory_snapshots SET resource_count=0 WHERE account_id=$1 AND resource_type='vpc'", [account]);
    if (reason === 'disabled') await pool.query('UPDATE accounts SET enabled=false WHERE account_id=$1', [account]);
    if (reason === 'excluded') await pool.query('UPDATE accounts SET all_regions=false WHERE account_id=$1', [account]);
    if (reason === 'older_run') await pool.query("UPDATE inventory_sync_runs SET started_at=started_at+interval '1 second', finished_at=finished_at+interval '2 seconds', last_success_at=last_success_at+interval '2 seconds' WHERE resource_type='vpc'");
    await build('infra');
    expect(await state('infra', account)).toMatchObject({ status: 'unavailable', retainedPrevious: true });
    expect((await pool.query("SELECT id FROM topology_nodes WHERE account_id=$1", [account])).rows).toEqual([{ id: 'vpc:one' }]);
  });
  it('discloses a missing infra source even with no rows or prior publication for that type', async () => {
    await seed('infra');
    await pool.query("DELETE FROM inventory_sync_runs WHERE resource_type='neptune_cluster'");
    await build('infra');
    expect((await state('infra')).sources).toContainEqual(expect.objectContaining({
      sourceId: 'inventory:neptune_cluster', status: 'unavailable', reasons: expect.arrayContaining(['missing_ledger']),
    }));
    expect(await state('infra')).toMatchObject({ retainedPrevious: true });
  });
  it('does not infer member successful absence from the host aggregate ledger', async () => {
    await seed('infra', recent, '111122223333');
    await build('infra');
    await pool.query('DELETE FROM inventory_resources');
    await build('infra');
    expect(await state('infra', '111122223333')).toMatchObject({ stale: true, retainedPrevious: true });
    expect((await pool.query("SELECT * FROM topology_nodes WHERE account_id='111122223333'")).rowCount).toBeGreaterThan(0);
  });
  it('retains the graph and reports a source-read failure during ledger schema rollout', async () => {
    await seed('infra');
    await build('infra');
    const previous = await state('infra');
    await pool.query('ALTER TABLE inventory_sync_runs RENAME TO inventory_sync_runs_unavailable');
    try {
      await expect(build('infra')).rejects.toThrow();
      expect(await state('infra')).toMatchObject({ status: 'error', stale: true, retainedPrevious: true,
        failureReason: 'source_read_failed', captured_at: previous.captured_at });
      expect((await pool.query('SELECT * FROM topology_nodes')).rowCount).toBeGreaterThan(0);
    } finally { await pool.query('ALTER TABLE inventory_sync_runs_unavailable RENAME TO inventory_sync_runs'); }
  });
  it('API nodes and state stay on one snapshot across a concurrent publication', async () => {
    await seed('infra');
    await build('infra');
    const previous = await state('infra');
    api.pool = { connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client);
      return { on: client.on.bind(client), removeListener: client.removeListener.bind(client),
        release: client.release.bind(client), query: async (sql: string, args?: unknown[]) => {
        const result = await query(sql, args);
        if (sql.includes('FROM topology_graph_state')) {
          await pool.query('DELETE FROM inventory_resources; UPDATE inventory_sync_runs SET row_count=0');
          await build('infra');
        }
        return result;
      } };
    } };
    const body = await (await GET(new Request('http://localhost/api/graph?class=infra'))).json();
    expect(body.collection.captured_at).toBe(new Date(previous.captured_at).toISOString());
    expect(body.nodes.length).toBeGreaterThan(0);
    expect((await pool.query('SELECT * FROM topology_nodes')).rows).toEqual([]);
  });
  it('API can read retained nodes before the state migration without an aborted transaction', async () => {
    await seed('infra');
    await build('infra');
    await pool.query('ALTER TABLE topology_graph_state RENAME TO topology_graph_state_unavailable');
    try {
      const response = await GET(new Request('http://localhost/api/graph?class=infra'));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.collection.status).toBe('unknown');
      expect(body.nodes.length).toBeGreaterThan(0);
    } finally { await pool.query('ALTER TABLE topology_graph_state_unavailable RENAME TO topology_graph_state'); }
  });
});
