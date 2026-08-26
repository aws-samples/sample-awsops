# ADR-010: 인벤토리 · 리소스 모델 / Inventory · Resource Model

## 상태 / Status
**Accepted (2026-06-22) — consolidated.** consolidates: 003 (SCP 차단 컬럼 처리), 007 (리소스 인벤토리 베이스라인)

## 컨텍스트 / Context

AWSops는 운영 대시보드로서 AWS 리소스 인벤토리를 수집·표시한다. 인벤토리 수집과 표시에는 두 가지 교차하는 관심사가 있다.
(AWSops, as an operations dashboard, collects and displays the AWS resource inventory. Inventory collection and display involve two intersecting concerns.)

1. **리소스 인벤토리 베이스라인** — 어떤 리소스 타입을 어떻게 수집·영속·표시하는가. v2에서는 flag-gated Steampipe Fargate sync가 결과를 Aurora `inventory_resources` 테이블로 적재하고, 타입 레지스트리가 표시 대상 리소스 타입을 정의한다. (구 ADR-007 v1 메커니즘 — `data/inventory/` JSON 스냅샷 + 대시보드 쿼리 재활용 — 은 ADR-037 v2가 Steampipe/`data/*.json`을 쓰지 않으므로 **v1 전용**이다.)
   (Resource inventory baseline — which resource types are collected, how they are persisted, and how they are displayed. In v2 a flag-gated Steampipe Fargate sync loads results into the Aurora `inventory_resources` table, and a type registry defines which resource types are surfaced. The legacy ADR-007 v1 mechanism — `data/inventory/` JSON snapshots + reusing dashboard query results — is **v1-only**, since the realized v2 (ADR-037) uses neither Steampipe `data/*.json` nor inventory JSON snapshots.)

2. **SCP 차단 컬럼 처리** — AWS Organizations의 서비스 제어 정책(SCP)이 특정 API 호출(예: `iam:ListMFADevices`, `lambda:GetFunction`)을 차단할 수 있다. 인벤토리 sync가 이런 컬럼을 하이드레이트하려다 실패하면 쿼리 전체가 실패하므로, 쿼리 견고성(query robustness)을 확보해야 한다.
   (SCP-blocked column handling — AWS Organizations Service Control Policies can block certain API calls (e.g. `iam:ListMFADevices`, `lambda:GetFunction`). If the inventory sync tries to hydrate such columns and fails, the entire query fails — so query robustness is required.)

## 결정 / Decision

### 1. 리소스 인벤토리 (현행 v2 메커니즘) / Resource inventory (current v2 mechanism)
- **타입 레지스트리** — 표시 대상 리소스 타입을 레지스트리로 정의하고, 이 레지스트리가 인벤토리 sync 대상과 네비게이션을 구동한다.
  (A **type registry** defines which resource types are surfaced; this registry drives both what the inventory sync collects and the navigation.)
- **flag-gated Steampipe Fargate sync → Aurora** — `steampipe_enabled` 플래그로 게이트된 Steampipe Fargate 워커가 인벤토리를 수집하여 Aurora `inventory_resources` 테이블로 적재한다(기본 false → $0). 라이브 쿼리는 별도로 AgentCore MCP Lambda 도구가 담당한다.
  (A `steampipe_enabled`-gated Steampipe Fargate worker collects inventory and loads it into the Aurora `inventory_resources` table (default false → $0). Live queries remain the responsibility of AgentCore MCP Lambda tools.)

### 2. SCP 차단 컬럼 처리 (쿼리 견고성) / SCP-blocked column handling (query robustness)
- `aws.spc`(Steampipe 커넥션 설정)에서 테이블 수준 오류를 위한 `ignore_error_codes`를 설정한다.
  (Set `ignore_error_codes` in `aws.spc` (the Steampipe connection config) for table-level errors.)
- **리스트 쿼리에서 SCP 차단 컬럼을 제거**한다 — `mfa_enabled`, `attached_policy_arns`, 리스트에서의 `tags` 등. 리스트는 다수 리소스를 하이드레이트하므로 단일 차단 컬럼이 전체 쿼리를 실패시킨다.
  (**Remove SCP-blocked columns from list queries** — `mfa_enabled`, `attached_policy_arns`, `tags` in lists, etc. Lists hydrate many resources, so one blocked column fails the whole query.)
- **상세 쿼리에서는 차단 컬럼을 유지**한다 — 단일 리소스 조회라 실패 가능성이 낮다.
  (**Keep blocked columns in detail queries** — single-resource lookups, lower failure probability.)

차단된 API 목록 / Blocked APIs found:

| 컬럼 (Column) | API | 테이블 (Table) |
|---|---|---|
| `mfa_enabled` | `iam:ListMFADevices` | `aws_iam_user` |
| `attached_policy_arns` | `iam:ListAttachedUserPolicies` | `aws_iam_user` |
| `tags` (리스트에서 / in list) | `lambda:GetFunction` | `aws_lambda_function` |

