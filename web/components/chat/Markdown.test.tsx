// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@/components/charts/MultiLineTrend', () => ({
  default: ({ title, variant, data }: any) => <div data-testid="metric-chart">{title} · {variant} · {data.length}</div>,
}));
import Markdown from './Markdown';

afterEach(cleanup);

describe('Markdown (assistant rendering)', () => {
  it('renders headings, bold and lists as elements (not raw text)', () => {
    const { container } = render(<Markdown>{'## 제목\n\n**굵게** 그리고\n\n- 하나\n- 둘'}</Markdown>);
    expect(container.querySelector('h2')?.textContent).toContain('제목');
    expect(container.querySelector('strong')?.textContent).toBe('굵게');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders GFM tables', () => {
    const md = '| 액션 | 위험 |\n| --- | --- |\n| iam:PassRole | 높음 |';
    const { container } = render(<Markdown>{md}</Markdown>);
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(screen.getByText('iam:PassRole')).toBeTruthy();
    expect(screen.getByText('높음')).toBeTruthy();
  });

  it('renders inline code and fenced code blocks', () => {
    const { container } = render(<Markdown>{'inline `code` here\n\n```\nblock code\n```'}</Markdown>);
    expect(container.querySelector('code')).toBeTruthy();
    expect(container.querySelector('pre')).toBeTruthy();
    expect(container.textContent).toContain('block code');
  });

  it('opens links in a new tab with rel=noopener noreferrer', () => {
    const { container } = render(<Markdown>{'[AWS](https://aws.amazon.com)'}</Markdown>);
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://aws.amazon.com');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('does NOT render raw HTML (XSS-safe by default)', () => {
    const { container } = render(<Markdown>{'<img src=x onerror="alert(1)"> and <b>raw</b>'}</Markdown>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('tolerates partial/empty markdown mid-stream', () => {
    expect(() => render(<Markdown>{''}</Markdown>)).not.toThrow();
    cleanup();
    expect(() => render(<Markdown>{'**unterminated and | half | table'}</Markdown>)).not.toThrow();
  });

  it('charts completed explicit time tables, separates units, and preserves the original table', () => {
    const md = '| 시각(UTC) | 에러율(%) | p99(ms) | 에러율 그래프 |\n| --- | --- | --- | --- |\n| 08:30 | 0.223 | 5.68 | ■■■ |\n| 08:35* | 0.148 | 4.24 | ■■ |';
    const { container } = render(<Markdown visualizeTables>{md}</Markdown>);
    expect(screen.getAllByTestId('metric-chart')).toHaveLength(2);
    expect(container.querySelector('table')?.textContent).toContain('08:35*');
    expect(container.querySelector('table')?.textContent).toContain('0.223');
    fireEvent.click(screen.getByRole('button', { name: '막대 그래프' }));
    expect(screen.getAllByTestId('metric-chart')[0].textContent).toContain('bar');
    fireEvent.click(screen.getByRole('button', { name: '표' }));
    expect(screen.queryByTestId('metric-chart')).toBeNull();
    expect(container.querySelector('table')).toBeTruthy();
  });

  it('keeps the default streaming renderer as a table without repeatedly creating charts', () => {
    render(<Markdown>{'| Time | Requests |\n| --- | --- |\n| 08:30 | 2 |\n| 08:35 | 3 |'}</Markdown>);
    expect(screen.queryByTestId('metric-chart')).toBeNull();
  });
});
