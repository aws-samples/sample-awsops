import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyRuntimeSmoke, validateRuntimeSmokeConfig, readRuntimeSmokeConfig } from './runtime-smoke.mjs';
import { authenticatedSmoke } from './authenticated-smoke.mjs';

const account = '123456789012';
const start = '2026-09-13T14:00:00.000Z';
const config = { schemaVersion: 1, mode: 'verify', expectedAccountId: account,
  expectedCloudfrontId: 'E123EXAMPLE', expectedQueuedTypes: ['cloudfront', 'ec2'], collectionStartedAt: start };
const jobIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
function readyReply(options, ageMinutes = 0) {
  return { httpStatus: 200, body: {
    schemaVersion: 1, nonce: options.body.nonce, accountId: account, status: 'ready', reason: 'ok',
    webIdentity: true, parameters: { runtime_arn: 'ready', interpreter_id: 'ready', memory_id: 'ready' },
    agent: { schemaVersion: 1, mode: 'deployment_readiness', nonce: options.body.nonce, accountId: account,
      status: 'ready', reason: 'ok', checks: { identity: true, inventorySummary: true,
        inventoryQuery: true, knownResource: true, freshInventory: true, model: true },
      inventory: { count: 1, ageMinutes } },
  } };
}
function fixture(overrides = {}, runtimeOptions = {}) {
  let now = Date.parse(start) + 1000;
  const calls = [];
  const polls = new Map();
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (overrides[path]) return overrides[path](options);
    if (path === '/api/accounts') return { accounts: [{ accountId: account, isHost: true, enabled: true }] };
    if (path.startsWith('/api/inventory/summary')) return { collection: { configured: true, readOk: true,
      runs: ['cloudfront', 'ec2'].map(type => ({ type, accountId: 'self', status: 'succeeded', row_count: 0,
        last_success_at: start, started_at: start, unknown_attribute_count: 0, unknown_attributes: false })) } };
    if (path.startsWith('/api/inventory/cloudfront')) return { rows: [{
      resource_id: config.expectedCloudfrontId, account_id: 'self', captured_at: start,
      data: { id: config.expectedCloudfrontId },
    }] };
    if (path === '/api/deployment/readiness') return readyReply(options, overrides.ageMinutes ?? 0);
    if (path === '/api/jobs') return { job_id: jobIds[options.body.type === 'noop' ? 0 : 1], status: 'queued' };
    if (path.startsWith('/api/jobs/')) {
      const index = jobIds.indexOf(path.split('/').at(-1));
      const count = (polls.get(path) || 0) + 1; polls.set(path, count);
      return { job_id: jobIds[index], type: index === 0 ? 'noop' : 'noop-heavy',
        runtime: index === 0 ? 'lambda' : 'fargate', status: count < 2 ? 'running' : 'succeeded',
        dry_run: false, result: { ok: true } };
    }
    throw new Error('unexpected request');
  };
  return { calls, now: () => now, advance: ms => { now += ms; }, run: (c = config) => verifyRuntimeSmoke(c, request, {
    now: () => now, wait: async ms => { now += ms; },
    ...runtimeOptions,
  }) };
}
test('full readiness requires fresh collection, known record, runtime and terminal success of both workers', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { status: 'ok', mode: 'verify', collected_types: 2, workers: 2 });
  assert.equal(f.calls.filter(c => c.path.startsWith('/api/jobs/')).length, 4);
  assert.deepEqual(f.calls.filter(c => c.path === '/api/jobs').map(c => c.options.body.type), ['noop', 'noop-heavy']);
});
test('prepare is distinctly host registry only', async () => {
  const f = fixture();
  assert.deepEqual(await f.run({ schemaVersion: 1, mode: 'prepare', expectedAccountId: account }),
    { status: 'ok', mode: 'prepare' });
  assert.equal(f.calls.length, 1);
});
test('refuses absent/foreign/disabled hosts and host-only enabled foreign rows', async () => {
  for (const accounts of [[], [{ accountId: account, isHost: false, enabled: true }],
    [{ accountId: account, isHost: true, enabled: false }],
    [{ accountId: account, isHost: true, enabled: true }, { accountId: '999999999999', enabled: true }]]) {
    await assert.rejects(fixture({ '/api/accounts': () => ({ accounts }) }).run({ ...config, hostOnly: true }), /host_registry/);
  }
});
test('optional hostOnly defaults false and regular multi-account registries remain valid', async () => {
  const accounts = [{ accountId: account, isHost: true, enabled: true },
    { accountId: '999999999999', isHost: false, enabled: true }];
  for (const optional of [{}, { hostOnly: false }]) {
    assert.equal((await fixture({ '/api/accounts': () => ({ accounts }) }).run({
      schemaVersion: 1, mode: 'prepare', expectedAccountId: account, ...optional,
    })).status, 'ok');
  }
  assert.throws(() => validateRuntimeSmokeConfig({ ...config, hostOnly: 'true' }, Date.parse(start) + 1000), /configuration/);
});
test('CloudFront requests have small pages and a bounded budget only for the inventory leg', async () => {
  const f = fixture();
  await f.run();
  const page = f.calls.find(c => c.path.startsWith('/api/inventory/cloudfront?'));
  assert.match(page.path, /limit=5&offset=0$/);
  assert.equal(page.options.maxResponseBytes, 2 * 1024 * 1024);
  assert.ok(f.calls.filter(c => !c.path.startsWith('/api/inventory/cloudfront?'))
    .every(c => c.options.maxResponseBytes === undefined));
});
test('a 503 retains only bound fixed failure codes and sanitized parameter states', async () => {
  const f = fixture({ '/api/deployment/readiness': options => ({
    httpStatus: 503, body: { schemaVersion: 1, nonce: options.body.nonce, accountId: account,
      status: 'not_ready', reason: 'parameters_not_ready', arbitrary: 'PRIVATE',
      parameters: { runtime_arn: 'denied', interpreter_id: 'ready', memory_id: 'ready' } },
  }) });
  await assert.rejects(f.run(), error => /runtime_parameters_not_ready.*runtime_arn=denied/.test(error.message)
    && !error.message.includes('PRIVATE'));
});
test('HTTP 503 cannot become success even if its body says ready', async () => {
  await assert.rejects(fixture({ '/api/deployment/readiness': () => ({
    httpStatus: 503, body: { status: 'ready', reason: 'ok' },
  }) }).run(), /runtime_protocol/);
});
test('runtime age validation permits the producer range without imposing a new freshness threshold', async () => {
  for (const ageMinutes of [16, 120, 1440]) assert.equal((await fixture({ ageMinutes }).run()).status, 'ok');
  await assert.rejects(fixture({ ageMinutes: 1441 }).run(), /runtime_protocol/);
});
test('missing/partial/stale/unknown collection cannot pass or be treated as zero resources', async () => {
  for (const collection of [{ configured: false, readOk: true, runs: [] },
    { configured: true, readOk: false, runs: [] }, { configured: true, readOk: true, runs: [] }]) {
    await assert.rejects(fixture({ '/api/inventory/summary?accounts=self&view=collection': () => ({ collection }) }).run(), /collection/);
  }
  for (const change of [{ status: 'partial' }, { status: 'failed' }, { status: 'running' },
    { last_success_at: '2020-01-01T00:00:00Z' }, { unknown_attribute_count: null, unknown_attributes: null },
    { unknown_attribute_count: 1, unknown_attributes: true }]) {
    const runs = ['cloudfront', 'ec2'].map(type => ({ type, accountId: 'self', status: 'succeeded',
      row_count: 0, started_at: start, last_success_at: start, unknown_attribute_count: 0, unknown_attributes: false, ...change }));
    await assert.rejects(fixture({
      '/api/inventory/summary?accounts=self&view=collection': () => ({ collection: { configured: true, readOk: true, runs } }),
    }).run(), Object.hasOwn(change, 'unknown_attribute_count') ? /inventory_incomplete/
      : change.status === 'partial' ? /collection_partial/
        : change.status === 'failed' ? /collection_failed/ : /collection_timeout/);
  }
});
test('missing ledger is distinct and a later incomplete type cannot hide behind an earlier running type', async () => {
  const path = '/api/inventory/summary?accounts=self&view=collection';
  await assert.rejects(fixture({ [path]: () => ({
    collection: { configured: true, readOk: true, runs: [] },
  }) }).run(), /collection_missing/);
  const runs = [
    { type: 'cloudfront', accountId: 'self', status: 'running', started_at: start },
    { type: 'ec2', accountId: 'self', status: 'succeeded', started_at: start,
      last_success_at: start, row_count: 1, unknown_attribute_count: 1, unknown_attributes: true },
  ];
  await assert.rejects(fixture({ [path]: () => ({
    collection: { configured: true, readOk: true, runs },
  }) }).run(), /inventory_incomplete/);
});
test('a 500-row sample without the known ID is unverified, not proof of absence', async () => {
  const responses = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [
    `/api/inventory/cloudfront?accounts=self&limit=5&offset=${i * 5}`,
    () => ({ rows: Array.from({ length: 5 }, (_, j) => ({
      account_id: 'self', resource_id: `E${i * 5 + j}`, captured_at: start, data: { id: `E${i * 5 + j}` },
    })) }),
  ]));
  await assert.rejects(fixture(responses).run(), /inventory_known_resource_unverified/);
});
test('queued delivery and wrong runtime never count as terminal worker proof', async () => {
  for (const body of [{ status: 'failed' }, { status: 'queued' },
    { status: 'succeeded', type: 'noop', runtime: 'fargate', dry_run: false, result: { ok: true } }]) {
    await assert.rejects(fixture({ [`/api/jobs/${jobIds[0]}`]: () => body }).run(), /worker/);
  }
});
test('rejects fake readiness prose and missing nonce binding', async () => {
  await assert.rejects(fixture({ '/api/deployment/readiness': () => ({ status: 'ready', role: 'ready' }) }).run(), /runtime/);
});
test('configuration validates bounded typed inputs and disallows stale/future collection starts', () => {
  const now = Date.parse(start) + 1000;
  assert.deepEqual(validateRuntimeSmokeConfig(config, now), config);
  for (const invalid of [{ ...config, expectedAccountId: 'self' }, { ...config, mode: 'skip' },
    { ...config, expectedQueuedTypes: [] }, { ...config, expectedQueuedTypes: ['ec2', 'ec2'] },
    { ...config, collectionStartedAt: '2020-01-01T00:00:00Z' }, { ...config, extra: 'secret' }]) {
    assert.throws(() => validateRuntimeSmokeConfig(invalid, now), /configuration/);
  }
});
test('private runtime configuration refuses symlinks, public modes and oversized files', t => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-smoke-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  chmodSync(dir, 0o700);
  const file = join(dir, 'runtime.json'), credentials = join(dir, 'credentials.json');
  const prepare = { schemaVersion: 1, mode: 'prepare', expectedAccountId: account };
  writeFileSync(file, JSON.stringify(prepare), { mode: 0o600 });
  assert.deepEqual(readRuntimeSmokeConfig(file, credentials), prepare);
  chmodSync(file, 0o644);
  assert.throws(() => readRuntimeSmokeConfig(file, credentials), /configuration_file/);
  chmodSync(file, 0o600); writeFileSync(file, 'x'.repeat(17000));
  assert.throws(() => readRuntimeSmokeConfig(file, credentials), /configuration_file/);
  const link = join(dir, 'link.json'); symlinkSync(file, link);
  assert.throws(() => readRuntimeSmokeConfig(link, credentials), /configuration_file/);
  assert.throws(() => readRuntimeSmokeConfig(file, join(dir, 'nested', 'credentials.json')), /configuration_file/);
});
for (const [inventoryBytes, releaseMode] of [[75 * 1024, false], [2 * 1024 * 1024 + 1, false], [75 * 1024, true]]) test(
  `authenticated full flow bounds inventory (${inventoryBytes} bytes, release=${releaseMode})`, { timeout: 20_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-smoke-curl-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const runtimeConfig = { ...config, collectionStartedAt: now, ...(releaseMode ? { collectionMode: 'release' } : {}) };
  const responses = new Set(), requests = [];
  const password = 'fixture-private-password', token = 'fixture-private-token';
  let jobIndex = 0;
  const runCurl = async (file, args, options) => {
    const path = new URL(args.at(-1)).pathname;
    requests.push(path);
    const output = args[args.indexOf('--output') + 1];
    assert.equal(args[args.indexOf('--max-filesize') + 1],
      String(path === '/api/inventory/cloudfront' ? 2 * 1024 * 1024 : 64 * 1024));
    assert.ok(!responses.has(output)); responses.add(output);
    assert.equal(statSync(dirname(output)).mode & 0o777, 0o700);
    for (const filename of readdirSync(dirname(output))) assert.equal(statSync(join(dirname(output), filename)).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify({ args, env: options.env }).includes(password));
    assert.ok(!JSON.stringify({ args, env: options.env }).includes(token));
    const body = args.includes('--data-binary') ? JSON.parse(readFileSync(args[args.indexOf('--data-binary') + 1].slice(1), 'utf8')) : {};
    let result, status = '200';
    if (path === '/api/auth/login') {
      assert.equal(body.password, password);
      writeFileSync(args[args.indexOf('--cookie-jar') + 1],
        `#HttpOnly_dev.example.com\tFALSE\t/\tTRUE\t0\tawsops_token\t${token}\n`);
      result = { ok: true };
    } else if (path === '/api/db') result = { status: 'ok', public_tables: 42 };
    else if (path === '/api/accounts') result = { accounts: [{ accountId: account, isHost: true, enabled: true }] };
    else if (path === '/api/inventory/summary') {
      result = { collection: { configured: true, readOk: true,
      runs: ['ec2', 'cloudfront'].map(type => ({ type, accountId: 'self', status: 'succeeded', row_count: 1,
        started_at: now,
        last_success_at: now, unknown_attribute_count: 0, unknown_attributes: false })) } };
    }
    else if (path === '/api/inventory/cloudfront') result = { rows: [{ resource_id: config.expectedCloudfrontId,
      account_id: 'self', captured_at: now, data: { id: config.expectedCloudfrontId, cache_behaviors: 'x'.repeat(inventoryBytes) } }] };
    else if (path === '/api/deployment/readiness') result = { schemaVersion: 1, nonce: body.nonce, accountId: account,
      status: 'ready', reason: 'ok', webIdentity: true,
      parameters: { runtime_arn: 'ready', interpreter_id: 'ready', memory_id: 'ready' },
      agent: { schemaVersion: 1, mode: 'deployment_readiness', nonce: body.nonce, accountId: account,
        status: 'ready', reason: 'ok', checks: { identity: true, inventorySummary: true, inventoryQuery: true,
          knownResource: true, freshInventory: true, model: true }, inventory: { count: 1, ageMinutes: 0 } } };
    else if (path === '/api/jobs') { result = { job_id: jobIds[jobIndex++], status: 'queued' }; status = '202'; }
    else if (path.startsWith('/api/jobs/')) {
      const i = jobIds.indexOf(path.split('/').at(-1));
      result = { job_id: jobIds[i], type: i === 0 ? 'noop' : 'noop-heavy', runtime: i === 0 ? 'lambda' : 'fargate',
        status: 'succeeded', result: { ok: true }, dry_run: false };
    } else throw new Error('unexpected request');
    writeFileSync(output, JSON.stringify(result));
    return { stdout: status };
  };
  const action = authenticatedSmoke({
    publicUrl: 'https://dev.example.com', cloudfrontDomain: 'd123.cloudfront.net',
    email: 'demo@example.com', password, runtimeConfig,
  }, { runCurl, tempRoot: dir });
  if (inventoryBytes > 2 * 1024 * 1024) {
    await assert.rejects(action, /inventory_http/);
    assert.equal(requests.length, 5);
  } else {
    assert.equal((await action).mode, 'verify');
    assert.equal(requests.length, 10);
  }
  assert.deepEqual(readdirSync(dir), []);
});

