# 문서·결정·아키텍처 정합 리셋 — 설계 문서 (v3, 패널 합의 반영)

> 작성 2026-06-21 · 브랜치 `feat/v2-architecture-design`
> 한 줄 요약: 누적된 ADR 모순 + 문서↔현실 drift + V1→V2 미구현/오구현 + docs/ 구조 난맥을, **고정된 북극성** 위에 **단일 현행 진실 문서(BASELINE)** + **현행/역사 분리 docs IA**로 리셋한다. 옛 기록은 동결 보존(삭제 없음).
> **v3 변경:** 6-AI 패널 합의(`docs/reviews/2026-06-21-adr-reset-live-panel-consensus.md` + `2026-06-21-codex-adr-reset-opinion.md`) 반영 — freeze=유지(C1=A), archive를 `decisions/` 바깥으로(C4), anti-drift 메커니즘(C2), forward 링크(C3), sweep 결정론화(C5), 컨텍스트 전체 동기화(C6) 등.

---

## 1. 문제 (Problem)

1. **ADR 모순 누적** — 001~046. 029·031·032·035·036·039·040·041의 Status가 `REVERSED→carve-out→DOWNGRADED→owner-override→clarification→scope정정→addendum` 다층 누적 → "지금 무엇이 진실인가" 단일 출처 부재 → AI가 매 세션 체인을 *재생*하여 모순 재생산.
2. **문서↔현실 drift** — `docs/architecture.md`는 v1 기준(낡음). reference/CLAUDE.md 서술과 실제 코드/terraform flag·배포 상태 불일치(예: `agent.py` 8 agents ↔ `catalog.py` 9 gateways; `reference/README.md:62`에 번복된 ADR-029 mutating 잔존). V1→V2 미구현/오구현이 테스트 때마다 발견됨.
3. **docs/ 구조 난맥** — 현행 설계 2곳, 설계·계획 4곳, brainstorm·reviews 분산. 과정 잔여물(plans 75개 등)이 현행 진실과 혼재.
4. **근본 원인** — 고정된 **북극성**(목표/가치/핵심설계) 부재 → 결정 정당성 검증 기준 없음 → 번복 반복. (codex: ADR이 동시에 ①의사결정 기록 ②현행 진실 ③AI 지시문 3역할을 한 곳에서 수행 → active context에 역사가 섞임.)

## 2. 북극성 (North Star) — 확정 (변경 시 owner 승인)

### 목표
> **AWSops는 AWS에 올라가는 모든 리소스를 AWS Well-Architected 6대 기둥에 맞게 안전하고 빠르게 운영하도록 돕는다.**
> 6대 기둥: 운영 우수성 · 보안 · 안정성 · 성능 효율성 · 비용 최적화 · 지속가능성.
> 다양한 데이터소스와 에이전트로 **6대 기둥 관점의 진단과 해결방법 제시**를 제공하여 운영을 지속 고도화한다.

"안전하게"는 목표의 일부 → 지금까지의 read-only 번복은 "후퇴"가 아니라 **"안전을 위한 실행 경로 게이팅"**으로 재해석.

### 가치
- **단일 창에서 6대 기둥을 본다** — 인벤토리·토폴로지(안정성), 비용(비용최적화), 보안/CIS(보안), 메트릭(성능), 진단(운영우수성).
- **진단을 넘어 해결까지** — 라이브 데이터(AWS+외부 관측성)+에이전트로 근본원인 + *고치는 법*까지 제시.
- **안전 내장** — 빠르게 운영하되 위험한 실행은 통제·게이트·승인 뒤. 프로덕션 안전.

### 핵심 설계 — 4축
1. 모든 기능·진단은 **6대 기둥 중 하나 이상에 매핑**된다.
2. 운영의 현재 형태 = **진단 + 해결방법 제시**. 실행은 안전 게이트 뒤.
3. **Terraform MSA** — 비공개 엣지 · Aurora · thin-BFF + 비동기 워커 · AgentCore 섹션 에이전트 · 외부 데이터소스/통합.
4. **모든 신기능 flag-gated** — 기본 OFF, 단계적 활성화.

### 실행/자동화의 위상 — **현 invariant 유지 (C1=A, 6-AI 합의)**
2-티어로 구분(코드에 이미 존재):

- **현재 ON:** 진단 + 해결방법 제시(read-only).
- **외부 DATA write** (`integrations_write_enabled`; Slack/Jira/Notion 등 비-AWS 기록·메시지): 거버넌스(SSRF·Secrets·DLP·human-gate·flag) 하 **허용·OFF** = 점진 로드맵 항목. (ADR-040/041)
- **AWS 리소스 변경 + 자율 조치** (`remediation_enabled` 등): **FROZEN / do-not-enable.** 켜는 PR = regression. 재활성화는 *문서 정리가 아니라 제품 결정 변경* → **새 ADR로 2026-06-11 번복을 명시 번복 + 멀티-AI 패널 + 날짜박힌 owner-override** 필요. 2026-06-11 합의를 조용히 재해석 금지.
- **aspiration:** owner의 "안전한 실행/자동화로 나아간다"는 장기 *방향*으로 §0에 보존. frozen invariant와 양립(aspiration ≠ 오늘의 게이트 완화).

