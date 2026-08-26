# ADR Consistency Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2026-06-11 ADR 전수 감사(6축 병렬 + 적대 검증)에서 교차 확인된 CRITICAL 1·MAJOR 10·MINOR 7을 해소 — ADR↔ADR 모순 제거, ADR↔구현 드리프트 정정, 1건의 TF fail-loud 가드 추가.

**Architecture:** 전부 docs 정정 + Terraform validation 1건. 코드 동작 변경 0 (read-only 자세 불변). 신규 기능 없음 — M7(v2 토큰 예산 부재)은 ADR 문구를 사실에 맞게 정정하고 v2 포팅은 명시적 후속 항목으로 격하.

**Tech Stack:** Markdown(ADR/CLAUDE.md), Terraform variable validation.

**감사 근거:** 워크플로 wf_1a0a411d (12 에이전트, 6축 감사 + CRITICAL/MAJOR 적대 검증 — 전 항목 file:line 인용 확인됨)

**파일 스코프 (scope guard):**
- Modify: `docs/decisions/001-steampipe-pg-pool.md`, `docs/decisions/002-ai-hybrid-routing.md`, `docs/decisions/005-vpc-lambda-steampipe.md`, `docs/decisions/006-cost-availability-probe.md`, `docs/decisions/007-resource-inventory-baseline.md`, `docs/decisions/024-cdk-three-stack-split.md`, `docs/decisions/030-ecs-fargate-aurora-split.md`, `docs/decisions/032-event-triggered-autonomous-incident-lifecycle.md`, `docs/decisions/033-aiops-llm-cost-optimization.md`, `docs/decisions/034-alert-auto-rca-write-back.md`, `docs/decisions/035-k8sgpt-hybrid-incluster-diagnosis.md`, `docs/decisions/037-v2-terraform-foundation.md`, `docs/decisions/CLAUDE.md`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `terraform/foundation/variables.tf`

---

### Task 1: Steampipe 모순 클러스터 (C-Steampipe: 001/005/030 + 인덱스)

**Files:**
- Modify: `docs/decisions/001-steampipe-pg-pool.md`, `docs/decisions/005-vpc-lambda-steampipe.md`, `docs/decisions/030-ecs-fargate-aurora-split.md`, `docs/decisions/CLAUDE.md`

- [ ] **Step 1**: `005-vpc-lambda-steampipe.md:5` v2 노트 교체 — "ADR-030이 승계, awsops-steampipe Fargate task + Service Connect(`awsops-steampipe.awsops.local:9193`)" 문구를 → "v2는 ADR-037이 확정: **라이브 Steampipe 없음** — flag-gated 인벤토리 sync 배치(`steampipe_enabled`, D1)만 존재하며 Service-Connect 데몬은 폐기된 030 초안 메커니즘. v2 라이브 조회는 AgentCore MCP 경유." (한/영 병기 유지)
- [ ] **Step 2**: `001-steampipe-pg-pool.md:5`의 동일한 Fargate/Service-Connect 문구도 같은 방식으로 정정.
- [ ] **Step 3**: `030-ecs-fargate-aurora-split.md` 본문 113/115행(영/한 Service Connect DNS 클레임)과 155행(Supersession note — **단, 155행은 024/006/007 승계 서술은 유효하므로 'awsops-steampipe Fargate task ... Service Connect DNS' 조각만 외과적으로** 정정)에 `~~취소선~~ + "(2026-06-10 ADR-037 정정: 라이브 Steampipe 없음 — 인벤토리 sync만)"` 인라인 정정 — 상단 8행의 자기-정정과 본문이 더 이상 모순되지 않게.
- [ ] **Step 4**: `docs/decisions/CLAUDE.md` 인덱스 — 001·005 행에 "(030 메커니즘은 037이 정정 — 라이브 Steampipe 없음)" 추가, 037 행에 "(029/036은 이 파운데이션 위에 설계됐으나 2026-06-11 REVERSED — 파운데이션 자체는 무관)" 추가.
- [ ] **Step 5**: 검증 + 커밋

```bash
grep -rn "awsops-steampipe.awsops.local" docs/decisions/ | grep -v "~~\|정정\|corrected"   # 미정정 잔존 0이어야 함
git add docs/decisions/001-steampipe-pg-pool.md docs/decisions/005-vpc-lambda-steampipe.md docs/decisions/030-ecs-fargate-aurora-split.md docs/decisions/CLAUDE.md
git commit -m "docs(adr): fix Steampipe contradiction cluster — 001/005/030 bodies now defer to 037 (no live Steampipe)"
```

---

### Task 2: 번복 잔재 정정 (035 헤더 · 032 stale 절 · 035 H3a dark-code 노트)

**Files:**
- Modify: `docs/decisions/035-k8sgpt-hybrid-incluster-diagnosis.md`, `docs/decisions/032-event-triggered-autonomous-incident-lifecycle.md`