test('a successful poll admitted within its collection window can finish before the overall deadline', async () => {
  let clock = Date.parse(start) + 1000;
  const f = fixture({ [ `/api/jobs/${jobIds[0]}` ]: () => {
    clock += 301_000;
    return { job_id: jobIds[0], type: 'noop', runtime: 'lambda', status: 'succeeded',
      dry_run: false, result: { ok: true } };
  } }, { now: () => clock, wait: async ms => { clock += ms; } });
  assert.equal((await f.run()).status, 'ok');
});

test('a late incomplete response does not admit another poll after the deadline', async () => {
  let clock = Date.parse(start) + 1000, reads = 0;
  const f = fixture({ [`/api/jobs/${jobIds[0]}`]: () => {
    reads++;
    clock += 301_000;
    return { job_id: jobIds[0], type: 'noop', runtime: 'lambda', status: 'running' };
  } }, { now: () => clock, wait: async ms => { clock += ms; } });
  await assert.rejects(f.run(), /worker_timeout/);
  assert.equal(reads, 1);
});

test('fresh ledger metadata cannot substitute for an old known resource record', async () => {
  const f = fixture({ '/api/inventory/cloudfront?accounts=self&limit=5&offset=0': () => ({
    rows: [{ account_id: 'self', resource_id: config.expectedCloudfrontId,
      data: { id: config.expectedCloudfrontId },
      captured_at: new Date(Date.parse(start) - 15 * 60_000).toISOString() }],
  }) });
  await assert.rejects(f.run({ ...config, collectionMode: 'release' }), /inventory_known_resource_unverified/);
});

