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
