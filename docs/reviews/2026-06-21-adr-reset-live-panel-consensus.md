# ADR/문서 리셋 — 라이브 멀티-AI 패널 합의 (2026-06-21)

> 검토 대상: `docs/superpowers/specs/2026-06-21-decisions-baseline-reset-design.md` (접근/방안 검증)
> 패널: kiro(claude-opus-4.8 · kimi-k2.5 · glm-5) + antigravity(Gemini 3.1 Pro High) + codex(gpt-5.5) = **5쌍, 5패밀리**. gemini CLI는 티어 종료로 스킵.
> 별도로 owner가 제출한 codex 독립 의견(`docs/reviews/2026-06-21-codex-adr-reset-opinion.md`)도 동일 결론으로 수렴 → 총 6개 독립 AI 관점.
> chair: Claude. 인용은 실제 코드로 교차검증 완료.

## VERDICT: SOUND-WITH-CHANGES (5/5 만장일치)
핵심 진단(BASELINE 단일 진실 + ADR archive + 현행/역사 분리 + 고정 북극성)은 옳다. 단 아래 변경 필수.

## 교차검증된 사실 (chair 확인)
1. ✅ `terraform/foundation/variables.tf:142` `remediation_enabled` = "⛔ DECISION REVERSED 2026-06-11 — DO NOT ENABLE … Stays false permanently". → spec이 §2 원천으로 지정한 terraform이 정작 "영구"라 말함 = 자기모순.
2. ✅ `agent/agent.py` "the section agents are EXACTLY these 8" ↔ `scripts/v2/agentcore/catalog.py:3` "GATEWAYS: 9 domain gateway" = 실제 8↔9 doctrine/as-built 드리프트(Phase 1 감사 대상).
3. ✅ `docs/superpowers/reference/README.md:62` 가 아직 "P3 … OpenCost install button (ADR-029 **mutating**)" = *현행 설계 문서*에조차 번복 내용 잔존.
4. ✅ `variables.tf:148` `integrations_write_enabled` = 외부 DATA write 전용·독립 control plane·no-AWS-mutation IAM (ADR-040/041) → 2-티어가 코드에 이미 존재.

## 합의 지적 + 결정

### ⚠️ C1 (5/5 + codex) — "영구 동결 → 게이트 로드맵" 재서술은 안전·거버넌스 위반
- spec이 AWS 리소스 변경·자율을 `영구 금지`→`아직 안 켬`으로 softening. 전원이 위험 판정.
- 근거: ①자기모순(C1 사실), ②2026-06-16 거버넌스 규칙(scope-creep 번복 재서술 = 새 패널/owner-override 필요)을 우회, ③"frozen"="건드리지마" vs "gated"="조건 만족시켜봐" 의미 드리프트(에이전트 자기승인 여지).
- **결정(권고):** 코드의 실제 2-티어를 BASELINE에 그대로 반영.
  - **외부 DATA write** (`integrations_write_enabled`, Slack/Jira/Notion): 거버넌스 하 **gated-OFF(허용)** — 로드맵 OK.
  - **AWS 리소스 변경 + 자율** (`remediation_enabled` 등): **FROZEN 유지 / do-not-enable.** 재활성화 = "새 ADR로 번복을 명시 번복 + 패널 + owner-override". 켜는 PR = regression.
  - owner의 "운영으로 나아간다"는 §0 북극성의 *aspiration*으로 보존(가드레일 약화 없이). frozen↔aspiration은 양립.

### C2 (5/5) — anti-drift는 규율이 아니라 메커니즘
"진짜 실패는 ADR #46." 새 ADR/flag 변경 시 **같은 PR에서 BASELINE 갱신 강제** + (가능시) CI 체크로 BASELINE §2 ↔ terraform `*_enabled` default 대조. 없으면 BASELINE도 stale.

### C3 (3/5) — archive ADR에 forward 링크
통째 이동만 하면 옛 ADR 직접 열람 시 stale 본문만 봄. 각 archived ADR 상단에 "Superseded — 현행: BASELINE §X" 배너 + archive README의 ADR→BASELINE 매핑.

### C4 (codex 정제) — archive는 `decisions/` 바깥으로
AI 컨텍스트 생성기가 `decisions/**`(archive 포함) 읽음 → **`docs/history/decisions-archive/`** 로 이동. 그래도 새면 git tag 보존 + working tree 제거(폴백).

### C5 (4/5) — sweep 트리거 결정론화 + reference 우선
"LIVE면 history로"의 LIVE 정의·주체 없음 = architecture.md 갈라진 그 경로. 결정론적 기준 정의 + **spec을 reference/에 증류한 뒤** sweep(as-built 컨텍스트 손실 방지).

### C6 (3/5) — 에이전트 컨텍스트 전부 동기화
루트 `CLAUDE.md` + `docs/CLAUDE.md` + `docs/decisions/CLAUDE.md` **+ `AGENTS.md` + `GEMINI.md`**. 일부만 고치면 시스템프롬프트↔BASELINE 인지 부조화.

### C7 (3/5) — BASELINE 크기 예산
§1 무한정 누적 → 컨텍스트 한계. "index이지 소설 아님" 규칙(상세는 reference/로).

### C8 (kimi) — v1 범위 명시 제외
BASELINE = v2 현행 진실. v1(CDK/EC2/Steampipe, 여전히 프로덕션)은 별도 범위로 못박아 v1 패치가 "현행 진실 위반"으로 오독되지 않게.

### C9 (codex §4) — 앞으로의 ADR = "기록"보다 "판정 가능성"
Status 하나만, addendum 짧게, 같은 주제 2번째 반전이면 덧붙이지 말고 새 항목으로 대체, 품질 기준 = "AI가 이 문서만 보고 PR을 막/통과시킬 수 있는가".

### C10 (glm/kimi) — Phase 1 보강
병렬 서브에이전트 불일치 해소 프로토콜(owner 리뷰 게이트) + Phase1.5 자동 terraform `*_enabled` 대조.

## owner 결정 필요 (단 하나)
C1: AWS 리소스 변경·자율을 **(A) FROZEN 유지**(6-AI 권고) vs **(B) 게이트 로드맵 softening**(owner-override 로그 필수). chair 추천 = **A**.