test('catalog verification cannot pass an older sweep as this release evidence', async () => {
  const recent = new Date(Date.parse(start) - 15 * 60_000).toISOString();
  const f = fixture({ '/api/inventory/summary?accounts=self&view=collection': () => ({ collection: {
    configured: true, readOk: true, runs: ['cloudfront', 'ec2'].map(type => ({
      type, accountId: 'self', status: 'succeeded', row_count: 1,
      started_at: recent, last_success_at: recent, unknown_attribute_count: 0, unknown_attributes: false,
    })),
  } }) });
  await assert.rejects(f.run({ ...config, collectionMode: 'recent' }), /Runtime smoke: configuration$/);
  await assert.rejects(f.run({ ...config, collectionMode: 'release' }), /collection_timeout/);
});

test('full verification reports every catalog gap and cannot pass incomplete collection', async () => {
  const types = ['cloudfront', 'ec2', 's3', 'iam_role', 'rds', 'new_catalog_type'];
  const row = type => ({ type, accountId: 'self', status: 'succeeded', row_count: 1,
    started_at: start, last_success_at: start, unknown_attribute_count: 0, unknown_attributes: false });
  const f = fixture({ '/api/inventory/summary?accounts=self&view=collection': () => ({ collection: {
    configured: true, readOk: true, runs: [row('cloudfront'), { ...row('ec2'), status: 'partial' },
      { ...row('s3'), last_success_at: '2020-01-01T00:00:00Z' },
      { ...row('iam_role'), unknown_attribute_count: 3, unknown_attributes: true },
      { ...row('rds'), accountId: '999999999999' }, { ...row('outside_catalog'), status: 'failed' }],
  } }) });
  const result = await f.run({ ...config, collectionMode: 'release', inventoryPolicy: 'full',
    expectedQueuedTypes: types }).catch(error => error);
  assert.equal(result.message, 'Runtime smoke: inventory_incomplete');
  assert.equal(result.inventory_quality.status, 'gaps');
  assert.deepEqual(result.inventory_quality.catalog_types, types);
  assert.deepEqual(result.inventory_quality.types, { verified: ['cloudfront'],
    partial: ['ec2'], failed: [], stale: ['s3'], missing: ['rds', 'new_catalog_type'],
    unknown: ['iam_role'], pending: [], invalid: [] });
  assert.equal(result.inventory_quality.counts.expected, 6);
  assert.equal(result.inventory_quality.counts.verified, 1);
  assert.equal(f.calls.filter(c => c.path.includes('view=collection')).length, 1);
  assert.ok(!f.calls.some(c => c.path === '/api/jobs'), 'Incomplete collection cannot reach worker acceptance');
});

