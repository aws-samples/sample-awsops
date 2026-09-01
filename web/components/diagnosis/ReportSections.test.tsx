// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import ReportSections, { splitSections, sectionSeverity } from './ReportSections';

afterEach(cleanup);

const MD = [
  '# AWS 진단 리포트 — 계정 123456789012 (mid)',
  '',
  '> 생성 일시: 2026-08-31 10:00 (KST)',
  '',
  '**목차**',
  '',
  '- [Executive Summary](#executive_summary)',
  '- [Security Posture](#security_posture)',
  '',
  '## Executive Summary',
  '',
  '전반적으로 양호합니다.',
  '',
  '## Security Posture',
  '',
  '[Critical] 0.0.0.0/0 인그레스 위반이 발견되었습니다.',
  '',
  '## Recommendations',
  '',
  '[Warning] gp2 → gp3 전환을 권장합니다.',
].join('\n');

describe('splitSections', () => {
  it('splits on h2 headings and strips the dead markdown TOC from the preamble', () => {
    const { preamble, sections } = splitSections(MD);
    expect(sections.map((s) => s.title)).toEqual(['Executive Summary', 'Security Posture', 'Recommendations']);
    expect(preamble).toContain('# AWS 진단 리포트');
    expect(preamble).not.toContain('**목차**');
    expect(preamble).not.toContain('](#executive_summary)');
  });
  it('returns zero sections for markdown with no h2 heading', () => {
    expect(splitSections('# 제목\n\n본문뿐').sections).toEqual([]);
  });
  it('does not split on a ## line inside a code fence (backtick or tilde)', () => {
    const md = '## A\n\n```\n## not a heading\n```\n\n## B\n\nb';
    const { sections } = splitSections(md);
    expect(sections.map((s) => s.title)).toEqual(['A', 'B']);
    expect(sections[0].body).toContain('## not a heading');
    const tilde = splitSections('## A\n\n~~~\n## nope\n~~~\n\n## B\n\nb');
    expect(tilde.sections.map((s) => s.title)).toEqual(['A', 'B']);
  });
  it('strips the localized TOC labels too', () => {
    const en = '# T\n\n**Table of Contents**\n\n- [A](#a)\n\n## A\n\nbody';
    expect(splitSections(en).preamble).not.toContain('Table of Contents');
  });
});

describe('sectionSeverity', () => {
  it('matches the verbatim markers only; critical beats warning', () => {
    expect(sectionSeverity('[Critical] 위반 and [Warning]')).toBe('critical');
    expect(sectionSeverity('[Warning] 주의가 필요')).toBe('warning');
    expect(sectionSeverity('모두 정상입니다')).toBe('ok');
  });
  it('does NOT false-positive on the prompt-mandated 심각도 table column or prose keywords', () => {
    expect(sectionSeverity('| 항목 | 심각도 | 권고 |\n| a | Info | b |')).toBe('ok');
    expect(sectionSeverity('취약점 없음, 전환을 recommend하지 않음')).toBe('ok');
  });
  it('a degraded/failed section body never reads green', () => {
    expect(sectionSeverity('_이 섹션 생성에 실패했습니다 (degraded): boom_')).toBe('warning');
  });
});

describe('ReportSections', () => {
  it('renders section cards + a TOC sidebar; collapse toggle hides the body', () => {
    render(<ReportSections markdown={MD} />);
    // TOC + card both carry the title.
    expect(screen.getAllByText('Security Posture').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/전반적으로 양호/)).toBeTruthy();
    // Collapse the first section (the card header button carries aria-expanded).
    const header = screen.getAllByRole('button', { expanded: true })[0];
    fireEvent.click(header);
    expect(screen.queryByText(/전반적으로 양호/)).toBeNull();
  });
  it('falls back to the continuous document when there is no h2 section', () => {
    render(<ReportSections markdown={'# 제목\n\n본문뿐'} />);
    expect(screen.getByText('본문뿐')).toBeTruthy();
    expect(screen.queryByText('모두 접기')).toBeNull();
  });
});
