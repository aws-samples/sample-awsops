// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ServiceTopologyView from './ServiceTopologyView';

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/shell/LanguageProvider', () => ({ useI18n: () => ({ tt: (s: string) => s }) }));
vi.mock('@/lib/use-theme', () => ({ useTheme: () => 'light' }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const view = (id: string) => Response.json({ snapshotId:id,builtAt:'2026-11-17T00:00:00Z',
  entities:[],relations:[],sources:[],gaps:[],omitted:{entities:0,relations:0},nextCursor:200 });

it('makes no request in an unsupported scope', () => {
  const fetcher=vi.fn(); vi.stubGlobal('fetch',fetcher);
  render(<ServiceTopologyView supported={false}/>);
  expect(screen.getByRole('status').textContent).toContain('현재 범위에서는');
  expect(fetcher).not.toHaveBeenCalled();
});

it('pins a subsequent page and clears the expired pin on refresh', async () => {
  const fetcher=vi.fn().mockResolvedValueOnce(view('generation-A')).mockResolvedValueOnce(new Response(null,{status:410}))
    .mockResolvedValueOnce(view('generation-B'));
  vi.stubGlobal('fetch',fetcher);
  render(<ServiceTopologyView supported/>);
  fireEvent.click(await screen.findByRole('button',{name:'다음'}));
  await screen.findByText('스냅샷이 만료되었습니다. 새로고침하세요.');
  const params=(index:number)=>new URL(fetcher.mock.calls[index][0],'http://local').searchParams;
  expect(params(1).get('snapshot')).toBe('generation-A');
  expect(params(1).get('cursor')).toBe('200');
  fireEvent.click(screen.getByRole('button',{name:'새로고침'}));
  await screen.findByRole('button',{name:'다음'});
  expect(params(2).has('snapshot')).toBe(false);
  expect(params(2).get('cursor')).toBe('0');
});

it('ignores a late response from a lens that has already been left', async () => {
  let resolveFirst!: (r:Response)=>void;
  const fetcher=vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{resolveFirst=resolve;}))
    .mockResolvedValueOnce(new Response(null,{status:401}));
  vi.stubGlobal('fetch',fetcher);
  render(<ServiceTopologyView supported/>);
  await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button',{name:'인프라 배치'}));
  const login=await screen.findByRole('link',{name:'로그인'});
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async()=>resolveFirst(view('old')));
  expect(login.isConnected).toBe(true);
  expect(screen.queryByRole('button',{name:'다음'})).toBeNull();
});
