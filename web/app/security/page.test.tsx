// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// recharts ResponsiveContainer measures 0×0 in jsdom — stub the chart to keep the page test focused.
vi.mock('@/components/charts/DonutBreakdown', () => ({ default: () => null }));

import SecurityPage from './page';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mockFetch(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}

describe('SecurityPage', () => {
  it('renders the disabled notice when enabled:false', async () => {
    mockFetch({ enabled: false, summary: {}, findings: {} });
    render(<SecurityPage />);
    await waitFor(() => expect(screen.getByText(/Security inventory is disabled/i)).toBeTruthy());
  });

  it('shows the loading line while the first fetch is in flight (gap L246)', async () => {
    // a fetch that never resolves → data stays null → the page must NOT render zero tiles
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    render(<SecurityPage />);
    expect(screen.getByText('로딩 중…')).toBeTruthy();
    expect(screen.queryByText('Public S3 Buckets')).toBeNull();
  });

  it('renders the issues-summary bars with zero bars filtered (gap L245)', async () => {
    mockFetch({
      enabled: true,
      summary: { public_s3: 2, open_sg: 0, unencrypted_ebs: 0, iam_no_mfa: 0, ecr_cve: 1 },
      findings: { ecr_cve: [{ resource_id: 'repo', region: 'r', severity: 'high', detail: { critical: 3, high: 0, medium: 0, low: 0 } }] },
    });
    render(<SecurityPage />);
    await waitFor(() => expect(screen.getByText('Security Issues Summary')).toBeTruthy());
    // CVE labels exist ONLY as bars (check labels also appear on the tiles, so they can't
    // discriminate) — critical:3 summed from the scan detail renders, the zero HIGH is filtered.
    expect(screen.getByText('CVE Critical')).toBeTruthy();
    expect(screen.queryByText('CVE High')).toBeNull();
  });

  it('omits the issues-summary chart entirely when every bar is zero', async () => {
    mockFetch({ enabled: true, summary: {}, findings: {} });
    render(<SecurityPage />);
    await waitFor(() => expect(screen.getByText('Public S3 Buckets')).toBeTruthy());
    expect(screen.queryByText('Security Issues Summary')).toBeNull();
  });

  it('renders the four check tiles when enabled', async () => {
    mockFetch({
      enabled: true,
      summary: { public_s3: 2, open_sg: 1, unencrypted_ebs: 0, iam_no_mfa: 3 },
      findings: { public_s3: [], open_sg: [], unencrypted_ebs: [], iam_no_mfa: [] },
    });
    render(<SecurityPage />);
    // getAllByText: a nonzero check's label now also renders as an issues-summary bar (L245)
    await waitFor(() => expect(screen.getAllByText('Public S3 Buckets').length).toBeGreaterThan(0));
    expect(screen.getAllByText('IAM Users without MFA').length).toBeGreaterThan(0);
  });
});
