// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import DatasourceForm from './DatasourceForm';

let calls: { url: string; method?: string; body?: string }[] = [];
beforeEach(() => {
  calls = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body as string });
    const json = url.endsWith('/test') ? { ok: true, latencyMs: 42 } : { id: 9 };
    return { ok: true, status: 200, json: async () => json };
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DatasourceForm', () => {
  it('shows conditional credential fields per auth method', () => {
    render(<DatasourceForm onSaved={() => {}} onCancel={() => {}} />);
    // none → no credential inputs
    expect(screen.queryByText('Username')).toBeNull();
    fireEvent.change(screen.getByLabelText('Auth method'), { target: { value: 'basic' } });
    expect(screen.getByText('Username')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Auth method'), { target: { value: 'bearer' } });
    expect(screen.getByText('Token')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Auth method'), { target: { value: 'custom_header' } });
    expect(screen.getByText('Header name')).toBeTruthy();
  });

  it('Save is disabled until name + endpoint are present (auth None is allowed)', () => {
    render(<DatasourceForm onSaved={() => {}} onCancel={() => {}} />);
    const save = screen.getByRole('button', { name: '저장' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/prod-prometheus/), { target: { value: 'prod-prom' } });
    fireEvent.change(screen.getByPlaceholderText(/prometheus.internal/), { target: { value: 'http://p:9090' } });
    expect(save.disabled).toBe(false); // no auth required
  });

  it('Test connection posts the unsaved form and shows a success banner', async () => {
    render(<DatasourceForm onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/prometheus.internal/), { target: { value: 'http://p:9090' } });
    fireEvent.click(screen.getByRole('button', { name: /Test connection/ }));
    await waitFor(() => expect(screen.getByText(/연결 성공/)).toBeTruthy());
    const t = calls.find((c) => c.url === '/api/datasources/test');
    expect(JSON.parse(t!.body!)).toMatchObject({ kind: 'prometheus', endpoint: 'http://p:9090', authType: 'none' });
  });

  it('Save (create) POSTs /manage with name+kind+endpoint+authType and calls onSaved', async () => {
    const onSaved = vi.fn();
    render(<DatasourceForm onSaved={onSaved} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/prod-prometheus/), { target: { value: 'prod-prom' } });
    fireEvent.change(screen.getByPlaceholderText(/prometheus.internal/), { target: { value: 'http://p:9090' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const s = calls.find((c) => c.url === '/api/datasources/manage');
    expect(s!.method).toBe('POST');
    expect(JSON.parse(s!.body!)).toMatchObject({ name: 'prod-prom', kind: 'prometheus', endpoint: 'http://p:9090', authType: 'none' });
  });

  it('edit mode PATCHes and locks the Type field', async () => {
    const onSaved = vi.fn();
    render(<DatasourceForm initial={{ id: 5, name: 'p', kind: 'loki', endpoint: 'http://l', authType: 'none' }} onSaved={onSaved} onCancel={() => {}} />);
    expect((screen.getByLabelText('Type') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const s = calls.find((c) => c.url === '/api/datasources/manage');
    expect(s!.method).toBe('PATCH');
    expect(JSON.parse(s!.body!)).toMatchObject({ id: 5 });
  });
});
