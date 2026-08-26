# ADR-011: 멀티 어카운트 지원 (STS AssumeRole, read-only) / Multi-Account Support (STS AssumeRole, read-only)

## Status / 상태
**Accepted (2026-06-22) — consolidated.** consolidates: 008. **Amended 2026-06-26: ExternalId optional for 1st-party (host-ARN-pinned trust), required for 3rd-party.**

## Context / 컨텍스트

여러 AWS 계정을 운영하는 조직은 계정별 별도 인스턴스 배포 없이, 단일 AWSops에서 통합 대시보드와 계정별 뷰가 필요하다. v2는 단일 계정 호스트(`123456789012`)에서 ECS Fargate로 동작하며, 대상 계정의 리소스를 **read-only**로만 조회한다(AWS-리소스 변경·자율은 영구 동결 — 프로젝트 read-only 원칙). 계정 추가/제거는 코드 변경 없이 런타임 구성으로 처리되어야 하고, 단일 계정 동작은 그대로 호환되어야 한다.

Organizations running multiple AWS accounts need a unified dashboard and per-account views from a single AWSops, without per-account deployments. v2 runs on a single host account (`123456789012`) on ECS Fargate and only queries target-account resources **read-only** (AWS-resource mutation and autonomy stay permanently frozen — the project's read-only principle). Adding/removing accounts must be a runtime config operation with no code change, and single-account operation must remain backwards compatible.

## Decision / 결정

계정 레지스트리 + STS AssumeRole 기반 read-only 페더레이션을 채택한다. 현행 net(deployed) 구성:

- **accounts 레지스트리 (Aurora)**: 등록된 대상 계정을 Aurora 테이블에 보관. 호스트 계정은 lazy seed.
- **STS AssumeRole**: 대상 계정의 `AWSopsReadOnlyRole`을 host 실행 역할(task role)이 assume. **ExternalId**: 대상 trust 정책이 **AWSops task-role ARN을 정확히 핀**하는 **1st-party** 계정에선 선택(생략 가능); **3rd-party/공유/와일드카드 principal**엔 **필수**(confused-deputy 방어). 1st/3rd 구분은 **trust 정책으로 강제되는 운영적 구분**이며 코드가 강제하지 않는다.
- **/accounts admin UI**: 인증된 admin이 대상 계정을 등록/관리. CFN으로 대상 계정에 read-only role 배포.
- **글로벌 셀렉터 + per-account fan-out**: 전역 계정 선택기로 단일 계정 스코프; `__all__` 선택 시 전 계정 fan-out(bedrock/cost 등 per-account 집계).
- **호스트 계정 self-assume 함정 방어**: target == host인 경우 `cross_account.get_role_arn()`이 `None`을 반환해 host 실행 역할을 직접 사용(대상 계정 전용 role을 호스트에서 self-assume → AccessDenied 오진 방지). 진짜 다른 계정 assume 경로는 불변.

Account registry + STS-AssumeRole read-only federation. Current deployed net:

- **accounts registry (Aurora)** — registered target accounts in an Aurora table; host account seeds lazily.
- **STS AssumeRole** — the host task role assumes the target account's `AWSopsReadOnlyRole`. **ExternalId** is **optional** for **1st-party** accounts whose target trust policy **pins the exact AWSops task-role ARN** (never account-root/org/wildcard), and **required** for **3rd-party/shared/wildcard** principals (confused-deputy mitigation). The 1st/3rd-party distinction is **administrative — enforced by the target trust policy, not by code**. Trust-policy variants: 1st-party omits the `sts:ExternalId` condition and trusts only the task-role ARN; 3rd-party adds the `sts:ExternalId` `StringEquals` condition.
- **/accounts admin UI** — an authenticated admin registers/manages target accounts; a CFN template deploys the read-only role in each target account.
- **Global selector + per-account fan-out** — a global account selector scopes to one account; `__all__` fans out across all accounts (per-account aggregation for bedrock/cost, etc.).
- **Host self-assume guard** — when target == host, `cross_account.get_role_arn()` returns `None` so the host execution role is used directly (prevents self-assuming a target-only role on the host → AccessDenied misdiagnosis). The genuine other-account assume path is unchanged.

## Consequences / 결과

### Positive / 긍정
- 단일 배포로 다수 AWS 계정 모니터링; 계정 추가 = CFN 배포 + /accounts 등록(코드 변경 없음).
- UI는 계정별 / 전체 집계 뷰 제공; 단일 계정 배포는 호환 유지.
- 3rd-party는 ExternalId required로 confused-deputy 차단; 1st-party(task-role ARN 핀)는 ExternalId 생략 가능 — v1 온보딩 단순성 회복.

### Negative / Trade-offs
- `__all__` fan-out은 계정 수에 비례해 지연·집계 비용 증가(per-account 순차/병렬 호출).
- 대상 계정마다 CFN role 선행 배포 필요.
- read-only 한정 — 대상 계정 변경 작업은 범위 밖(영구 동결).

## 6 Pillars (보안 중심) / 6 Pillars (security-focused)

- **Security**: 대상 계정 role은 read-only(ReadOnlyAccess); trust condition = **3rd-party는 ExternalId required, 1st-party는 task-role ARN 핀(ExternalId 생략 가능)** — 두 경우 모두 confused-deputy 방어(ARN 핀 또는 ExternalId); 자격증명은 메모리에만(디스크 미기록); host self-assume 가드로 권한 오용·오진 차단; admin-gated /accounts 등록(인증 경유).
- **Reliability**: target == host 분기로 단일 계정에서도 fail-safe; registry는 Aurora 영속 + host lazy seed.
- **Performance Efficiency**: 단일 계정 스코프는 직접 assume 1회; `__all__`만 fan-out 비용 발생.
- **Cost Optimization**: per-account 집계는 선택 시에만 실행; 상시 폴링 없음.
- **Operational Excellence**: 계정 lifecycle = CFN + /accounts UI(코드 변경 없음); 멱등 등록.
- **Sustainability**: 단일 호스트가 다계정을 커버 — 계정별 인스턴스 중복 제거.
