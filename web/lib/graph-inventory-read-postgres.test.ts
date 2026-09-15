import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { inventoryAccounts, inventoryAttempt, inventoryCounts, inventorySnapshot, inventoryTypesForAccount } from './graph-inventory-read';
import { graphTransaction, graphReadTransaction, GraphReadBusy, GraphReadDeadline } from './graph-transaction';
import { HOST_ONLY_TREND_TYPES } from './trend-utils';
import { buildFlowGraph } from './flow-topology';

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
    expect(socket?.startsWith('/')).toBe(true);
    expect(statSync(resolve(socket!, '.s.PGSQL.5432')).isSocket()).toBe(true);
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
    expect((await pool.query('SHOW server_version')).rows[0].server_version).toMatch(/^17\./);
    if ((await pool.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0]?.marker !== 'awsops-disposable-inventory-read-test')
      throw new Error('Refusing fixture without disposable target database marker');
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE SCHEMA IF NOT EXISTS sql_reader;
      DO $$ BEGIN CREATE ROLE awsops_web; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE awsops_worker; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE awsops_sql_reader LOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;`);
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
  async function seed(count = 0, unknown: number | null = 0, selfCount = count) {
    const point = at();
    await pool.query(`INSERT INTO inventory_sync_runs(resource_type,status,started_at,finished_at,last_success_at,row_count,unknown_attribute_count)
      VALUES ('vpc','succeeded',$1,$1,$1,$2,$3)`, [point, count, unknown]);
    await pool.query("INSERT INTO inventory_snapshots(account_id,resource_type,resource_count,captured_at) VALUES ('self','vpc',$1,$2)", [selfCount, point]);
    return point;
  }
  it('returns affirmative self-empty evidence only with reconciled succeeded counts', async () => {
    await seed();
    const snapshot = await inventorySnapshot(pool, 'infra', 'self', ['vpc']);
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.aggregateCounts.get('vpc')).toBe(0);
    expect(inventoryAttempt(snapshot, ['vpc'], 'infra', 'self', at())).toMatchObject({ publish: true, status: 'empty',
      details: { sources: [{ itemCount: 0, scope: 'account', producerStatus: 'succeeded' }] } });
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
  it('cannot omit a failed queried type from the attempt evidence', async () => {
    await seed();
    await pool.query("INSERT INTO inventory_sync_runs(resource_type,status) VALUES ('ec2','failed')");
    const snapshot = await inventorySnapshot(pool, 'infra', 'self', ['vpc', 'ec2']);
    const attempt = inventoryAttempt(snapshot, ['vpc'], 'infra', 'self', at());
    expect(attempt.publish).toBe(false);
    expect(attempt.details.sources).toContainEqual(expect.objectContaining({
      sourceId: 'inventory:ec2', producerStatus: 'failed', reasons: ['source_failed', 'unknown_attributes'],
    }));
  });
  it('account discovery alone never supplies missing member participation', async () => {
    await seed();
    await pool.query("INSERT INTO accounts(account_id,alias,external_id,enabled,all_regions) VALUES ('000000000001','fixture','fixture',true,true)");
    expect((await inventoryAccounts(pool, 'infra', ['vpc']))?.accounts).toContain('000000000001');
    const snapshot = await inventorySnapshot(pool, 'infra', '000000000001', ['vpc']);
    expect(inventoryAttempt(snapshot, ['vpc'], 'infra', '000000000001', at())).toMatchObject({ publish: false,
      details: { sources: [{ reasons: expect.arrayContaining(['unknown_account_coverage']) }] } });
  });
  it('preserves all consumed listener/route label fields through the real flow builder', async () => {
    const rows = [
      ['alb', 'lb', { arn: 'arn:lb', dns_name: 'lb.example.test' }],
      ['target_group', 'tg', { load_balancer_arns: ['arn:lb'], target_type: 'ip' }],
      ['alb_listener_rule', 'rule', { load_balancer_arn: 'arn:lb', port: 443,
        conditions: [{ Field: 'path-pattern', Values: ['/orders'] }], actions: [{ TargetGroupArn: 'tg' }], is_default: false }],
      ['alb_listener_rule', 'default', { load_balancer_arn: 'arn:lb', port: 8443, conditions: [], actions: [{ TargetGroupArn: 'tg' }], is_default: true }],
      ['apigatewayv2_api', 'api', { name: 'api' }],
      ['apigatewayv2_integration', 'int', { api_id: 'api', integration_uri: 'arn:aws:lambda:us-east-1:1:function:fixture' }],
      ['apigatewayv2_route', 'route', { api_id: 'api', target: 'integrations/int', route_key: 'GET /orders' }],
    ] as const;
    for (const [type, id, data] of rows) await pool.query(`INSERT INTO inventory_resources(resource_type,resource_id,region,data,captured_at)
      VALUES ($1,$2,'fixture',$3::jsonb,$4)`, [type, id, JSON.stringify(data), at()]);
    const snapshot = await inventorySnapshot(pool, 'flow', 'self', [...new Set(rows.map(row => row[0]))]);
    const items = (type: string) => snapshot.rows.filter(row => row.resource_type === type).map(row => ({ ...row.data, resource_id: row.resource_id }));
    const graph = buildFlowGraph({ alb: items('alb'), tg: items('target_group'), alb_listener_rule: items('alb_listener_rule'),
      apigatewayv2_api: items('apigatewayv2_api'), apigatewayv2_integration: items('apigatewayv2_integration'), apigatewayv2_route: items('apigatewayv2_route') });
    expect(graph.edges.find(edge => edge.source === 'alb:arn:lb' && edge.target === 'tg:tg')?.label).toMatch(/default :8443/);
    expect(graph.edges.find(edge => edge.source === 'alb:arn:lb' && edge.target === 'tg:tg')?.label).toMatch(/\/orders :443/);
    expect(graph.edges.find(edge => edge.source === 'apigw:api')?.label).toBe('GET /orders');
  });
  it('keeps 400 target identities/ports/health states after dropping unused diagnostic payload', async () => {
    const targets = Array.from({ length: 400 }, (_, i) => ({ Target: { Id: `2001:db8::${i+1}`, Port: 8080, AvailabilityZone: 'unused' },
      TargetHealth: { State: i === 399 ? 'unhealthy' : 'healthy', Description: 'unused'.repeat(1000) } }));
    await pool.query(`INSERT INTO inventory_resources(resource_type,resource_id,region,data,captured_at)
      VALUES ('target_group','tg','fixture',$1::jsonb,$2)`, [JSON.stringify({ target_type: 'ip', target_health_descriptions: targets }), at()]);
    const snapshot = await inventorySnapshot(pool, 'flow', 'self', ['target_group']);
    expect(snapshot.truncated).toBe(false);
    const row = snapshot.rows[0];
    expect((row.data as { target_health_descriptions: unknown[] }).target_health_descriptions).toHaveLength(400);
    expect(JSON.stringify(row.data)).not.toContain('Description');
    const graph = buildFlowGraph({ ownershipRead: { configurationOnly: true }, tg: [{ ...row.data, resource_id: row.resource_id, region: 'fixture' }] });
    expect(graph.nodes.find(node => node.kind === 'target')?.meta).toMatchObject({ count: 400, health: 'unhealthy' });
    expect(Object.values(graph.targetMembers)[0]).toHaveLength(400);
  });
  it('does not charge a withheld row against later rows and localizes the incomplete source', async () => {
    await pool.query(`INSERT INTO inventory_resources(resource_type,resource_id,region,data,captured_at) VALUES
      ('ec2','large','fixture',jsonb_build_object('name',repeat('x',9000000)),$1),
      ('vpc','small','fixture','{"vpc_id":"vpc-fixture"}',$1)`, [at()]);
    const snapshot = await inventorySnapshot(pool, 'infra', 'self', ['ec2','vpc']);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.rows.find(row => row.resource_type === 'vpc')?.data).toEqual({ vpc_id: 'vpc-fixture' });
    expect(snapshot.truncatedTypes).toEqual(['ec2']);
    expect(inventoryAttempt(snapshot, ['ec2','vpc'], 'infra', 'self', at()).publish).toBe(false);
  });
  it('reads 5000 ordinary small records but retains at the explicit 8192-row boundary', async () => {
    await seed(5000);
    await pool.query(`INSERT INTO inventory_resources(resource_type,resource_id,region,data,captured_at)
      SELECT 'vpc','vpc-'||n,'fixture','{}',$1 FROM generate_series(1,5000)n`, [at()]);
    expect((await inventorySnapshot(pool, 'infra', 'self', ['vpc'])).truncated).toBe(false);
    await pool.query(`INSERT INTO inventory_resources(resource_type,resource_id,region,data,captured_at)
      SELECT 'vpc','vpc-'||n,'fixture','{}',$1 FROM generate_series(5001,8193)n`, [at()]);
    await pool.query("UPDATE inventory_sync_runs SET row_count=8193 WHERE resource_type='vpc'");
    await pool.query("UPDATE inventory_snapshots SET resource_count=8193 WHERE account_id='self' AND resource_type='vpc'");
    const bounded = await inventorySnapshot(pool, 'infra', 'self', ['vpc']);
    expect(bounded.rows).toHaveLength(8193);
    expect(bounded.truncated).toBe(true);
    expect(inventoryAttempt(bounded, ['vpc'], 'infra', 'self', at()).publish).toBe(false);
  });
  it('keeps flow detail fields consumed from meta.row', async () => {
    const detail = { subnet_id: 'subnet-fixture', subnets: ['subnet-fixture'], availability_zones: ['zone-fixture'],
      security_group_ids: ['sg-fixture'], vpc_security_group_ids: ['sg-fixture'], group_name: 'group-fixture', title: 'fixture-title' };
    await pool.query(`INSERT INTO inventory_resources(resource_type,resource_id,region,data,captured_at)
      VALUES ('target_group','tg','fixture',$1::jsonb,$2)`, [JSON.stringify({ ...detail, target_type: 'ip' }), at()]);
    const snapshot = await inventorySnapshot(pool, 'flow', 'self', ['target_group']);
    const row = snapshot.rows[0];
    const graph = buildFlowGraph({ tg: [{ ...row.data, resource_id: row.resource_id }] });
    expect(graph.nodes.find(node => node.kind === 'tg')?.meta.row).toMatchObject(detail);
  });
  it.each(['running','partial'])('a member %s sync reports collection incompleteness before coverage uncertainty', async status => {
    const point = await seed();
    await pool.query("INSERT INTO accounts(account_id,alias,external_id,all_regions) VALUES ('000000000001','fixture','fixture',true)");
    await pool.query("INSERT INTO inventory_snapshots(account_id,resource_type,resource_count,captured_at) VALUES ('000000000001','vpc',0,$1)", [point]);
    await pool.query("UPDATE inventory_sync_runs SET status=$1 WHERE resource_type='vpc'", [status]);
    const snapshot = await inventorySnapshot(pool, 'infra', '000000000001', ['vpc']);
    const result = inventoryAttempt(snapshot, ['vpc'], 'infra', '000000000001', at());
    expect(result).toMatchObject({ publish: false, status: 'partial', details: { sources: [{ scope: 'account', reasons: ['incomplete_collection'] }] } });
  });
  it('host empty is account-scoped when the nonzero aggregate lives in a member', async () => {
    const point = await seed(1, 0, 0);
    await pool.query(`INSERT INTO inventory_resources(resource_type,account_id,resource_id,region,data,captured_at)
      VALUES ('vpc','000000000001','member-vpc','fixture','{}',$1)`, [point]);
    const snapshot = await inventorySnapshot(pool, 'infra', 'self', ['vpc']);
    expect(inventoryAttempt(snapshot, ['vpc'], 'infra', 'self', at())).toMatchObject({ publish: true, status: 'empty',
      details: { sources: [{ scope: 'account', itemCount: 0 }] } });
    await pool.query("DELETE FROM inventory_snapshots WHERE account_id='self'");
    const unproven = await inventorySnapshot(pool, 'infra', 'self', ['vpc']);
    expect(inventoryAttempt(unproven, ['vpc'], 'infra', 'self', at()).publish).toBe(false);
  });
  it('discloses the discovery cap and advances once the caller records actual attempts', async () => {
    await pool.query(`INSERT INTO accounts(account_id,alias,external_id,all_regions)
      SELECT lpad(n::text,12,'0'),'fixture','fixture',true FROM generate_series(1,205)n`);
    const first = await inventoryAccounts(pool, 'infra', ['vpc']);
    expect(first?.accounts).toHaveLength(100);
    expect(first?.truncated).toBe(true);
    await pool.query(`INSERT INTO topology_graph_state(account_id,class,status,attempted_at,details)
      SELECT account,'infra','unavailable',now(),'{}'::jsonb FROM unnest($1::text[]) account`, [first!.accounts]);
    const second = await inventoryAccounts(pool, 'infra', ['vpc']);
    expect(second?.accounts).toHaveLength(100);
    expect(second?.accounts[0]).toBe('self');
    expect(second?.accounts.some(account => account !== 'self' && first!.accounts.includes(account))).toBe(false);
    expect(second?.truncated).toBe(true);
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
  it('expires background checkout but holds admission until the late client is returned', async () => {
    const holders = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
    const failures: unknown[] = []; let called = false;
    const work = [0, 1].map(() => graphTransaction(pool, true, async () => { called = true; })
      .catch(error => { failures.push(error); }));
    try {
      await new Promise(resolve => setTimeout(resolve, 2200));
      expect(failures).toHaveLength(2);
      expect(failures.every(error => error instanceof GraphReadDeadline && error.phase === 'acquire')).toBe(true);
      expect(called).toBe(false);
      await expect(graphReadTransaction(pool, client => client.query('SELECT 1'))).rejects.toBeInstanceOf(GraphReadBusy);
    } finally { holders.forEach(client => client.release()); await Promise.all(work); }
    await new Promise(resolve => setImmediate(resolve));
    expect(called).toBe(false);
    expect((await graphReadTransaction(pool, client => client.query('SELECT 42 AS value'))).rows[0].value).toBe(42);
    expect(pool.waitingCount).toBe(0);
  });
});