- [ ] **Step 1**: `035:9` "Depends on ADR-029 (**Accepted 2026-06-09**) for the remediation tier" → "Depended on ADR-029 for the remediation tier — **029는 2026-06-11 REVERSED되어 해당 의존성은 무효**; read-only 진단 스코프만 유효."
- [ ] **Step 2**: `035` H3a 행(~68행)에 "(dark code retained, flag-OFF — `web/lib/k8sgpt.ts`의 `raiseIncidentFromFinding`은 이중 게이트로 보존되나 라우트에 미연결)" 추가 — 034의 보존 명시와 일관되게.
- [ ] **Step 3**: `032:98` "(Phases 2–3 additionally require ADR-029 and ADR-031 to advance from Proposed.)" → "(Phases 2–3 depended on ADR-029/031 — both 2026-06-11 REVERSED; mitigation 경로는 폐기, read-only Triage/RCA만 유지.)"
- [ ] **Step 4**: 검증 + 커밋

```bash
grep -n "Accepted 2026-06-09" docs/decisions/035-*.md   # 0이어야 함 (헤더 의존선 기준)
git add docs/decisions/035-k8sgpt-hybrid-incluster-diagnosis.md docs/decisions/032-event-triggered-autonomous-incident-lifecycle.md
git commit -m "docs(adr): purge stale pre-reversal references in 035 header + 032 phasing"
```

---

### Task 3: C1 — ADR-034 하드커플링 (배너 정정 + TF fail-loud validation)

**Files:**
- Modify: `docs/decisions/034-alert-auto-rca-write-back.md`, `terraform/foundation/variables.tf`

> 결정: 옵션 (b) — **정직한 문서화 + fail-loud 가드**. 신규 자족 IAM role(옵션 a)은 영구 flag-OFF인 dark 기능을 위한 신규 권한 표면이라 reversal 자세에 어긋남. 대신 ADR이 사실을 말하게 하고, TF가 침묵 대신 명시적 에러를 내게 한다.

- [ ] **Step 1**: `034:7` 배너 정정 — "NOT routed through the reversed ADR-029 framework or the ADR-036 executor / self-contained" → "실행 경로는 ADR-036 mutating executor를 경유하지 않으나(전용 Lambda 스테이지 + `ssm:CreateOpsItem` 단일 권한), **현재 구현은 frozen 029/036 substrate의 IAM role(`action_opscenter_write`, count=remediation_enabled)을 재사용**한다. 따라서 이 KEPT 기능을 켜려면 do-not-enable인 `remediation_enabled`까지 필요 — **활성화하려면 먼저 자족 role로 분리하는 선행 작업이 필요**(plan-time `[0]` 인덱스가 fail-loud 가드로 이를 강제)."
- [ ] **Step 2**: `variables.tf`의 `rca_writeback_enabled`(:136 부근)에 validation 추가:

```hcl
  validation {
    # ADR-034 vs 029/036 reversal: the write-back currently reuses the frozen substrate's
    # action_opscenter_write role (count = remediation_enabled). Enabling rwb alone would
    # hit an index-out-of-range deep in incidents.tf — fail here with the real story instead.
    condition     = !var.rca_writeback_enabled || var.remediation_enabled
    error_message = "rca_writeback_enabled currently requires remediation_enabled (frozen substrate role reuse — see ADR-034 banner). remediation_enabled is DO-NOT-ENABLE (2026-06-11 reversal): to activate write-back, first decouple it onto a self-contained role."
  }
```

- [ ] **Step 3**: `variables.tf:136` `rca_writeback_enabled` description도 새 가드와 일치하게 갱신 — "REQUIRES ... remediation_enabled=true" 서술에 "(frozen substrate 재사용 탓 — 활성화 전 자족 role 분리 선행 필요, validation이 fail-loud 강제)" 추가.
- [ ] **Step 4**: `terraform -chdir=terraform/foundation validate` Success 확인 (init -backend=false 후) + 커밋

```bash
git add docs/decisions/034-alert-auto-rca-write-back.md terraform/foundation/variables.tf
git commit -m "fix(adr-034): banner tells the truth about substrate-role coupling + fail-loud TF validation"
```

---

### Task 4: 스키마/마이그레이션 드리프트 (7-table ×8 + ULID 노트 + Steampipe 현황)

**Files:**
- Modify: `docs/decisions/030-ecs-fargate-aurora-split.md`, `docs/decisions/037-v2-terraform-foundation.md`, `CLAUDE.md`, `docs/decisions/CLAUDE.md`

