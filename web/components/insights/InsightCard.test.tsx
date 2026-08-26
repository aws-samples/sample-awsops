// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import InsightCard from './InsightCard';

function mockFetch(getResp: unknown, refreshStatus = 202) {
  return vi.fn(async (url: string, opts?: { method?: string }) => {
    if (opts?.method === 'POST') return { ok: refreshStatus < 300, status: refreshStatus, json: async () => ({ status: 'queued' }) };
    return { ok: true, status: 200, json: async () => ({ insight: getResp }) };
  });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const THIRTY_MIN_AGO = new Date(Date.now() - 30 * 60 * 1000).toISOString();

describe('InsightCard', () => {
  it('renders insights with severity badges', async () => {
    vi.stubGlobal('fetch', mockFetch({
      status: 'succeeded', generatedAt: THIRTY_MIN_AGO, sourcesUsed: { k8s: 1 },
      insights: [
        { severity: 'critical', title: 'OOM in prod', detail: 'api pod OOMKilled', source: 'k8s' },
        { severity: 'warning', title: 'EC2 cost up', detail: '+120%', source: 'cost' },
      ],
    }));
    render(<InsightCard />);
    await waitFor(() => screen.getByText('OOM in prod'));
    expect(screen.getByText('critical')).toBeTruthy();
    expect(screen.getByText('EC2 cost up')).toBeTruthy();
    expect(screen.getByText('30분 전')).toBeTruthy();
  });

  it('renders nothing when the feature is disabled (enabled:false)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ enabled: false, insight: null }) })));
    const { container } = render(<InsightCard />);
    await waitFor(() => expect(container.querySelector('[data-testid="ai-insight-card"]')).toBeNull());
  });

  it('shows empty-state CTA when no insights', async () => {
    vi.stubGlobal('fetch', mockFetch(null));
    render(<InsightCard />);
    await waitFor(() => screen.getByTestId('ai-insight-empty'));
  });

  it('refresh POSTs and shows a message; 403 surfaces admin-only', async () => {
    vi.stubGlobal('fetch', mockFetch(null, 403));
    render(<InsightCard />);
    await waitFor(() => screen.getByTestId('ai-insight-empty'));
    fireEvent.click(screen.getByText('새로고침'));
    await waitFor(() => screen.getByText('관리자만 새로고침할 수 있습니다'));
  });
});