> 즉 BASELINE은 "frozen"을 "gated roadmap"으로 **softening 하지 않는다.** softening은 owner-override가 필요한 별도 제품 결정이며 이 리셋의 범위 밖.

## 3. 프로그램 (3 Phase)

### Phase 1 — 현실 감사 (토대, **리포트 먼저**, 코드 변경 없음)
3자 대조: **문서 ↔ 코드/terraform flag/state ↔ 배포 현실**.
- 근거 깊이 = **정적 대조 + 라이브 프로빙**(read-only 경로만; mutating/POST 호출 금지).
- **컴포넌트별 병렬 서브에이전트 fan-out**: 엣지·인증·데이터·web-BFF·agentcore·워커·eks + V1→V2 기능 패리티.
- **불일치 해소 프로토콜(C10):** 서브에이전트 간 상충(예: "X LIVE" ↔ "미배포")은 chair가 코드/state 재확인 후 판정, 미해결은 owner 게이트로. **Phase1.5 자동 대조:** terraform `*_enabled` default ↔ 문서 LIVE 주장 grep 대조.
- **ADR 3분류 + 병합 클러스터(옵션 Y 입력):** 46개를 `진짜결정 / 브레인스토밍-오분류 / 중복·승계·번복`로 분류하고, 진짜 결정들을 토픽 클러스터로 묶어 "새 ADR 후보 목록"(클러스터→통합 ADR 제목, 구성 LEGACY 번호)을 제안. Phase 2 consolidation이 이를 그대로 실행.
- 산출 = **단일 감사 리포트** `docs/reviews/2026-06-21-docs-reality-audit.md`: Drift 맵 + V1→V2 갭(미구현/오구현) + ADR 분류·클러스터 + 6기둥 태그 + 우선순위(P0~P3). **보안·제품 invariant > 배포 현실** — invariant 위반 배포는 P0 드리프트.
- **게이트:** owner 검토·승인(특히 병합 클러스터 구성) 후 Phase 2/3.

### Phase 2 — 통합·정리 (consolidate + docs IA 재정비, 코드 변경 없음)
Phase 1 확정 진실 + ADR 3분류/클러스터로 (**옵션 Y: 진짜 결정을 소수 새 ADR로 물리 병합**):
- **`docs/decisions/BASELINE.md`** 작성 (구조 §4).
- **진짜 결정 → 새 통합 ADR `001~N` 작성** (`docs/decisions/`): Phase 1이 식별한 클러스터(예: 029+031P4+032+035+036→"AWS변경·자율 FROZEN"; 002+025+038+044→"AI 라우팅")를 토픽별 1개 ADR로 병합. **번호 새로 001부터 재시작**, single Status, 판정가능 등급(C9). 각 ADR 하단에 `consolidates: LEGACY-0xx,...` 명시.
- **브레인스토밍-오분류 ADR → `docs/history/brainstorm/`** 로 재분류 이동(결정이 아니므로 archive 아님).
- **옛 46개 전부 → `docs/history/decisions-archive/`**(`git mv`), **`LEGACY-0xx-*.md`로 리네임**(새 001~N과 프로즈 참조 충돌 제거), **본문 불변** + 상단에 "Superseded — 현행: ADR-0xx / BASELINE §X" 배너(C3). `MAPPING.md`에 **old LEGACY → new ADR / brainstorm / dropped** 매핑.
- **코드 참조(`ADR-029` 등) 일괄 renumber 안 함** — LEGACY-archive에서 계속 resolve(역사 맥락 정확). 새 작업만 새 번호. (폴백: archive가 AI context에 계속 누수 시 working tree 제거 + git tag.)
- **docs/ IA 재정비** (§5).
- **에이전트 컨텍스트 전체 동기화(C6):** 루트 `CLAUDE.md` + `docs/CLAUDE.md` + `docs/decisions/CLAUDE.md` + **`AGENTS.md` + `GEMINI.md`** — 모두 "현행 진실=BASELINE+reference만 읽고, history/archive는 명시 요청 없이는 읽지 말라"로. 일부만 고치면 시스템프롬프트↔BASELINE 인지 부조화.
- **stale 설계문서 현행화/폐기:** architecture.md(v1) → reference/README.md(v2 개요) 재작성; reference/README.md:62 등 번복 잔재 제거.
- **BASELINE §1/§2 확정 전 멀티-AI 패널 교차검증**(누락·오분류).

