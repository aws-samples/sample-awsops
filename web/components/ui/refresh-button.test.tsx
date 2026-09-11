// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import RefreshButton from './RefreshButton';

afterEach(cleanup);

describe('RefreshButton force-sync (gap L79)', () => {
  it('without onForceSync renders only the Refresh button (unchanged surface)', () => {
    render(<RefreshButton busy={false} onClick={() => {}} />);
    expect(screen.getByText('Refresh')).toBeTruthy();
    expect(screen.queryByText('전체 동기화')).toBeNull();
  });

  it('queued outcome shows the async-semantics note (no optimistic data mutation)', async () => {
    const onForceSync = vi.fn().mockResolvedValue('queued');
    render(<RefreshButton busy={false} onClick={() => {}} onForceSync={onForceSync} />);
    fireEvent.click(screen.getByText('전체 동기화'));
    await waitFor(() => expect(screen.getByText(/동기화가 큐에 등록/)).toBeTruthy());
    expect(onForceSync).toHaveBeenCalledTimes(1);
  });

  it('forbidden outcome shows the admin-only note and disables further attempts', async () => {
    const onForceSync = vi.fn().mockResolvedValue('forbidden');
    render(<RefreshButton busy={false} onClick={() => {}} onForceSync={onForceSync} />);
    const btn = screen.getByText('전체 동기화').closest('button')!;
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/관리자 전용/)).toBeTruthy());
    expect(btn.disabled).toBe(true);
  });

  it('unconfigured outcome shows the sync-disabled note', async () => {
    const onForceSync = vi.fn().mockResolvedValue('unconfigured');
    render(<RefreshButton busy={false} onClick={() => {}} onForceSync={onForceSync} />);
    fireEvent.click(screen.getByText('전체 동기화'));
    await waitFor(() => expect(screen.getByText(/sync가 비활성화/)).toBeTruthy());
  });

  it('a rejected dispatcher lands on the error note (never an unhandled rejection)', async () => {
    const onForceSync = vi.fn().mockRejectedValue(new Error('boom'));
    render(<RefreshButton busy={false} onClick={() => {}} onForceSync={onForceSync} />);
    fireEvent.click(screen.getByText('전체 동기화'));
    await waitFor(() => expect(screen.getByText(/요청에 실패/)).toBeTruthy());
  });
});
