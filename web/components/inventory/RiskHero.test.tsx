// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import RiskHero from './RiskHero';

afterEach(cleanup);

describe('RiskHero', () => {
  it('shows 정상 when no danger card has issues', () => {
    render(<RiskHero label="IAM Users" total={5} cards={[
      { label: 'MFA 설정', value: 5, variant: 'accent' },
      { label: 'MFA 미설정', value: 0, variant: 'danger' },
    ]} />);
    expect(screen.getByText('정상')).toBeTruthy();
    expect(screen.getByText('MFA 미설정')).toBeTruthy();
  });

  it('sums danger counts into a 주의 verdict', () => {
    render(<RiskHero label="CloudTrail" total={3} cards={[
      { label: '로깅 꺼짐', value: 2, variant: 'danger' },
      { label: '검증 비활성', value: 1, variant: 'danger' },
    ]} />);
    expect(screen.getByText('주의 3건')).toBeTruthy();
  });

  it('does NOT assert 정상 on a capped (partial) clean set — shows 표본 검사', () => {
    render(<RiskHero label="S3 Public" total={500} capped cards={[
      { label: '정책 공개', value: 0, variant: 'danger' },
    ]} />);
    expect(screen.queryByText('정상')).toBeNull();
    expect(screen.getByText('표본 검사')).toBeTruthy();
  });

  it('shows 주의 N건+ (lower bound) when capped with issues', () => {
    render(<RiskHero label="IAM Users" total={500} capped cards={[
      { label: 'MFA 미설정', value: 3, variant: 'danger' },
    ]} />);
    expect(screen.getByText('주의 3건+')).toBeTruthy();
  });
});
