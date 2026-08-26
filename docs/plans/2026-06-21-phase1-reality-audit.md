# Phase 1 — 현실 감사 (Reality Audit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 문서(ADR/reference/architecture) ↔ 코드/terraform/state ↔ 배포 현실의 3자 대조로 단일 **감사 리포트**를 만들어, BASELINE(Phase 2)을 먹일 검증된 진실 + V1→V2 미구현/오구현 목록 + **ADR 3분류·병합 클러스터(옵션 Y: 새 통합 ADR 001~N 후보)**를 확정한다.

**Architecture:** 컴포넌트별 병렬 서브에이전트(Explore/general)가 각 lane을 정적 대조 → 구조화 finding 반환 → chair(메인 세션)가 인용을 실제 코드로 교차검증 → 단일 리포트에 누적 커밋. 라이브 프로빙은 read-only 경로만(public + best-effort authed). 코드 변경 없음.

**Tech Stack:** Markdown 리포트 · git(path-scoped 커밋) · grep/read 검증 · 서브에이전트 fan-out · (옵션) playwright MCP / curl for 라이브 프로빙.

## Global Constraints

- **코드 변경 0.** Phase 1은 순수 감사(read-only). mutating/POST 호출 금지, 비용 유발 호출 최소.
- **출력 = 단일 파일** `docs/reviews/2026-06-21-docs-reality-audit.md`. 모든 finding은 §4 스키마 준수.
- **chair 검증 필수:** 서브에이전트의 모든 LIVE/GATED/FROZEN/미구현/오구현 주장은 메인 세션이 `file:line`로 재확인한 뒤에만 리포트에 채택(vote-count 아닌 evidence).
- **동시 세션 안전:** working tree에 타 세션 WIP 존재 → 항상 `git add <명시 경로>`만, 절대 `git add -A`/`.` 금지. 작업 직전 `git branch --show-current`=`feat/v2-architecture-design` 확인.
- **현실 우선, 단 invariant 위반은 P0:** 문서 LIVE ↔ 코드 불일치 시 코드(현실) 우선. 그러나 배포 현실이 보안/제품 invariant(특히 AWS-mutation FROZEN)를 위반하면 "현실이 맞다"가 아니라 **P0 드리프트**로 기록.
- **라벨 집합:** `LIVE` / `GATED-OFF` / `FROZEN` / `MISSING(미구현)` / `MIS-IMPL(오구현)` / `DRIFT(doc↔code)` / `SUPERSEDED` / `v1-only`.
- **6기둥 태그:** 운영우수성·보안·안정성·성능효율성·비용최적화·지속가능성 중 1+.

---

### Task 0: 감사 리포트 스캐폴드 + finding 스키마 고정

**Files:**
- Create: `docs/reviews/2026-06-21-docs-reality-audit.md`

**Interfaces:**
- Produces: 모든 후속 task가 append하는 리포트 골격 + finding 스키마(§4). 섹션 앵커: `## A. ADR 라벨 대조`, `## B. 컴포넌트 Drift`, `## C. V1→V2 갭`, `## D. terraform 교차검증`, `## E. 종합(우선순위·BASELINE 매핑)`.

- [ ] **Step 1: 리포트 골격 작성**

아래 내용으로 파일 생성:

```markdown
# Phase 1 현실 감사 리포트 (2026-06-21)

> 대상: docs(ADR/reference/architecture) ↔ code/terraform/state ↔ 배포 현실.
> 방법: 정적 대조 + 라이브 프로빙(read-only). 모든 주장은 file:line 교차검증됨.
> 산출 소비처: Phase 2 BASELINE §1/§2 + Phase 3 갭 백로그.

## finding 스키마
| 필드 | 값 |
|---|---|
| id | <lane>-NN |
| 라벨 | LIVE/GATED-OFF/FROZEN/MISSING/MIS-IMPL/DRIFT/SUPERSEDED/v1-only |
| 문서 says | <doc:line> |
| 실제 | <file:line 또는 probe 결과> |
| verdict | 일치 / drift(어느쪽 맞음) / 미구현 / 오구현 |
| pillar | <WA 기둥> |
| priority | P0/P1/P2/P3 |
| BASELINE | §1 / §2 / 제외(archive) |

## A. ADR 라벨 대조 (001~046)
_(Task 10)_

## B. 컴포넌트 Drift
### B1 엣지/네트워크 _(Task 1)_
### B2 인증 _(Task 2)_
### B3 데이터/Aurora _(Task 3)_
### B4 web/BFF _(Task 4)_
### B5 AgentCore _(Task 5)_
### B6 워커 _(Task 6)_
### B7 EKS _(Task 7)_
### B8 AI 진단/챗 (cross-cutting) _(Task 9)_

## C. V1→V2 기능 갭 (미구현/오구현) _(Task 8)_

## D. terraform *_enabled 교차검증 _(Task 11)_

## E. 종합 — 우선순위 · BASELINE 매핑 · self-contradiction 체크 _(Task 12)_
```

