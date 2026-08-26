// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/components/shell/LanguageProvider';
import GroupOverviewClient from './GroupOverviewClient';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const SUMMARY = {
  byType: [
    { type: 'vpc', label: 'VPCs', count: 3 },
    { type: 'alb', label: 'App Load Balancers', count: 2 },
    { type: 'security_group', label: 'Security Groups', count: 7 },
  ],
  byCategory: [],
  total: 12,
  splits: { ec2Running: 1, ec2Stopped: 0, ebsUnencrypted: 0, iamUserNoMfa: 0, sgOpenIngress: 4 },
};

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => SUMMARY })) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderG = (slug: string) => render(<LanguageProvider><GroupOverviewClient slug={slug} /></LanguageProvider>);

describe('GroupOverviewClient', () => {
  it('renders direct + subgroup resource-type tiles with counts from /api/inventory/summary', async () => {
    renderG('network');
    await waitFor(() => expect(screen.getByText('VPCs')).toBeTruthy());
    expect(screen.getByText('App Load Balancers')).toBeTruthy(); // Load Balancing subgroup item surfaced
    expect(screen.getByText('Security Groups')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();                  // security_group count
  });

  it('surfaces the group-pinned split value (Network → sgOpenIngress = 4)', async () => {
    renderG('network');
    await waitFor(() => expect(screen.getByText('4')).toBeTruthy());
  });

  it('Compute surfaces the EKS family tiles (feature links from the eks subgroup)', async () => {
    renderG('compute');
    await waitFor(() => expect(screen.getByText('EKS 개요')).toBeTruthy());
    expect(screen.getByText('EKS 탐색기')).toBeTruthy();
    expect(screen.getByText('컨테이너 비용')).toBeTruthy();
  });
});
