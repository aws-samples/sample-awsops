// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { EbsVerdictBanners } from './EbsVerdictBanners';

afterEach(cleanup);

describe('EbsVerdictBanners (gap L210)', () => {
  it('encrypted volume → green verdict with the KMS key', () => {
    render(<EbsVerdictBanners data={{ encrypted: true, kms_key_id: 'arn:aws:kms:x:1:key/k', state: 'in-use' }} />);
    expect(screen.getByText('암호화됨')).toBeTruthy();
    expect(screen.getByText('arn:aws:kms:x:1:key/k')).toBeTruthy();
    expect(screen.queryByText('유휴 볼륨 (스냅샷 기준)')).toBeNull();
  });

  it("explicitly UNencrypted → red verdict with v1's encrypted-copy recommendation", () => {
    render(<EbsVerdictBanners data={{ encrypted: 'false', state: 'in-use' }} />);
    expect(screen.getByText('미암호화')).toBeTruthy();
    expect(screen.getByText('스냅샷으로 암호화 사본 생성을 검토하세요.')).toBeTruthy();
  });

  it('unknown encryption (field absent) renders NO verdict — tri-state honesty', () => {
    const { container } = render(<EbsVerdictBanners data={{ state: 'in-use' }} />);
    expect(container.innerHTML).toBe('');
  });

  it("a detached (state=available) volume adds the idle cost hint", () => {
    render(<EbsVerdictBanners data={{ encrypted: true, state: 'available' }} />);
    expect(screen.getByText('유휴 볼륨 (스냅샷 기준)')).toBeTruthy();
    expect(screen.getByText('마지막 sync 시점에 미연결 — 여전히 과금되므로 삭제로 비용 절감을 검토하세요.')).toBeTruthy();
  });
});
