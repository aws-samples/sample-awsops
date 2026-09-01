// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import SubscribersPanel from './SubscribersPanel';

let fetchMock: ReturnType<typeof vi.fn>;
function setFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const r = handler(url, init) ?? {};
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body ?? {} };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const listBody = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  canManage: true,
  subscribers: [{ email: 'a@x.io', status: 'Confirmed', subscriptionArn: 'arn:t:1' }],
  ...over,
});

describe('SubscribersPanel', () => {
  it('renders nothing while disabled', async () => {
    setFetch(() => ({ body: listBody({ enabled: false }) }));
    const { container } = render(<SubscribersPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('shows the subscriber list with status badges', async () => {
    setFetch(() => ({ body: listBody({ subscribers: [
      { email: 'a@x.io', status: 'Confirmed', subscriptionArn: 'arn:t:1' },
      { email: 'b@x.io', status: 'PendingConfirmation', subscriptionArn: null },
    ] }) }));
    render(<SubscribersPanel />);
    await waitFor(() => expect(screen.getByText('a@x.io')).toBeTruthy());
    expect(screen.getByText('구독중')).toBeTruthy();
    expect(screen.getAllByText('확인 대기').length).toBeGreaterThanOrEqual(1);
  });

  // Test-notification send (gap L53).
  it('offers 테스트 발송 only to admins with a confirmed subscriber, and POSTs the test route', async () => {
    setFetch((url, init) => (init?.method === 'POST' && String(url).endsWith('/test')
      ? { body: { messageId: 'm1' } }
      : { body: listBody() }));
    render(<SubscribersPanel />);
    await waitFor(() => expect(screen.getByText('테스트 발송')).toBeTruthy());
    fireEvent.click(screen.getByText('테스트 발송'));
    await waitFor(() => expect(screen.getByText(/테스트 메시지를 발송했습니다/)).toBeTruthy());
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(String(post![0])).toBe('/api/diagnosis/subscribers/test');
  });

  it('hides 테스트 발송 for non-admins and when no subscriber is confirmed', async () => {
    setFetch(() => ({ body: listBody({ canManage: false }) }));
    render(<SubscribersPanel />);
    await waitFor(() => expect(screen.getByText('a@x.io')).toBeTruthy());
    expect(screen.queryByText('테스트 발송')).toBeNull();
    cleanup();
    setFetch(() => ({ body: listBody({ subscribers: [{ email: 'b@x.io', status: 'PendingConfirmation', subscriptionArn: null }] }) }));
    render(<SubscribersPanel />);
    await waitFor(() => expect(screen.getByText('b@x.io')).toBeTruthy());
    expect(screen.queryByText('테스트 발송')).toBeNull();
  });

  it('surfaces a failed test send instead of a silent success', async () => {
    setFetch((url, init) => (init?.method === 'POST' && String(url).endsWith('/test')
      ? { status: 502, body: { message: 'publish failed: boom' } }
      : { body: listBody() }));
    render(<SubscribersPanel />);
    await waitFor(() => screen.getByText('테스트 발송'));
    fireEvent.click(screen.getByText('테스트 발송'));
    await waitFor(() => expect(screen.getByText(/테스트 발송에 실패했습니다/)).toBeTruthy());
  });

  it('gap L178: the pause switch reflects state and PUTs the toggle (admin)', async () => {
    setFetch((url, init) => {
      if (url === '/api/diagnosis/notify' && init?.method === 'PUT') return { body: { paused: true } };
      if (url === '/api/diagnosis/notify') return { body: { paused: false, canManage: true } };
      return { body: listBody() };
    });
    render(<SubscribersPanel />);
    await waitFor(() => expect(screen.getByText('활성')).toBeTruthy());
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true'); // active = checked
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByText('일시 중지됨')).toBeTruthy());
    const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT');
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({ paused: true });
  });

  it('gap L178: non-admins see the state badge but no interactive switch', async () => {
    setFetch((url) => {
      if (url === '/api/diagnosis/notify') return { body: { paused: true, canManage: false } };
      return { body: listBody({ canManage: false }) };
    });
    render(<SubscribersPanel />);
    await waitFor(() => expect(screen.getByText('일시 중지됨')).toBeTruthy());
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
