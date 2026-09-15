// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ lang: 'en', tt: (s: string) => s, t: (s: string) => s }),
}));
import JobsPage from './page';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('workload observations', () => {
  it('keeps unknown timing visible and applies an explicit completion target', async () => {
    const fetcher = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        summary: { sampled: 1, totalCount: 1, coverage: 'partial', targetMs: null,
          attainment: null, p95Ms: null, unknown: 1, statuses: { succeeded: 1 } },
        jobs: [{ job_id: 'legacy-job', type: 'report', status: 'succeeded', created_at: '2026-09-11',
          timing: { correlationId: 'legacy-job', waitMs: null, workerLifecycleMs: null, totalMs: null } }],
      }),
    }));
    vi.stubGlobal('fetch', fetcher);
    render(<JobsPage />);
    await screen.findByText('No completion target selected');
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Completion target (seconds)'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('targetMs=45000'))).toBe(true));
  });
});
