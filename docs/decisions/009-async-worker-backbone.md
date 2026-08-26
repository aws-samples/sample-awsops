# ADR-009: 비동기 워커 백본 (SQS + Step Functions + Lambda/Fargate) / Async Worker Backbone

## Status / 상태

**Accepted (2026-06-22) — consolidated.**

> **Consolidates:** ADR-037 (worker tier 부분 — 비동기 워커 티어 결정). 본 ADR은 문서 리셋의 통합 ADR로, 037의 워커 백본 결정만 승계한다(037의 thin-BFF/엣지/Terraform 파운데이션 결정은 별개 통합 ADR 소관). v1 ADR-010(이벤트 사전 스케일링)은 v2에 **미구현**(2026-06-21 현실 감사 parity-18)이므로 본 ADR에 포함하지 않는다 — v1-only로 남긴다.
>
> **Consolidates:** the worker-tier decision of ADR-037 only. The v1 ADR-010 event pre-scaling backbone is **not built in v2** (audit parity-18) and is excluded here (kept v1-only).

## Context / 컨텍스트

v2 웹은 **thin-BFF**다 — 무겁고/길고/OOM 위험이 있는 작업을 요청 경로에서 인라인 실행하면 Fargate web 태스크가 OOM·타임아웃으로 죽고 요청 지연이 커진다. 진단 리포트 렌더, CIS 컴플라이언스 스캔(Powerpipe) 같은 장기 read-only 작업에는 **내구성 있는 비동기 실행 spine**이 필요하다. 동시에 v2는 read-only 운영 대시보드이므로 이 spine은 AWS-리소스를 변경하지 않는 작업만 실행해야 한다.

The v2 web service is a **thin-BFF**: heavy / long / OOM-risk work cannot run inline on the request path without killing the Fargate web task (OOM, timeout) and inflating latency. Long-running read-only jobs — diagnosis report rendering, CIS compliance scans (Powerpipe) — need a **durable async execution spine**. Because v2 is a read-only ops dashboard, that spine must run only non-mutating jobs.

## Decision / 결정

`workers_enabled`-게이트(기본 false → `plan` = No changes, $0)의 단일 내구 오케스트레이션 spine을 채택한다. 현행 net 플로우:

A single `workers_enabled`-gated durable orchestration spine (default false → idle cost $0). Current net flow:

```
POST /api/jobs
  → worker_jobs (Aurora, status=queued; ledger-first)
  → SQS
  → ESM (Event Source Mapping, kill-switch)
  → dispatcher Lambda (idempotent on job_id)
  → Step Functions Standard
       └─ Choice on $.runtime
            ├─ RunLambda            (short jobs)
            └─ ecs:runTask.sync     (long / OOM-risk → Fargate worker)
  → worker writes running / succeeded directly to Aurora
  → on Catch: status_updater Lambda sets failed
       (SFN itself can't write the VPC-private Aurora)
  → reaper (EventBridge, 5 min) reconciles stale rows
```

핵심 규약 / Invariants:

- **Ledger-first**: web가 먼저 `worker_jobs`에 queued 행을 기록한 뒤 SQS로 enqueue → 진실 원천은 Aurora.
- **dispatcher 멱등성**: `job_id` 기준으로 중복 메시지를 흡수(at-least-once SQS 대응).
- **`$.runtime` Choice**: 짧은 작업은 RunLambda, 길거나 OOM 위험이 있는 작업은 `ecs:runTask.sync` Fargate 워커로 분기.
- **상태 기록 분리**: 워커가 running/succeeded를 직접 Aurora에 기록. SFN은 VPC-private Aurora에 쓸 수 없으므로 실패 경로만 status_updater Lambda(Catch)가 failed로 표기.
- **reaper**: EventBridge 5분 주기로 stale 행을 정합화(워커가 죽어 상태를 못 남긴 경우 보정).
- **킬스위치**: ESM을 비활성화하면 전체 워커 파이프라인이 즉시 정지(롤백/사고 차단).
- **Fargate 워커 = `CMD`** (ENTRYPOINT 금지) — SFN `containerOverrides.command`는 CMD를 대체하지만 exec-form ENTRYPOINT엔 append되어 argv 중복 → argparse 실패.
- **Single Status**: 본 ADR은 단일 Status(Accepted)만 가진다.

**Job 타입 (전부 read-only):** `noop` · `report`(진단 리포트 렌더) · `compliance`(Powerpipe CIS 스캔). 모든 job은 AWS-리소스를 변경하지 않는다.

**Job types (all read-only):** `noop`, `report` (diagnosis report render), `compliance` (Powerpipe CIS scan). No job mutates AWS resources.

**실행 substrate의 *mutating* 분기는 ADR-005가 관할하며 영구 동결(FROZEN, do-not-enable)이다.** 동일 spine 위에 설계됐던 AWS-리소스 변경 경로는 flag-OFF로 동결되어 있고 본 ADR의 범위가 아니다.

The *mutating* branch of this execution substrate is owned by ADR-005 and stays **permanently FROZEN (do-not-enable)** — it is out of scope for this ADR.

## Consequences / 결과

### Positive / 긍정

- thin-BFF + 워커 분리로 요청 경로가 경량·OOM 안전. 단일 내구 spine이 모든 비동기 read-only 작업을 처리.
- ledger-first + 멱등 dispatcher + reaper로 at-least-once 전달과 워커 크래시에도 상태가 결국 정합.
- `$.runtime` Choice로 짧은 작업(Lambda)과 긴/OOM 작업(Fargate)을 비용·안정성 최적으로 분리.
- `workers_enabled` 게이트로 유휴 비용 $0·기능 롤아웃 가역. ESM 킬스위치로 즉시 정지 가능.

### Negative / 부정

- 단일 spine을 여러 job 타입이 공유 → job 타입 추가 시 dispatcher 라우팅/Fargate 이미지 회귀 위험.
- SFN이 Aurora에 직접 쓸 수 없어 실패 경로가 status_updater Lambda + reaper의 2단 보정에 의존(직접 단순 경로 대비 복잡).
- at-least-once 전달이므로 모든 신규 job 핸들러는 멱등이어야 함(설계 제약).

### 6 Pillars — 안정성 · 운영 우수성 / Reliability · Operational Excellence

- **Reliability**: ledger-first 진실 원천(Aurora), 멱등 dispatcher(중복 흡수), Catch→status_updater(실패 표기), reaper 5분 정합(stale 보정) — 4중 안전망으로 작업이 유실되거나 영구 unknown 상태에 빠지지 않는다. `ecs:runTask.sync`로 OOM 위험 작업을 web 태스크에서 격리.
- **Operational Excellence**: `workers_enabled` 게이트(유휴 $0·가역 롤아웃) + ESM 킬스위치(즉시 정지) + EventBridge reaper(자동 정합) + Fargate `CMD` 규약(argv 회귀 방지)로 운영 가시성·통제·안전한 배포를 확보.

## References / 참조

- 컴포넌트 현행 출처: `docs/reference/06-workers.md`
- 코드: `scripts/v2/workers/{db,dispatcher,handlers,reaper,status_updater,worker_lambda,fargate_worker}.py` + `sfn.asl.json`, `terraform/foundation/workers.tf`
- 현실 감사: `docs/reviews/2026-06-21-docs-reality-audit.md` §B6 (worker-01~19)
- 동결 substrate: ADR-005 (mutating 분기, FROZEN)