test('full blocks missing, stale, partial and unknown CloudFront collection', async () => {
  for (const [change, reason] of [[null, 'collection_missing'],
    [{ status: 'partial' }, 'collection_partial'], [{ status: 'failed' }, 'collection_failed'],
    [{ last_success_at: '2020-01-01T00:00:00Z' }, 'collection_stale'],
    [{ unknown_attribute_count: null, unknown_attributes: null }, 'inventory_incomplete']]) {
    const f = fixture({ '/api/inventory/summary?accounts=self&view=collection': () => ({ collection: {
      configured: true, readOk: true, runs: change ? [{ type: 'cloudfront', accountId: 'self',
        status: 'succeeded', row_count: 1, started_at: start, last_success_at: start,
        unknown_attribute_count: 0, unknown_attributes: false, ...change },
        { type: 'ec2', accountId: 'self', status: 'succeeded', row_count: 0,
          started_at: start, last_success_at: start, unknown_attribute_count: 0, unknown_attributes: false }] : [],
    } }) });
    await assert.rejects(f.run({ ...config, inventoryPolicy: 'full' }),
      error => error.message === `Runtime smoke: ${reason}`);
    assert.ok(!f.calls.some(c => c.path === '/api/jobs'));
  }
});

test('full verification can wait for running rows whose metrics are not known yet', async () => {
  let reads = 0;
  const f = fixture({ '/api/inventory/summary?accounts=self&view=collection': () => {
    reads++;
    return { collection: { configured: true, readOk: true, runs: ['cloudfront', 'ec2'].map(type => ({
      type, accountId: 'self', started_at: start, last_success_at: start,
      status: reads === 1 ? 'running' : 'succeeded', row_count: reads === 1 ? null : 1,
      unknown_attribute_count: reads === 1 ? null : 0, unknown_attributes: reads === 1 ? null : false,
    })) } };
  } });
  assert.equal((await f.run({ ...config, inventoryPolicy: 'full' })).inventory_quality.status, 'complete');
  assert.equal(reads, 2);
});

