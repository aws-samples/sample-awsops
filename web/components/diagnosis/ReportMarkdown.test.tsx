// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ReportMarkdown from './ReportMarkdown';

afterEach(cleanup);

const MD = `# AWS 진단 리포트

## Cost Overview

### 비용 총괄

| 서비스 | 월비용($) | 비중% |
| --- | --- | --- |
| EC2 | 123.45 | 60 |
| S3 | 10.00 | 5 |

- 첫째 항목
- 둘째 항목
`;

describe('ReportMarkdown — diagnosis report renderer', () => {
  it('renders GFM tables with header + body cells (not raw pipes)', () => {
    render(<ReportMarkdown markdown={MD} />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '서비스' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'EC2' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '123.45' })).toBeTruthy();
    // no raw pipe leakage
    expect(screen.queryByText(/\| 서비스 \|/)).toBeNull();
  });

  it('renders the document / section / subsection heading hierarchy', () => {
    render(<ReportMarkdown markdown={MD} />);
    expect(screen.getByRole('heading', { level: 1, name: /AWS 진단 리포트/ })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Cost Overview' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: /비용 총괄/ })).toBeTruthy();
  });

  it('renders bullet lists as list items', () => {
    render(<ReportMarkdown markdown={MD} />);
    expect(screen.getByText('첫째 항목')).toBeTruthy();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(2);
  });

  it('collapses a doubled heading prefix (## ### X → ### X, no literal ###)', () => {
    // The section LLM sometimes emits `## ### 보안 점수`, which CommonMark renders as an h2 whose text
    // is literally "### 보안 점수". normalizeHeadings must collapse it to a real h3.
    render(<ReportMarkdown markdown={'## ### 보안 점수 (0~100)\n\n본문입니다.'} />);
    expect(screen.getByRole('heading', { level: 3, name: /보안 점수 \(0~100\)/ })).toBeTruthy();
    expect(screen.queryByText(/### 보안 점수/)).toBeNull(); // no literal ### on screen
  });
});