### Phase 3 — 갭 백로그
Phase 1 미구현/오구현 → 6기둥 매핑 + 우선순위 백로그(`docs/plans/` active). 코드 수정은 별도 승인 후.

## 4. `BASELINE.md` 구조 + 새 ADR과의 관계

**역할 분리(중복 금지):** BASELINE = "읽기 시작점" = 북극성 + 불변식 + 동결/게이트 register + **결정 인덱스**. 새 통합 ADR 001~N = 각 결정의 *상세 + why*. BASELINE은 ADR 내용을 복붙하지 않고 한 줄+링크로 인덱스만. (두 출처 모순 방지는 §6 anti-drift로.)

AI와 모든 에이전트 컨텍스트가 **BASELINE을 먼저, 필요 시 링크된 ADR을** 읽는다. 한/영 병기. **범위 = v2 현행 진실; v1(CDK/EC2/Steampipe, 여전히 프로덕션)은 명시 제외(C8).**

| 섹션 | 내용 | 규칙 |
|---|---|---|
| **§0 북극성** | 위 2장 그대로 (aspiration 포함) | 고정. owner 승인 시만 변경. |
| **§1 불변식/용어** | read-only 정의, 6기둥 매핑, flag 규율, **크기 예산(C7)** | 결정론적 판정 기준. |
| **§2 게이트/동결 register** | OFF인 것. **2-티어 명시**(아래) | "동결"과 "거버넌스 게이트" 구분. terraform flag와 일치. |
| **§3 결정 인덱스** | 새 통합 ADR 001~N 목록 — 토픽·한 줄 요약·6기둥 태그·`→ ADR-0xx` 링크 | 인덱스만(상세는 ADR). 번복 체인 금지. |

§2 2-티어 예시:
- `[게이트] 외부 DATA write(Slack/Notion/Jira) — OFF (integrations_write_enabled). 독립 control plane·no-AWS-mutation IAM·거버넌스. (why: ADR-040/041)`
- `[동결] AWS 리소스 변경(SSM/Change Manager) — FROZEN / do-not-enable (remediation_enabled). 재활성화 = 새 ADR 명시 번복 + 패널 + owner-override. (why: ADR-029/036, 2026-06-11 reversal)`
- `[동결] 자율 mitigation/인시던트 자동조치 — FROZEN (incident_lifecycle_enabled=analysis-only). (why: ADR-032/035)`
- `[폐기] BYO-MCP(임의 외부 MCP) — 큐레이션 커넥터만. (why: ADR-031-P3/041)`

**§3 크기 예산(C7):** BASELINE은 *index*이지 소설이 아니다. 상세 설계는 reference/로, ADR rationale는 archive로 위임. §1 줄 수가 늘면 토픽 묶음/reference 추출.

## 5. docs/ 목표 IA

원칙: **현행 진실(항상 정확) 과 역사/과정(보존, 안 읽음)을 물리 분리.** 역사는 `decisions/` 바깥(C4).

```
docs/
├── README.md                  # docs 지도(사람용)
├── CLAUDE.md                  # AI 안내: 현행 진실 = decisions/BASELINE.md + reference/
├── AGENTS.md · GEMINI.md      # co-agent 컨텍스트 (BASELINE 가리키도록 동기화)
│
│   ── 현행 진실 ──
├── decisions/
│   ├── BASELINE.md            # 읽기 시작점(북극성+불변식+동결register+결정인덱스)
│   ├── 001..NNN-*.md          # 통합된 새 ADR(진짜 결정만, 토픽별 병합, single Status)
│   └── CLAUDE.md              # 짧은 포인터
├── reference/                 # 현행 설계, 컴포넌트당 1파일 (superpowers/reference 승격)
│   ├── README.md              # v2 시스템 개요 (낡은 architecture.md 대체)
│   └── 01..07-*.md
│
│   ── 운영 가이드 ──
├── guides/                    # install · onboarding · troubleshooting · ai-testing
├── runbooks/                  # (유지)
│
│   ── active 작업공간 ──
├── specs/                     # 진행 중 신규 설계. reference 증류 후 history로 sweep.
├── plans/                     # 진행 중 구현 계획. 완료 후 history로 sweep.
│
│   ── 역사/과정 (보존, 명시 요청 없인 안 읽음) ──
├── history/
│   ├── decisions-archive/    # 옛 46개 → LEGACY-0xx-*.md (동결, forward 배너) + MAPPING.md
│   └── specs/  plans/  reviews/  brainstorm/  archive/   # brainstorm/ = 오분류 ADR 재분류 포함
│
│   ── 기타 ──
└── brochure/                  # (유지, 마케팅 소스)
```