test('full cannot bypass the known record, runtime protocol or either owned worker', async () => {
  for (const override of [
    { '/api/inventory/cloudfront?accounts=self&limit=5&offset=0': () => ({ rows: [] }) },
    { '/api/deployment/readiness': () => ({ httpStatus: 200, body: { status: 'ready' } }) },
    ...jobIds.map(id => ({ [`/api/jobs/${id}`]: () => ({ status: 'failed' }) })),
  ]) await assert.rejects(fixture(override).run({ ...config, inventoryPolicy: 'full' }),
    error => /inventory_known_resource_unverified|runtime_protocol|worker_failed/.test(error.message));
});

test('overall deadline returns a typed failure before starting another request', async () => {
  let clock = Date.parse(start) + 1000;
  const f = fixture({ '/api/accounts': () => {
    clock += 61_000;
    return { accounts: [{ accountId: account, isHost: true, enabled: true }] };
  } }, { now: () => clock, deadline: clock + 60_000 });
  await assert.rejects(f.run({ ...config, inventoryPolicy: 'full' }), /Runtime smoke: release_timeout$/);
  assert.equal(f.calls.length, 1);
});

test('the retired core policy is rejected instead of relaxing full collection', () => {
  assert.throws(() => validateRuntimeSmokeConfig({ ...config, inventoryPolicy: 'core' },
    Date.parse(start) + 1000), /Runtime smoke: configuration$/);
});
test('release collection never accepts stale, missing, partial or unknown evidence', async () => {
  const old = new Date(Date.parse(start) - 31 * 60_000).toISOString();
  for (const change of [{ started_at: old, last_success_at: old }, { status: 'partial' },
    { unknown_attribute_count: 1, unknown_attributes: true }]) {
    const f = fixture({ '/api/inventory/summary?accounts=self&view=collection': () => ({ collection: {
      configured: true, readOk: true, runs: ['cloudfront', 'ec2'].map(type => ({
        type, accountId: 'self', status: 'succeeded', row_count: 1, started_at: start,
        last_success_at: start, unknown_attribute_count: 0, unknown_attributes: false, ...change,
      })),
    } }) });
    await assert.rejects(f.run({ ...config, collectionMode: 'release' }), /collection_timeout|collection_partial|inventory_incomplete/);
  }
});

