// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react';
import DiagnosisView from './DiagnosisView';

afterEach(cleanup);

function mockCapture(reports: Array<Record<string, unknown>> = []) {
  const posts: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (method === 'POST' && path === '/api/diagnosis') {
      posts.push(JSON.parse(String(init?.body)));
      return resp({ job_id: 'j1', report_id: 1, tier: 'deep', model: 'sonnet' }, 202);
    }
    if (method === 'GET' && path === '/api/diagnosis') return resp({ reports });
    if (method === 'GET' && path.startsWith('/api/diagnosis/')) {
      const id = Number(path.split('/').pop());
      const r = reports.find((x) => (x as { id: number }).id === id) ?? { id, tier: 'deep', status: 'running' };
      return resp({ report: r, markdown: null });
    }
    return resp({}, 404);
  }));
  return posts;
}

function resp(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function mockList(reports: Array<Record<string, unknown>>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (method === 'GET' && path === '/api/diagnosis') return resp({ reports });
    if (method === 'GET' && path.startsWith('/api/diagnosis/')) {
      const id = Number(path.split('/').pop());
      const r = reports.find((x) => (x as { id: number }).id === id) ?? reports[0];
      return resp({ report: r, markdown: (r as { status: string }).status === 'succeeded' ? '# ok' : null });
    }
    return resp({}, 404);
  }));
}

describe('DiagnosisView — live progress & never-stuck UI (A6)', () => {
  it('shows live per-section progress for a running report (not a bare spinner)', async () => {
    mockList([{ id: 5, tier: 'mid', status: 'running', created_at: 't',
                progress: { current: 3, total: 9, section: '네트워크', phase: 'render' } }]);
    render(<DiagnosisView />);
    // the in-progress panel shows the current section + an N/total counter (sidebar shows it too →
    // assert via the progressbar's container, which is unique to the main panel)
    const bar = await screen.findByRole('progressbar');
    const panel = bar.parentElement as HTMLElement;
    expect(within(panel).getByText(/3\s*\/\s*9/)).toBeTruthy();   // N/total counter
    expect(within(panel).getByText(/네트워크/)).toBeTruthy();      // current section title
  });

  it('surfaces a failed report with its error and a retry control', async () => {
    mockList([{ id: 6, tier: 'mid', status: 'failed', created_at: 't',
                error: 'reaped: worker failed or stale', progress: {} }]);
    render(<DiagnosisView />);
    expect(await screen.findByText(/worker failed or stale/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /재시도|다시 실행/ })).toBeTruthy();
  });
});

