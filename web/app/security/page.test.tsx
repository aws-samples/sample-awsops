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

  it('renders the four check tiles when enabled', async () => {
    mockFetch({
      enabled: true,
      summary: { public_s3: 2, open_sg: 1, unencrypted_ebs: 0, iam_no_mfa: 3 },
      findings: { public_s3: [], open_sg: [], unencrypted_ebs: [], iam_no_mfa: [] },
    });
    render(<SecurityPage />);
    await waitFor(() => expect(screen.getByText('Public S3 Buckets')).toBeTruthy());
    expect(screen.getByText('IAM Users without MFA')).toBeTruthy();
  });
});
