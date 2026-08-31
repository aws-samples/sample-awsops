// @vitest-environment jsdom
// Confirms the SG usage analysis is no longer embedded at the bottom of
// /inventory/security_group (moved to /network/security-groups/usage — see
// docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md), while every OTHER
// inventory type's own bottom-of-page metric section is unaffected (checked against `ec2`, whose
// Ec2Metrics section must still render as before).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import InventoryTypePage from './page';

let currentType = 'security_group';
vi.mock('next/navigation', () => ({ useParams: () => ({ type: currentType }) }));

afterEach(cleanup);
beforeEach(() => { vi.unstubAllGlobals(); });

function mockInventory(rows: Record<string, unknown>[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/metrics')) return { ok: true, status: 200, json: async () => ({ cards: [] }) } as Response;
    if (u.includes('/api/inventory/')) {
      return {
        ok: true, status: 200,
        json: async () => ({ rows: rows.map((r) => ({ resource_id: r.resource_id, region: r.region, data: r })), run: { finished_at: null } }),
      } as Response;
    }
    if (u.includes('/api/sg')) return { ok: true, status: 200, json: async () => ({ rows: [], totals: { total: 0, attached: 0, unused: 0, referencedOnly: 0, openIngress: 0, enis: 0 }, flowLogVpcs: 0, degradedRegions: [] }) } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
}

describe('/inventory/[type] — SG usage analysis no longer embedded', () => {
  it('security_group: does not render the "보안 그룹 사용 분석" section', async () => {
    currentType = 'security_group';
    mockInventory([{ resource_id: 'sg-1', region: 'ap-northeast-2', name: 'web', vpc_id: 'vpc-1' }]);
    render(<InventoryTypePage />);
    await waitFor(() => expect(screen.queryByText(/Security Groups/i)).toBeTruthy());
    expect(screen.queryByText('보안 그룹 사용 분석')).toBeNull();
  });

  it('ec2: its own bottom-of-page metrics section is unaffected', async () => {
    currentType = 'ec2';
    mockInventory([{ resource_id: 'i-1', region: 'ap-northeast-2', name: 'web', instance_type: 't3.micro', instance_state: 'running' }]);
    render(<InventoryTypePage />);
    await waitFor(() => expect(screen.queryByText(/EC2 Instances/i)).toBeTruthy());
  });
});