describe('DiagnosisView — deep tier + model selection', () => {
  it('offers a Deep tier option and a model radio (default Sonnet) only for deep', async () => {
    mockCapture();
    render(<DiagnosisView />);
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    expect(within(select).getByRole('option', { name: /deep/i })).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull(); // mid → no model radio
    fireEvent.change(select, { target: { value: 'deep' } });
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect((screen.getByRole('radio', { name: /sonnet/i }) as HTMLInputElement).checked).toBe(true);
  });

  it('omits model in the POST body for mid', async () => {
    const posts = mockCapture();
    render(<DiagnosisView />);
    await screen.findByRole('combobox');
    fireEvent.click(screen.getByRole('button', { name: /진단 실행/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ tier: 'mid' });
  });

  it('posts the selected model for deep (opus)', async () => {
    const posts = mockCapture();
    render(<DiagnosisView />);
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'deep' } });
    fireEvent.click(screen.getByRole('radio', { name: /opus/i }));
    fireEvent.click(screen.getByRole('button', { name: /진단 실행/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ tier: 'deep', model: 'opus' });
  });

  it('shows the model in the report list for a deep report', async () => {
    mockList([{ id: 9, tier: 'deep', model: 'opus', status: 'succeeded', created_at: 't', progress: {} }]);
    render(<DiagnosisView />);
    const row = await screen.findByRole('button', { name: /#9/ });
    expect(row.textContent).toMatch(/deep/);
    expect(row.textContent).toMatch(/opus/);
  });
});

describe('DiagnosisView — export menu + generation date', () => {
  it('renders MD/DOCX/PDF download links + the generation date for an opened report', async () => {
    mockList([{ id: 12, tier: 'mid', status: 'succeeded', created_at: '2026-06-17T00:00:00Z', progress: {} }]);
    render(<DiagnosisView />);
    fireEvent.click(await screen.findByRole('button', { name: /#12/ }));
    await screen.findByText(/생성 일시/);
    expect(screen.getByRole('link', { name: /^MD$/ }).getAttribute('href')).toBe('/api/diagnosis/12/download?format=md');
    expect(screen.getByRole('link', { name: /^DOCX$/ }).getAttribute('href')).toBe('/api/diagnosis/12/download?format=docx');
    expect(screen.getByRole('link', { name: /^PDF$/ }).getAttribute('href')).toBe('/api/diagnosis/12/download?format=pdf');
  });
});

describe('DiagnosisView — title / tags / soft delete', () => {
  function mockMeta(rows: Array<Record<string, unknown>>, calls: any[]) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      if (method === 'GET' && path === '/api/diagnosis') return resp({ reports: rows });
      if (method === 'GET' && path.startsWith('/api/diagnosis/')) {
        const id = Number(path.split('/').pop());
        return resp({ report: rows.find((x) => (x as { id: number }).id === id), markdown: '# ok' });
      }
      if ((method === 'PATCH' || method === 'DELETE') && path.startsWith('/api/diagnosis/')) {
        calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
        return resp({ ok: true });
      }
      return resp({}, 404);
    }));
  }

  it('shows the title as the list primary line', async () => {
    mockMeta([{ id: 3, tier: 'mid', status: 'succeeded', created_at: 't', title: '핵심 리스크: 보안 형상', tags: [], can_edit: false, progress: {} }], []);
    render(<DiagnosisView />);
    expect((await screen.findAllByText('핵심 리스크: 보안 형상')).length).toBeGreaterThan(0);
  });

  it('owner: delete control → confirm → DELETE', async () => {
    vi.stubGlobal('confirm', () => true);
    const calls: any[] = [];
    mockMeta([{ id: 3, tier: 'mid', status: 'succeeded', created_at: 't', title: 't', tags: [], can_edit: true, progress: {} }], calls);
    render(<DiagnosisView />);
    fireEvent.click(await screen.findByRole('button', { name: /리포트 삭제/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/diagnosis/3')).toBe(true));
  });

  it('owner: edit title (PATCH) and add a tag (PATCH)', async () => {
    const calls: any[] = [];
    mockMeta([{ id: 3, tier: 'mid', status: 'succeeded', created_at: 't', title: 'old', tags: [], can_edit: true, progress: {} }], calls);
    render(<DiagnosisView />);
    fireEvent.click(await screen.findByRole('button', { name: /제목 수정/ }));
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '새 제목' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.body.title === '새 제목')).toBe(true));
    const tagInput = screen.getByLabelText('태그 추가');
    fireEvent.change(tagInput, { target: { value: '보안' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && Array.isArray(c.body.tags) && c.body.tags.includes('보안'))).toBe(true));
  });

  it('non-owner: no edit/delete controls', async () => {
    mockMeta([{ id: 3, tier: 'mid', status: 'succeeded', created_at: 't', title: 'read only', tags: ['x'], can_edit: false, progress: {} }], []);
    render(<DiagnosisView />);
    await screen.findByText('read only', { selector: 'h2' });
    expect(screen.queryByRole('button', { name: /리포트 삭제/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /제목 수정/ })).toBeNull();
  });

  it('renders a title with markup as escaped text (no XSS)', async () => {
    mockMeta([{ id: 3, tier: 'mid', status: 'succeeded', created_at: 't', title: '<script>alert(1)</script>', tags: [], can_edit: false, progress: {} }], []);
    const { container } = render(<DiagnosisView />);
    expect((await screen.findAllByText('<script>alert(1)</script>')).length).toBeGreaterThan(0);
    expect(container.querySelector('script')).toBeNull();
  });
});
