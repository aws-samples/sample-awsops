import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { inventoryAccounts, inventoryAttempt, inventoryCounts, inventorySnapshot, inventoryTypesForAccount } from './graph-inventory-read';
import { graphTransaction, graphReadTransaction, GraphReadBusy } from './graph-transaction';
import { HOST_ONLY_TREND_TYPES } from './trend-utils';

it('uses the existing SDK host-only type contract for member reads', () => {
  const types = ['vpc', ...HOST_ONLY_TREND_TYPES];
  expect(inventoryTypesForAccount(types, 'self')).toEqual(types);
  expect(inventoryTypesForAccount(types, '000000000001')).toEqual(['vpc']);
});

const socket = process.env.GRAPH_TEST_POSTGRES_SOCKET;
describe.skipIf(!socket)('bounded inventory reads on disposable PostgreSQL17', () => {
  let pool: Pool;
  const at = () => new Date(Date.now() - 1000).toISOString();
  beforeAll(async () => {
    const admin = new Pool({ host: socket, user: 'postgres', database: 'awsops' });
    try {
      expect((await admin.query('SHOW server_version')).rows[0].server_version).toMatch(/^17\./);
      if ((await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0]?.marker !== 'awsops-disposable-graph-test')
        throw new Error('Refusing fixture without disposable admin database marker');
      if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='awsops_inventory_read_test'")).rowCount) {
        await admin.query('CREATE DATABASE awsops_inventory_read_test');
        await admin.query("COMMENT ON DATABASE awsops_inventory_read_test IS 'awsops-disposable-inventory-read-test'");
      }
    } finally { await admin.end(); }
    pool = new Pool({ host: socket, user: 'postgres', database: 'awsops_inventory_read_test', max: 3 });
    if ((await pool.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0]?.marker !== 'awsops-disposable-inventory-read-test')
      throw new Error('Refusing fixture without disposable target database marker');
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE SCHEMA IF NOT EXISTS sql_reader;
      DO $$ BEGIN CREATE ROLE awsops_web; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE awsops_worker; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE awsops_sql_reader; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    const schema = readFileSync(resolve('../terraform/foundation/data/schema.sql'), 'utf8');
    for (const table of ['inventory_resources', 'inventory_sync_runs', 'inventory_snapshots', 'account_regions'])
      await pool.query(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0]);
    const migrations = resolve('../terraform/foundation/migrations');
    for (const suffix of ['_accounts.sql', '_accounts_all_regions.sql', '_topology_graph.sql', '_topology_class.sql',
      '_inventory_sync_freshness.sql', '_inventory_sync_unknown_attrs.sql', '_topology_graph_collection_state.sql'])
      await pool.query(readFileSync(resolve(migrations, readdirSync(migrations).find(f => f.endsWith(suffix))!), 'utf8'));
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    await pool.query('TRUNCATE inventory_resources, inventory_sync_runs, inventory_snapshots, account_regions, accounts, topology_nodes, topology_edges, topology_graph_state');
  });
  async function seed(count = 0, unknown: number | null = 0) {
    const point = at();
    await pool.query(`INSERT INTO inventory_sync_runs(resource_type,status,started_at,finished_at,last_success_at,row_count,unknown_attribute_count)
      VALUES ('vpc','succeeded',$1,$1,$1,$2,$3)`, [point, count, unknown]);
    return point;
  }
  it('returns affirmative self-empty evidence only with reconciled succeeded counts', async () => {
    await seed();
    const snapshot = await inventorySnapshot(pool, 'infra', 'self', ['vpc']);
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.aggregateCounts.get('vpc')).toBe(0);
    expect(inventoryAttempt(snapshot, ['vpc'], 'infra', 'self', at())).toMatchObject({ publish: true, status: 'empty',
      details: { sources: [{ itemCount: 0, scope: 'aggregate', producerStatus: 'succeeded' }] } });
  });
  it.each([null, 1])('unknown attribute completeness %s cannot prove empty', async unknown => {
    await seed(0, unknown);
    const snapshot = await inventorySnapshot(pool, 'infra', 'self', ['vpc']);
    expect(inventoryAttempt(snapshot, ['vpc'], 'infra', 'self', at())).toMatchObject({ publish: false, status: 'partial' });
  });
  it('projects consumed fields before byte accounting and excludes unrelated provider data', async () => {
    const point = await seed(1);
    await pool.query(`INSERT INTO inventory_resources(resource_type,resource_id,region,data,captured_at)
      VALUES ('vpc','one','fixture',$1::jsonb,$2)`, [JSON.stringify({ vpc_id: 'vpc-fixture', private_payload: 'DO_NOT_EXPORT'.repeat(10000) }), point]);
    const snapshot = await inventorySnapshot(pool, 'infra', 'self', ['vpc']);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.rows[0].data).toEqual({ vpc_id: 'vpc-fixture' });
    expect(JSON.stringify(snapshot)).not.toContain('DO_NOT_EXPORT');
    expect(inventoryAttempt(snapshot, ['vpc'], 'infra', 'self', at()).publish).toBe(true);
  });
  it('oversized consumed data is withheld and cannot become empty proof', async () => {
    const point = await seed(1);
    await pool.query(`INSERT INTO inventory_resources(resource_type,resource_id,region,data,captured_at)
      VALUES ('vpc','one','fixture',$1::jsonb,$2)`, [JSON.stringify({ name: 'x'.repeat(70000) }), point]);
    const snapshot = await inventorySnapshot(pool, 'infra', 'self', ['vpc']);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.rows[0]).toMatchObject({ resource_id: '', region: '', data: null });
    expect(inventoryAttempt(snapshot, ['vpc'], 'infra', 'self', at())).toMatchObject({ publish: false,
      details: { sources: [{ itemCount: null, reasons: expect.arrayContaining(['payload_truncated']) }] } });
  });
  it('a changed ledger version invalidates an earlier count proof', async () => {
    const point = await seed(1);
    await pool.query("INSERT INTO inventory_resources(resource_type,resource_id,region,data,captured_at) VALUES ('vpc','one','fixture','{}',$1)", [point]);
    const proof = await inventoryCounts(pool, ['vpc']);
    await pool.query("UPDATE inventory_sync_runs SET row_count=2 WHERE resource_type='vpc'");
    const snapshot = await inventorySnapshot(pool, 'infra', 'self', ['vpc'], proof);
    expect(snapshot.aggregateCounts.has('vpc')).toBe(false);
    expect(inventoryAttempt(snapshot, ['vpc'], 'infra', 'self', at()).publish).toBe(false);
  });
  it('account discovery alone never supplies missing member participation', async () => {
    await seed();
    await pool.query("INSERT INTO accounts(account_id,alias,external_id,enabled,all_regions) VALUES ('000000000001','fixture','fixture',true,true)");
    expect(await inventoryAccounts(pool, 'infra', ['vpc'])).toContain('000000000001');
    const snapshot = await inventorySnapshot(pool, 'infra', '000000000001', ['vpc']);
    expect(inventoryAttempt(snapshot, ['vpc'], 'infra', '000000000001', at())).toMatchObject({ publish: false,
      details: { sources: [{ reasons: expect.arrayContaining(['unknown_account_coverage']) }] } });
  });
  it('read/background helpers share two admissions and leave an ordinary pool slot free', async () => {
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    let admitted = 0; let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const work = () => graphTransaction(pool, true, async () => { if (++admitted === 2) entered(); await hold; });
    const tasks = [work(), work()];
    try {
      await ready;
      await expect(graphReadTransaction(pool, client => client.query('SELECT 1'))).rejects.toBeInstanceOf(GraphReadBusy);
      expect((await pool.query('SELECT 42 AS value')).rows[0].value).toBe(42);
      expect(pool.waitingCount).toBe(0);
    } finally { release(); await Promise.all(tasks); }
    await expect(graphReadTransaction(pool, client => client.query('SELECT 1'))).resolves.toBeTruthy();
  });
});
