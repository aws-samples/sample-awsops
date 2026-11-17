// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/components/shell/LanguageProvider';

vi.mock('@/components/topology/MapCanvas', () => ({ default: () => null, MapLegend: () => null }));

import K8sMapView from './K8sMapView';

const MEMBER_ARN = 'arn:aws:eks:ap-northeast-2:222222222222:cluster/shared';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('K8sMapView', () => {
  it('lists every connected account and reads member clusters by full ARN', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url.startsWith('/api/eks?')) {
        return new Response(JSON.stringify({ clusters: [
          { id: 'shared', name: 'shared', accountId: '111111111111', access: 'connected' },
          { id: MEMBER_ARN, name: 'shared', accountId: '222222222222', access: 'connected' },
          { id: 'offline', name: 'offline', accountId: '111111111111', access: 'unreachable' },
        ] }));
      }
      return new Response(JSON.stringify({ rows: [] }));
    }));
    render(<LanguageProvider><K8sMapView query="" /></LanguageProvider>);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(['shared', MEMBER_ARN]);
    expect(options[1].textContent).toBe('shared · 222222222222');
    expect(calls[0]).toBe('/api/eks?accounts=__all__&regions=__all__&includeGlobal=1');
    await waitFor(() => expect(calls.some((u) => u.startsWith('/api/eks/shared/incluster'))).toBe(true));
  });
});
