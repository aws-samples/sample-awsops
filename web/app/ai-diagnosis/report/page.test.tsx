// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/components/shell/LanguageProvider';
import PrintReportPage from './page';

const search = new URLSearchParams('id=7');
vi.mock('next/navigation', () => ({ useSearchParams: () => search, useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const REPORT = { id: 7, title: 'Fleet Deep Dive', tier: 'deep', status: 'succeeded', created_at: '2026-09-01T00:00:00Z', finished_at: '2026-09-01T00:20:00Z' };
const MD = '# Fleet Deep Dive\nintro text\n\n## Compute\nec2 body\n\n## Network\nvpc body';

function setFetch(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(String(url)).toBe('/api/diagnosis/7');
    return { ok, status: ok ? 200 : 404, json: async () => body };
  }));
}

const mount = () => render(<LanguageProvider><PrintReportPage /></LanguageProvider>);

describe('printable report view (gap L179)', () => {
  it('renders the cover block, a numbered anchor TOC from ## headings, and per-section page breaks', async () => {
    setFetch({ report: REPORT, markdown: MD });
    mount();
    // The markdown body repeats the # title — assert on the COVER h1 specifically.
    await waitFor(() => expect(screen.getAllByText('Fleet Deep Dive').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('deep')).toBeTruthy(); // cover tier
    const toc = screen.getAllByRole('link');
    expect(toc.map((a) => a.getAttribute('href'))).toEqual(['#report-sec-0', '#report-sec-1']);
    expect(document.getElementById('report-sec-0')).toBeTruthy();
    expect(document.getElementById('report-sec-1')?.className).toContain('print-break');
  });

  it('Print / Close buttons render on screen and carry the print-hidden class', async () => {
    setFetch({ report: REPORT, markdown: MD });
    mount();
    await waitFor(() => expect(screen.getByText('인쇄')).toBeTruthy());
    expect(screen.getByText('인쇄').closest('div')?.className).toContain('print-hidden');
    expect(screen.getByText('닫기')).toBeTruthy();
  });

  it("a null markdown (artifact unreadable) reads '데이터 불가' under the cover — never a blank page", async () => {
    setFetch({ report: REPORT, markdown: null });
    mount();
    await waitFor(() => expect(screen.getByText('리포트 본문을 읽지 못했습니다.')).toBeTruthy());
  });

  it("an EMPTY-string markdown (zero-byte artifact) also takes the honest fallback", async () => {
    setFetch({ report: REPORT, markdown: '   ' });
    mount();
    await waitFor(() => expect(screen.getByText('리포트 본문을 읽지 못했습니다.')).toBeTruthy());
  });

  it('a not-yet-finished report reads its status, not a body-read failure', async () => {
    setFetch({ report: { ...REPORT, status: 'running' }, markdown: null });
    mount();
    await waitFor(() => expect(screen.getByText(/리포트가 아직 완료되지 않았습니다\. \(running\)/)).toBeTruthy());
  });

  it('a ## line inside a code fence never becomes a section/TOC entry (fence-aware split)', async () => {
    setFetch({ report: REPORT, markdown: '## Real\nbody\n```\n## not-a-heading\n```\ntail' });
    mount();
    await waitFor(() => expect(screen.getAllByRole('link').length).toBe(1));
    expect(screen.getAllByRole('link')[0].textContent).toBe('Real');
  });

  it('fetch failure renders the inline error state', async () => {
    setFetch({}, false);
    mount();
    await waitFor(() => expect(screen.getByText('리포트를 불러오지 못했습니다.')).toBeTruthy());
  });
});
