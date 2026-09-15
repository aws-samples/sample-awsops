// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { readGraphState } from '@/lib/graph-state';
const language = vi.hoisted(() => ({ current: 'en' }));
vi.mock('@/components/shell/LanguageProvider', () => ({ useI18n: () => ({ lang: language.current }) }));
import GraphCollectionStatus from './GraphCollectionStatus';
import * as CollectionStatusContract from './GraphCollectionStatus';

afterEach(cleanup);

describe('shared collection loss contract', () => {
  beforeEach(() => { language.current = 'en'; });
  it('exports exactly the five existing loss fields', () => {
    expect(CollectionStatusContract.COLLECTION_LOSS_KEYS).toEqual([
      'nodeDrops', 'edgeDrops', 'orphanSpans', 'invalidSpans', 'unresolvedMessaging',
    ]);
  });
  it.each([
    [0, true], [1, true], [Number.MAX_SAFE_INTEGER, true],
    [-1, false], [0.5, false], [NaN, false], [Infinity, false],
    [Number.MAX_SAFE_INTEGER + 1, false], ['3', false], [null, false],
    [undefined, false], [true, false], [{}, false],
  ])('validates shared count %s as %s', (value, expected) => {
    expect(typeof CollectionStatusContract.isCollectionLossCount).toBe('function');
    expect(CollectionStatusContract.isCollectionLossCount(value)).toBe(expected);
  });
  it.each([
    ['ko', '수집 한계'], ['en', 'Collection limitations'],
    ['ja', '収集上の制限'], ['zh', '采集限制'],
  ])('groups all five losses and unavailable context accessibly in %s', (lang, label) => {
    language.current = lang;
    render(<GraphCollectionStatus collection={{ status: 'partial', nodeDrops: 1, edgeDrops: 2,
      orphanSpans: 3, invalidSpans: 4, unresolvedMessaging: 5, infraUnavailable: true }} />);
    const list = screen.getByRole('list', { name: label });
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    expect(list.closest('details')).toBeNull();
    expect(screen.getByRole('alert').contains(list)).toBe(true);
    if (lang !== 'ko') expect(list.textContent).not.toMatch(/[가-힣]/);
  });
  it('groups unavailable inventory without inventing a numeric loss', () => {
    render(<GraphCollectionStatus collection={{ status: 'partial', infraUnavailable: true }} />);
    const list = screen.getByRole('list', { name: 'Collection limitations' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list.textContent).toBe('Inventory context unavailable');
  });
  it.each([
    {}, { nodeDrops: 0, edgeDrops: 0, orphanSpans: 0, invalidSpans: 0, unresolvedMessaging: 0 },
    { nodeDrops: -1, edgeDrops: 0.5, orphanSpans: '3', invalidSpans: Infinity,
      unresolvedMessaging: Number.MAX_SAFE_INTEGER + 1, infraUnavailable: 'true', itemCount: 17 },
  ])('does not create a loss group from absent, zero or invalid counters: %j', counters => {
    render(<GraphCollectionStatus collection={{ status: 'unknown', stale: false, ...counters }} />);
    expect(screen.queryByRole('list', { name: 'Collection limitations' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Collection state unknown');
  });
  it.each([false, true])('preserves full saved reasons and six clocks without changing retention=%s', retainedPrevious => {
    const times = Array.from({ length: 6 }, (_, i) => Date.parse('2026-09-14T09:00:00Z') + i * 60_000);
    const { container } = render(<GraphCollectionStatus collection={{
      status: 'partial', retainedPrevious,
      sources: [{ sourceId: 'current', status: 'ok', reasons: ['current_reason'] }],
      publishedSources: [{ sourceId: 'saved', status: 'partial', scope: 'account',
        producerStatus: 'failed', reasons: ['saved_cap', null, { message: 'PRIVATE' }],
        capturedAtMs: times[0], lastSuccessAtMs: times[1], attemptedAtMs: times[2],
        finishedAtMs: times[3], windowStartMs: times[4], windowEndMs: times[5] }],
    }} />);
    const details = container.querySelector('details')!;
    const saved = Array.from(details.querySelectorAll('li')).find(item => item.textContent?.startsWith('saved'))!;
    expect(saved.textContent).toContain('Partial collection');
    expect(saved.textContent).toContain('account');
    expect(saved.textContent).toContain('saved_cap');
    expect(saved.textContent).toContain('Producer status: failed');
    expect(saved.textContent).not.toMatch(/PRIVATE|\[object Object\]/);
    expect(Array.from(saved.querySelectorAll('time'), item => item.dateTime))
      .toEqual(times.map(time => new Date(time).toISOString()));
    expect(details.open).toBe(false);
    expect(details.querySelector('[data-source-details]')?.className).toContain('overflow-y-auto');
    expect(details.querySelector('summary')?.textContent).toContain('Source details (2)');
    expect(container.textContent).not.toContain('Same displayed source evidence as above.');
  });
});

describe('graph collection status', () => {
  beforeEach(() => { language.current = 'en'; });
  it.each([
    ['orphanSpans', 'Unresolved span parents/links'],
    ['invalidSpans', 'Invalid spans'],
    ['unresolvedMessaging', 'Unresolved messaging spans'],
  ])('explains %s without mislabeling it as a processing limit', async (key, label) => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{
      status: 'partial', attempted_at: new Date(), captured_at: new Date(),
      details: { [key]: 2, retainedPrevious: false, sources: [] },
    }] }) } as unknown as Pool;
    const collection = JSON.parse(JSON.stringify(await readGraphState(pool, 'self')));
    render(<GraphCollectionStatus collection={collection} />);
    const text = screen.getByRole('alert').textContent;
    expect(text).toContain(`${label}: 2`);
    expect(text).not.toContain('Processing limit');
    expect(text).not.toContain('previous graph retained');
  });
  it('does not interpret ordinary numeric metadata as loss evidence', () => {
    render(<GraphCollectionStatus collection={{ status: 'ok', stale: false, itemCount: 12, spanCount: 99 }} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).not.toContain('Processing limit');
  });
  it('renders trace windows and legacy loss/context evidence from the state reader', async () => {
    const start = Date.parse('2026-09-14T09:00:00Z');
    const end = Date.parse('2026-09-14T10:00:00Z');
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{
      status: 'partial', attempted_at: new Date(), captured_at: new Date(),
      details: {
        nodeDrops: 2, edgeDrops: 3, infraUnavailable: true, retainedPrevious: false,
        sources: [{ sourceId: 'tempo:fixture', status: 'ok', itemCount: 4,
          windowStartMs: start, windowEndMs: end }],
      },
    }] }) } as unknown as Pool;
    const collection = JSON.parse(JSON.stringify(await readGraphState(pool, 'self')));
    const { container } = render(<GraphCollectionStatus collection={collection} />);
    const text = screen.getByRole('alert').textContent;
    expect(text).toContain('Nodes omitted: 2');
    expect(text).toContain('Edges omitted: 3');
    expect(text).toContain('Inventory context unavailable');
    expect(text).not.toContain('previous graph retained');
    expect(text).toContain('Source window start');
    expect(text).toContain('Source window end');
    const times = Array.from(container.querySelectorAll('time'), time => time.dateTime);
    expect(times).toContain('2026-09-14T09:00:00.000Z');
    expect(times).toContain('2026-09-14T10:00:00.000Z');
  });
  it('counts saved sources when the latest attempt has none', () => {
    const { container } = render(<GraphCollectionStatus collection={{
      status: 'error', stale: true, retainedPrevious: true, sources: [],
      publishedSources: [{ sourceId: 'tempo:saved', status: 'ok' }],
    }} />);
    expect(container.querySelector('summary')?.textContent).toContain('Source details (1)');
  });
  it.each([false, true])('shows identical current/saved evidence once while preserving saved provenance (retained=%s)', retainedPrevious => {
    const source = { sourceId: 'inventory:vpc', status: 'ok', producerStatus: 'succeeded',
      itemCount: 1, capturedAtMs: 1789380000000, lastSuccessAtMs: 1789380000000, reasons: [] };
    const { container } = render(<GraphCollectionStatus collection={{
      status: 'ok', retainedPrevious, sources: [source],
      publishedSources: [{ ...source }],
    }} />);
    expect(container.querySelector('summary')?.textContent).toContain('Source details (1)');
    expect(container.querySelectorAll('li')).toHaveLength(1);
    expect(container.textContent).toContain('Sources used by saved graph');
    expect(container.textContent).toContain('Same displayed source evidence as above.');
    if (retainedPrevious) expect(container.textContent).toContain('previous graph');
  });
  it('keeps differing saved capture evidence separate', () => {
    const source = { sourceId: 'inventory:vpc', status: 'ok', capturedAtMs: 1789380000000 };
    const { container } = render(<GraphCollectionStatus collection={{
      status: 'ok', sources: [source], publishedSources: [{ ...source, capturedAtMs: 1789376400000 }],
    }} />);
    expect(container.querySelector('summary')?.textContent).toContain('Source details (2)');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.textContent).not.toContain('Same displayed source evidence as above.');
  });
  it('collapses dozens of sources while keeping quality counts and saved-source details accessible', () => {
    const { container } = render(<GraphCollectionStatus collection={{
      status: 'partial', stale: true, retainedPrevious: true,
      sources: Array.from({ length: 48 }, (_, i) => ({ sourceId: `inventory:type_${i}`, status: i ? 'ok' : 'partial' })),
      publishedSources: [{ sourceId: 'inventory:saved', status: 'ok', capturedAtMs: 1789380000000 }],
    }} />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    const summary = container.querySelector('summary')!;
    expect(summary.textContent).toContain('49');
    expect(summary.textContent).toContain('47');
    expect(summary.textContent).toContain('1 partial');
    expect(summary.textContent).toContain('Latest attempt sources: 48');
    expect(summary.textContent).toContain('Saved sources: 1');
    // Hidden source content remains mounted; native toggling is covered by the browser suite.
    expect(details?.querySelectorAll('li')).toHaveLength(49);
    expect(details?.textContent).toContain('Sources used by saved graph');
    expect(screen.getByRole('alert').textContent).toContain('previous graph');
  });
  it('identifies failed collection and retained data without claiming no traffic', () => {
    render(<GraphCollectionStatus collection={{
      status: 'error', stale: true, retainedPrevious: true,
      sources: [{ sourceId: 'tempo:1', status: 'error' }],
    }} />);
    expect(screen.getByRole('alert').textContent).toContain('Collection failed');
    expect(screen.getByRole('alert').textContent).toContain('previous graph');
    expect(screen.queryByText('No observations in this window')).toBeNull();
  });

  it('labels a successful empty read separately from unavailable telemetry', () => {
    render(<GraphCollectionStatus collection={{ status: 'empty', stale: false }} />);
    expect(screen.getByRole('status').textContent).toContain('No observations in this window');
  });

  it('does not describe a stale successful snapshot as current', () => {
    render(<GraphCollectionStatus collection={{ status: 'ok', stale: true }} />);
    expect(screen.getByRole('alert').textContent).toContain('Stale');
  });

  it('shows inventory capture, successful source sweep, attempt and publication as different clocks', () => {
    const { container } = render(<GraphCollectionStatus collection={{
      status: 'error', stale: true, retainedPrevious: true, evidenceKind: 'inventory',
      attempted_at: '2026-09-14T12:00:00Z', captured_at: '2026-09-14T11:00:00Z',
      sources: [{ sourceId: 'inventory:alb', status: 'error', scope: 'aggregate',
        capturedAtMs: Date.parse('2026-09-14T09:00:00Z'), lastSuccessAtMs: Date.parse('2026-09-14T10:00:00Z') }],
    }} />);
    expect(container.querySelectorAll('time')).toHaveLength(4);
    expect(screen.getByRole('alert').textContent).toContain('Source capture');
    expect(screen.getByRole('alert').textContent).toContain('Last successful sweep');
    expect(screen.getByRole('alert').textContent).toContain('aggregate');
  });
  it('keeps saved source capture visible when the latest attempt returned no rows', () => {
    const { container } = render(<GraphCollectionStatus collection={{
      status: 'error', stale: true, evidenceKind: 'inventory', retainedPrevious: true,
      sources: [{ sourceId: 'inventory:alb', status: 'error', itemCount: 0 }],
      publishedSources: [{ sourceId: 'inventory:alb', status: 'ok', itemCount: 1,
        capturedAtMs: Date.parse('2026-09-14T09:00:00Z') }],
    }} />);
    expect(container.querySelector('time')?.dateTime).toBe('2026-09-14T09:00:00.000Z');
    expect(screen.getByRole('alert').textContent).toContain('Sources used by saved graph');
  });
});

