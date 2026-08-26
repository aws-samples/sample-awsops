// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import DatasourceExplorePage from './page';

beforeEach(() => {
  global.fetch = vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url === '/api/datasources'
      ? { datasources: [{ id: 5, name: 'prod-prom', kind: 'prometheus', authType: 'none', isDefault: true, connected: true }] }
      : {}),
  })) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DatasourceExplorePage', () => {
  it('renders the Explore console scoped to the instance id (picker hidden)', async () => {
    render(DatasourceExplorePage({ params: { id: '5' } }));
    await waitFor(() => expect(screen.getByPlaceholderText(/PromQL/)).toBeTruthy());
    // picker is shown and preselected to the scoped instance (no dead-end if id isn't resolvable)
    await waitFor(() => expect((screen.getByRole('combobox', { name: '데이터소스' }) as HTMLSelectElement).value).toBe('5'));
  });
});
