import { describe, it, expect } from 'vitest';
import { parseChangelog } from './changelog';

const FIXTURE = `# Changelog

[badges](#english)

---

<a id="english"></a>

# English

Intro line.

## [Unreleased]

## [0.5.0] - 2026-08-02

### Added

- First v2 release
- **NFM** integration

## [1.9.0] - 2026-05-27

### Fixed

- old v1 fix

[Unreleased]: https://github.com/x/y/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/x/y/releases/tag/v0.5.0

---

<a id="korean"></a>

# 한국어

소개.

## [Unreleased]

## [0.5.0] - 2026-08-02

### Added

- v2 첫 릴리스

## [1.9.0] - 2026-05-27

### Fixed

- 옛 v1 수정

[Unreleased]: https://github.com/x/y/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/x/y/releases/tag/v0.5.0
`;

describe('parseChangelog', () => {
  it('latest = 첫 번째 non-Unreleased 버전 (사이드바 칩과 CHANGELOG 일치의 근거)', () => {
    const c = parseChangelog(FIXTURE);
    expect(c.latest).toBe('0.5.0');
  });

  it('버전 목록: Unreleased 포함 순서 유지 + 날짜 파싱', () => {
    const c = parseChangelog(FIXTURE);
    expect(c.versions.map((v) => v.version)).toEqual(['Unreleased', '0.5.0', '1.9.0']);
    expect(c.versions[1].date).toBe('2026-08-02');
    expect(c.versions[0].date).toBeNull();
  });

  it('언어별 본문 분리: en/ko가 각자의 섹션 본문을 가짐', () => {
    const c = parseChangelog(FIXTURE);
    const v = c.versions.find((x) => x.version === '0.5.0')!;
    expect(v.en).toContain('First v2 release');
    expect(v.en).not.toContain('릴리스');
    expect(v.ko).toContain('v2 첫 릴리스');
  });

  it('참조 링크 정의 줄은 본문에서 제거', () => {
    const c = parseChangelog(FIXTURE);
    const last = c.versions[c.versions.length - 1];
    expect(last.en).not.toMatch(/releases\/tag/);
  });

  it('한국어 섹션에 없는 버전은 영어 본문으로 폴백', () => {
    const noKo = FIXTURE.replace(/<a id="korean"><\/a>[\s\S]*$/, '');
    const c = parseChangelog(noKo);
    const v = c.versions.find((x) => x.version === '0.5.0')!;
    expect(v.ko).toBe(v.en);
  });

  it('빈 입력은 안전하게 빈 결과', () => {
    expect(parseChangelog('')).toEqual({ latest: null, versions: [] });
  });
});
