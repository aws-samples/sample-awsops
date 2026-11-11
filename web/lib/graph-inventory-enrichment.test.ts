import { describe, expect, it } from 'vitest';
import { inventoryAttempt } from './graph-inventory-read';
import { inventorySourcesStale, projectGraphDetails } from './graph-state';

const recent = () => new Date(Date.now() - 60_000).toISOString();
const run = (type: string, status = 'succeeded', at = recent()) => ({ resource_type: type, account_id: 'self', status,
  started_at: at, finished_at: at, last_success_at: at, row_count: 1, unknown_attribute_count: 0, version: '1' });
const row = (type: string, at: string) => ({ resource_type: type, resource_id: `${type}-1`, region: 'ap-northeast-2',
  account_id: 'self', captured_at: at, data: {} });

function snapshot(runs: ReturnType<typeof run>[], types: string[], extra: Record<string, unknown> = {}) {
  const at = runs[0]?.finished_at ?? recent();
  return { rows: types.map(type => row(type, runs.find(r => r.resource_type === type)?.finished_at ?? at)), types, runs,
    truncated: false, truncatedTypes: [], aggregateCounts: new Map(runs.map(r => [r.resource_type, 1])),
    participation: runs.map(r => ({ resource_type: r.resource_type, resource_count: 1, captured_at: r.finished_at })), ...extra };
}
const types = ['target_group', 'eni'];
const attempt = (snap: ReturnType<typeof snapshot>, enrichment = new Set(['eni'])) =>
  inventoryAttempt(snap as never, types, 'flow', 'self', recent(), enrichment);
const sourceIds = (a: ReturnType<typeof attempt>) => (a.details.sources as { sourceId: string }[]).map(s => s.sourceId);

describe('inventoryAttempt enrichment sources', () => {
  it('still blocks publication when a core source has no ledger', () => {
    expect(attempt(snapshot([run('target_group')], types), new Set()).publish).toBe(false);
  });

  it.each([
    ['has no ledger', [run('target_group')]],
    ['failed', [run('target_group'), run('eni', 'failed')]],
    ['is still running', [run('target_group'), run('eni', 'running')]],
    ['is older than the inventory freshness threshold', [run('target_group'), run('eni', 'succeeded', new Date(Date.now() - 3 * 3600_000).toISOString())]],
  ])('withholds an enrichment source that %s without touching core status or freshness', (_label, runs) => {
    const result = attempt(snapshot(runs, types));
    expect(result).toMatchObject({ publish: true, status: 'ok', withheldTypes: ['eni'] });
    // Core sources only: readers, freshness and the reason vocabulary never see enrichment.
    expect(sourceIds(result)).toEqual(['inventory:target_group']);
    expect(inventorySourcesStale(result.details.sources)).toBe(false);
    expect(projectGraphDetails(result.details)).not.toHaveProperty('metadataTruncated');
    expect((result.details.enrichmentSources as { sourceId: string }[]).map(s => s.sourceId)).toEqual(['inventory:eni']);
  });

  it('keeps a confirmed, fresh enrichment source in the build', () => {
    const result = attempt(snapshot([run('target_group'), run('eni')], types));
    expect(result).toMatchObject({ publish: true, status: 'ok', withheldTypes: [] });
    expect(sourceIds(result)).toEqual(['inventory:target_group']);
  });
});

describe('inventoryAttempt row-cap truncation', () => {
  const cut = (truncatedTypes: string[]) => snapshot([run('target_group'), run('eni')], types, { truncated: true, truncatedTypes });

  it('keeps the core graph whole when the cap only cut enrichment rows, withholding that type', () => {
    const result = attempt(cut(['eni']));
    expect(result).toMatchObject({ publish: true, status: 'ok', withheldTypes: ['eni'] });
    expect(result.details).not.toHaveProperty('inputTruncated');
  });

  it('blocks publication when the cap cut a core source', () => {
    expect(attempt(cut(['target_group', 'eni'])).publish).toBe(false);
  });
});
