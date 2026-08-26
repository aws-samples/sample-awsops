# Plugin Platform — Phase 1: 내부 capability 척추 (설계)

> ⚠️ **SUPERSEDED (2026-06-20)** by `2026-06-20-devops-rca-incident-orchestrator-stage3-design.md`.
> 멀티-AI 패널 만장일치 PIVOT-TO-RCA-AGENT: 이 레지스트리의 주 소비자(현 enumerate형 진단)가 RCA 에이전트의 EoG 컨트롤러로 아키텍처적으로 대체됨 → 지금 짓는 건 throwaway 위험. 플러그인/manifest 추상화는 **두 실제 소비자(RCA 에이전트 + 8게이트웨이)에서 나중에 추출**. 이 문서는 그 추출 시점의 참고로 보존. 근거: `docs/brainstorm/devops-rca-vs-plugin-registry-brief.md`.

> Status: Draft (brainstorm → spec) — **SUPERSEDED**. Branch `feat/v2-architecture-design`.
> 멀티-AI 패널(kimi·glm·agy, 2026-06-20) PROCEED-WITH-AMENDMENTS 반영. 결정 브리프: `docs/brainstorm/plugin-platform-decision-brief.md`.

## 1. 목적과 1차 가치 (왜)

AWSops의 capability(에이전트가 무엇을 조회할 수 있나)는 현재 **세 곳에 흩어져 하드코딩**돼 있다:

| 소스 | 위치 | 형태 | 역할 |
|---|---|---|---|
| 게이트웨이/툴 타입 | `scripts/v2/agentcore/catalog.py` | Python (`GATEWAYS`, `TARGETS{tools[]}`) | 프로비저너+런타임이 소비 |
| UI/라우팅 뷰 | `web/lib/sections.ts` | TS (`SECTIONS[]`, `active` 플래그) | chat 섹션·프리셋 |
| 외부 커넥터 | `integrations` 테이블 / `web/lib/integrations.ts` | DB (`IntegrationRow`, 거버넌스 필드 보유) | 거버넌스된 외부 통합 |

결과: **AI 진단이 "지금 어떤 capability를 쓸 수 있는지"를 열거하지 못한다.** 진단은 자기 컨텍스트만 모으고, 가용 도구/도메인의 통합된 그림이 없다.

**1차 사업가치 = 내부 capability 통합 + AI 가시성** (패널 교정, glm). 외부 에이전트 상호운용(MCP/A2A)은 **deferred upside**이며 Phase 1의 명분이 아니다. 따라서 Phase 1 성공지표는 규제 완화와 무관하게 *지금* 측정 가능하다:

- **S1**: AI 진단이 단일 레지스트리에서 capability를 (계층적으로) 열거할 수 있다.
- **S2**: 게이트웨이/커넥터 1개를 추가/설명하는 것이 산발적 3곳 수정이 아니라 **레지스트리 1엔트리**로 표현된다.

## 2. 범위 / 비범위

**In scope (Phase 1):**
- 통합 capability 레지스트리를 **읽기-모델(read-model) 오버레이**로 구축 (Approach A — 책을 옮기지 않고 카드 목록을 만든다).
- `catalog.py`에서 builtin manifest를 **생성**(generator) + drift CI 체크.
- `sections.ts`·`integrations` 테이블을 같은 레지스트리에 병합.
- AI 진단을 레지스트리 **계층적 열거**에 배선 (flat 125-tool dump 금지 — agy 교정).

**Out of scope (명시적으로 Phase 1 아님):**
- ❌ DB 권위화 / 런타임 토글 (Approach B) → Phase 1.5+ 승격 경로로 열어둠.
- ❌ 거버넌스 필드 *런타임 강제* (audit/residency/TPRM) → 스키마에 **예약만**, 강제는 Phase 1.5.
- ❌ 공개 plugin API 스펙 / 큐레이션 설치 → Phase 2.
- ❌ agent-plugin(A2A) / managed 호스팅 / 샌드박스 티어 → Phase 3 (비규제 실수요 전까지 동결).
- ❌ 실행 경로(chat/agent 125-tool 라우팅) 변경 → **라이브 회귀 위험 0이 핵심 제약**.
- ⚠️ 관련하지만 별건: 동결된 BYO-MCP dead code 구조적 제거(kimi) — 별도 청소 작업으로 분리.

## 3. 아키텍처 (Approach A — read-model overlay)

```
build time:
  scripts/v2/plugins/gen-manifests.mjs
     reads catalog.py (GATEWAYS, GATEWAY_DESCRIPTIONS, TARGETS)
     emits  web/lib/plugins/builtin-manifests.generated.json   (committed)
     CI/test: regenerate == committed  (drift guard)

runtime (web/BFF):
  web/lib/plugins/registry.ts
     merges:  builtin-manifests.generated.json   (gateways/tools, from catalog.py)
            + SECTIONS                           (web/lib/sections.ts — label/domain/active)
            + listIntegrations()                 (integrations table — governed connectors)
     exposes: listCapabilities() / byDomain() / getDomainSummary()
     (read-only; no execution-path change)

consumers (Phase 1: diagnosis only):
  scripts/v2/workers/diagnosis/ collector
     → getDomainSummary()  (top-level "what can I inspect")
     → byDomain(d)         (drill into relevant domains only)
```

