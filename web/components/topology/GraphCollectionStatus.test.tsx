// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { readGraphState } from '@/lib/graph-state';
const language = vi.hoisted(() => ({ current: 'en' }));
vi.mock('@/components/shell/LanguageProvider', () => ({ useI18n: () => ({ lang: language.current }) }));
import GraphCollectionStatus from './GraphCollectionStatus';

afterEach(cleanup);

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

});
