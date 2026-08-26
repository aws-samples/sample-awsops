// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ConnectorsTab from './ConnectorsTab';

let calls: { url: string; method?: string; body?: string }[] = [];
beforeEach(() => {
  calls = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body as string });
    return { ok: true, status: 200, json: async () => (url === '/api/integrations/credential' && (!init || init.method === undefined) ? { configured: [] } : { ok: true }) };
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ConnectorsTab', () => {
  it('lists Notion as a connector and shows the propose-only write note', async () => {
    render(<ConnectorsTab canManage />);
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy());
    expect(screen.getAllByText(/제안전용/).length).toBeGreaterThan(0);
    // no datasource kinds here
    expect(screen.queryByText('prometheus')).toBeNull();
    expect(screen.queryByText('clickhouse')).toBeNull();
  });

  it('admin can paste a token and connect (PUT credential)', async () => {
    render(<ConnectorsTab canManage />);
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/토큰 붙여넣기/), { target: { value: 'secret_x' } });
    fireEvent.click(screen.getByRole('button', { name: '연결' }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.body!)).toEqual({ slug: 'notion', secret: { token: 'secret_x' } });
    });
  });

  it('non-admin sees a read-only note, no token field', async () => {
    render(<ConnectorsTab canManage={false} />);
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy());
    expect(screen.queryByPlaceholderText(/토큰/)).toBeNull();
    expect(screen.getByText(/관리자 전용/)).toBeTruthy();
  });
});
