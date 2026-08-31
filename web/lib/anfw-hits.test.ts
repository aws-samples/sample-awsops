// classifyHits() 판정 매트릭스 고정 — /network-firewall의 표 hits 컬럼(value/danger/render)과
// 상세 패널(ruleHitDetail)이 공유하는 단일 분류기. 분기 순서 자체가 계약이다(순서를 바꾸면
// 다른 판정이 나온다 — PR #225 round8-27 / PR #229 리뷰 이력). 이 테스트는 (a) 각 분기의
// 단독 판정과 (b) 상위 분기가 하위 분기를 이기는 우선순위, (c) exact가 되는 유일한 조합을
// 고정한다. reason 문구 전문은 UI 사본이므로 전부 스냅샷하지 않고, 분기 구분에 필요한
// 식별 키워드만 매칭한다(문구 수정이 판정 회귀 없이 가능하도록).
import { describe, it, expect } from 'vitest';
import { classifyHits, type RuleHitRow } from './anfw-hits';

/** 모든 불신 신호가 꺼진, exact가 나와야 하는 기준 행. 각 테스트는 여기서 한 신호씩 켠다. */
function row(over: Partial<RuleHitRow> = {}): RuleHitRow {
  return {
    key: 'r|g|1', sid: '1', msg: 'sig', actions: ['blocked'], hits: 5,
    ruleGroups: ['g'], configured: true,
    isPass: false,
    observability: 'observed',
    attributionUnsafe: false,
    sharedSid: false,
    unknown: false,
    unknownReason: null,
    hitsAttributable: true,
    ruleGroupModifiedInRange: false,
    ...over,
  };
}
// (alertCoverageComplete, ruleHitsPartial, alertObservabilityIncomplete)의 "깨끗한" 기본값.
const clean = [true, false, false] as const;

describe('classifyHits — 단독 분기 판정', () => {
  it('신호가 전부 깨끗하면 exact', () => {
    expect(classifyHits(row(), ...clean)).toEqual({ kind: 'exact' });
    expect(classifyHits(row({ hits: 0 }), ...clean)).toEqual({ kind: 'exact' });
  });

  it('isPass → na (pass/noalert 룰은 Alert 로그 미발생)', () => {
    const d = classifyHits(row({ isPass: true }), ...clean);
    expect(d.kind).toBe('na');
    expect((d as { reason: string }).reason).toContain('pass');
  });

  it('sharedSid → na (귀속 불가)', () => {
    const d = classifyHits(row({ sharedSid: true }), ...clean);
    expect(d.kind).toBe('na');
    expect((d as { reason: string }).reason).toContain('여러 룰 그룹');
  });

  it('unknown → unknown, unknownReason에 따라 문구 분기(failed vs truncated)', () => {
    const failed = classifyHits(row({ unknown: true, unknownReason: 'failed' }), ...clean);
    expect(failed.kind).toBe('unknown');
    expect((failed as { reason: string }).reason).toContain('쿼리 실패');
    const truncated = classifyHits(row({ unknown: true, unknownReason: 'truncated' }), ...clean);
    expect(truncated.kind).toBe('unknown');
    expect((truncated as { reason: string }).reason).toContain('절단');
  });

  it('attributionUnsafe → unknown (계정 전체 토폴로지 불신)', () => {
    const d = classifyHits(row({ attributionUnsafe: true }), ...clean);
    expect(d.kind).toBe('unknown');
    expect((d as { reason: string }).reason).toContain('불완전');
  });

  it('ruleGroupModifiedInRange → unknown (양수 히트도 귀속 불가 — round16 대칭성)', () => {
    const d = classifyHits(row({ ruleGroupModifiedInRange: true, hits: 100 }), ...clean);
    expect(d.kind).toBe('unknown');
    expect((d as { reason: string }).reason).toContain('수정');
  });

  it("observability 'unobserved' → na, 양수 히트여도 (오귀속 증거이므로 숫자 숨김)", () => {
    const d = classifyHits(row({ observability: 'unobserved', hits: 100 }), ...clean);
    expect(d.kind).toBe('na');
    expect((d as { reason: string }).reason).toContain('꺼져');
  });

  it("hits=0 + observability 'unknown' → unknown (0을 확정할 수 없음)", () => {
    const d = classifyHits(row({ observability: 'unknown', hits: 0 }), ...clean);
    expect(d.kind).toBe('unknown');
    expect((d as { reason: string }).reason).toContain('확정할 수 없음');
  });

  it('hits=0 + !alertCoverageComplete → unknown (시간적 커버리지 미확보 — round14)', () => {
    const d = classifyHits(row({ hits: 0 }), false, false, false);
    expect(d.kind).toBe('unknown');
    expect((d as { reason: string }).reason).toContain('기간 전체를 커버');
  });
});