Python(catalog.py)이 툴 타입의 **진실의 원천**으로 남는다. 생성기는 그걸 TS가 읽을 JSON으로 떨구고, CI가 drift를 막는다 — Python을 TS로 재작성하지 않는다.

## 4. 컴포넌트

### 4.1 PluginManifest 스키마 (`IntegrationRow` 일반화)

경량 manifest — **툴 *이름+한줄설명*만**, 전체 inputSchema는 포함하지 않는다(계층적 discovery의 context 비대화 방지, agy 교정). 전체 스키마는 catalog.py/게이트웨이에 그대로 둔다.

```ts
// web/lib/plugins/types.ts
export type PluginKind = 'agent' | 'source';          // 2-layer (owner 결정: agent ≠ source)
export type PluginCapability = 'read' | 'read_write';  // 선언된 read-only vs mutating (agy 교정)
export type PluginStatus = 'active' | 'inactive' | 'dark';
export type PluginOrigin = 'builtin' | 'integration';

export interface ToolRef { name: string; description: string } // 경량 — no inputSchema

export interface PluginManifest {
  id: string;                 // 안정 슬러그: "gateway:security", "source:datadog"
  kind: PluginKind;
  domain: string;             // sections.ts key: network|container|data|security|cost|monitoring|iac|ops|observability
  label: string;
  description: string;
  capability: PluginCapability;
  status: PluginStatus;       // sections.ts active + dark 폴백 반영
  origin: PluginOrigin;
  tools: ToolRef[];           // 경량 목록
  // 거버넌스 필드 — Phase 1은 RESERVED(채우되 강제 안 함). Phase 1.5에서 강제.
  governance?: {
    auditRelevant?: boolean;
    dataResidency?: string | null;
    authMode?: string | null;
    sourceAllowlist?: string[];
    tier?: string;
  };
}
```

`integrations` row → manifest 매핑은 거의 1:1 (`kind`/`capability`/`exposedTools`→`tools`/`tier`/`sourceAllowlist`가 이미 존재).

### 4.2 Registry (`web/lib/plugins/registry.ts`)

```ts
listCapabilities(opts?: { kind?; domain?; status? }): PluginManifest[];
byDomain(): Record<string, PluginManifest[]>;                 // 계층 1단계
getDomainSummary(): DomainSummary[];  // { domain, label, pluginCount, toolCount, capabilities: ('read'|'read_write')[] }
```

`getDomainSummary()`가 진단의 top-level 열거(저비용), `byDomain(d)`가 관련 도메인만 drill.

### 4.3 catalog.py 생성기 + drift 가드 (`scripts/v2/plugins/gen-manifests.mjs`)

- catalog.py의 `GATEWAYS`/`GATEWAY_DESCRIPTIONS`/`TARGETS`를 파싱(python -c JSON dump 경유)해 builtin manifest 배열 emit.
- 게이트웨이 → `kind:'agent'`(섹션 페르소나), 각 TARGET의 tools → 그 도메인 source 묶음. (정확한 agent/source 경계는 plan에서 확정 — 일단 게이트웨이=agent-plugin, 그 안의 MCP 타깃=source 후보로 표시.)
- 테스트: 생성기 재실행 결과 == 커밋된 `.generated.json` 아니면 실패.

### 4.4 진단 배선 (`scripts/v2/workers/diagnosis/`)

- 컬렉터가 capability 컨텍스트를 `getDomainSummary()`로 시작 → 진단 scope에 해당하는 도메인만 `byDomain(d)` tool 목록 주입. **flat 전체 dump 금지.**
- 정확한 함수/주입 지점은 plan 단계에서 확정(현 컬렉터 구조 확인 후).

## 5. 데이터 플로우 / 에러 처리

- integrations DB 읽기 실패 → 레지스트리는 builtins+sections로 **degrade**(진단 안 깨짐), 경고 로그.
- `.generated.json` 누락/stale → build/test 실패(drift 가드).
- 알 수 없는 domain → `'other'` 버킷 + 로그(조용히 누락 금지).
- 레지스트리는 read-only — 어떤 소비자도 capability를 *실행*하거나 변경하지 않는다(실행은 기존 경로 그대로).

## 6. 테스트 (TDD)

- registry 병합: builtins+sections+integrations 3소스 → 중복 id 규칙, status 반영.
- `byDomain` 버킷팅 + `getDomainSummary` 카운트.
- `capability` 선언 보존(read vs read_write).
- 생성기 drift 테스트(regenerate == committed).
- degrade 테스트(integrations DB down → builtins-only, 예외 없음).
- 진단 컬렉터가 summary-first(계층) 호출, flat dump 아님.

## 7. 승격 경로 (참고 — Phase 1 이후)

- **A→B**: 런타임 토글/배포별 거버넌스 config가 필요해지면, builtin manifest도 DB row로 승격(레지스트리 인터페이스는 불변 — 소비자 무영향).
- **Phase 1.5**: `governance` 필드 강제(audit-trace, data-residency, authMode) — 공개 스펙 전 필수(glm).
- **Phase 2**: source-plugin 공개 스펙(MCP conformance) + 큐레이션 설치 + 런타임 egress/DLP/data-flow 로깅.
- **Phase 3**: agent-plugin(A2A) + managed + 하드닝 샌드박스 티어 — 동결.