function contentionFixture({ repeat = false, evidence = {}, afterRetry = {}, deadline = Infinity, initialDelay = 0, cooldownOvershoot = 0 } = {}) {
  const types = ['cloudfront', 'ec2', ...Array.from({ length: 41 }, (_, i) => `catalog_type_${i}`)];
  let attempts = 0, reads = 0;
  const times = [];
  const f = fixture({
    '/api/inventory/summary?accounts=self&view=collection': () => {
      reads++;
      if (reads === 1) f.advance(initialDelay);
      const competing = reads === 2 || (repeat && attempts === 2);
      return { collection: { configured: true, readOk: true, runs: types.map(type => ({
        type, accountId: 'self', status: 'succeeded', row_count: 1,
        started_at: start, last_success_at: start, unknown_attribute_count: 0, unknown_attributes: false,
        ...(type === 'cloudfront' && competing ? { status: 'running', row_count: null,
          unknown_attribute_count: null, unknown_attributes: null, ...evidence } : {}),
        ...(type === 'ec2' && reads >= 3 ? afterRetry : {}),
      })) } };
    },
    '/api/deployment/readiness': options => {
      attempts++; times.push(f.now());
      return attempts === 1 || repeat ? { httpStatus: 503, body: {
        schemaVersion: 1, nonce: options.body.nonce, accountId: account,
        status: 'not_ready', reason: 'inventory_incomplete',
      } } : readyReply(options);
    },
  }, { deadline, ...(cooldownOvershoot ? {
    wait: async ms => { f.advance(ms + (ms === 65_000 ? cooldownOvershoot : 0)); },
  } : {}) });
  return { ...f, times, attempts: () => attempts, reads: () => reads,
    run: () => f.run({ ...config, inventoryPolicy: 'full', expectedQueuedTypes: types }) };
}