describe('classifyHits — 양수 히트의 하한(≥N) 판정과 reason 우선순위', () => {
  it('hits>0 + !alertCoverageComplete → lowerbound, coverage 문구 (round19)', () => {
    const d = classifyHits(row(), false, false, false);
    expect(d.kind).toBe('lowerbound');
    expect((d as { reason: string }).reason).toContain('기간 전체를 커버하지 않아');
  });

  it('hits>0 + ruleHitsPartial → lowerbound, 리전 상한 문구 (round8)', () => {
    const d = classifyHits(row(), true, true, false);
    expect(d.kind).toBe('lowerbound');
    expect((d as { reason: string }).reason).toContain('리전별 상한');
  });

  it("hits>0 + observability 'unknown' → lowerbound, 부분 관측 문구 (round22)", () => {
    const d = classifyHits(row({ observability: 'unknown' }), true, false, false);
    expect(d.kind).toBe('lowerbound');
    expect((d as { reason: string }).reason).toContain('일부 방화벽만 관측');
  });

  it('hits>0 + configured:false + alertObservabilityIncomplete → lowerbound (PR #229 MAJOR)', () => {
    const d = classifyHits(row({ configured: false }), true, false, true);
    expect(d.kind).toBe('lowerbound');
    expect((d as { reason: string }).reason).toContain('CloudWatch Logs가 아니거나');
  });

  it('configured:true 행은 alertObservabilityIncomplete만으로는 하한이 되지 않는다 — 자체 observability가 판정 담당', () => {
    // 설정 룰은 자기 룰그룹의 observability 신호가 공간 결손을 이미 커버하므로,
    // 계정 전역 신호를 중복 적용하면 완전 관측된 그룹까지 과도하게 강등된다.
    expect(classifyHits(row({ configured: true }), true, false, true)).toEqual({ kind: 'exact' });
  });

  it('reason 우선순위: !coverage > partial > observability-unknown > non-configured-incomplete', () => {
    // 넷 다 켜져도 coverage 문구가 이긴다.
    const all = classifyHits(row({ configured: false, observability: 'unknown' }), false, true, true);
    expect((all as { reason: string }).reason).toContain('기간 전체를 커버하지 않아');
    // coverage만 끄면 partial이 이긴다.
    const noCov = classifyHits(row({ configured: false, observability: 'unknown' }), true, true, true);
    expect((noCov as { reason: string }).reason).toContain('리전별 상한');
    // partial도 끄면 observability-unknown이 이긴다.
    const obsOnly = classifyHits(row({ configured: false, observability: 'unknown' }), true, false, true);
    expect((obsOnly as { reason: string }).reason).toContain('일부 방화벽만 관측');
  });
});

describe('classifyHits — 분기 순서(우선순위) 계약', () => {
  it('isPass는 sharedSid보다 먼저 (pass 룰이 SID를 공유해도 pass 문구)', () => {
    const d = classifyHits(row({ isPass: true, sharedSid: true }), ...clean);
    expect((d as { reason: string }).reason).toContain('pass');
  });

  it('sharedSid는 unknown보다 먼저 (na가 unknown을 이김 — 귀속 불가가 더 강한 판정)', () => {
    const d = classifyHits(row({ sharedSid: true, unknown: true, unknownReason: 'failed' }), ...clean);
    expect(d.kind).toBe('na');
  });

  it('unknown(집계 실패)은 attributionUnsafe보다 먼저', () => {
    const d = classifyHits(row({ unknown: true, unknownReason: 'failed', attributionUnsafe: true }), ...clean);
    expect((d as { reason: string }).reason).toContain('쿼리 실패');
  });

  it('attributionUnsafe는 ruleGroupModifiedInRange보다 먼저 (계정 전체 신호가 국지 신호를 흡수 — round19)', () => {
    const d = classifyHits(row({ attributionUnsafe: true, ruleGroupModifiedInRange: true }), ...clean);
    expect((d as { reason: string }).reason).toContain('불완전');
  });

  it("unobserved(na)는 hits=0 unknown 분기보다 먼저 (확정 부관측 > 불확실)", () => {
    const d = classifyHits(row({ observability: 'unobserved', hits: 0 }), false, false, false);
    expect(d.kind).toBe('na');
  });

  it('hits=0의 observability 검사가 coverage 검사보다 먼저 (문구 구분)', () => {
    const d = classifyHits(row({ observability: 'unknown', hits: 0 }), false, false, false);
    expect((d as { reason: string }).reason).toContain('관측할 수 있는지');
    expect((d as { reason: string }).reason).not.toContain('기간 전체를 커버');
  });
});
