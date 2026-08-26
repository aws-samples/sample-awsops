// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/charts/DonutBreakdown', () => ({ default: () => null }));

import CompliancePage from './page';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('CompliancePage', () => {
  // Match the LONGEST registered key contained in the URL so `/api/compliance/runs/7` resolves to
  // the run-detail entry, not the `/api/compliance/runs` list entry (substring of the former).
  function routedFetch(map: Record<string, unknown>) {
    const keys = Object.keys(map).sort((a, b) => b.length - a.length);
    return vi.fn((url: string) => {
      const key = keys.find((k) => String(url).includes(k));
      // Unmapped URL → 404 (not a silent success) so an endpoint typo fails the test.
      if (!key) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      return Promise.resolve({ ok: true, status: 200, json: async () => map[key] });
    });
  }

  it('renders the benchmark selector + Run button', async () => {
    vi.stubGlobal('fetch', routedFetch({
      '/api/compliance/benchmarks': { benchmarks: [{ id: 'cis_v300', name: 'CIS AWS v3.0.0', description: '' }] },
      '/api/compliance/runs': { runs: [] },
    }));
    render(<CompliancePage />);
    expect(screen.getByText('Run Benchmark')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('option', { name: 'CIS AWS v3.0.0' })).toBeTruthy());
  });

  it('renders the saved run history on mount', async () => {
    vi.stubGlobal('fetch', routedFetch({
      '/api/compliance/benchmarks': { benchmarks: [{ id: 'cis_v300', name: 'CIS AWS v3.0.0', description: '' }] },
      '/api/compliance/runs': { runs: [
        { id: 7, benchmark: 'cis_v300', status: 'succeeded', pass_rate: 82, started_at: '2026-06-18T00:00:00Z' },
      ] },
    }));
    render(<CompliancePage />);
    await waitFor(() => expect(screen.getByText('Recent runs')).toBeTruthy());
    expect(screen.getByText('succeeded')).toBeTruthy();
    expect(screen.getByText('82%')).toBeTruthy();
  });

  it('clicking a recent run loads its saved results via /runs/[id] (no re-run)', async () => {
    vi.stubGlobal('fetch', routedFetch({
      '/api/compliance/benchmarks': { benchmarks: [{ id: 'cis_v300', name: 'CIS AWS v3.0.0', description: '' }] },
      '/api/compliance/runs': { runs: [
        { id: 9, benchmark: 'cis_v300', status: 'succeeded', pass_rate: 75, started_at: '2026-06-18T00:00:00Z' },
      ] },
      // longest key → matched for /api/compliance/runs/9
      '/api/compliance/runs/': {
        run: { id: 9, benchmark: 'cis_v300', status: 'succeeded', pass_rate: 75, total_controls: 4, ok: 3, alarm: 1, info: 0, skip: 0, error: 0, started_at: '2026-06-18T01:23:45Z' },
        results: [{ control_id: '1.1', title: 'MFA', section: '1 IAM', status: 'alarm', reason: 'no mfa', resource: 'arn:user/b', region: 'us-east-1', severity: 'high' }],
      },
    }));
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    render(<CompliancePage />);
    await waitFor(() => expect(screen.getByText('cis_v300')).toBeTruthy());
    fireEvent.click(screen.getByText('cis_v300'));
    // run-detail loaded: the unique pass-rate stat (75.0%) + the control row (1.1 appears in both
    // the desktop table and the mobile card, hence getAllByText).
    await waitFor(() => expect(screen.getByText('75.0%')).toBeTruthy());
    expect(screen.getAllByText('1.1').length).toBeGreaterThan(0);
    // execution time identifies which run is shown (v1 parity)
    expect(screen.getByText(/^실행 /)).toBeTruthy();
    // viewing a saved run must NOT start a new benchmark (no POST /api/compliance/run)
    expect(fetchMock.mock.calls.every((c) => (c[1]?.method ?? 'GET') !== 'POST')).toBe(true);
  });

  it('adopts a running run on mount (refresh/new-tab) → Run disabled without any click', async () => {
    const runningRun = { id: 8, benchmark: 'cis_v300', status: 'running', pass_rate: null, total_controls: null, ok: null, alarm: null, info: null, skip: null, error: null, started_at: '2026-06-18T03:00:00Z' };
    vi.stubGlobal('fetch', routedFetch({
      '/api/compliance/benchmarks': { benchmarks: [{ id: 'cis_v300', name: 'CIS AWS v3.0.0', description: '' }] },
      '/api/compliance/runs': { runs: [runningRun] },
      '/api/compliance/runs/': { run: runningRun, results: [] },
    }));
    render(<CompliancePage />);
    // no click — the in-flight run is adopted from the history list, so Run is already busy/disabled
    await waitFor(() => expect(screen.getByText('실행 중…')).toBeTruthy());
  });
});
