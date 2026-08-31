// Stateful 룰 히트 표시 판정 — /network-firewall 페이지의 표·상세 패널·차트가 공유하는
// 단일 분류기. page.tsx에서 추출(2026-08-28): 4곳(표 hits 컬럼 value/danger/render,
// ruleHitDetail)이 공유하는 order-sensitive 핵심 로직인데 유닛테스트가 없어 PR #229/#240
// 리뷰에서 반복 지적됨 — 순수 함수라 lib으로 옮겨 anfw-hits.test.ts로 고정한다.

export type Observability = 'observed' | 'unknown' | 'unobserved';

export interface RuleHitRow {
  key: string; sid: string; msg: string; actions: string[]; hits: number;
  ruleGroups: string[]; configured: boolean;
  /** pass 룰 또는 noalert 룰 — 둘 다 Alert 로그를 남기지 않으므로 매칭 0을 idle로 볼 수 없다.
   *  리뷰 MAJOR(PLAUSIBLE, PR #225 라운드9): noalert는 action이 alert/drop이어도 로그가
   *  안 남으므로 pass와 동일하게 취급해야 한다. */
  isPass: boolean;
  /** 이 룰 그룹을 서빙하는 방화벽들의 ALERT 관측 가능성(3상태) — 'observed'만 0을 신뢰.
   *  양수 히트는 이 값과 무관하게 항상 표시(실제 로그 매칭은 토폴로지 추정보다 강한
   *  증거) — attributionUnsafe/sharedSid만 양수 여부와 무관하게 숫자를 숨긴다. */
  observability: Observability;
  /** 계정(조회 스코프) 전체 단위 신호 — 어느 리전이든 firewalls/policies/ruleGroups
   *  List·Describe가 부분 실패했거나, 어느 정책이든 파싱 못한(관리형 등) stateful 룰
   *  그룹을 참조한다. true면 이 룰의 리전과 무관하게 sidGroupCount(rgs 전체 순회 전제)
   *  자체를 못 믿으므로, 0과 양수 모두 이 룰에 확정 귀속할 수 없다(히트는 sid로 리전
   *  불문 전역 병합되므로 "이 룰의 리전만 안전하면 된다"는 국지적 판정은 성립하지 않음). */
  attributionUnsafe: boolean;
  /** 같은 SID가 여러 룰 그룹에 존재 — 로그 히트를 특정 그룹에 귀속 불가. 리뷰 MAJOR(확정):
   *  숫자를 그대로 보여주면 그 그룹의 실제 트래픽처럼 오독된다 — 표시를 숨긴다(CLAUDE.md의
   *  "flagged in UI rather than counted" 서술을 실제로 구현). */
  sharedSid: boolean;
  /** 로그 집계 자체가 실패/잘렸거나(ruleHits=null) top-100 밖 — 매칭 여부 불명. */
  unknown: boolean;
  /** unknown=true인 이유 — 툴팁 문구 분기용(리뷰 MINOR: 원인이 서로 다른데 문구가 같았음). */
  unknownReason: 'failed' | 'truncated' | null;
  /** 화면에 실제 hits 숫자를 보여주는 행인가 — n/a/"?"로 숨기는 행과 동일한 조건.
   *  리뷰 확정(Codex stop-hook, PR #225): 정렬 키가 이 값과 다르면(예: 화면엔 항상
   *  n/a인 'unobserved' 행이 실제 hits로 정렬돼) top-50 표시 슬롯을 정보 없는 행이
   *  차지해 진짜 신뢰 가능한 행을 밀어낸다 — 정렬은 항상 화면 표시와 같은 기준을 써야 한다. */
  hitsAttributable: boolean;
  /** 이 룰 그룹 자체가 조회 range 시작 이후 수정됐음 — 지금 있는 SID가 range 전체 동안
   *  존재/동일했다고 보장할 수 없다(리뷰 MAJOR, PR #225 라운드15: 과거 히트가 현재
   *  토폴로지에 조인되지만 rg.lastModified가 검증에 쓰이지 않았음). true면 hits=0을
   *  확정 idle로 표시하지 않고, 양수 히트도 이 행에 확정 귀속하지 않는다
   *  (hitsAttributable=false). 룰 그룹을 참조하는 "정책" 쪽 수정(라운드17)은 라운드19에서
   *  attributionUnsafe(계정 전체)로 흡수됐다 — 정책에서 제거되거나 삭제된 룰 그룹은 현재
   *  토폴로지에 없어 이 필드로는 열거할 수 없기 때문(round8과 동일 논리로 계정 전체 불신
   *  쪽이 더 안전). */
  ruleGroupModifiedInRange: boolean;
}

