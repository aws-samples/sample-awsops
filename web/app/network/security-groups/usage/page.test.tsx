// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import UsagePage from './page';

// React Flow (used by PolicyGraph) measures its container via ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(cleanup);
beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

const SG_ROW = {
  id: 'sg-1', name: 'web-sg', description: '', region: 'ap-northeast-2', vpcId: 'vpc-1', vpcLabel: 'vpc-1',
  isDefault: false, eniCount: 1, attachedKinds: [{ kind: 'ec2', count: 1 }], referencedBy: [],
  ingressRules: 1, egressRules: 0, openIngress: 0, unused: false, rules: [],
};

function mockFetches() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/inventory/security_group')) {
      return { ok: true, status: 200, json: async () => ({ rows: [{ resource_id: 'sg-1', region: 'ap-northeast-2', data: {} }], run: null }) } as Response;
    }
    if (u.includes('/api/sg?view=hits')) {
      return { ok: true, status: 200, json: async () => ({ source: 'flowlogs', note: null, ruleHits: [], idleIngressRules: 0, peers: [], rangeSec: 86400 }) } as Response;
    }
    if (u.includes('/api/sg')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          rows: [SG_ROW],
          totals: { total: 1, attached: 1, unused: 0, referencedOnly: 0, openIngress: 0, enis: 1 },
          flowLogVpcs: 0, degradedRegions: [],
        }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
}

describe('/network/security-groups/usage', () => {
  it('renders the moved analysis (KPI + table) and the row-click graph + Rules link', async () => {
    mockFetches();
    render(<UsagePage />);
    await waitFor(() => expect(screen.getByText('sg-1')).toBeTruthy());

    // No graph/link until a row is selected.
    expect(screen.queryByTestId('policy-graph')).toBeNull();

    fireEvent.click(screen.getByText('sg-1'));

    await waitFor(() => expect(screen.getByTestId('policy-graph')).toBeTruthy());
    expect(screen.getByText(/이 SG의 규칙 보기|Rules for this|규칙 보기/)).toBeTruthy();
  });
});