이동 요지:
- **설계 단일화** — architecture.md(v1) 폐기 → reference/README.md(v2 개요); superpowers/reference 7개 → docs/reference 승격.
- **ADR archive는 `history/decisions-archive/`** (decisions/ 바깥, C4).
- **active vs history 이분법 + sweep 결정론화(C5)** — 신규 spec/plan은 docs/specs·docs/plans(active). **sweep 트리거 = 결정론적 기준**(기능이 main 병합 + LIVE 배포 확인) **AND 해당 내용이 reference/에 증류 완료**된 뒤에만 history로 이동(as-built 컨텍스트 손실 방지). superpowers/ 경로 은퇴(스킬 기본값은 설정으로 docs/specs·docs/plans 재지정).
- **역사 격리** — superpowers/{specs,plans,archive} + 옛 plans/ + reviews/ + brainstorm/ → docs/history/. "완료" 판정은 Phase 1 감사.
- **가이드 묶음** — 흩어진 운영문서 → guides/.

## 6. anti-drift 메커니즘 (C2) — 규율 아닌 강제
- **새 ADR/flag 변경 = 같은 PR에서 BASELINE §1/§2 갱신 필수.** 갱신 없으면 "not live".
- (가능 시) **CI/PR 체크:** BASELINE §2의 `*_enabled` 항목 ↔ terraform variable default 대조, 불일치 시 실패.
- **앞으로의 ADR 품질 기준(C9):** Status 하나만, addendum 짧게, 같은 주제 2번째 반전이면 덧붙이지 말고 새 항목으로 대체, 기준 = "AI가 이 문서만 보고 PR을 막/통과시킬 수 있는가".

## 7. §1·§2 추출/정확성 방법
- 1차: 인덱스 + 각 ADR Status + terraform `*_enabled` description → `LIVE / GATED-OFF / FROZEN / SUPERSEDED / v1-only` 라벨링.
- 2차: Phase 1 감사(코드/배포)와 대조 — 문서 LIVE ↔ 코드 flag 불일치 시 **현실 우선**(단 invariant 위반 현실은 P0 드리프트), 불일치는 감사 리포트 기록.
- SUPERSEDED·v1-only → §1/§2 제외(archive에만). LIVE→§1, GATED/FROZEN→§2.
- 멀티-AI 패널 교차검증(BASELINE 확정 전).

## 8. 비목표 (YAGNI)
- **옛 ADR(LEGACY) 본문 재작성·삭제 안 함** — 새 통합 ADR은 *별도 작성*, 옛 원본은 forward 배너 1줄만 추가 후 그대로 동결(provenance 보존). 병합은 새 파일에서.
- **코드의 `ADR-0xx` 참조 일괄 renumber 안 함** — LEGACY-archive resolve. (옵션 Y는 *새* 결정 레지스터만 새 번호.)
- freeze→roadmap softening **안 함**(별도 owner-override 제품 결정, 범위 밖).
- 새 거버넌스 메커니즘 **안 함** — 기존 결정의 표현/구조/위치/병합만 정리.
- Phase 1/2 코드 변경 **없음**(문서만). 코드 수정은 Phase 3 별도 승인.

## 9. 검증
- BASELINE 자체 무모순: §1 어느 줄도 §2와 충돌 없음; §2가 인용 출처(terraform·ADR)와 모순 없음(특히 frozen 항목이 `variables.tf` "permanently"와 일치).
- 루트/AGENTS/GEMINI/CLAUDE 어디에도 "ADR-0xx…REVERSED…carve-out…" 모순 문단 잔존 없음, 전부 BASELINE 가리킴.
- `git mv` 후 `ADR-0`·`docs/decisions/0xx` 참조 미파손(grep, 필요 시 history 경로로 치환).
- 새 세션 시뮬: BASELINE만 읽고 "AWS 변경 자동화 해도 되나?" → 결정론적 "FROZEN, 재활성화는 새 ADR 필요".
- docs/ IA: 루트에서 "현행 vs 역사" 즉시 구분; `decisions/`엔 BASELINE+CLAUDE만.

## 10. 리스크
- **추출 누락** — §7 2차(현실 대조) + 멀티-AI로 완화.
- **동시 세션 충돌** — 다른 세션이 docs/ADR 건드리는 중(이미 046으로 증가) git mv 충돌 → 작업 직전 `git status`, 작은 단위 즉시 커밋, HEAD 동기화. **Phase 2 중 docs/ 동결 권장.**
- **교차참조 혼선** — 절대경로 참조 파손 → grep 색출 후 history 경로 치환.
- **archive context 누수** — C4 폴백(working tree 제거 + git tag).
- **라이브 프로빙 부작용** — read-only 경로만, mutating 호출 금지, 비용 유발 호출 최소.
