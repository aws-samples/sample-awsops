import { describe, expect, it } from 'vitest';
import { inventoryAttempt } from './graph-inventory-read';

const finished = '2026-11-11T00:00:00.000Z';
const run = (type: string, status = 'succeeded') => ({ resource_type: type, account_id: 'self', status,
  started_at: finished, finished_at: finished, last_success_at: finished, row_count: 1, unknown_attribute_count: 0, version: '1' });
const point = (type: string) => ({ resource_type: type, resource_count: 1, captured_at: finished });
const row = (type: string) => ({ resource_type: type, resource_id: `${type}-1`, region: 'ap-northeast-2',
  account_id: 'self', captured_at: finished, data: {} });

function snapshot(runs: ReturnType<typeof run>[], types: string[]) {
  return { rows: types.map(row), types, runs, truncated: false, truncatedTypes: [],
    aggregateCounts: new Map(runs.map(r => [r.resource_type, 1])), participation: runs.map(r => point(r.resource_type)) };
}

describe('inventoryAttempt enrichment sources', () => {
  it('blocks publication when a core source has no ledger', () => {
    const attempt = inventoryAttempt(snapshot([run('target_group')], ['target_group', 'eni']) as never,
      ['target_group', 'eni'], 'flow', 'self', finished);
    expect(attempt.publish).toBe(false);
  });

  it('publishes a degraded graph and withholds only the enrichment rows that lack a ledger', () => {
    const attempt = inventoryAttempt(snapshot([run('target_group')], ['target_group', 'eni']) as never,
      ['target_group', 'eni'], 'flow', 'self', finished, new Set(['eni']));
    expect(attempt).toMatchObject({ publish: true, status: 'partial', withheldTypes: ['eni'],
      details: { withheldEnrichment: ['eni'] } });
    const eni = (attempt.details.sources as { sourceId: string; reasons: string[]; enrichment?: boolean }[])
      .find(s => s.sourceId === 'inventory:eni');
    expect(eni).toMatchObject({ enrichment: true, reasons: ['missing_ledger', 'enrichment_withheld'] });
  });

  it('withholds a failed enrichment source instead of feeding its stale rows to ownership', () => {
    const attempt = inventoryAttempt(snapshot([run('target_group'), run('eni', 'failed')], ['target_group', 'eni']) as never,
      ['target_group', 'eni'], 'flow', 'self', finished, new Set(['eni']));
    expect(attempt).toMatchObject({ publish: true, status: 'partial', withheldTypes: ['eni'] });
  });

  it('keeps a healthy enrichment source in the build without degrading the publication', () => {
    const attempt = inventoryAttempt(snapshot([run('target_group'), run('eni')], ['target_group', 'eni']) as never,
      ['target_group', 'eni'], 'flow', 'self', finished, new Set(['eni']));
    expect(attempt).toMatchObject({ publish: true, status: 'ok', withheldTypes: [] });
    expect(attempt.details).not.toHaveProperty('withheldEnrichment');
  });
});

describe('inventoryAttempt row-cap truncation', () => {
  const types = ['target_group', 'eni'];
  const cut = (truncatedTypes: string[]) => ({ ...snapshot([run('target_group'), run('eni')], types), truncated: true, truncatedTypes });

  it('keeps publishing when the cap only cut enrichment rows, withholding that type whole', () => {
    expect(inventoryAttempt(cut(['eni']) as never, types, 'flow', 'self', finished, new Set(['eni'])))
      .toMatchObject({ publish: true, status: 'partial', withheldTypes: ['eni'] });
  });

  it('blocks publication when the cap cut a core source', () => {
    expect(inventoryAttempt(cut(['target_group', 'eni']) as never, types, 'flow', 'self', finished, new Set(['eni'])).publish)
      .toBe(false);
  });
});