- [ ] **Step 2: 커밋**

```bash
git add docs/reviews/2026-06-21-docs-reality-audit.md
git commit -m "docs(audit): scaffold Phase 1 reality-audit report + finding schema"
```

---

### Task 1–7: 컴포넌트 정적 대조 (병렬 서브에이전트 7 lane)

> 7개 lane은 서로 독립 → **한 메시지에서 7개 Explore 서브에이전트를 동시 dispatch**. 각 lane은 동일 절차(아래)를 따르며 대상 doc/code만 다름. 반환받은 finding은 chair가 검증 후 해당 섹션(B1~B7)에 채택.

**lane별 대상:**
- **Task 1 엣지/네트워크** → doc `docs/superpowers/reference/01-edge-network.md`, `docs/architecture.md`(v1 비교) · code `terraform/foundation/{edge.tf,network.tf}` · 검증축: CloudFront VPC Origin·내부 ALB·SG(CloudFront managed SG 443)·ACM.
- **Task 2 인증** → doc `02-auth.md` · code `terraform/foundation/auth.tf`, `edge-lambda/cognito_edge.py.tftpl`, `web/app/api/auth/login/route.ts`, `web/app/login/` · 검증축: RS256 JWKS·PKCE·in-app login(ADR-042)·`/_callback` dark fallback.
- **Task 3 데이터/Aurora** → doc `03-data-aurora.md` · code `terraform/foundation/data.tf`, `data/schema.sql`, `web/lib/db.ts`, `migrations/` · 검증축: PG17.9·스키마 baseline v9·ULID 마이그레이션·node-pg.
- **Task 4 web/BFF** → doc `04-web-bff.md` · code `web/app/api/{health,stream,db,jobs}/`, `web/app/**/page.tsx` · 검증축: thin-BFF 라우트·root basePath 없음·standalone arm64·HOSTNAME=0.0.0.0.
- **Task 5 AgentCore** → doc `05-agentcore.md` · code `agent/agent.py`, `scripts/v2/agentcore/{catalog.py,provision.py}`, `terraform/foundation/ai.tf`, `agent/lambda/*.py` · 검증축: **게이트웨이 수 8↔9(agent.py "EXACTLY 8" vs catalog.py "9")**, MCP 도구 수, SSM source-of-truth, 배포된 슬라이스 vs 전체 함대.
- **Task 6 워커** → doc `06-workers.md` · code `terraform/foundation/workers.tf`, `scripts/v2/workers/*` · 검증축: SQS+ESM+dispatcher/worker/status_updater/reaper+SFN, `workers_enabled` 게이트, Fargate CMD.
- **Task 7 EKS** → doc `07-eks.md` · code `terraform/foundation/eks.tf`, `web/lib/eks-incluster.ts`, `web/app/eks/` · 검증축: Access Entry+View policy·in-cluster read·`eks_auto_register_enabled`.

**Interfaces (모든 lane 공통):**
- Produces: lane finding 목록(§4 스키마), 각 항목에 후보 `file:line` 인용 포함.

- [ ] **Step 1: 7개 서브에이전트 동시 dispatch (Explore)**

각 서브에이전트 brief 템플릿(lane별 대상 치환):

```
역할: AWSops v2 [LANE] 컴포넌트의 문서↔코드 정합 감사관. read-only.
대상 문서: [DOC paths]. 대상 코드: [CODE paths].
할 일:
1. 문서가 주장하는 현행 동작/설정을 항목화.
2. 각 항목을 실제 코드/terraform에서 확인하고 file:line 인용.
3. 라벨 판정: LIVE/GATED-OFF/FROZEN/MISSING(문서엔 있는데 코드 없음=미구현)/
   MIS-IMPL(코드가 문서와 다르게 동작=오구현)/DRIFT(doc↔code 불일치)/SUPERSEDED/v1-only.
4. terraform flag가 관련되면 default 값과 description의 'do-not-enable/permanent/frozen' 문구를 그대로 인용.
출력: finding 표(id=[lane]-NN, 라벨, 문서says[doc:line], 실제[file:line], verdict, pillar 추정).
추측 금지 — 확인 못 한 항목은 'UNVERIFIED'로 표시. 400단어 내 표 중심.
```