test('one proven sweep collision retries after cooldown and revalidates all 43 types', async () => {
  const f = contentionFixture();
  const result = await f.run();
  assert.equal(f.attempts(), 2);
  assert.ok(f.times[1] - f.times[0] >= 60_000);
  assert.equal(f.reads(), 3);
  assert.equal(result.inventory_quality.counts.expected, 43);
  assert.equal(result.inventory_quality.counts.verified, 43);
  const probes = f.calls.filter(c => c.path === '/api/deployment/readiness');
  assert.equal(probes[0].options.body.nonce, probes[1].options.body.nonce);
  const jobs = f.calls.filter(c => c.path === '/api/jobs');
  assert.equal(jobs.length, 2);
  assert.ok(f.calls.indexOf(jobs[0]) > f.calls.indexOf(probes[1]));
});

test('readiness errors without a fresh running sweep are not retried', async () => {
  for (const evidence of [{ status: 'partial' }, { status: 'failed' }, { status: 'succeeded' },
    { accountId: '999999999999' }, { last_success_at: '2020-01-01T00:00:00Z' }]) {
    const f = contentionFixture({ evidence });
    await assert.rejects(f.run(), /Runtime smoke: runtime_inventory_incomplete$/);
    assert.equal(f.attempts(), 1);
    assert.ok(!f.calls.some(c => c.path === '/api/jobs'));
  }
});

test('a repeated proven sweep collision stops after two probes with a distinct diagnostic', async () => {
  const f = contentionFixture({ repeat: true });
  await assert.rejects(f.run(), error => error.message === 'Runtime smoke: runtime_inventory_contention'
    && error.inventory_quality.status === 'gaps'
    && error.inventory_quality.types.pending.includes('cloudfront'));
  assert.equal(f.attempts(), 2);
  assert.ok(!f.calls.some(c => c.path === '/api/jobs'));
});

test('a readiness retry never bypasses new gaps in another catalog type', async () => {
  for (const [afterRetry, expected] of [[{ status: 'partial' }, 'collection_partial'],
    [{ status: 'failed' }, 'collection_failed'],
    [{ last_success_at: '2020-01-01T00:00:00Z' }, 'collection_stale'],
    [{ unknown_attribute_count: 1, unknown_attributes: true }, 'inventory_incomplete']]) {
    const f = contentionFixture({ afterRetry });
    await assert.rejects(f.run(), error => error.message === `Runtime smoke: ${expected}`);
    assert.equal(f.attempts(), 1);
    assert.ok(!f.calls.some(c => c.path === '/api/jobs'));
  }
});

test('an insufficient overall budget blocks requests before billed readiness', async () => {
  const f = contentionFixture({ deadline: Date.parse(start) + 30_000 });
  await assert.rejects(f.run(), /Runtime smoke: release_timeout$/);
  assert.equal(f.attempts(), 0);
  assert.ok(!f.calls.some(c => c.path === '/api/jobs'));
});

test('readiness requires the remaining probe and both-worker budgets before spending', async () => {
  const f = fixture({}, { deadline: Date.parse(start) + 2 * 60_000 });
  await assert.rejects(f.run(), /Runtime smoke: release_timeout$/);
  assert.ok(!f.calls.some(c => c.path === '/api/deployment/readiness' || c.path === '/api/jobs'));
});

test('retry admission includes cooldown, recheck, probe and worker allowances', async () => {
  const f = contentionFixture({ deadline: Date.parse(start) + 15 * 60_000 });
  await assert.rejects(f.run(), /Runtime smoke: runtime_inventory_contention$/);
  assert.equal(f.attempts(), 1);
  assert.equal(f.now(), Date.parse(start) + 1000);
  assert.ok(!f.calls.some(c => c.path === '/api/jobs'));
});

