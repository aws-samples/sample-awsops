// Internal release probe. CI supplies trusted state/dispatch evidence via a private file.
import { randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export class RuntimeSmokeError extends Error {}
const fail = phase => { throw new RuntimeSmokeError(`Runtime smoke: ${phase}`); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const baseKeys = ['schemaVersion', 'mode', 'expectedAccountId'];
export function validateRuntimeSmokeConfig(value, now = Date.now()) {
  const keys = value?.mode === 'prepare' ? baseKeys
    : [...baseKeys, 'expectedCloudfrontId', 'expectedQueuedTypes', 'collectionStartedAt'];
  if (!exact(value, keys) || value.schemaVersion !== 1 || !['prepare', 'verify'].includes(value.mode)
      || typeof value.expectedAccountId !== 'string' || !/^[0-9]{12}$/.test(value.expectedAccountId)) fail('configuration');
  if (value.mode === 'verify') {
    const types = value.expectedQueuedTypes;
    const start = Date.parse(value.collectionStartedAt);
    if (typeof value.expectedCloudfrontId !== 'string' || !/^[A-Z0-9]{5,32}$/.test(value.expectedCloudfrontId)
        || !Array.isArray(types) || types.length < 1 || types.length > 128 || new Set(types).size !== types.length
        || !types.includes('cloudfront') || types.some(t => typeof t !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(t))
        || typeof value.collectionStartedAt !== 'string' || !Number.isFinite(start)
        || start > now || start < now - 30 * 60_000) fail('configuration');
  }
  return value;
}

export function readRuntimeSmokeConfig(file, credentialFile) {
  // Same private directory as credentials: the existing always() cleanup also covers SIGKILL.
  if (typeof file !== 'string' || !file || resolve(file) !== file
      || dirname(file) !== dirname(credentialFile) || file === credentialFile) fail('configuration_file');
  let fd;
  try {
    const directory = lstatSync(dirname(file));
    if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700) fail('configuration_file');
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 16_384) fail('configuration_file');
    const bytes = Buffer.alloc(16_385);
    let size = 0, count;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += count;
    if (size > 16_384) fail('configuration_file');
    return validateRuntimeSmokeConfig(JSON.parse(bytes.subarray(0, size).toString('utf8')));
  } catch {
    fail('configuration_file');
  } finally { if (fd !== undefined) closeSync(fd); }
}

const finiteCount = n => Number.isSafeInteger(n) && n >= 0;
const freshTime = (value, start, now) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && Date.parse(value) >= start && Date.parse(value) <= now + 60_000;

export async function verifyRuntimeSmoke(configuration, request, {
  now = Date.now, wait = ms => delay(ms),
} = {}) {
  const config = validateRuntimeSmokeConfig(configuration, now());
  const { accounts } = await request('/api/accounts');
  if (!Array.isArray(accounts) || accounts.length > 1000
      || accounts.some(a => !object(a) || typeof a.enabled !== 'boolean' || typeof a.isHost !== 'boolean')
      || accounts.filter(a => a.isHost).length !== 1
      || accounts.filter(a => a.accountId === config.expectedAccountId && a.isHost && a.enabled).length !== 1
      || accounts.some(a => a.enabled && a.accountId !== config.expectedAccountId)) fail('host_registry');
  if (config.mode === 'prepare') return { status: 'ok', mode: 'prepare' };

  async function poll(check, phase, seconds) {
    const deadline = now() + seconds * 1000;
    for (let attempt = 0; attempt <= seconds / 5 && now() <= deadline; attempt++) {
      if (await check()) return;
      if (now() >= deadline) break;
      await wait(5000);
    }
    fail(phase);
  }
  const started = Date.parse(config.collectionStartedAt);
  await poll(async () => {
    const summary = await request('/api/inventory/summary?accounts=self');
    const c = summary?.collection;
    if (!object(c) || c.configured !== true || c.readOk !== true || !Array.isArray(c.runs)) fail('collection_unavailable');
    return config.expectedQueuedTypes.every(type => {
      const rows = c.runs.filter(r => r?.type === type && r.accountId === 'self');
      if (rows.length !== 1) return false;
      const row = rows[0];
      return row.status === 'succeeded' && finiteCount(row.row_count)
        && row.unknown_attribute_count === 0 && row.unknown_attributes === false
        && freshTime(row.started_at, started, now()) && freshTime(row.last_success_at, started, now());
    });
  }, 'collection_timeout', 600);

  let found = false;
  for (let offset = 0; offset < 500 && !found; offset += 50) {
    const page = await request(`/api/inventory/cloudfront?accounts=self&limit=50&offset=${offset}`);
    if (!Array.isArray(page?.rows) || page.rows.length > 50) fail('inventory_protocol');
    found = page.rows.some(row => row.account_id === 'self'
      && row.resource_id === config.expectedCloudfrontId && row.data?.id === config.expectedCloudfrontId
      && freshTime(row.captured_at, started, now()));
    if (page.rows.length < 50) break;
  }
  if (!found) fail('inventory_known_resource');
  const nonce = randomBytes(24).toString('hex');
  const runtime = await request('/api/deployment/readiness', { method: 'POST', timeout: 80_000, body: {
    nonce, expectedAccountId: config.expectedAccountId, expectedCloudfrontId: config.expectedCloudfrontId,
  } });
  const agent = runtime?.agent;
  const checkNames = ['identity', 'inventorySummary', 'inventoryQuery', 'knownResource', 'freshInventory', 'model'];
  if (runtime?.schemaVersion !== 1 || runtime.nonce !== nonce || runtime.accountId !== config.expectedAccountId
      || runtime.status !== 'ready' || runtime.reason !== 'ok' || runtime.webIdentity !== true
      || !exact(runtime.parameters, ['runtime_arn', 'interpreter_id', 'memory_id'])
      || !Object.values(runtime.parameters).every(v => v === 'ready')
      || agent?.schemaVersion !== 1 || agent.mode !== 'deployment_readiness'
      || agent.nonce !== nonce || agent.accountId !== config.expectedAccountId
      || agent.status !== 'ready' || agent.reason !== 'ok' || !exact(agent.checks, checkNames)
      || !Object.values(agent.checks).every(v => v === true)
      || !finiteCount(agent.inventory?.count) || agent.inventory.count < 1
      || !finiteCount(agent.inventory?.ageMinutes) || agent.inventory.ageMinutes > 15) fail('runtime_protocol');

  for (const [type, runtimeName] of [['noop', 'lambda'], ['noop-heavy', 'fargate']]) {
    const job = await request('/api/jobs', { method: 'POST', status: '202', body: {
      type, payload: {}, dry_run: false, idempotency_key: `readiness:${nonce}:${type}`,
    } });
    if (typeof job?.job_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.job_id)
        || !['queued', 'running', 'succeeded'].includes(job.status) || job.enqueue === 'failed') fail('worker_enqueue');
    await poll(async () => {
      const state = await request(`/api/jobs/${job.job_id}`);
      if (!object(state) || !['queued', 'running', 'succeeded'].includes(state.status)) fail('worker_failed');
      if (state.status !== 'succeeded') return false;
      if (state.job_id !== job.job_id || state.type !== type || state.runtime !== runtimeName
          || state.dry_run !== false || state.result?.ok !== true) fail('worker_protocol');
      return true;
    }, 'worker_timeout', 300);
  }
  return { status: 'ok', mode: 'verify', collected_types: config.expectedQueuedTypes.length, workers: 2 };
}
