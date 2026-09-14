// Internal release probe. CI supplies trusted state/dispatch evidence via a private file.
import { randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export class RuntimeSmokeError extends Error {}
const fail = (phase, quality) => {
  const error = new RuntimeSmokeError(`Runtime smoke: ${phase}`);
  if (quality) error.inventory_quality = quality;
  throw error;
};
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const baseKeys = ['schemaVersion', 'mode', 'expectedAccountId'];
const VERIFICATION_WINDOW_MS = 30 * 60_000;
export function validateRuntimeSmokeConfig(value, now = Date.now()) {
  const keys = value?.mode === 'prepare' ? [...baseKeys]
    : [...baseKeys, 'expectedCloudfrontId', 'expectedQueuedTypes', 'collectionStartedAt'];
  const hasHostOnly = object(value) && Object.hasOwn(value, 'hostOnly');
  const hasCollectionMode = object(value) && Object.hasOwn(value, 'collectionMode');
  const hasPolicy = object(value) && Object.hasOwn(value, 'inventoryPolicy');
  if (hasPolicy) keys.push('inventoryPolicy');
  if (hasCollectionMode) keys.push('collectionMode');
  if ((hasPolicy && (value.mode !== 'verify' || value.inventoryPolicy !== 'full'))
      || (hasCollectionMode && (value.mode !== 'verify' || value.collectionMode !== 'release'))
      || !exact(value, hasHostOnly ? [...keys, 'hostOnly'] : keys) || (hasHostOnly && typeof value.hostOnly !== 'boolean')
      || value.schemaVersion !== 1 || !['prepare', 'verify'].includes(value.mode)
      || typeof value.expectedAccountId !== 'string' || !/^[0-9]{12}$/.test(value.expectedAccountId)) fail('configuration');
  if (value.mode === 'verify') {
    const types = value.expectedQueuedTypes;
    const start = Date.parse(value.collectionStartedAt);
    if (typeof value.expectedCloudfrontId !== 'string' || !/^[A-Z0-9]{5,32}$/.test(value.expectedCloudfrontId)
        || !Array.isArray(types) || types.length < 1 || types.length > 128 || new Set(types).size !== types.length
        || !types.includes('cloudfront') || types.some(t => typeof t !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(t))
        || typeof value.collectionStartedAt !== 'string' || !Number.isFinite(start)
        || start > now || start < now - VERIFICATION_WINDOW_MS) fail('configuration');
  }
  return value;
}

// Call after config validation. A caller may shorten, never extend, the evidence window.
export function runtimeSmokeDeadline(config, now, requested = Infinity) {
  const start = config.mode === 'verify' ? Date.parse(config.collectionStartedAt) : now;
  const deadline = Math.min(requested, start + VERIFICATION_WINDOW_MS);
  if (!Number.isFinite(deadline)) fail('configuration');
  return deadline;
}

export function readRuntimeSmokeConfig(file, credentialFile) {
  // Same private directory as credentials; handled cleanup is not a SIGKILL guarantee.
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
const failureReasons = new Set(['configuration_invalid', 'disabled', 'identity_failed', 'parameters_not_ready',
  'runtime_unavailable', 'runtime_protocol', 'invalid_request', 'account_mismatch', 'gateway_unavailable',
  'tools_unavailable', 'inventory_unavailable', 'inventory_incomplete', 'inventory_stale', 'known_resource_missing', 'known_resource_unverified', 'model_failed', 'timeout']);
const parameterKeys = ['runtime_arn', 'interpreter_id', 'memory_id'];
const parameterStates = new Set(['uninspected', 'ready', 'disabled', 'pending', 'missing', 'denied', 'invalid', 'unavailable']);
function inventoryQuality(catalog, runs, started, now) {
  const types = { verified: [], partial: [], failed: [], stale: [], missing: [], unknown: [], pending: [], invalid: [] };
  for (const type of catalog) {
    const rows = runs.filter(row => row?.type === type && row.accountId === 'self');
    if (!rows.length) { types.missing.push(type); continue; }
    if (rows.length !== 1) { types.invalid.push(type); continue; }
    const row = rows[0];
    const fresh = freshTime(row.started_at, started, now) && freshTime(row.last_success_at, started, now);
    const known = finiteCount(row.row_count) && row.unknown_attribute_count === 0 && row.unknown_attributes === false;
    if (!fresh) types.stale.push(type);
    if (!known || row.status === 'unknown') types.unknown.push(type);
    if (['partial', 'failed'].includes(row.status)) types[row.status].push(type);
    else if (row.status === 'running') types.pending.push(type);
    else if (!['succeeded', 'unknown'].includes(row.status)) types.invalid.push(type);
    if (row.status === 'succeeded' && fresh && known) types.verified.push(type);
  }
  return { status: types.verified.length === catalog.length ? 'complete' : 'gaps', catalog_types: catalog,
    observed_at: new Date(now).toISOString(), since: new Date(started).toISOString(),
    counts: { expected: catalog.length, ...Object.fromEntries(Object.entries(types).map(([key, value]) => [key, value.length])) },
    types };
}
function readinessFailure(value, nonce, account) {
  if (value?.schemaVersion !== 1 || value.nonce !== nonce || value.accountId !== account
      || value.status !== 'not_ready' || !failureReasons.has(value.reason)) return 'runtime_protocol';
  if (value.reason !== 'parameters_not_ready') return `runtime_${value.reason}`;
  if (!exact(value.parameters, parameterKeys)
      || !Object.values(value.parameters).every(v => parameterStates.has(v))) return 'runtime_protocol';
  const failed = parameterKeys.filter(k => value.parameters[k] !== 'ready');
  if (!failed.length) return 'runtime_protocol';
  return `runtime_parameters_not_ready(${failed.map(k => `${k}=${value.parameters[k]}`).join(',')})`;
}

export async function verifyRuntimeSmoke(configuration, send, {
  now = Date.now, wait = ms => delay(ms), deadline = Infinity,
} = {}) {
  const config = validateRuntimeSmokeConfig(configuration, now());
  deadline = runtimeSmokeDeadline(config, now(), deadline);
  let quality;
  const request = async (path, options = {}) => {
    const remaining = deadline - now();
    if (remaining <= 0) fail('release_timeout', quality);
    let result;
    try {
      result = await send(path, { ...options, timeout: Math.max(1, Math.ceil(Math.min(options.timeout ?? 35_000, remaining))) });
    } catch (error) {
      if (now() >= deadline) fail('release_timeout', quality);
      throw error;
    }
    if (now() >= deadline) fail('release_timeout', quality);
    return result;
  };
  const { accounts } = await request('/api/accounts');
  if (!Array.isArray(accounts) || accounts.length > 1000
      || accounts.some(a => !object(a) || typeof a.enabled !== 'boolean' || typeof a.isHost !== 'boolean')
      || accounts.filter(a => a.isHost).length !== 1
      || accounts.filter(a => a.accountId === config.expectedAccountId && a.isHost && a.enabled).length !== 1
      || (config.hostOnly === true && accounts.some(a => a.enabled && a.accountId !== config.expectedAccountId))) fail('host_registry');
  if (config.mode === 'prepare') return { status: 'ok', mode: 'prepare' };

  async function poll(check, phase, seconds, collectionEnd = Infinity) {
    const end = Math.min(deadline, collectionEnd, now() + seconds * 1000);
    for (let attempt = 0; attempt <= seconds / 5 && now() < end; attempt++) {
      if (await check()) return;
      if (now() >= end) break;
      await wait(Math.min(5000, end - now()));
    }
    if (now() >= deadline) fail('release_timeout', quality);
    fail(typeof phase === 'function' ? phase() : phase, Number.isFinite(collectionEnd) ? quality : undefined);
  }
  const started = Date.parse(config.collectionStartedAt);
  const releaseWindow = config.collectionMode === 'release';
  const required = config.expectedQueuedTypes;
  const collectionEnd = Math.min(deadline, now() + (releaseWindow ? 1200 : 600) * 1000);
  let collectionFailure = 'collection_timeout';
  const readCollection = async () => {
    const summary = await request('/api/inventory/summary?accounts=self&view=collection');
    const c = summary?.collection;
    if (!object(c) || c.configured !== true || c.readOk !== true || !Array.isArray(c.runs))
      fail('collection_unavailable', { status: 'unavailable', catalog_types: required, counts: null, types: null });
    return c;
  };
  const verifyCollection = () => {
    collectionFailure = 'collection_timeout';
    return poll(async () => {
      const c = await readCollection();
      quality = inventoryQuality(config.expectedQueuedTypes, c.runs, started, now());
      const has = category => required.some(type => quality.types[category].includes(type));
      if (has('invalid')) fail('collection_protocol', quality);
      const recent = c.runs.filter(row => required.includes(row?.type) && row.accountId === 'self'
        && freshTime(row.started_at, started, now()));
      if (recent.some(row => row.status === 'succeeded' && freshTime(row.last_success_at, started, now())
        && (row.unknown_attribute_count !== 0 || row.unknown_attributes !== false))) fail('inventory_incomplete', quality);
      for (const status of ['partial', 'failed'])
        if (recent.some(row => row.status === status)) fail(`collection_${status}`, quality);
      collectionFailure = has('missing') ? 'collection_missing'
        : config.inventoryPolicy && has('stale') ? 'collection_stale' : 'collection_timeout';
      return required.every(type => quality.types.verified.includes(type));
    }, () => collectionFailure, releaseWindow ? 1200 : 600, collectionEnd);
  };
  await verifyCollection();

  let found = false;
  for (let offset = 0; offset < 500 && !found; offset += 5) {
    const page = await request(`/api/inventory/cloudfront?accounts=self&limit=5&offset=${offset}`, {
      maxResponseBytes: 2 * 1024 * 1024,
    });
    if (!Array.isArray(page?.rows) || page.rows.length > 5) fail('inventory_protocol');
    found = page.rows.some(row => row.account_id === 'self'
      && row.resource_id === config.expectedCloudfrontId && row.data?.id === config.expectedCloudfrontId
      && freshTime(row.captured_at, started, now()));
    if (page.rows.length < 5) break;
  }
  if (!found) fail('inventory_known_resource_unverified');
  const nonce = randomBytes(24).toString('hex');
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await request('/api/deployment/readiness', {
      method: 'POST', timeout: 80_000, status: ['200', '503'], withStatus: true, body: {
        nonce, expectedAccountId: config.expectedAccountId, expectedCloudfrontId: config.expectedCloudfrontId,
      },
    });
    if (response?.httpStatus !== 503 && response?.body?.status !== 'not_ready') break;
    const reason = readinessFailure(response?.body, nonce, config.expectedAccountId);
    if (!['runtime_inventory_incomplete', 'runtime_inventory_stale'].includes(reason)) fail(reason);
    const c = await readCollection();
    quality = inventoryQuality(required, c.runs, started, now());
    const rows = c.runs.filter(row => row?.type === 'cloudfront' && row.accountId === 'self');
    const competing = rows.length === 1 && rows[0].status === 'running'
      && freshTime(rows[0].started_at, started, now()) && freshTime(rows[0].last_success_at, started, now());
    if (!competing) fail(reason, quality);
    if (attempt === 1) fail('runtime_inventory_contention', quality);
    // Allow the per-process BFF cooldown only when the shared recheck window can still admit work.
    const retryAt = now() + 65_000;
    if (retryAt >= deadline) fail('release_timeout', quality);
    if (retryAt >= collectionEnd) fail('runtime_inventory_contention', quality);
    await wait(65_000);
    if (now() >= deadline) fail('release_timeout', quality);
    if (now() >= collectionEnd) fail('runtime_inventory_contention', quality);
    await verifyCollection();
  }
  const runtime = response?.body;
  if (response?.httpStatus !== 200) fail('runtime_protocol');
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
      || !finiteCount(agent.inventory?.count) || agent.inventory.count < 1 || agent.inventory.count > 500
      || !finiteCount(agent.inventory?.ageMinutes) || agent.inventory.ageMinutes > 1440) fail('runtime_protocol');

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
  return config.inventoryPolicy
    ? { status: 'ok', mode: 'verify', inventory_policy: config.inventoryPolicy,
      inventory_quality: quality, workers: 2 }
    : { status: 'ok', mode: 'verify', collected_types: config.expectedQueuedTypes.length, workers: 2 };
}
