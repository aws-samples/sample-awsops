import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cookies } from 'next/headers';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import IntegrationsPage from './page';

vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyUser: vi.fn() }));
vi.mock('@/lib/admin', () => ({ isAdmin: vi.fn() }));
vi.mock('./IntegrationsTabs', () => ({ default: () => null }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(cookies).mockResolvedValue({ toString: () => 'awsops_token=test' } as Awaited<ReturnType<typeof cookies>>);
  vi.mocked(verifyUser).mockResolvedValue({ sub: 'admin-sub', email: 'admin@example.com' } as NonNullable<Awaited<ReturnType<typeof verifyUser>>>);
  vi.mocked(isAdmin).mockResolvedValue(true);
});

describe('IntegrationsPage async request APIs', () => {
  it('awaits cookies and promised searchParams while preserving admin access', async () => {
    const page = await IntegrationsPage({ searchParams: Promise.resolve({ tab: 'connectors' }) });
    expect(verifyUser).toHaveBeenCalledWith('awsops_token=test');
    expect(isAdmin).toHaveBeenCalledWith({ sub: 'admin-sub', email: 'admin@example.com' });
    expect(page.props.children[1].props).toMatchObject({ initialTab: 'connectors', canManage: true });
  });

  it('keeps management disabled for unauthenticated users and optional searchParams', async () => {
    vi.mocked(verifyUser).mockResolvedValue(null);
    const page = await IntegrationsPage({});
    expect(isAdmin).not.toHaveBeenCalled();
    expect(page.props.children[1].props).toMatchObject({ initialTab: undefined, canManage: false });
  });

  it('keeps management disabled when asynchronous cookie access fails', async () => {
    vi.mocked(cookies).mockRejectedValue(new Error('request unavailable'));
    const page = await IntegrationsPage({ searchParams: Promise.resolve({ tab: 'datasources' }) });
    expect(verifyUser).not.toHaveBeenCalled();
    expect(isAdmin).not.toHaveBeenCalled();
    expect(page.props.children[1].props).toMatchObject({ initialTab: 'datasources', canManage: false });
  });
});