// 리뷰 MAJOR(확정, PR #229): 표의 hits 컬럼 render와 상세 패널(ruleHitDetail)이 각자 다른
// 판정 기준을 썼다 — ruleHitDetail은 hitsAttributable만 봐서, hits===0인데 observability가
// 'observed'가 아니거나 alertCoverageComplete=false인 행(표에서는 "?" 처리)에서도
// hitsAttributable=true가 나와 "hits: 0"을 확정처럼 보여줬다(그 옆 hit_note는 "unknown"이라고
// 말하는데도). 두 표시가 항상 같은 결론을 내도록 판정 로직을 하나로 합친다 — round8-27의 전체
// 귀속 모델을 정확히 이 순서로 반영해야 한다(순서를 바꾸면 다른 판정이 나온다).
export type HitsDisplay =
  | { kind: 'na' | 'unknown'; reason: string }
  | { kind: 'lowerbound'; reason: string }
  | { kind: 'exact' };
export function classifyHits(r: RuleHitRow, alertCoverageComplete: boolean, ruleHitsPartial: boolean, alertObservabilityIncomplete: boolean): HitsDisplay {
  if (r.isPass) return { kind: 'na', reason: 'pass 또는 noalert 룰 — Alert 로그 미발생' };
  if (r.sharedSid) return { kind: 'na', reason: '여러 룰 그룹이 같은 SID 사용 — 어느 그룹의 히트인지 알 수 없어 숫자를 표시하지 않습니다' };
  if (r.unknown) {
    return { kind: 'unknown', reason: r.unknownReason === 'failed' ? '로그 집계 쿼리 실패 — 매칭 여부 불명' : '집계 절단(상위 100 sid 초과 또는 리전별 상한 도달)으로 이 sid가 포함됐는지 불명' };
  }
  if (r.attributionUnsafe) return { kind: 'unknown', reason: '일부 리전의 정책/방화벽/룰그룹 데이터가 불완전하거나, 파싱할 수 없는 룰그룹이 있거나, 어느 정책이 조회 기간 중 수정돼 그 시점 구성을 알 수 없어 매칭 여부·귀속을 확정할 수 없음' };
  if (r.ruleGroupModifiedInRange) return { kind: 'unknown', reason: '이 룰 그룹이 조회 기간 중에 수정됨 — 현재 SID가 기간 전체 동안 이 설정 그대로였다고 확정할 수 없어 히트를 이 룰에 귀속할 수 없음' };
  if (r.observability === 'unobserved') return { kind: 'na', reason: '이 룰 그룹을 서빙하는 방화벽 전부 ALERT 로깅이 꺼져 있음이 확인됨 — 표시되는 히트가 있어도 이 룰 귀속으로 볼 수 없음' };
  if (r.hits === 0 && r.observability !== 'observed') return { kind: 'unknown', reason: '이 룰 그룹을 관측할 수 있는지 확인할 수 없어 매칭 0을 확정할 수 없음' };
  if (r.hits === 0 && !alertCoverageComplete) return { kind: 'unknown', reason: 'ALERT 로그가 선택한 기간 전체를 커버하지 않거나 커버 여부를 확인할 수 없어 매칭 0을 확정할 수 없음 (로깅이 기간 중간에 시작됐거나, 로그 그룹 조회가 거부/시간 초과됨)' };
  // 리뷰 MAJOR(확정, PR #229 AI Code Review): configured:false(관리형/미설정 SID) 행은
  // 어느 룰 그룹에도 속하지 않아 observability를 계산할 근거가 없으므로 하드코딩된
  // 'observed'로만 채워진다 — 그래서 이 행들은 위 observability 기반 분기를 전혀 타지
  // 않는다. 하지만 alertObservabilityIncomplete(일부 방화벽의 ALERT 목적지가 CWL이
  // 아니거나 로깅이 꺼져 있음)가 true면, 그 방화벽에서 발생한 이 SID의 매칭은 애초에
  // 이 로그 집계에 나타날 수 없다 — 공간적으로 불완전한 값인데도 하드코딩된 'observed'
  // 때문에 exact로 보인다. 도넛/바 차트/빈 상태는 이미 이 신호를 반영하므로, 표·상세
  // 패널만 예외로 남으면 같은 화면에서 서로 다른 결론을 보여주게 된다.
  if (r.hits > 0 && (ruleHitsPartial || !alertCoverageComplete || r.observability === 'unknown' || (!r.configured && alertObservabilityIncomplete))) {
    return {
      kind: 'lowerbound',
      reason: !alertCoverageComplete ? 'ALERT 로그가 기간 전체를 커버하지 않아 실제 값이 더 클 수 있음 — 하한'
        : ruleHitsPartial ? '리전별 상한에 도달해 실제 값이 더 클 수 있음 — 하한'
          : r.observability === 'unknown' ? '일부 방화벽만 관측이 확인돼 실제 값이 더 클 수 있음 — 하한'
            : '일부 방화벽의 ALERT 로깅이 CloudWatch Logs가 아니거나 꺼져 있어, 이 SID의 매칭이 이 집계에 전부 반영됐다고 확정할 수 없음 — 하한',
    };
  }
  return { kind: 'exact' };
}
