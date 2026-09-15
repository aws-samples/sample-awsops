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
    fireEvent.click(screen.getByRole('button', { name: /연결 테스트/ }));
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

describe('connection settings (gap L203)', () => {
  it('sends a valid timeoutS; ClickHouse shows the Database field and sends it', async () => {
    render(<DatasourceForm onSaved={() => {}} onCancel={() => {}} />);
    // switch kind to clickhouse → Database field appears
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'clickhouse' } });
    fireEvent.change(screen.getByPlaceholderText(/prod-prometheus/), { target: { value: 'ch-1' } });
    fireEvent.change(screen.getByPlaceholderText(/clickhouse.internal/), { target: { value: 'http://ch:8123' } });
    fireEvent.change(screen.getByPlaceholderText('기본 10'), { target: { value: '30' } });
    fireEvent.change(screen.getByPlaceholderText('default'), { target: { value: 'metrics_db' } });
    fireEvent.click(screen.getByText('저장'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/manage'))).toBe(true));
    const body = JSON.parse(calls.find((c) => c.url.includes('/manage'))!.body!);
    expect(body.settings).toEqual({ timeoutS: 30, database: 'metrics_db' });
  });

  it('non-clickhouse kinds hide the Database field; an out-of-range timeout blocks save with an inline error', async () => {
    render(<DatasourceForm onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.queryByPlaceholderText('default')).toBeNull(); // prometheus default kind
    fireEvent.change(screen.getByPlaceholderText(/prod-prometheus/), { target: { value: 'p-1' } });
    fireEvent.change(screen.getByPlaceholderText(/prometheus.internal/), { target: { value: 'http://p:9090' } });
    fireEvent.change(screen.getByPlaceholderText('기본 10'), { target: { value: '999' } });
    // a typo must NOT silently clear the stored setting — save is blocked, error shown
    expect(screen.getByText(/1–60 사이의 정수/)).toBeTruthy();
    expect((screen.getByText('저장').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.url.includes('/manage'))).toBe(false);
  });
});
