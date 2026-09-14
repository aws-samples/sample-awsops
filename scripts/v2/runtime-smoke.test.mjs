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
function readyResponse(options, ageMinutes = 0) {
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
    if (path === '/api/deployment/readiness') return readyResponse(options, overrides.ageMinutes ?? 0);
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
  return { calls, now: () => now, run: (c = config) => verifyRuntimeSmoke(c, request, {
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

test('a successful response from an attempt admitted before the deadline is accepted', async () => {
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

test('release accepts a recent catalog success while retaining the post-marker CloudFront proof', async () => {
  const recent = new Date(Date.parse(start) - 15 * 60_000).toISOString();
  const f = fixture({ '/api/inventory/summary?accounts=self&view=collection': () => ({ collection: {
    configured: true, readOk: true, runs: ['cloudfront', 'ec2'].map(type => ({
      type, accountId: 'self', status: 'succeeded', row_count: 1,
      started_at: type === 'cloudfront' ? start : recent,
      last_success_at: type === 'cloudfront' ? start : recent,
      unknown_attribute_count: 0, unknown_attributes: false,
    })),
  } }) });
  assert.deepEqual(await f.run({ ...config, collectionMode: 'release' }), {
    status: 'ok', mode: 'verify', catalog_types: 2, workers: 2,
    collection: { status: 'current', completeness: 'unknown', freshness_minutes: 30, degraded_types: [] },
  });
  assert.equal(f.calls.filter(c => c.path === '/api/deployment/readiness').length, 1);
  assert.deepEqual(f.calls.filter(c => c.path === '/api/jobs').map(c => c.options.body.type), ['noop', 'noop-heavy']);
});
test('unsupported collection modes fail validation before any requests', async () => {
  const f = fixture();
  await assert.rejects(f.run({ ...config, collectionMode: 'recent' }), /Runtime smoke: configuration$/);
  assert.equal(f.calls.length, 0);
});
test('release discloses catalog degradation with a recent last success, never complete collection', async () => {
  const recent = new Date(Date.parse(start) - 15 * 60_000).toISOString();
  for (const change of [{ status: 'partial' }, { status: 'failed', row_count: null },
    { status: 'running', row_count: null }, { unknown_attribute_count: 1, unknown_attributes: true },
    { unknown_attribute_count: null, unknown_attributes: null }]) {
    const f = fixture({ '/api/inventory/summary?accounts=self&view=collection': () => ({ collection: {
      configured: true, readOk: true, runs: ['cloudfront', 'ec2'].map(type => ({
        type, accountId: 'self', status: 'succeeded', row_count: 1, started_at: start,
        last_success_at: start, unknown_attribute_count: 0, unknown_attributes: false,
        ...(type === 'ec2' ? { last_success_at: recent, ...change } : {}),
      })),
    } }) });
    const result = await f.run({ ...config, collectionMode: 'release' });
    assert.deepEqual(result.collection, { status: 'degraded', completeness: 'unknown', freshness_minutes: 30,
      degraded_types: [{ type: 'ec2', status: change.status || 'succeeded',
        unknown_attributes: ['running', 'failed'].includes(change.status) ? null
          : Object.hasOwn(change, 'unknown_attributes') ? change.unknown_attributes : false }] });
    assert.equal(result.catalog_types, 2);
    assert.equal(result.collected_types, undefined);
    assert.equal(result.workers, 2);
  }
});
test('release refuses missing, stale and malformed catalog evidence without starting workers', async () => {
  const old = new Date(Date.parse(start) - 31 * 60_000).toISOString();
  for (const [change, reason] of [
    [null, 'collection_missing'],
    [{ last_success_at: null }, 'collection_stale'],
    [{ last_success_at: old }, 'collection_stale'],
    [{ status: 'failed', last_success_at: old }, 'collection_stale'],
    [{ status: 'unknown' }, 'collection_protocol'],
    [{ unknown_attribute_count: -1, unknown_attributes: true }, 'collection_protocol'],
  ]) {
    const f = fixture({ '/api/inventory/summary?accounts=self&view=collection': () => ({ collection: {
      configured: true, readOk: true, runs: ['cloudfront', ...(change ? ['ec2'] : [])].map(type => ({
        type, accountId: 'self', status: 'succeeded', row_count: 1, started_at: start,
        last_success_at: start, unknown_attribute_count: 0, unknown_attributes: false,
        ...(type === 'ec2' ? change : {}),
      })),
    } }) });
    await assert.rejects(f.run({ ...config, collectionMode: 'release' }), new RegExp(`Runtime smoke: ${reason}$`));
    assert.ok(f.calls.every(c => c.path !== '/api/jobs'));
  }
});
test('release freshness uses observation time even when the marker was recorded earlier', async () => {
  const observed = Date.parse(start) + 10 * 60_000;
  for (const [ageMinutes, accepted] of [[30, true], [30.01, false]]) {
    const lastSuccess = new Date(observed - ageMinutes * 60_000).toISOString();
    const f = fixture({ '/api/inventory/summary?accounts=self&view=collection': () => ({ collection: {
      configured: true, readOk: true, runs: ['cloudfront', 'ec2'].map(type => ({
        type, accountId: 'self', status: 'succeeded', row_count: 1,
        started_at: type === 'cloudfront' ? start : lastSuccess,
        last_success_at: type === 'cloudfront' ? start : lastSuccess,
        unknown_attribute_count: 0, unknown_attributes: false,
      })),
    } }) }, { now: () => observed, wait: async () => {} });
    if (accepted) assert.equal((await f.run({ ...config, collectionMode: 'release' })).status, 'ok');
    else await assert.rejects(f.run({ ...config, collectionMode: 'release' }), /collection_stale$/);
  }
});
test('a newer scheduled CloudFront attempt cannot invalidate the owned proof but is disclosed', async () => {
  for (const status of ['running', 'partial', 'failed', 'succeeded']) {
    const f = fixture({ '/api/inventory/summary?accounts=self&view=collection': () => ({ collection: {
      configured: true, readOk: true, runs: ['cloudfront', 'ec2'].map(type => ({
        type, accountId: 'self', status: 'succeeded', row_count: 1, started_at: start,
        last_success_at: start, unknown_attribute_count: 0, unknown_attributes: false,
        ...(type === 'cloudfront' ? { status, started_at: new Date(Date.parse(start) + 500).toISOString(),
          unknown_attribute_count: 1, unknown_attributes: true } : {}),
      })),
    } }) });
    const result = await f.run({ ...config, collectionMode: 'release' });
    assert.deepEqual(result.collection.degraded_types, [{ type: 'cloudfront', status,
      unknown_attributes: ['running', 'failed'].includes(status) ? null : true }]);
    assert.equal(result.collection.completeness, 'unknown');
    assert.ok(f.calls.findIndex(c => c.path === '/api/deployment/readiness') <
      f.calls.findIndex(c => c.path.startsWith('/api/inventory/summary')));
    assert.equal(result.workers, 2);
  }
});
test('an older CloudFront success cannot pass even when the current attempt is newer', async () => {
  const previous = new Date(Date.parse(start) - 1000).toISOString();
  const f = fixture({ '/api/inventory/summary?accounts=self&view=collection': () => ({ collection: {
    configured: true, readOk: true, runs: ['cloudfront', 'ec2'].map(type => ({
      type, accountId: 'self', status: 'running', row_count: null, started_at: start,
      last_success_at: type === 'cloudfront' ? previous : start,
      unknown_attribute_count: null, unknown_attributes: null,
    })),
  } }) });
  await assert.rejects(f.run({ ...config, collectionMode: 'release' }), /collection_stale$/);
});
test('degraded catalog acceptance never substitutes for own SSM/model and terminal worker proof', async () => {
  const summary = () => ({ collection: {
    configured: true, readOk: true, runs: ['cloudfront', 'ec2'].map(type => ({
      type, accountId: 'self', status: type === 'cloudfront' ? 'succeeded' : 'partial',
      row_count: 1, started_at: start, last_success_at: start,
      unknown_attribute_count: 0, unknown_attributes: false,
    })),
  } });
  for (const [path, reply, reason] of [
    ['/api/deployment/readiness', options => ({ httpStatus: 503, body: {
      schemaVersion: 1, nonce: options.body.nonce, accountId: account, status: 'not_ready',
      reason: 'parameters_not_ready', parameters: {
        runtime_arn: 'denied', interpreter_id: 'ready', memory_id: 'ready',
      },
    } }), /runtime_parameters_not_ready/],
    ['/api/deployment/readiness', options => ({ httpStatus: 503, body: {
      schemaVersion: 1, nonce: options.body.nonce, accountId: account, status: 'not_ready', reason: 'model_failed',
    } }), /runtime_model_failed/],
    ...jobIds.map(id => [`/api/jobs/${id}`, () => ({ status: 'failed' }), /worker_failed/]),
  ]) {
    await assert.rejects(fixture({
      '/api/inventory/summary?accounts=self&view=collection': summary, [path]: reply,
    }).run({ ...config, collectionMode: 'release' }), reason);
  }
});

const readinessPath = '/api/deployment/readiness';
const collectionPath = '/api/inventory/summary?accounts=self&view=collection';
const releaseConfig = { ...config, collectionMode: 'release' };
function incompleteResponse(options) {
  const response = readyResponse(options);
  response.httpStatus = 503;
  response.body.status = response.body.agent.status = 'not_ready';
  response.body.reason = response.body.agent.reason = 'inventory_incomplete';
  response.body.agent.checks.knownResource = response.body.agent.checks.freshInventory =
    response.body.agent.checks.model = false;
  response.body.agent.inventory.ageMinutes = null;
  return response;
}
function collectionResponse(cloudfront = {}) {
  return { collection: { scope: 'aggregate', configured: true, readOk: true,
    runs: ['cloudfront', 'ec2'].map(type => ({
      type, accountId: 'self', status: 'succeeded', row_count: 1,
      started_at: start, finished_at: start, last_success_at: start,
      unknown_attribute_count: 0, unknown_attributes: false,
      ...(type === 'cloudfront' ? cloudfront : {}),
    })) } };
}
const runningCloudfront = {
  status: 'running', started_at: new Date(Date.parse(start) + 500).toISOString(),
  finished_at: null, row_count: null, unknown_attribute_count: null, unknown_attributes: null,
};

test('release retries a proven scheduled CloudFront race once after cooldown with a fresh nonce', async () => {
  let clock = Date.parse(start) + 1000;
  const posts = [], waits = [];
  const f = fixture({
    [readinessPath]: options => {
      posts.push({ nonce: options.body.nonce, at: clock });
      if (posts.length === 1) {
        clock += 20_000; // A failed BFF/AgentCore request also consumes time.
        return incompleteResponse(options);
      }
      if (clock - posts[0].at < 60_000) return { httpStatus: 429 };
      return readyResponse(options);
    },
    [collectionPath]: () => collectionResponse(clock < Date.parse(start) + 60_000 ? runningCloudfront : {
      started_at: runningCloudfront.started_at,
      finished_at: new Date(clock).toISOString(), last_success_at: new Date(clock).toISOString(),
    }),
  }, { now: () => clock, wait: async ms => { waits.push(ms); clock += ms; } });
  const result = await f.run(releaseConfig);
  assert.equal(result.status, 'ok');
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].nonce, posts[1].nonce);
  assert.ok(posts.every(p => /^[0-9a-f]{48}$/.test(p.nonce)));
  assert.ok(posts[1].at - posts[0].at >= 60_000);
  assert.equal(waits.filter(ms => ms === 60_000).length, 1);
  assert.equal(f.calls.filter(c => c.path === readinessPath).every(c => c.options.timeout === 80_000), true);
  assert.deepEqual(f.calls.filter(c => c.path === '/api/jobs').map(c => c.options.body.idempotency_key),
    [`readiness:${posts[1].nonce}:noop`, `readiness:${posts[1].nonce}:noop-heavy`]);
  assert.ok(f.calls.findIndex(c => c.path === '/api/jobs') >
    f.calls.findLastIndex(c => c.path === readinessPath));
});

test('release reports only confirmed running contention after the second failure and never calls a third time', async () => {
  const f = fixture({
    [readinessPath]: incompleteResponse,
    [collectionPath]: () => collectionResponse(runningCloudfront),
  });
  await assert.rejects(f.run(releaseConfig), /^Error: Runtime smoke: runtime_inventory_contention$/);
  assert.equal(f.calls.filter(c => c.path === readinessPath).length, 2);
  assert.equal(f.calls.filter(c => c.path === '/api/jobs').length, 0);
});

test('release does not retry real failures, incomplete identities, or malformed readiness proof', async () => {
  const mutations = [
    r => { r.httpStatus = 401; },
    r => { r.httpStatus = 403; },
    r => { r.httpStatus = 429; },
    r => { r.httpStatus = 200; },
    r => { r.body.nonce = 'wrong'; },
    r => { r.body.accountId = '999999999999'; },
    r => { r.body.schemaVersion = 2; },
    r => { r.body.webIdentity = false; },
    r => { r.body.parameters.runtime_arn = 'denied'; },
    r => { r.body.agent = null; },
    r => { r.body.agent.nonce = 'wrong'; },
    r => { r.body.agent.accountId = '999999999999'; },
    r => { r.body.agent.mode = 'chat'; },
    r => { r.body.agent.checks.identity = false; },
    r => { r.body.agent.checks.inventoryQuery = false; },
    r => { r.body.agent.checks.model = true; },
    r => { r.body.agent.inventory.count = 0; },
    r => { r.body.agent.inventory.ageMinutes = 30; },
    ...['model_failed', 'runtime_protocol', 'inventory_stale', 'inventory_unavailable',
      'known_resource_unverified', 'identity_failed', 'timeout'].map(reason => r => {
      r.body.reason = r.body.agent.reason = reason;
    }),
  ];
  for (const mutate of mutations) {
    const waits = [];
    const f = fixture({
      [readinessPath]: options => { const r = incompleteResponse(options); mutate(r); return r; },
      [collectionPath]: () => collectionResponse(runningCloudfront),
    }, { wait: async ms => { waits.push(ms); } });
    await assert.rejects(f.run(releaseConfig), /Runtime smoke: runtime_/);
    assert.equal(f.calls.filter(c => c.path === readinessPath).length, 1);
    assert.equal(f.calls.filter(c => c.path === collectionPath).length, 0);
    assert.deepEqual(waits, []);
    assert.equal(f.calls.filter(c => c.path === '/api/jobs').length, 0);
  }
});

test('release cannot attribute owned, stale, partial, failed, or malformed CloudFront evidence to contention', async () => {
  const before = new Date(Date.parse(start) - 1000).toISOString();
  const changes = [
    { status: 'partial' }, { status: 'failed' }, { status: 'succeeded' },
    { started_at: start }, // Not a later attempt than the durable owned success.
    { started_at: before }, { last_success_at: before }, { last_success_at: null },
    { started_at: null }, { started_at: new Date(Date.parse(start) + 120_000).toISOString() },
    { finished_at: start }, { row_count: 1 },
    { unknown_attribute_count: 1, unknown_attributes: true },
    { accountId: '999999999999' },
  ];
  const summaries = [
    ...changes.map(change => () => collectionResponse({ ...runningCloudfront, ...change })),
    () => ({ collection: { configured: false, readOk: true, runs: [] } }),
    () => ({ collection: { configured: true, readOk: false, runs: [] } }),
    () => ({ collection: { configured: true, readOk: true, runs: null } }),
    () => { const s = collectionResponse(runningCloudfront); s.collection.runs.push(s.collection.runs[0]); return s; },
  ];
  for (const summary of summaries) {
    const waits = [];
    const f = fixture({ [readinessPath]: incompleteResponse, [collectionPath]: summary },
      { wait: async ms => { waits.push(ms); } });
    await assert.rejects(f.run(releaseConfig), /Runtime smoke: runtime_inventory_incomplete$/);
    assert.equal(f.calls.filter(c => c.path === readinessPath).length, 1);
    assert.deepEqual(waits, []);
    assert.equal(f.calls.filter(c => c.path === '/api/jobs').length, 0);
  }
});

test('the one retry must still satisfy every original AgentCore proof check and its new nonce', async () => {
  for (const mutate of [
    (r, first) => { r.body.nonce = first; r.body.agent.nonce = first; },
    r => { r.body.agent.checks.model = false; },
    r => { r.body.agent.checks.freshInventory = false; },
    r => { r.body.agent.inventory.count = 0; },
    r => { r.body.parameters.runtime_arn = 'pending'; },
  ]) {
    const posts = [];
    const f = fixture({
      [readinessPath]: options => {
        posts.push(options.body.nonce);
        if (posts.length === 1) return incompleteResponse(options);
        const response = readyResponse(options); mutate(response, posts[0]); return response;
      },
      [collectionPath]: () => collectionResponse(runningCloudfront),
    });
    await assert.rejects(f.run(releaseConfig), /Runtime smoke: runtime_protocol$/);
    assert.equal(posts.length, 2);
    assert.notEqual(posts[0], posts[1]);
    assert.equal(f.calls.filter(c => c.path === '/api/jobs').length, 0);
  }
});

test('a second real failure retains its cause instead of being relabeled as contention', async () => {
  for (const reason of ['model_failed', 'inventory_stale', 'runtime_protocol']) {
    let posts = 0;
    const f = fixture({
      [readinessPath]: options => {
        const r = incompleteResponse(options);
        if (++posts === 2) r.body.reason = r.body.agent.reason = reason;
        return r;
      },
      [collectionPath]: () => collectionResponse(runningCloudfront),
    });
    await assert.rejects(f.run(releaseConfig), new RegExp(`Runtime smoke: runtime_${reason}$`));
    assert.equal(posts, 2);
    assert.equal(f.calls.filter(c => c.path === '/api/jobs').length, 0);
  }
  for (const change of [{ status: 'partial' }, { status: 'failed' },
    { last_success_at: new Date(Date.parse(start) - 1000).toISOString() }]) {
    let reads = 0;
    const f = fixture({
      [readinessPath]: incompleteResponse,
      [collectionPath]: () => collectionResponse({ ...runningCloudfront, ...(reads++ ? change : {}) }),
    });
    await assert.rejects(f.run(releaseConfig), /Runtime smoke: runtime_inventory_incomplete$/);
    assert.equal(f.calls.filter(c => c.path === readinessPath).length, 2);
    assert.equal(f.calls.filter(c => c.path === '/api/jobs').length, 0);
  }
});

test('standalone strict mode still makes one readiness request when a sweep starts after collection proof', async () => {
  let reads = 0;
  const waits = [];
  const f = fixture({
    [collectionPath]: () => collectionResponse(reads++ ? runningCloudfront : {}),
    [readinessPath]: incompleteResponse,
  }, { wait: async ms => { waits.push(ms); } });
  await assert.rejects(f.run(config), /Runtime smoke: runtime_inventory_incomplete$/);
  assert.equal(f.calls.filter(c => c.path === readinessPath).length, 1);
  assert.equal(reads, 1);
  assert.deepEqual(waits, []);
});
