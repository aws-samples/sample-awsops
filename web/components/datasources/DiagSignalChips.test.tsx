// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import DiagSignalChips from './DiagSignalChips';

const SIGNALS = {
  ready: [{ signalKey: 'oom_kills', title: 'OOM Kill',
            query: { tool: 'prometheus_query', queries: [{ label: 'l', expr: 'max_over_time(x[1h])' }] } }],
  unavailable: [{ signalKey: 'node_disk_usage', title: '노드 디스크',
                  missingMetrics: ['node_filesystem_avail_bytes'] }],
};

const LOKI_SIGNALS = {
  ready: [{ signalKey: 'loki_error_count', title: '에러 로그 수(5분)',
            query: { tool: 'loki_query_range', queries: [{ label: 'error_rate', expr: 'sum by(job) (count_over_time({job=~".+"} |~ "(?i)error|exception|fatal" [5m]))' }] } }],
  unavailable: [],
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => SIGNALS })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('DiagSignalChips', () => {
  it('renders ready (clickable) + unavailable (disabled) chips for prometheus', async () => {
    const onPick = vi.fn();
    render(<DiagSignalChips instanceId={7} kind="prometheus" onPick={onPick} />);
    await waitFor(() => screen.getByText('OOM Kill'));
    expect((global.fetch as any)).toHaveBeenCalledWith('/api/datasources/7/diag-signals');
    fireEvent.click(screen.getByText('OOM Kill'));
    expect(onPick).toHaveBeenCalledWith('max_over_time(x[1h])');
    // unavailable chip is present, NOT a button, with a missing-metric tooltip
    const un = screen.getByTestId('diag-chip-unavailable');
    expect(un.tagName).not.toBe('BUTTON');
    expect(un.getAttribute('title')).toMatch(/node_filesystem_avail_bytes/);
  });

  it('renders chips for a non-prom/mimir kind (loki) now that it has its own catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => LOKI_SIGNALS })));
    const onPick = vi.fn();
    render(<DiagSignalChips instanceId={7} kind="loki" onPick={onPick} />);
    await waitFor(() => screen.getByText('에러 로그 수(5분)'));
    expect((global.fetch as any)).toHaveBeenCalledWith('/api/datasources/7/diag-signals');
    fireEvent.click(screen.getByText('에러 로그 수(5분)'));
    expect(onPick).toHaveBeenCalledWith('sum by(job) (count_over_time({job=~".+"} |~ "(?i)error|exception|fatal" [5m]))');
  });

  it('clears the previous instance chips when the switch fetch fails', async () => {
    // Before the kind gate was removed, switching to a non-prom kind hit `!enabled` and cleared. Now
    // `enabled = !!instanceId`, so a failed fetch after a switch used to leave the OLD instance's chips
    // on screen — and clicking a loki chip while a clickhouse instance is selected sends LogQL to the
    // clickhouse connector (review MAJOR).
    const { rerender } = render(<DiagSignalChips instanceId={7} kind="loki" onPick={vi.fn()} />);
    await waitFor(() => screen.getByText('OOM Kill'));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    rerender(<DiagSignalChips instanceId={8} kind="clickhouse" onPick={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('OOM Kill')).toBeNull());
    expect(screen.queryByTestId('diag-signal-chips')).toBeNull();
  });

  it('renders nothing without an instanceId', async () => {
    render(<DiagSignalChips kind="prometheus" onPick={vi.fn()} />);
    expect(screen.queryByTestId('diag-signal-chips')).toBeNull();
  });
});
