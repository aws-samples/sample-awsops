// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccountsPage from './page';

const accounts = [
  { accountId: '111111111111', alias: 'Host', region: 'ap-northeast-2', isHost: true, externalId: null, enabled: true, status: 'verified' },
  { accountId: '210987654321', alias: 'Prod', region: 'ap-northeast-2', isHost: false, externalId: 'ext-1', enabled: true, status: 'verified' },
];
const regions = [
  { accountId: '111111111111', region: 'ap-northeast-2', enabled: true },
  { accountId: '210987654321', region: 'ap-northeast-2', enabled: true },
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/accounts' && !init) {
      return new Response(JSON.stringify({ accounts }), { status: 200 });
    }
    if (url === '/api/accounts/regions' && !init) {
      return new Response(JSON.stringify({ regions }), { status: 200 });
    }
    if (url === '/api/accounts/regions' && init?.method === 'POST') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AccountsPage regions', () => {
  it('does not treat a failed registry lookup as an empty registry', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/accounts') return new Response('{}', { status: 500 });
      if (url === '/api/accounts/onboarding') return Response.json({
        hostAccountId: '111111111111', hostTaskRoleArn: 'arn:aws:iam::111111111111:role/task',
        region: 'ap-northeast-2', registrationEnabled: true,
      });
      return Response.json({ regions: [] });
    });
    render(<AccountsPage />);
    await screen.findByText('계정 목록을 불러오지 못했습니다. 페이지를 새로고침하세요.');
    expect(screen.queryByText('등록된 계정이 없습니다.')).toBeNull();
    expect(screen.getByLabelText('Account ID').matches(':disabled')).toBe(true);
    expect((screen.getByRole('button', { name: '연결 확인 및 등록' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('adds another region for an existing account without re-registering the account', async () => {
    render(<AccountsPage />);

    await screen.findByText('Prod');
    fireEvent.change(screen.getByLabelText('Prod 추가 리전'), { target: { value: 'us-east-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prod 리전 추가' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/accounts/regions', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ accountId: '210987654321', region: 'us-east-1' }),
      }));
    });
  });
});
