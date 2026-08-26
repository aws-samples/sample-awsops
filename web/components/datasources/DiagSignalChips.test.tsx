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

  it('renders nothing for a non-prom/mimir kind (no fetch)', async () => {
    render(<DiagSignalChips instanceId={7} kind="loki" onPick={vi.fn()} />);
    expect(screen.queryByTestId('diag-signal-chips')).toBeNull();
    expect((global.fetch as any)).not.toHaveBeenCalled();
  });

  it('renders nothing without an instanceId', async () => {
    render(<DiagSignalChips kind="prometheus" onPick={vi.fn()} />);
    expect(screen.queryByTestId('diag-signal-chips')).toBeNull();
  });
});
