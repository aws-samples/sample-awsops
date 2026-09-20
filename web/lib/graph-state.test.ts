import { afterEach, describe, expect, it, vi } from 'vitest';
import { inventorySourcesStale, projectGraphDetails, readGraphState } from './graph-state';

afterEach(() => vi.unstubAllEnvs());

describe('graph state during rollout', () => {
  it('preserves the legacy unknown trace envelope while inventory kind remains explicit', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await readGraphState(pool as never, 'self', 'trace')).toEqual({
      status: 'unknown', stale: true, attempted_at: null, captured_at: null, sources: [],
    });
    expect(await readGraphState(pool as never, 'self', 'infra')).toMatchObject({ evidenceKind: 'inventory' });
  });
  it('reports unknown collection before its additive migration is applied', async () => {
    const pool = { query: vi.fn(async () => { throw Object.assign(new Error('missing relation'), { code: '42P01' }); }) };
    await expect(readGraphState(pool as never, 'self')).resolves.toMatchObject({ status: 'unknown', stale: true });
  });
  it('does not disguise permission failures as an unmigrated schema', async () => {
    const pool = { query: vi.fn(async () => { throw Object.assign(new Error('denied'), { code: '42501' }); }) };
    await expect(readGraphState(pool as never, 'self')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('inventory capture quality', () => {
  it.each([
    { status: 'ok', itemCount: 0 },
    { capturedAtMs: 'invalid' },
    { capturedAtMs: -1 },
    { capturedAtMs: Date.now() + 60_000 },
    { reasons: ['cap_reached'] },
    { reasons: ['unknown_attributes'] },
    { reasons: ['future_reason'] },
    { reasons: null },
  ])('rejects contradictory or incomplete successful-empty evidence: %j', override => {
    expect(inventorySourcesStale([{ status: 'empty', producerStatus: 'succeeded', itemCount: 0,
      lastSuccessAtMs: Date.now() - 1000, ...override }])).toBe(true);
  });
  it('accepts an explicit successful zero with a nullable capture and no coverage reasons', () => {
    expect(inventorySourcesStale([{ status: 'empty', producerStatus: 'succeeded', itemCount: 0,
      capturedAtMs: null, lastSuccessAtMs: Date.now() - 1000, reasons: [] }])).toBe(false);
  });
  it.each([undefined, null, -1, false, '0', 0.5])('missing or invalid row count %s cannot certify capture', itemCount => {
    expect(inventorySourcesStale([{ status: 'ok', itemCount, lastSuccessAtMs: Date.now() - 1000 }])).toBe(true);
  });
  it('requires capture for nonempty data but allows durable successful zero', () => {
    const source = { status: 'ok', producerStatus: 'succeeded', itemCount: 1, lastSuccessAtMs: Date.now() - 1000 };
    expect(inventorySourcesStale([source])).toBe(true);
    expect(inventorySourcesStale([{ ...source, status: 'empty', itemCount: 0 }])).toBe(false);
  });
  it.each(['0', '1441', 'NaN', '30.5'])('invalid threshold %s falls back to the inventory 30 minute policy', threshold => {
    vi.stubEnv('INVENTORY_STALE_AFTER_MINUTES', threshold);
    expect(inventorySourcesStale([{ status: 'empty', producerStatus: 'succeeded', itemCount: 0, lastSuccessAtMs: Date.now() - 31 * 60_000 }])).toBe(true);
  });
});

const malformedMetadata = [
  ...['status', 'producerStatus', 'scope'].flatMap(key => [null, false, {}, 'future_value']
    .map(value => ({ sources: [{ sourceId: 'inventory:vpc', [key]: value }] }))),
  ...['itemCount', 'windowStartMs', 'windowEndMs', 'capturedAtMs', 'lastSuccessAtMs', 'attemptedAtMs', 'finishedAtMs']
    .flatMap(key => [-1, '123', 8640000000000001].map(value => ({ publishedSources: [{ sourceId: 'inventory:vpc', [key]: value }] }))),
  { windowStartMs: -1 }, { nodeDrops: '3' }, { infraUnavailable: 'true' },
  { failureReason: 'future_value' }, { metadataTruncated: null },
];
it.each(malformedMetadata)('discloses rejected recognized metadata: %j', details => {
  expect(projectGraphDetails(details).metadataTruncated).toBe(true);
});

describe('graph producer and scope honesty', () => {
  it('does not expose the internal scheduling clock or mutate stored details', async () => {
    const details = { sourceAttempted: false, lastSourceAttemptedAtMs: 1000, sources: [] };
    const query = vi.fn().mockResolvedValue({ rows: [{ status: 'unavailable', details }] });
    const state = await readGraphState({ query }, 'self', 'infra');
    expect(state).not.toHaveProperty('lastSourceAttemptedAtMs');
    expect(details.lastSourceAttemptedAtMs).toBe(1000);
  });
  it.each(['failed', 'running', 'partial', 'unknown', undefined])('does not certify fresh producer status %s', producerStatus => {
    expect(inventorySourcesStale([{ status: 'empty', producerStatus, itemCount: 0, lastSuccessAtMs: Date.now() - 1000 }])).toBe(true);
  });
  it('reads the host trace state for an all-account selector without extending inventory coverage', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ status: 'ok', captured_at: new Date().toISOString(), details: {} }] });
    expect(await readGraphState({ query } as never, '__all__', 'trace')).toMatchObject({ status: 'ok' });
    expect(query.mock.calls[0][1]).toEqual(['self', 'trace']);
    query.mockClear();
    expect(await readGraphState({ query } as never, '__all__', 'infra')).toMatchObject({ status: 'unknown', coverage: 'unknown', evidenceKind: 'inventory' });
    expect(query).not.toHaveBeenCalled();
  });
});


it('projects bounded HTTP collection metadata and removes injected read fields', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ status: 'ok', captured_at: new Date(), attempted_at: new Date(),
    details: { secret: 'PRIVATE', readReason: 'PRIVATE', readStatus: 'ok', coverage: 'PRIVATE',
      sources: Array.from({ length: 129 }, (_, i) => ({ sourceId: `tempo:${i}`, status: 'ok', secret: 'PRIVATE',
        reasons: ['query_failed', 'PRIVATE'] })),
      publishedSources: [{ sourceId: 'inventory:vpc', status: 'partial', producerStatus: 'running', secret: 'PRIVATE' }] } }] });
  const result = await readGraphState({ query } as never, 'self', 'infra');
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(result).not.toHaveProperty('readStatus');
  expect(result).not.toHaveProperty('coverage');
  expect(result).toMatchObject({ metadataTruncated: true, stale: true });
  expect(result.sources).toHaveLength(128);
  expect(result.publishedSources?.[0]).toEqual({ sourceId: 'inventory:vpc', status: 'partial', producerStatus: 'running', reasons: [] });
});

it('rejects future publication clocks and contradictory empty source counts', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ status: 'ok', captured_at: new Date(Date.now() + 60000), details: { sources: [] } }] });
  expect((await readGraphState({ query } as never, 'self')).stale).toBe(true);
  expect(inventorySourcesStale([{ status: 'empty', producerStatus: 'succeeded', itemCount: 1,
    capturedAtMs: Date.now() - 1000, lastSuccessAtMs: Date.now() - 1000 }])).toBe(true);
});
