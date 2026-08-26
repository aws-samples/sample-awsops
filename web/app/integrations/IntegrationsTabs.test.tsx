// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import IntegrationsTabs from './IntegrationsTabs';

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

beforeEach(() => {
  global.fetch = vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url === '/api/datasources' ? { datasources: [] } : url === '/api/integrations/credential' ? { configured: [] } : {}),
  })) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('IntegrationsTabs', () => {
  it('renders three tabs and defaults to Datasources', async () => {
    render(<IntegrationsTabs canManage />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Datasources', 'Connectors', 'Agents & Skills']);
    expect(screen.getByRole('tab', { name: 'Datasources' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(screen.getByText(/관측성 데이터소스/)).toBeTruthy());
  });

  it('honors the initialTab (?tab=connectors)', async () => {
    render(<IntegrationsTabs initialTab="connectors" canManage />);
    expect(screen.getByRole('tab', { name: 'Connectors' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy());
  });

  it('switches tabs on click (Agents & Skills → link to /customization)', async () => {
    render(<IntegrationsTabs canManage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Agents & Skills' }));
    expect(screen.getByText(/Custom Agents & Skills 열기/)).toBeTruthy();
  });

  it('falls back to Datasources for an unknown tab', () => {
    render(<IntegrationsTabs initialTab="bogus" canManage />);
    expect(screen.getByRole('tab', { name: 'Datasources' }).getAttribute('aria-selected')).toBe('true');
  });
});