- [ ] **Step 2: 반환 finding을 chair가 교차검증**

각 채택 후보에 대해 인용 확인(예시):

Run: `grep -n "<주장 키워드>" <인용 파일>`
Expected: 서브에이전트가 댄 라벨과 실제 코드가 일치. 불일치/UNVERIFIED는 chair가 직접 read로 재판정.

- [ ] **Step 3: 검증된 finding을 리포트 B1~B7에 append + lane별 커밋**

```bash
git add docs/reviews/2026-06-21-docs-reality-audit.md
git commit -m "docs(audit): B[N] <lane> drift findings (verified)"
```

(7 lane 반복 — lane마다 별도 커밋으로 리뷰 단위 분리.)

---

### Task 8: V1→V2 기능 패리티 갭 (미구현/오구현)

**Files:**
- Modify: `docs/reviews/2026-06-21-docs-reality-audit.md` (§C)
- 참조(read): `docs/v1-v2-gap-audit-2026-06-10.md`(11일 전, 갱신 대상), `src/**`(v1 기능), `web/**`(v2 구현).

**Interfaces:**
- Consumes: Task 1–7의 컴포넌트 finding.
- Produces: V1 기능별 `구현됨/미구현/오구현/v2-의도적-제외` 표 + 우선순위.

- [ ] **Step 1: 서브에이전트 dispatch — v1 기능 인벤토리 vs v2**

```
역할: v1(src/, 43 페이지/20 API/26 쿼리)의 사용자대면 기능을 인벤토리하고
v2(web/)에서 각 기능의 상태를 판정. 기준 문서=docs/v1-v2-gap-audit-2026-06-10.md(갱신).
출력: 기능 | v1 위치 | v2 상태(구현/미구현/오구현/의도적제외) | 근거 file:line | pillar | priority.
'오구현'은 v2에 있으나 v1과 동작이 다르거나 깨진 것 — 구체 증상 명시.
```

- [ ] **Step 2: chair 검증 — 06-10 감사 대비 신규/해소 항목 확인**

Run: `sed -n '1,60p' docs/v1-v2-gap-audit-2026-06-10.md`
Expected: 11일 전 갭 중 해소된 것/잔존한 것/신규 발생한 것 구분.

- [ ] **Step 3: §C에 갭 표 append + 커밋**

```bash
git add docs/reviews/2026-06-21-docs-reality-audit.md
git commit -m "docs(audit): C V1->V2 functional gap (미구현/오구현) findings"
```

---

### Task 9: AI 진단/챗 cross-cutting 감사 (라이브 프로빙 포함)

> 사용자가 "테스트하면 버그가 계속 난다"고 한 영역 — 정적 + **라이브 read-only 프로빙** 집중.

**Files:**
- Modify: `docs/reviews/2026-06-21-docs-reality-audit.md` (§B8)
- 참조(read): `web/app/api/ai/**`, `web/components/chat/**`, `web/app/assistant/**`, `agent/agent.py`, 진단 워커 코드.

**Interfaces:**
- Produces: 진단/챗 경로의 drift·미구현·오구현 finding + 라이브 프로빙 결과(가능한 경우).

- [ ] **Step 1: 정적 — 진단/챗 라우팅·렌더·스트리밍 경로 점검 (서브에이전트)**

```
역할: AI 진단(15섹션/deep/스트리밍 ADR-045)·챗(하이브리드 라우팅 ADR-038/044) 경로의
문서↔코드 정합 + 알려진 버그 패턴(빈 응답/항상 같은 진단/punt/환각) 점검. file:line 인용.
```

- [ ] **Step 2: 라이브 프로빙 — public read-only 경로**

Run: `curl -fsS -o /dev/null -w "%{http_code}\n" https://awsops-v2.atomai.click/api/health`
Expected: `200`. (authed 경로는 토큰 필요 → 가능하면 playwright MCP 로그인 후 read-only 페이지 스냅샷, 불가 시 'NEEDS-MANUAL-PROBE'로 기록하고 정적 결과로 대체.)

