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

  // Detail fields (gap L51) + report lang (gap L50).
  it('shows dayOfWeek for weekly, dayOfMonth for monthly, hour + lang always; renders lastRunAt', async () => {
    setFetch(() => sched({ dayOfWeek: 1, hour: 9, lang: 'en', lastRunAt: '2026-06-18T00:00:00.000Z' }));
    render(<SchedulePanel />);
    await waitFor(() => expect(screen.getByText('자동 진단 예약')).toBeTruthy());
    expect((screen.getByLabelText('실행 요일') as HTMLSelectElement).value).toBe('1');
    expect(screen.queryByLabelText('실행 날짜')).toBeNull();
    expect((screen.getByLabelText('실행 시각') as HTMLSelectElement).value).toBe('9');
    expect((screen.getByLabelText('리포트 언어') as HTMLSelectElement).value).toBe('en');
    expect(screen.getByText(/최근 실행/)).toBeTruthy();
  });
  it('monthly cadence swaps the weekday select for a day-of-month select', async () => {
    setFetch(() => sched({ scheduleType: 'monthly', dayOfMonth: 5 }));
    render(<SchedulePanel />);
    await waitFor(() => expect(screen.getByText('자동 진단 예약')).toBeTruthy());
    expect((screen.getByLabelText('실행 날짜') as HTMLSelectElement).value).toBe('5');
    expect(screen.queryByLabelText('실행 요일')).toBeNull();
  });
  it('PUT body carries only the cadence-appropriate detail field', async () => {
    setFetch(() => sched({ dayOfWeek: 1, dayOfMonth: 5, hour: 9 })); // stale cross-cadence value in state
    render(<SchedulePanel />);
    await waitFor(() => screen.getByText('저장'));
    fireEvent.click(screen.getByText('저장'));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body.dayOfWeek).toBe(1);
      expect(body.hour).toBe(9);
      expect(body.dayOfMonth).toBeUndefined(); // weekly PUT must not carry the monthly-only field
      expect(body.lang).toBe('ko'); // the displayed default is persisted, not omitted
    });
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