## 결과 / Consequences

### Positive
- 타입 레지스트리 기반 sync로 표시 리소스 타입을 한 곳에서 관리. SCP 차단 컬럼을 리스트에서 제거하여 sync가 부분 차단 환경에서도 견고하게 동작.
  (Registry-driven sync centralizes surfaced types; removing SCP-blocked columns from lists keeps the sync robust under partially-restricted environments.)
- `steampipe_enabled` 게이트로 기본 비활성($0), 활성화 시에만 Fargate sync 비용 발생.
  (`steampipe_enabled` gate keeps it off by default ($0); Fargate sync cost only accrues when enabled.)

### Negative
- SCP가 컬럼을 차단하는 환경에서는 일부 대시보드 카드(특히 IAM MFA 관련 지표)가 0 또는 결측으로 표시될 수 있다.
  (Under SCP-blocking environments, some dashboard cards — notably IAM MFA metrics — may show 0 or missing values.)
- 신규 컬럼 하이드레이트 오류 발생 시 해당 컬럼을 리스트 SQL에서 제거하는 후속 조치가 필요하다.
  (New column hydrate errors require follow-up to remove that column from list SQL.)

### 알려진 갭 (백로그) / Known gaps (backlog)
- **parity-12 (P0): ECS 서비스 차원 미구현.** 현행 인벤토리 sync(`sync_lambda.py`)는 `ecs_cluster`/`ecs_task` 차원만 수집하고 **ECS 서비스 목록(desired/running 카운트)은 수집하지 않는다.** v1 대비 핵심 운영 기능 결손으로, Phase 3 갭 백로그 P0로 명시한다. (출처: `docs/reviews/2026-06-21-docs-reality-audit.md` §C parity-12 — MISSING ✓V.)
  (**parity-12 (P0): ECS service dimension not implemented.** The current inventory sync (`sync_lambda.py`) collects only the `ecs_cluster`/`ecs_task` dimensions and **does not collect the ECS service list (desired/running counts).** This is a core operational feature gap versus v1, recorded as a Phase 3 gap-backlog P0 item. Source: `docs/reviews/2026-06-21-docs-reality-audit.md` §C parity-12 — MISSING ✓V.)

## 6 기둥 / Six Pillars (Well-Architected)
- **운영 우수성 (Operational Excellence)** — 타입 레지스트리로 인벤토리 수집·네비게이션을 단일 출처에서 구동. ECS 서비스 차원 결손(parity-12)은 운영 가시성 갭으로 백로그화.
  (Type registry drives collection/navigation from a single source. The missing ECS service dimension (parity-12) is a backlogged operational-visibility gap.)
- **보안 (Security)** — read-only 인벤토리 수집. SCP 차단은 권한 경계를 존중하며, 차단 컬럼 제거는 우회가 아니라 부분 데이터로의 graceful degradation.
  (Read-only collection. SCP blocking respects permission boundaries; dropping blocked columns is graceful degradation to partial data, not a bypass.)
- **신뢰성 (Reliability)** — `ignore_error_codes` + 리스트 컬럼 제거로 부분 차단 환경에서도 sync가 전체 실패 없이 완료.
  (`ignore_error_codes` plus list-column removal lets the sync complete without total failure under partial blocking.)
- **성능 효율성 (Performance Efficiency)** — Fargate sync는 비동기 워커 티어에서 수행되어 thin-BFF 부하와 분리.
  (Fargate sync runs in the async worker tier, decoupled from thin-BFF load.)
- **비용 최적화 (Cost Optimization)** — `steampipe_enabled` 기본 false → 비활성 시 $0. 인벤토리는 Aurora에 영속되어 반복 라이브 쿼리 회피.
  (`steampipe_enabled` default false → $0 when off. Inventory persisted in Aurora avoids repeated live queries.)
- **지속가능성 (Sustainability)** — flag-gated 수집으로 불필요한 상시 폴링 제거. 적재는 Aurora 단일 테이블로 통합.
  (Flag-gated collection eliminates needless constant polling; loading consolidates into a single Aurora table.)

---

> 정정 노트 / Correction note: 구 ADR-007의 "v2" 라벨(멀티라인 차트 + EBS 추적, `data/inventory/` JSON 스냅샷)은 pre-037 계획 기준으로 실현되지 않았으며 본 ADR의 현행 v2 메커니즘과 무관하다. 구 ADR-007 v1 메커니즘은 v1 전용으로 보존된다.
> (The legacy ADR-007 "v2" label (multi-line chart + EBS tracking, `data/inventory/` JSON snapshots) reflects the never-realized pre-037 plan and is unrelated to this ADR's current v2 mechanism. The legacy ADR-007 v1 mechanism is preserved as v1-only.)
