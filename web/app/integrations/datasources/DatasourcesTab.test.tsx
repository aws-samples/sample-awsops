// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import DatasourcesTab from './DatasourcesTab';

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

const INSTANCES = [
  { id: 1, name: 'prod-prom', kind: 'prometheus', authType: 'none', isDefault: true, connected: true },
  { id: 2, name: 'stg-prom', kind: 'prometheus', authType: 'basic', isDefault: false, connected: true },
];
beforeEach(() => {
  global.fetch = vi.fn(async (url: string) => ({
    ok: true, status: 200, json: async () => (url === '/api/datasources' ? { datasources: INSTANCES } : {}),
  })) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DatasourcesTab', () => {
  it('lists instances (name/type/auth/default) with an Explore link per row', async () => {
    render(<DatasourcesTab canManage={false} />);
    await waitFor(() => expect(screen.getByText('prod-prom')).toBeTruthy());
    expect(screen.getByText('stg-prom')).toBeTruthy();
    expect(screen.getByText('★ default')).toBeTruthy();
    const links = screen.getAllByText('Explore →') as HTMLAnchorElement[];
    expect(links[0].getAttribute('href')).toBe('/integrations/datasources/1');
  });

  it('hides Add/Edit/Delete for non-admins (read-only)', async () => {
    render(<DatasourcesTab canManage={false} />);
    await waitFor(() => expect(screen.getByText('prod-prom')).toBeTruthy());
    expect(screen.queryByText('＋ Add datasource')).toBeNull();
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Delete')).toBeNull();
  });

  it('shows Add/Edit/Delete for admins and opens the form on Add', async () => {
    render(<DatasourcesTab canManage />);
    await waitFor(() => expect(screen.getByText('prod-prom')).toBeTruthy());
    expect(screen.getByText('＋ Add datasource')).toBeTruthy();
    expect(screen.getAllByText('Delete').length).toBe(2);
    fireEvent.click(screen.getByText('＋ Add datasource'));
    expect(screen.getByText('데이터소스 추가')).toBeTruthy();
  });
});
