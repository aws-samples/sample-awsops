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
    { type: 'subnet', label: 'Subnets', count: 9 },
    { type: 'nat_gateway', label: 'NAT Gateways', count: 2 },
    { type: 'alb', label: 'App Load Balancers', count: 2 },
    { type: 'security_group', label: 'Security Groups', count: 7 },
    { type: 'ec2', label: 'EC2 Instances', count: 5 },
    { type: 'lambda', label: 'Lambda Functions', count: 12 },
  ],
  byCategory: [],
  total: 40,
  splits: {
    ec2Running: 4, ec2Stopped: 1, ebsUnencrypted: 0, iamUserNoMfa: 0, sgOpenIngress: 4,
    lambdaRuntimes: 3, lambdaLongTimeout: 2,
  },
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

  it('renders gap-L82 micro-stat sublines: ec2 splits, lambda runtimes, vpc cross-type composition', async () => {
    renderG('compute');
    await waitFor(() => expect(screen.getByText('4 running · 1 stopped')).toBeTruthy());
    expect(screen.getByText('3 runtimes · 2 >300s')).toBeTruthy();
    renderG('network');
    await waitFor(() => expect(screen.getByText('9 subnets · 2 NAT · 0 TGW')).toBeTruthy());
    expect(screen.getByText('4 open ingress')).toBeTruthy();
  });

  it('no subline for a type whose split keys are absent (rolling-deploy skew) — no fabricated zeros', async () => {
    renderG('storage'); // ebs_volume needs ebsTotalGb, absent from this fixture
    await waitFor(() => expect(screen.queryByText(/GiB ·/)).toBeNull());
  });

  it('splits:null (aggregation failure) hides ALL sublines and the status verdict — never false-clean', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ...SUMMARY, splits: null }) })) as unknown as typeof fetch;
    renderG('network');
    await waitFor(() => expect(screen.getByText('VPCs')).toBeTruthy());
    expect(screen.queryByText(/open ingress/)).toBeNull();
    expect(screen.queryByText(/subnets ·/)).toBeNull(); // whole subline layer gated on splits
  });

  it('Compute surfaces the EKS family tiles (feature links from the eks subgroup)', async () => {
    renderG('compute');
    await waitFor(() => expect(screen.getByText('EKS 개요')).toBeTruthy());
    expect(screen.getByText('EKS 탐색기')).toBeTruthy();
    expect(screen.getByText('컨테이너 비용')).toBeTruthy();
  });
});
