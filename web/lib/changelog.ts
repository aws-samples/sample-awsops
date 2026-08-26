import { promises as fs } from 'node:fs';
import path from 'node:path';

// 사이드바 하단 버전 표시 + 변경 이력 모달의 데이터 계층 (서버 전용 — fs 사용).
// 단일 진실 = 저장소 루트 CHANGELOG.md: 배포 이미지에는 deploy.mjs가 빌드 직전 복사해
// /app/CHANGELOG.md 로 들어오고(standalone cwd), 로컬 dev(cwd=web/)는 ../CHANGELOG.md 폴백.
// CHANGELOG는 이중언어(# English / # 한국어) — 버전 목록은 양쪽 동일, 본문만 언어별.

export interface ChangelogVersion {
  version: string;         // '0.5.0' | 'Unreleased'
  date: string | null;     // 'YYYY-MM-DD'
  en: string;              // 해당 버전의 영어 본문 (마크다운)
  ko: string;              // 해당 버전의 한국어 본문 (마크다운)
}
export interface Changelog {
  /** 최신 릴리스 버전 (Unreleased 제외) — 사이드바에 표시. */
  latest: string | null;
  versions: ChangelogVersion[];
}

/** 한 언어 섹션에서 버전 헤딩(## [x.y.z] - date) 단위로 본문을 자른다 (참조 링크 줄은 제외). */
function sliceVersions(section: string): { version: string; date: string | null; body: string }[] {
  const out: { version: string; date: string | null; body: string }[] = [];
  const re = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/gm;
  const heads: { version: string; date: string | null; at: number; end: number }[] = [];
  for (let m = re.exec(section); m; m = re.exec(section)) {
    heads.push({ version: m[1], date: m[2] ?? null, at: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < heads.length; i++) {
    const bodyEnd = i + 1 < heads.length ? heads[i + 1].at : section.length;
    const body = section
      .slice(heads[i].end, bodyEnd)
      .split('\n')
      .filter((l) => !/^\[[^\]]+\]:\s+http/.test(l)) // 참조 링크 정의 제거
      .join('\n')
      .trim();
    out.push({ version: heads[i].version, date: heads[i].date, body });
  }
  return out;
}

/** 순수 파서 — 테스트 대상. raw 이중언어 CHANGELOG → 버전별 en/ko 본문. */
export function parseChangelog(raw: string): Changelog {
  const koAt = raw.search(/^# 한국어\s*$/m);
  const enAt = raw.search(/^# English\s*$/m);
  const en = enAt >= 0 ? raw.slice(enAt, koAt > enAt ? koAt : undefined) : raw;
  const ko = koAt >= 0 ? raw.slice(koAt) : '';
  const enV = sliceVersions(en);
  const koMap = new Map(sliceVersions(ko).map((v) => [v.version, v.body]));
  const versions: ChangelogVersion[] = enV.map((v) => ({
    version: v.version, date: v.date, en: v.body, ko: koMap.get(v.version) ?? v.body,
  }));
  const latest = versions.find((v) => v.version !== 'Unreleased')?.version ?? null;
  return { latest, versions };
}

const CANDIDATES = [
  () => path.join(process.cwd(), 'CHANGELOG.md'),        // standalone 컨테이너 (/app)
  () => path.join(process.cwd(), '..', 'CHANGELOG.md'),  // 로컬 dev (cwd=web/)
];

let cached: Changelog | null = null;

/** CHANGELOG.md를 읽어 파싱 (모듈 캐시 — 파일은 배포 단위로만 바뀜). */
export async function getChangelog(): Promise<Changelog> {
  if (cached) return cached;
  for (const p of CANDIDATES) {
    try {
      cached = parseChangelog(await fs.readFile(p(), 'utf8'));
      return cached;
    } catch { /* try next */ }
  }
  return { latest: null, versions: [] };
}

export function _resetChangelogCacheForTests() { cached = null; }