describe('GraphCollectionStatus', () => {
  beforeEach(() => { language.current = 'ko'; });
  it.each([undefined, null, {}, { status: 'unknown' }])('keeps absent or unknown metadata neutral: %j', collection => {
    render(<GraphCollectionStatus collection={collection} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('수집 상태 미확인');
    expect(screen.getByRole('status').className).not.toContain('amber');
  });

  it.each([
    { status: 'partial', stale: false, sources: [{ sourceId: 'tempo:fixture', status: 'error', reasons: ['timeout'] }] },
    { status: 'ok', stale: true },
    { status: 'ok', stale: false, retainedPrevious: true },
    { status: 'error', stale: false },
  ])('preserves a provided collection warning: %j', collection => {
    render(<GraphCollectionStatus collection={collection} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    if ('sources' in collection) {
      expect(screen.getByRole('alert').textContent).toContain('tempo:fixture');
      expect(screen.getByRole('alert').textContent).toContain('timeout');
    }
  });

  it.each([false, 7, 'invalid', []])('treats malformed collection payloads as unknown: %j', collection => {
    render(<GraphCollectionStatus collection={collection} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('수집 상태 미확인');
  });

  it('normalizes malformed sources and displays only string failure reasons', () => {
    render(<GraphCollectionStatus collection={{
      status: 'partial', sources: [
        null, false, [],
        { sourceId: 123, status: 'retained', reasons: 'invalid' },
        { sourceId: 'tempo:fixture', status: 'error', reasons: ['timeout', null, { message: 'invalid' }] },
      ],
    }} />);
    expect(screen.getAllByRole('listitem', { hidden: true })).toHaveLength(5);
    expect(screen.getByRole('alert').textContent).toContain('tempo:fixture: 수집 실패 · timeout');
    expect(screen.getByRole('alert').textContent).not.toContain('[object Object]');
    expect(screen.getByRole('alert').textContent).not.toContain('invalid');
  });

  it('discloses an unattempted source read without claiming collection failure', () => {
    render(<GraphCollectionStatus collection={{ status: 'unavailable', sourceAttempted: false,
      failureReason: 'not_attempted', retainedPrevious: true }} />);
    expect(screen.getByRole('alert').textContent).toContain('실행 예산으로 원본 조회를 시도하지 않음');
  });

  it('renders attempt and saved timestamps while omitting invalid values', () => {
    const attempted = '2026-09-12T12:00:00Z';
    const captured = '2026-09-11T12:00:00Z';
    const { container, rerender } = render(<GraphCollectionStatus collection={{
      status: 'error', retainedPrevious: true, attempted_at: attempted, captured_at: captured,
    }} />);
    expect(Array.from(container.querySelectorAll('time'), time => time.dateTime)).toEqual([attempted, captured]);
    expect(screen.getByRole('alert').textContent).toContain('최근 수집 시도');
    expect(screen.getByRole('alert').textContent).toContain('저장된 그래프 시각');
    expect(screen.getByRole('alert').textContent).toContain('이전 그래프');
    rerender(<GraphCollectionStatus collection={{ status: 'unknown', attempted_at: 'invalid', captured_at: {} }} />);
    expect(container.querySelectorAll('time')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).not.toContain('Invalid Date');
  });
  it('shows read failures and truncation separately from collection failure', () => {
    language.current = 'en';
    const { rerender } = render(<GraphCollectionStatus collection={{ status: 'unknown', failureReason: 'state_read_failed',
      readStatus: 'partial', readTruncated: true }} />);
    expect(screen.getByRole('alert').textContent).toContain('Collection metadata could not be read');
    expect(screen.getByRole('alert').textContent).toContain('Graph read limit');
    expect(screen.getByRole('alert').textContent).not.toContain('Collection failed');
    rerender(<GraphCollectionStatus collection={{ status: 'unknown', readStatus: 'unavailable' }} />);
    expect(screen.getByRole('alert').textContent).toContain('Graph read unavailable');
  });
  it('shows saved-source clocks on stale successful publications and explicit producer status', () => {
    language.current = 'en';
    render(<GraphCollectionStatus collection={{ status: 'ok', stale: true,
      windowStartMs: 1789360000000, windowEndMs: 1789360100000,
      publishedSources: [{ sourceId: 'inventory:vpc', producerStatus: 'running',
        attemptedAtMs: 1789360200000, finishedAtMs: 1789360300000 }] }} />);
    expect(screen.getByRole('alert').textContent).toContain('Saved sources: 1');
    expect(screen.getByRole('alert').textContent).toContain('Producer status: running');
    expect(screen.getByRole('alert').querySelectorAll('time')).toHaveLength(4);
  });

  it('labels graph-attempt and per-source windows separately', () => {
    language.current = 'en';
    render(<GraphCollectionStatus collection={{ status: 'ok', stale: false,
      windowStartMs: 1789360000000, windowEndMs: 1789360200000,
      sources: [{ sourceId: 'tempo:1', status: 'ok', windowStartMs: 1789360050000, windowEndMs: 1789360150000 }] }} />);
    expect(screen.getByText('Graph attempt window start', { exact: false })).toBeTruthy();
    expect(screen.getByText('Graph attempt window end', { exact: false })).toBeTruthy();
    expect(screen.getAllByText('Source window start', { exact: false })).toHaveLength(1);
    expect(screen.getAllByText('Source window end', { exact: false })).toHaveLength(1);
  });

  it('renders absent collection metadata as neutral information without a stale assertion', () => {
    language.current = 'en';
    render(<GraphCollectionStatus collection={{ status: 'unknown', stale: true,
      attempted_at: null, captured_at: null, sources: [], evidenceKind: 'inventory', readStatus: 'ok' }} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('No collection state recorded');
    expect(screen.getByRole('status').textContent).not.toContain('Stale data');
  });
  it.each([
    { failureReason: 'state_read_failed' }, { readStatus: 'unavailable' },
    { readStatus: 'partial', readTruncated: true }, { metadataTruncated: true },
  ])('keeps real read/disclosure failures actionable despite unknown collection: %s', extra => {
    language.current = 'en';
    render(<GraphCollectionStatus collection={{ status: 'unknown', stale: true,
      attempted_at: null, captured_at: null, sources: [], ...extra }} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

});