test('default and later caller deadlines cannot outlive the verification marker window', async () => {
  for (const deadline of [Infinity, Date.parse(start) + 60 * 60_000]) {
    const f = fixture({ '/api/inventory/cloudfront?accounts=self&limit=5&offset=0': () => {
      f.advance(31 * 60_000);
      return { rows: [{ account_id: 'self', resource_id: config.expectedCloudfrontId,
        captured_at: start, data: { id: config.expectedCloudfrontId } }] };
    } }, { deadline });
    await assert.rejects(f.run({ ...config, collectionMode: 'release' }), /Runtime smoke: release_timeout$/);
    assert.ok(!f.calls.some(c => c.path === '/api/deployment/readiness' || c.path === '/api/jobs'));
  }
});

test('contention fails before cooldown when the original collection window is exhausted', async () => {
  const f = contentionFixture({ initialDelay: 9 * 60_000 + 30_000 });
  await assert.rejects(f.run(), /Runtime smoke: runtime_inventory_contention$/);
  assert.equal(f.attempts(), 1);
  assert.equal(f.reads(), 2);
  assert.equal(f.now() - Date.parse(start), 9 * 60_000 + 31_000);
  assert.ok(!f.calls.some(c => c.path === '/api/jobs'));
});

test('a delayed cooldown cannot reset the shared collection window', async () => {
  const f = contentionFixture({ cooldownOvershoot: 10 * 60_000 });
  await assert.rejects(f.run(), /Runtime smoke: runtime_inventory_contention$/);
  assert.equal(f.attempts(), 1);
  assert.equal(f.reads(), 2);
  assert.ok(!f.calls.some(c => c.path === '/api/jobs'));
});

test('a current running sweep with old or absent success times out as pending', async () => {
  for (const last_success_at of [null, '2020-01-01T00:00:00Z']) {
    const f = fixture({ '/api/inventory/summary?accounts=self&view=collection': () => ({
      collection: { configured: true, readOk: true, runs: config.expectedQueuedTypes.map(type => ({
        type, accountId: 'self', status: 'running', started_at: start, last_success_at,
        row_count: null, unknown_attribute_count: null, unknown_attributes: true,
      })) },
    }) });
    await assert.rejects(f.run({ ...config, inventoryPolicy: 'full' }), /collection_timeout$/);
    assert.ok(!f.calls.some(c => c.path === '/api/deployment/readiness' || c.path === '/api/jobs'));
  }
});

test('runtime authentication refuses a partial login timeout before sending', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-login-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = Date.now();
  let calls = 0;
  await assert.rejects(authenticatedSmoke({
    publicUrl: 'https://dev.example.com', cloudfrontDomain: 'd123example.cloudfront.net',
    email: 'demo@example.com', password: 'fixture-password',
    runtimeConfig: { schemaVersion: 1, mode: 'prepare', expectedAccountId: account },
  }, { tempRoot: dir, now: () => clock, deadline: clock + 10_000,
    runCurl: async () => { calls++; throw new Error('unexpected request'); } }),
  /Runtime smoke: release_timeout$/);
  assert.equal(calls, 0);
});

test('the existing authenticated entry point bounds runtime preparation without caller options', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-default-deadline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.now(), calls = 0;
  await assert.rejects(authenticatedSmoke({
    publicUrl: 'https://dev.example.com', cloudfrontDomain: 'd123example.cloudfront.net',
    email: 'demo@example.com', password: 'fixture-password',
    runtimeConfig: { schemaVersion: 1, mode: 'prepare', expectedAccountId: account },
  }, { tempRoot: dir, now: () => clock, runCurl: async (command, args) => {
    calls++; clock += 31 * 60_000;
    const path = new URL(args.at(-1)).pathname;
    const body = path === '/api/auth/login' ? { ok: true } : path === '/api/db'
      ? { status: 'ok', public_tables: 1 } : { accounts: [{ accountId: account, isHost: true, enabled: true }] };
    writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify(body));
    if (args.includes('--cookie-jar')) writeFileSync(args[args.indexOf('--cookie-jar') + 1],
      '#HttpOnly_dev.example.com\tFALSE\t/\tTRUE\t0\tawsops_token\tfixture-token\n');
    return { stdout: '200' };
  } }), /Runtime smoke: release_timeout$/);
  assert.equal(calls, 1);
});
