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
function fixture(overrides = {}) {
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
    if (path === '/api/deployment/readiness') return { httpStatus: 200, body: {
      schemaVersion: 1, nonce: options.body.nonce, accountId: account, status: 'ready', reason: 'ok',
      webIdentity: true, parameters: { runtime_arn: 'ready', interpreter_id: 'ready', memory_id: 'ready' },
      agent: { schemaVersion: 1, mode: 'deployment_readiness', nonce: options.body.nonce, accountId: account,
        status: 'ready', reason: 'ok', checks: { identity: true, inventorySummary: true,
          inventoryQuery: true, knownResource: true, freshInventory: true, model: true },
        inventory: { count: 1, ageMinutes: overrides.ageMinutes ?? 0 } },
    } };
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
  return { calls, run: (c = config) => verifyRuntimeSmoke(c, request, {
    now: () => now, wait: async ms => { now += ms; },
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
    await assert.rejects(fixture({ '/api/inventory/summary?accounts=self': () => ({ collection }) }).run(), /collection/);
  }
  for (const change of [{ status: 'partial' }, { status: 'failed' }, { status: 'running' },
    { last_success_at: '2020-01-01T00:00:00Z' }, { unknown_attribute_count: null, unknown_attributes: null },
    { unknown_attribute_count: 1, unknown_attributes: true }]) {
    const runs = ['cloudfront', 'ec2'].map(type => ({ type, accountId: 'self', status: 'succeeded',
      row_count: 0, started_at: start, last_success_at: start, unknown_attribute_count: 0, unknown_attributes: false, ...change }));
    await assert.rejects(fixture({
      '/api/inventory/summary?accounts=self': () => ({ collection: { configured: true, readOk: true, runs } }),
    }).run(), /collection_timeout/);
  }
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
for (const inventoryBytes of [75 * 1024, 2 * 1024 * 1024 + 1]) test(
  `authenticated full flow bounds the larger inventory response (${inventoryBytes} bytes)`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-smoke-curl-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const runtimeConfig = { ...config, collectionStartedAt: now };
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
    else if (path === '/api/inventory/summary') result = { collection: { configured: true, readOk: true,
      runs: ['ec2', 'cloudfront'].map(type => ({ type, accountId: 'self', status: 'succeeded', row_count: 1,
        started_at: now, last_success_at: now, unknown_attribute_count: 0, unknown_attributes: false })) } };
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