- [ ] **Step 1**: `037:30` "(Inherits ADR-030's 7-table layout + P2 worker_jobs.)" → "(ADR-030의 초기 7-테이블에서 출발해 현재 **베이스라인 `data/schema.sql`(v9 동결, 29 앱 테이블)** + ULID 마이그레이션(`migrations/<ULID>_*.sql`, `make migrate`)으로 성장 — 테이블 수는 schema.sql이 source of truth.)"
- [ ] **Step 2**: `030:147` "finalize column types and indexes for the 7 tables" 부근에 "(이후 ULID 마이그레이션 체계로 대체 — 순차 정수는 동시 브랜치 충돌로 폐기, `migrations/README.md`)" 노트 추가.
- [ ] **Step 3**: 루트 `CLAUDE.md`의 "7-table/7-테이블" **6곳 전부**(14·24·66·136·146·188행) → "ADR-030 기반 스키마(베이스라인 v9 동결 — 테이블 수는 `data/schema.sql` 참조)" 형태로 교체. 동시에 "v2에는 Steampipe가 아직 없음(P3 검토)" 한/영 2곳 → "flag-gated Steampipe 인벤토리 sync(D1, `steampipe_enabled`) 존재 — 라이브 쿼리는 여전히 AgentCore MCP" 로 현행화.
- [ ] **Step 4**: `docs/decisions/CLAUDE.md` 정정 노트 섹션에 "스키마 카운트는 030 시점 스냅샷 — 현행은 schema.sql(v9)+ULID 마이그레이션" 한 줄 추가.
- [ ] **Step 4b (P2 게이트: kiro)**: CLAUDE.md 수정 후 **AGENTS.md + GEMINI.md 재증류**(sync-context 규칙 — 마커 보존, 32KiB 캡): "7-table" 잔존 제거 + **"KEEP/LIVE: ADR-034" 표기를 "KEPT(flag-OFF — 활성화엔 자족 role 분리 선행 필요)"로 정정**(이번 P2에서 gemini가 이 부정확한 표기를 근거로 034를 LIVE로 오판 — 증류본 자체가 오판 유발원). 최종 그렙에 AGENTS.md/GEMINI.md 포함.
- [ ] **Step 5**: 검증 + 커밋

```bash
grep -rn "7-table\|7-테이블" CLAUDE.md AGENTS.md GEMINI.md docs/decisions/037-*.md   # 0 (030 역사 서술 제외)
git add CLAUDE.md docs/decisions/030-ecs-fargate-aurora-split.md docs/decisions/037-v2-terraform-foundation.md docs/decisions/CLAUDE.md
git commit -m "docs: schema reality — 7-table claims (x8) -> baseline+ULID pointers; Steampipe D1 stance current"
```

---

### Task 5: 스코프 정정 (033 Phasing 사실화 + 002/006/007/024 v1-only 노트)

**Files:**
- Modify: `docs/decisions/033-aiops-llm-cost-optimization.md`, `docs/decisions/002-ai-hybrid-routing.md`, `docs/decisions/006-cost-availability-probe.md`, `docs/decisions/007-resource-inventory-baseline.md`, `docs/decisions/024-cdk-three-stack-split.md`

- [ ] **Step 1**: `033:78` Phasing 정정 — "Phase 2 implemented: ai_token_budget table + dual-write + cold-start hydrate" → "Phase 2 implemented **in v1 (`src/lib/ai-cost/token-budget.ts` + `src/lib/db/token-budget-writer.ts`, Aurora dual-write+hydrate)**. ⚠️ **v2 `web/` 챗 경로(`web/app/api/chat/route.ts`)에는 아직 예산 게이트가 없음** — v2 포팅은 미착수 후속 작업(open follow-up)." (감사 M7 — v2 거버넌스 공백을 ADR이 숨기지 않게)
- [ ] **Step 2**: `002:3` Status에 스코프 노트 — "Accepted **(v1 스코프** — Steampipe 기반 라우팅 서술은 v1 전용; v2 라우팅은 ADR-038이 대체**)**".
- [ ] **Step 3**: `006:3`/`007:3`의 "(v2 — ...)" Status 라벨 정정 — 해당 "v2"는 **pre-037 v2 계획(실현 안 됨)** 임을 명시: "(v2 표기는 구 계획 기준 — 실현된 v2(ADR-037)는 Steampipe/data-json 미사용; 본 ADR 메커니즘은 v1 전용)".
- [ ] **Step 4**: `024:9`의 구 노트("superseded for v2 by ADR-030")를 3행의 현행("Superseded by ADR-037")과 일치시키는 정정 — "(2026-06-03 노트는 030 기준 — 최종 승계는 037)".
- [ ] **Step 5**: 검증 + 커밋

```bash
grep -n "implemented" docs/decisions/033-*.md | head -3
git add docs/decisions/033-aiops-llm-cost-optimization.md docs/decisions/002-ai-hybrid-routing.md docs/decisions/006-cost-availability-probe.md docs/decisions/007-resource-inventory-baseline.md docs/decisions/024-cdk-three-stack-split.md
git commit -m "docs(adr): scope honesty — 033 Phase-2 is v1-only (v2 gap explicit); 002/006/007 v1-scope notes; 024 note reconciled"
```

---

### Task 6: 최종 검증 + PR

- [ ] **Step 1**: 전수 그렙 — 모순 시그니처 잔존 0 확인:

```bash
grep -rn "awsops-steampipe.awsops.local" docs/decisions/ | grep -vc "037\|정정\|~~"
grep -rn "Depends on ADR-029 (\*\*Accepted" docs/decisions/
grep -rn "7-table\|7-테이블" CLAUDE.md AGENTS.md GEMINI.md
terraform -chdir=terraform/foundation validate
cd web && npx vitest run 2>&1 | tail -2   # 무회귀
```

- [ ] **Step 2**: push + PR (base feat/v2-architecture-design) — 본문에 감사 방법론(6축+적대검증)과 C1 결정 근거 명기.
