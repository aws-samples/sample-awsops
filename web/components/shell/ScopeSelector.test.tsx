// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ScopeSelector from './ScopeSelector';
import { getActiveScope } from '@/lib/account-context';

const accounts = [
  { accountId: '111111111111', alias: 'Host', isHost: true },
  { accountId: '210987654321', alias: 'Prod', isHost: false },
];
const regions = [
  { accountId: 'self', region: 'ap-northeast-2', enabled: true },
  { accountId: '210987654321', region: 'us-east-1', enabled: true },
  { accountId: '210987654321', region: 'eu-west-1', enabled: true },
];

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/accounts') return new Response(JSON.stringify({ accounts }), { status: 200 });
    if (url === '/api/accounts/regions') return new Response(JSON.stringify({ regions }), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ScopeSelector', () => {
  it('renders account and region scope controls from APIs', async () => {
    render(<ScopeSelector />);

    expect(await screen.findByLabelText('모든 계정')).toBeTruthy();
    expect(screen.getByLabelText('활성화된 모든 리전')).toBeTruthy();
    expect(screen.getByLabelText('글로벌 서비스 포함')).toBeTruthy();
  });

  it('stores all accounts and multiple selected regions', async () => {
    render(<ScopeSelector />);
    await screen.findByLabelText('모든 계정');

    fireEvent.click(screen.getByLabelText('모든 계정'));
    await screen.findByLabelText('eu-west-1');
    // Uncheck the "All enabled regions" toggle first to get a clean single-region baseline,
    // then add regions one at a time — once out of ALL_REGIONS mode, per-region checkboxes
    // are a plain add/remove toggle.
    fireEvent.click(screen.getByLabelText('활성화된 모든 리전'));
    fireEvent.click(screen.getByLabelText('us-east-1'));
    fireEvent.click(screen.getByLabelText('eu-west-1'));

    expect(getActiveScope()).toEqual({
      accounts: '__all__',
      regions: ['ap-northeast-2', 'us-east-1', 'eu-west-1'],
      includeGlobal: true,
    });
  });

  it('unchecking one region while "all" is active excludes it, not narrows to only it', async () => {
    render(<ScopeSelector />);
    await screen.findByLabelText('모든 계정');
    fireEvent.click(screen.getByLabelText('모든 계정')); // bring us-east-1/eu-west-1 into scope
    await screen.findByLabelText('eu-west-1');

    // Default scope.regions === ALL_REGIONS, so every per-region box renders checked=true.
    // User intent: uncheck ap-northeast-2 to EXCLUDE it, keeping the other two selected.
    fireEvent.click(screen.getByLabelText('ap-northeast-2'));

    const regions = getActiveScope().regions;
    expect(regions).not.toContain('ap-northeast-2');
    expect(regions).toEqual(expect.arrayContaining(['us-east-1', 'eu-west-1']));
  });

  it('unchecking a second region narrows down to exactly the ones left checked', async () => {
    render(<ScopeSelector />);
    await screen.findByLabelText('모든 계정');
    fireEvent.click(screen.getByLabelText('모든 계정'));
    await screen.findByLabelText('eu-west-1');

    // Real-world report: 3 regions all checked by default; user unchecks the two they
    // don't want, expecting only the third to remain selected.
    fireEvent.click(screen.getByLabelText('ap-northeast-2'));
    fireEvent.click(screen.getByLabelText('eu-west-1'));

    expect(getActiveScope().regions).toEqual(['us-east-1']);
  });

  it('can exclude global services from the active scope', async () => {
    render(<ScopeSelector />);
    await screen.findByLabelText('모든 계정');

    fireEvent.click(screen.getByLabelText('글로벌 서비스 포함'));

    await waitFor(() => expect(getActiveScope().includeGlobal).toBe(false));
  });
});