- [ ] **Step 3: §B8 append + 커밋**

```bash
git add docs/reviews/2026-06-21-docs-reality-audit.md
git commit -m "docs(audit): B8 AI diagnosis/chat drift + live probe findings"
```

---

### Task 10: ADR 001~046 라벨 대조 + 3분류 + 병합 클러스터 (옵션 Y 입력)

**Files:**
- Modify: `docs/reviews/2026-06-21-docs-reality-audit.md` (§A)
- 참조(read): `docs/decisions/CLAUDE.md`(인덱스), `docs/decisions/0*.md`(Status+본문), `terraform/foundation/variables.tf`(flag).

**Interfaces:**
- Consumes: Task 1–9 컴포넌트 finding(라벨 근거).
- Produces: (1) 46개 ADR 단일 라벨(`LIVE/GATED-OFF/FROZEN/SUPERSEDED/v1-only`); (2) **분류** `진짜결정 / 브레인스토밍-오분류 / 중복·승계·번복`; (3) **병합 클러스터 = 새 ADR 001~N 후보 목록**(클러스터→통합ADR 제목 + 구성 LEGACY 번호) — Phase 2 consolidation이 그대로 실행.

- [ ] **Step 1: 서브에이전트 dispatch — 라벨 + 3분류 + 클러스터 제안**

```
역할: docs/decisions/ ADR 001~046 각각의 *현행* 상태를 단일 라벨로 환원하고, 결정 성격을 분류하고,
유사 결정을 병합 클러스터로 묶는다.
입력: 인덱스 CLAUDE.md + 각 ADR Status 헤더+본문 + (관련 시) terraform flag default/description.
출력 1 — 라벨표: ADR# | 제목 | 단일라벨 | 분류(진짜결정/브레인스토밍/중복) | 근거(file:line).
   · 브레인스토밍 판정 기준 = '결정(Decision)'이 모호/탐색적이거나, 본문이 옵션 나열·미결로 끝나거나,
     Status가 Proposed로 표류했거나, 실제 코드/flag로 구현 흔적이 없는 것.
출력 2 — 병합 클러스터: 클러스터명(통합 ADR 제목 후보) | 구성 LEGACY ADR 번호들 | 한 줄 net 결정.
   예: "AWS 변경·자율 FROZEN" ← 029,031P4,032,035,036 / "AI 라우팅" ← 002,025,038,044.
번복 체인은 *현재 net 상태*만 — 과정 서술 금지. 추측 금지(UNVERIFIED 표시).
```

- [ ] **Step 2: chair 검증 — frozen 항목이 terraform과 일치 + 클러스터 net 결정 타당성**

Run: `grep -n "do-not-enable\|permanently\|REVERSED\|DOWNGRADED" terraform/foundation/variables.tf`
Expected: 029/036(remediation)·032(incident_lifecycle)·035(k8sgpt) 등 FROZEN/analysis-only 라벨이 flag description과 정확히 일치. 각 클러스터의 net 결정이 §A~§D finding과 모순 없는지 chair가 확인.

- [ ] **Step 3: §A에 라벨표 + 3분류 + 클러스터(새 ADR 후보) append + 커밋**

```bash
git add docs/reviews/2026-06-21-docs-reality-audit.md
git commit -m "docs(audit): A ADR 001-046 labels + 3-way classification + merge clusters (Y input)"
```

---

### Task 11: terraform `*_enabled` ↔ 문서 교차검증 (Phase 1.5)

**Files:**
- Modify: `docs/reviews/2026-06-21-docs-reality-audit.md` (§D)
- 참조(read): `terraform/foundation/variables.tf`, `terraform.tfvars`(있으면, 실제 토글 상태).

**Interfaces:**
- Produces: 모든 `*_enabled` flag의 `default · 실제 tfvars · 문서 주장` 3열 대조 + 불일치 목록.

- [ ] **Step 1: 모든 flag와 default 추출**

Run: `grep -n 'variable "[a-z_]*_enabled"' terraform/foundation/variables.tf`
그리고 각 flag의 `default` 라인 확인:
Run: `grep -nA6 'variable "[a-z_]*_enabled"' terraform/foundation/variables.tf | grep -E "variable|default"`
Expected: flag 목록 + 각 default(대부분 false).

- [ ] **Step 2: 실제 토글 상태 확인 (tfvars)**

