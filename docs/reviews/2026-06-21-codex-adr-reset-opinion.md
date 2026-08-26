# Codex opinion: ADR reset / ADR 리셋 의견

> 작성: 2026-06-21  
> 작성자: Codex reviewer  
> 목적: Claude가 이어서 문서/ADR 정합 리셋을 진행할 때 참고할 수 있는 외부 리뷰어 의견. 이 문서는 새 ADR이 아니며, 기존 ADR 상태를 변경하지 않는다.

## 결론

나는 **ADR 리셋에 찬성**한다. 현재 문제는 단순히 ADR 수가 많다는 것이 아니라, ADR 파일들이 동시에 세 가지 역할을 하고 있다는 점이다.

1. 당시의 의사결정 기록
2. 현재 구현의 진실
3. AI 에이전트가 매 세션 따라야 하는 지시문

이 세 역할을 한 디렉터리와 한 인덱스에 계속 섞어두면, AI는 매번 `Accepted`, `REVERSED`, `DOWNGRADED`, `carve-out`, `owner-override`, `addendum` 체인을 다시 추론한다. 그 결과 "기록 보존"이라는 장점보다 "현재 지시의 불확실성"이라는 비용이 더 커졌다.

따라서 리셋의 본질은 **기록 삭제 여부**가 아니라 **active context에서 역사 기록을 제거하는 것**이어야 한다.

## 근거

- `docs/decisions/CLAUDE.md`는 현재 001~045 ADR을 같은 인덱스에 두고, 여러 행에서 승계/정정/번복/예외를 긴 문장으로 누적한다. 특히 029~041 구간은 현재 상태를 한 번에 판정하기 어렵다.
- 현재 루트 `AGENTS.md`는 v2 product posture를 "read-only ops dashboard + AI diagnosis"로 두고, AWS-resource mutation + autonomy는 permanently frozen이라고 명시한다.
- 반면 `docs/superpowers/specs/2026-06-21-decisions-baseline-reset-design.md`는 `do-not-enable 영구 동결`을 `로드맵 게이트`로 재서술하자고 제안한다.
- 이 차이는 단순 문구 정리가 아니다. **"영구 동결"과 "조건 충족 시 켤 수 있는 로드맵 게이트"는 제품 결정이 다르다.** Claude가 다음 단계로 가기 전에 owner가 이 점을 명시적으로 결정해야 한다.
- `decision-reconcile` 스킬의 기본 파서는 `ADR-*.md` 파일명을 전제로 하지만, 이 저장소는 `NNN-kebab-case-title.md` 형식이다. 도구가 ADR을 0개로 보는 것도 현재 문서 체계가 일반 ADR 자동화와 어긋나 있음을 보여주는 작은 증거다.

## 권고

### 1. 현행 진실은 `BASELINE.md` 하나로 만든다

`docs/decisions/BASELINE.md`를 만들고, AI가 판단할 현재 진실은 여기에만 둔다. 기존 ADR 번호는 `why: ADR-0xx` 포인터로만 남기고, 번복 체인 자체를 본문에 재생하지 않는다.

BASELINE에는 최소한 다음 세 가지가 필요하다.

- 현재 LIVE 결정
- 현재 OFF/gated 결정
- 절대 불변식과 용어 정의

### 2. 기존 ADR은 active decision surface에서 제거한다

기존 ADR 001~045를 계속 `docs/decisions/*.md` 또는 `docs/decisions/archive/*.md`에 두는 것은 반쪽짜리 해결일 수 있다. 많은 AI 컨텍스트 생성기는 디렉터리 이름이 `decisions`이면 archive 하위도 같이 읽는다.

내 권고는 다음 순서다.

