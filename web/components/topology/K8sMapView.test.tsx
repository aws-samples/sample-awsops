// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/components/shell/LanguageProvider';

vi.mock('@/components/topology/MapCanvas', () => ({ default: () => null, MapLegend: () => null }));

import K8sMapView from './K8sMapView';

const MEMBER_ARN = 'arn:aws:eks:ap-northeast-2:222222222222:cluster/shared';

function stubFetch(listing: Record<string, unknown>, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (url.startsWith('/api/eks?')) return new Response(JSON.stringify(listing), { status });
    return new Response(JSON.stringify({ rows: [] }));
  }));
  return calls;
}

beforeEach(() => {
  window.localStorage.setItem('awsops:scope', JSON.stringify({ accounts: '__all__', regions: '__all__', includeGlobal: true }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe('K8sMapView', () => {
  it('follows the active scope and reads a member cluster by its encoded full ARN', async () => {
    const calls = stubFetch({ clusters: [
      { id: 'shared', name: 'shared', accountId: '111111111111', access: 'connected' },
      { id: MEMBER_ARN, name: 'shared', accountId: '222222222222', access: 'connected' },
      { id: 'offline', name: 'offline', accountId: '111111111111', access: 'denied' },
    ] });
    render(<LanguageProvider><K8sMapView query="" /></LanguageProvider>);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(['shared', MEMBER_ARN]);
    expect(options[1].textContent).toBe('shared (222222222222 / ap-northeast-2)');
    expect(calls[0]).toContain('accounts=__all__');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: MEMBER_ARN } });
    await waitFor(() => expect(calls).toContain(`/api/eks/${encodeURIComponent(MEMBER_ARN)}/incluster?kind=pods`));
  });

  it('discloses partial or capped listings instead of presenting them as complete', async () => {
    stubFetch({ clusters: [{ id: 'shared', name: 'shared', access: 'connected' }],
      errors: [{ accountId: '222222222222', region: 'us-east-1', message: 'AccessDenied', reason: 'denied' }], truncated: true });
    render(<LanguageProvider><K8sMapView query="" /></LanguageProvider>);
    expect(await screen.findByText(/222222222222 \/ us-east-1: AccessDenied/)).toBeTruthy();
    expect(screen.getByText(/일부 결과만 표시됩니다/)).toBeTruthy();
  });

  it('keeps the empty-state guidance when the only note is the informational wildcard-scope note', async () => {
    stubFetch({ clusters: [], errors: [{ accountId: 'self', region: '__all__',
      message: 'All-region discovery covers configured and registered regions only.' }] });
    render(<LanguageProvider><K8sMapView query="" /></LanguageProvider>);
    expect(await screen.findByText(/연결된 EKS 클러스터가 없습니다/)).toBeTruthy();
    expect(screen.getByText(/All-region discovery covers/)).toBeTruthy();
  });

  it('shows the listing failure rather than an empty map when the scope is rejected', async () => {
    stubFetch({ status: 'error', message: 'EKS region is not enabled for this account' }, 403);
    render(<LanguageProvider><K8sMapView query="" /></LanguageProvider>);
    expect(await screen.findByText(/EKS region is not enabled/)).toBeTruthy();
  });
});

describe('K8sMapView partial empty listing', () => {
  it('does not claim no clusters when a partially failed listing returned none connected', async () => {
    stubFetch({ clusters: [], errors: [{ accountId: '222222222222', region: 'us-east-1', message: 'AccessDenied', reason: 'denied' }] });
    render(<LanguageProvider><K8sMapView query="" /></LanguageProvider>);
    expect(await screen.findByText(/222222222222 \/ us-east-1: AccessDenied/)).toBeTruthy();
    expect(screen.queryByText(/연결된 EKS 클러스터가 없습니다/)).toBeNull();
  });
});