Run: `grep -nE "_enabled" terraform/foundation/terraform.tfvars 2>/dev/null || echo "tfvars not present in tree"`
Expected: 실제 true로 켜진 flag 목록(예: hybrid_routing, steampipe, workers, agentcore, ai_cost_tracking 등 메모리상 LIVE).

- [ ] **Step 3: 3열 대조표 append — 불일치(문서 LIVE인데 flag false 등) 플래그 + 커밋**

```bash
git add docs/reviews/2026-06-21-docs-reality-audit.md
git commit -m "docs(audit): D terraform *_enabled cross-check (default/tfvars/doc)"
```

---

### Task 12: 종합 — 우선순위 · BASELINE 매핑 · self-contradiction 체크

**Files:**
- Modify: `docs/reviews/2026-06-21-docs-reality-audit.md` (§E)

**Interfaces:**
- Consumes: §A~§D 전체.
- Produces: (1) Drift 우선순위 목록(P0~P3), (2) V1→V2 갭 백로그(Phase 3 입력), (3) BASELINE §1/§2 후보 라인(Phase 2 입력), (4) self-contradiction 체크 결과.

- [ ] **Step 1: P0 추출 — invariant 위반·보안·깨진 기능 먼저**

§A~§D를 훑어 `priority=P0` 항목(특히 FROZEN 위반, 보안 finding, 오구현으로 깨진 사용자대면 기능)을 §E 상단에 모은다. 각 항목에 6기둥 태그.

- [ ] **Step 2: self-contradiction 체크 (Phase 2 사전 검증)**

§A의 FROZEN 라벨이 §D의 flag 상태와 모순되지 않는지, §B의 LIVE 주장이 §D flag와 일치하는지 표로 교차 확인. 모순 0이어야 BASELINE이 무모순으로 생성 가능.

Run: `grep -c "DRIFT\|MIS-IMPL\|MISSING" docs/reviews/2026-06-21-docs-reality-audit.md`
Expected: drift/갭 총 건수(요약 수치) — §E에 기록.

- [ ] **Step 3: §E 작성 (우선순위·BASELINE매핑·갭백로그·모순체크) + 커밋**

```bash
git add docs/reviews/2026-06-21-docs-reality-audit.md
git commit -m "docs(audit): E synthesis — priorities, BASELINE mapping, gap backlog, contradiction check"
```

---

### Task 13: owner 게이트 (Phase 2/3 진입 승인)

**Files:** (없음 — 보고/승인 단계)

- [ ] **Step 1: 리포트 요약 제시**

§E의 P0/P1 + 총 drift·갭 수치 + "BASELINE 무모순 생성 가능 여부"를 owner에게 한 화면 요약으로 제시.

- [ ] **Step 2: owner 결정 수집**

- 감사 리포트 승인 → Phase 2(BASELINE+IA) 계획 작성 착수.
- 추가 조사 요청 항목 있으면 해당 lane 재dispatch.
- 멀티-AI 패널로 감사 결과 교차검증 원하면 BASELINE 확정 전 단계에서 수행(spec §3 Phase 2).

- [ ] **Step 3: 결정 기록**

승인 시 메모리/커밋 메시지에 "Phase 1 GREEN, Phase 2 착수" 기록.

---

## Self-Review (작성자 체크)

- **spec 커버리지:** spec §3 Phase 1 요건(정적+라이브 프로빙·컴포넌트 fan-out·불일치 해소·Phase1.5 terraform 대조·단일 리포트·owner 게이트·invariant>현실) → Task 0~13에 모두 매핑됨. ✅
- **placeholder 스캔:** "적절히 처리" 류 없음; 각 task에 대상 file·검증 명령·커밋 메시지 명시. 서브에이전트 brief는 실제 템플릿 제공. ✅
- **라벨/스키마 일관성:** finding 스키마(Task 0)와 라벨 집합(Global Constraints)이 Task 1~12에서 동일하게 사용됨. ✅
- **알려진 실측 앵커 포함:** 8↔9 게이트웨이(Task 5), reference README:62 stale(Task 1/5), variables.tf:142 frozen(Task 10/11) — 패널이 검증한 실제 drift를 명시 타깃화. ✅

## Execution Handoff
Phase 1은 read-only 감사이며 **메인 세션이 서브에이전트를 fan-out**하는 형태가 자연스럽다(코드 변경 없음 → 격리 worktree 불필요). Task 1–7은 한 번에 병렬 dispatch 가능.