1. 먼저 `docs/decisions/BASELINE.md`를 만든다.
2. 기존 ADR은 `docs/history/decisions-archive/` 같은 역사 전용 경로로 이동한다.
3. `docs/decisions/CLAUDE.md`, 루트 `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`에는 "현행 진실은 BASELINE만 읽고, history/archive는 명시 요청 없이는 읽지 말라"는 짧은 규칙을 둔다.
4. 그래도 co-agent/context sync가 archive를 계속 끌어오면, 기존 ADR 원문은 repo에서 제거하고 git tag 또는 release artifact로 보존한다.

여기서 "repo에서 제거"는 기록 파괴가 아니다. Git history가 기록이다. 운영상 중요한 것은 과거 문서를 항상 working tree와 AI context에 노출시키는 것이 아니라, 필요할 때 재현 가능하게 보존하는 것이다.

### 3. "영구 동결" 대 "로드맵 게이트"는 리셋 전에 결정한다

현재 문서 리셋 설계는 안전한 실행/자동화를 장기 목표로 두고, AWS 리소스 변경과 자율 조치를 "영구 금지"가 아니라 "아직 안 켬"으로 재해석한다. 반면 현재 reviewer context와 2026-06-11 reversal record는 AWS-resource mutation + autonomy를 permanently reversed/frozen으로 둔다.

이 둘은 동시에 true일 수 없다. 리셋 후 BASELINE은 둘 중 하나를 명확히 선택해야 한다.

내 판단은 보수적으로는 다음과 같다.

- 지금 당장 BASELINE에는 **현재 invariant**를 유지한다: AWS-resource mutation + autonomy는 OFF이며, 켜는 PR은 regression으로 본다.
- owner가 장기적으로 "영구 금지"를 "조건부 로드맵"으로 바꾸고 싶다면, 그것은 문서 정리가 아니라 **제품 결정 변경**이다.
- 그 변경은 별도 owner decision log 또는 새 ADR-equivalent 항목으로 남겨야 하며, 2026-06-11 multi-AI reversal을 조용히 재해석해서는 안 된다.

### 4. 새 ADR 체계는 "기록"보다 "판정 가능성"을 우선한다

앞으로의 ADR은 장문의 역사 서사가 아니라 판정 가능한 결정 단위여야 한다.

- Status는 하나만 둔다.
- Post-acceptance addendum은 짧게 제한한다.
- 같은 주제에 두 번째 반전이 생기면 기존 ADR에 덧붙이지 말고 새 decision 항목으로 대체한다.
- "AI가 이 문서만 보고 PR을 막거나 통과시킬 수 있는가?"를 품질 기준으로 둔다.

## Claude에게 제안하는 다음 실행 순서

1. 현재 `docs/superpowers/specs/2026-06-21-decisions-baseline-reset-design.md`를 계속 사용하되, `docs/decisions/archive/` 대신 `docs/history/decisions-archive/`를 우선 검토한다.
2. Phase 1 감사 전에 owner에게 한 가지를 확인한다: AWS-resource mutation/autonomy는 계속 permanently frozen인가, 아니면 조건부 roadmap gate로 바꾸려는가?
3. Phase 1 감사 결과가 나오기 전에는 기존 ADR을 rewrite하지 않는다. 이동/격리와 BASELINE 초안만 만든다.
4. BASELINE이 확정되면 모든 agent-facing context는 기존 ADR 인덱스가 아니라 BASELINE을 가리키도록 바꾼다.

## 최종 의견

기존 ADR을 "삭제하지 말자"는 원칙은 audit 관점에서는 맞았지만, AI 작업 환경에서는 충분하지 않았다. 이제 필요한 원칙은 더 구체적이어야 한다.

**기록은 보존하되, 현행 지시에서 제거한다.**

그 제거가 archive 이동으로 충분하면 archive가 맞고, archive도 계속 AI context에 섞이면 repo working tree에서 제거하는 것이 맞다. 중요한 것은 과거 결정을 영원히 잃지 않는 것이 아니라, 현재 결정을 더 이상 모순되게 읽지 않도록 만드는 것이다.
