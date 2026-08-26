// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import SchedulePanel from './SchedulePanel';

let fetchMock: ReturnType<typeof vi.fn>;
function setFetch(handler: (url: string, init?: RequestInit) => unknown) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, status: 200, json: async () => handler(url, init) }));
  global.fetch = fetchMock as unknown as typeof fetch;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const sched = (over: Record<string, unknown> = {}) => ({
  schedule: { scheduleType: 'weekly', enabled: true, tier: 'mid', model: null, nextRunAt: '2026-06-25T00:00:00.000Z', lastRunAt: null, ...over },
});

describe('SchedulePanel', () => {
  it('loads the schedule and shows the next run when enabled', async () => {
    setFetch(() => sched());
    render(<SchedulePanel />);
    await waitFor(() => expect(screen.getByText('자동 진단 예약')).toBeTruthy());
    expect((screen.getByLabelText('진단 주기') as HTMLSelectElement).value).toBe('weekly');
    expect(screen.getByText(/다음 실행/)).toBeTruthy();
  });

  it('hides the next run when disabled', async () => {
    setFetch(() => sched({ enabled: false, nextRunAt: null }));
    render(<SchedulePanel />);
    await waitFor(() => expect(screen.getByText('자동 진단 예약')).toBeTruthy());
    expect(screen.queryByText(/다음 실행/)).toBeNull();
  });

  it('persists via PUT when 저장 is clicked', async () => {
    setFetch(() => sched());
    render(<SchedulePanel />);
    await waitFor(() => screen.getByText('저장'));
    fireEvent.click(screen.getByText('저장'));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(String((put![1] as RequestInit).body)).toContain('weekly');
    });
  });
});
