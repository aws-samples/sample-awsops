# 03. Data / Aurora — v2 Reference

## Purpose / 목적

AWSops v2의 **애플리케이션 상태 저장 계층**. v1이 `data/*.json` 파일로 관리하던
상태(인벤토리/비용 스냅샷, AgentCore 메모리·통계, 알림 진단, 이벤트 스케일링 플랜,
리포트 스케줄)를 Aurora PostgreSQL로 이전한다. **Steampipe 대체가 아니라 v1 JSON
상태 계층의 대체**다 — v2에 **라이브 Steampipe는 없다**(라이브 AWS 조회는 AgentCore
MCP Lambda). 단, 인벤토리 적재용 **flag-gated warm Steampipe Fargate→Aurora 배치
sync**(`var.steampipe_enabled`, 기본 off, `steampipe.tf`)는 존재한다 — 상시
Service Connect 라이브 쿼리 데몬이 아닌 배치 로더다. (ADR-001 참조.)

The v2 **application-state store**. It replaces v1's `data/*.json` state layer
(inventory/cost snapshots, AgentCore memory + stats, alert diagnosis, event-scaling
plans, report schedules) with Aurora PostgreSQL. It replaces the **v1 JSON state
layer, NOT Steampipe**. v2 has **no *live* Steampipe** (live AWS queries go through
AgentCore MCP Lambda tools); the only Steampipe is a **flag-gated warm
inventory-sync batch** (`var.steampipe_enabled`, default off, `steampipe.tf`) that
loads inventory into Aurora — not a Service-Connect live-query daemon. (See ADR-001.)

## Current design / 현행 설계

- **Cluster**: Aurora Serverless v2 `awsops-v2-aurora`, **PostgreSQL 17.9**,
  `engine_mode = provisioned`, scaling **0.5–4 ACU**, single writer instance
  (`awsops-v2-aurora-1`, `db.serverless`).
- **Database**: `awsops`. **Endpoint**:
  `awsops-v2-aurora.cluster-ch0io48c0dqx.ap-northeast-2.rds.amazonaws.com:5432`.
- **Encryption**: KMS CMK (`alias/awsops-v2-aurora`) for both storage
  (`storage_encrypted`) and the master-user secret.
- **Credentials**: RDS-managed master secret (`manage_master_user_password = true`,
  master username `awsops_admin`) in Secrets Manager — exposed as output
  `aurora_secret_arn`. The app reads this in P1d.
- **Network**: lives in the reused `mgmt-vpc` private subnets (DB subnet group
  `awsops-v2-aurora`). SG `awsops-v2-aurora-sg` allows **:5432 from the app/Fargate
  service SG**, plus an optional VPC-CIDR ingress (gated by `var.allow_vpc_db_access`)
  for in-VPC schema migration from the deploy host.
- **Backups**: 7-day retention. `deletion_protection = false` + `skip_final_snapshot = true`
  (dev-only — flip both for prod).
- **Schema**: the **ADR-001 baseline schema** (Phase-1 7-table baseline, **frozen**; expanded since via ULID `migrations/*` — current table count per `schema.sql`, incl. incident/k8s/integrations/topology/ai_usage/accounts) + a P2 `worker_jobs` table, applied via
  `make migrate` from an approved in-VPC host or the private migration runtime. A new empty DB
  requires `INITIALIZE_EMPTY_DB=1` for its initial migration; the baseline plus ledger conversion/checksum commit
  atomically before ULIDs. Any user object without a ledger prevents initialization.
  Ordinary host commands set this once. The default-off manual development migration template
  retains the flag for deliberate dispatches; an existing ledger skips initialization and an
  occupied unversioned database still fails closed. See the [runtime guide](../../terraform/foundation/migrations/README.md).
  새 빈 DB는 최초 초기화가 필요하며 baseline·원장 변환·checksum은 원자적으로 적용한다.
  일반 호스트 명령은 플래그를 한 번만 설정한다. 기본 비활성 수동 개발 템플릿은 명시적 dispatch용으로
  플래그를 유지하지만 기존 원장이 있으면 초기화를 건너뛰며, 원장 없는 비어 있지 않은 DB는 거부한다.
  원장 없이 사용자 객체가 있으면 초기화를 거부한다.
- **App access**: **node-pg** (`web/lib/db.ts`). No *live* Steampipe in v2 — live AWS
  queries go through AgentCore MCP Lambda tools; the ops gateway already has a limited
  Aurora-backed `inventory-read-target`, while direct domain API targets remain registered.
  A flag-gated warm Steampipe→Aurora inventory-sync batch (default off) is the only Steampipe
  usage (ADR-001).
- **2026-08-31 rollout note (ADR-021)**: Phase 1's limiter, backpressure, structured
  terminal state, and freshness threshold are implemented in the repository. The agent making
  this change did not run apply; controller deployment status must be verified separately.
  `inventory_sync_runs.last_success_at`/`last_success_row_count` durably preserve full success,
  including genuine zero-row inventories; unreachable expected accounts record `partial` without
  deleting last-good rows or advancing those fields. The reader classifies the oldest current
  `captured_at` (or durable last success when no rows exist) as
  `healthy|degraded|stale|unavailable`. Current truth is coexistence: the limited ops
  `inventory-read-target` serves Aurora data and freshness while direct domain
  inventory/config targets remain live. Phase 2 expands
  domain-aware Aurora coverage and retires those direct targets after parity; Aurora-only is not live.
  (2026-08-31 롤아웃 노트(ADR-021): Phase 1 limiter, backpressure, structured terminal state,
  freshness threshold와 durable last-success/partial semantics는 저장소에 구현됐다.
  성공한 0-row도 보존되고 expected account가 도달 불가하면 last-good row를 유지한다.
  이 변경을 수행한 에이전트는 apply를 실행하지 않았고 controller 배포 상태는 별도
  확인한다. 현재 limited ops `inventory-read-target`이
  Aurora 데이터/freshness를 제공하면서 direct domain target과 공존한다. Phase 2가
  domain-aware coverage를 확장하고 parity 뒤 direct target을 retirement하므로
  Aurora-only는 아직 live가 아니다.)
- **ADR-021 deployment gate**: Terraform packages the `inv-sync` Lambda, whose running UPSERT
  requires the migration-owned `inventory_sync_runs.run_token` column. Existing enabled
  environments must push the image without rolling, run `make migrate` against current outputs,
  and only then create/apply the saved plan. First-time enablement must establish Aurora with
  `steampipe_enabled=false`, migrate, create/push the image, and enable the feature only in the
  final saved-plan apply. `make deploy` rolls the web service, not this Lambda; if this order cannot
  be met, do not deploy the new Lambda.

### ADR-001 schema tables / 스키마 테이블

| Table | Replaces (v1) | Notes |
|-------|---------------|-------|
| `schema_migrations` | — | applied-version tracker; seeded with version 1 |
| `inventory_snapshots` | `data/inventory/<account>/*.json` | `(account_id, captured_at)` indexes; JSONB `payload`. Since 2026-09-04 the sync writes one daily row per (trusted account, resource_type) — plus derived security series (`public_s3_buckets`/`open_security_groups`/`unencrypted_ebs`, lockstep with `web/lib/security-findings.ts`); host-only SDK types stay `self`-scoped. No prune — the trend route filters by resolved account scope + a snake_case type charset (legacy v1 backfill label rows excluded) |
| `cost_snapshots` | `data/cost/<account>/*.json` | UPSERT on `(account, period, granularity)` |
| `agentcore_memory` | `data/memory/<user>/*.json` | per-user, 365-day TTL via `expires_at` (ADR-004) |
| `agentcore_stats` | `data/agentcore-stats.json` | append-only event log; token columns |
| `alert_diagnosis` | `data/alert-diagnosis/*.json` | GIN indexes on `services`/`resources` arrays |
| `event_scaling_plans` | `data/event-scaling/*.json` | `status` CHECK mirrors `EventStatus` (ADR-010) |
| `report_schedules` | `data/report-schedule.json` | unique per `(user_sub, schedule_type)`, **and at most one ENABLED row per user** — `uq_schedule_one_active`, a partial unique index `(user_sub) WHERE enabled` (migration 01KZ3C7Q). The dispatcher fires every enabled row, so two would double the diagnosis; `upsertSchedule()` disables the other frequencies in the same transaction |
| `worker_jobs` (P2) | — | async worker job ledger; orthogonal to the 7 app-state tables |

`updated_at` auto-touch triggers cover `cost_snapshots`, `event_scaling_plans`,
`report_schedules`, and `worker_jobs`.

## Decisions (ADRs) / 결정

- **ADR-001** — Aurora replaces the v1 `data/*.json` state layer (NOT Steampipe).
  Defines the Phase 1 7-table schema and the ECS Fargate + Aurora split.
  See [`../decisions/001-v2-foundation.md`](../decisions/001-v2-foundation.md).
- **ADR-021** — quota-limited inventory collection and the staged Aurora-backed MCP target.
  See ADR-021 (private upstream decision).

## Key files / 핵심 파일

- `terraform/foundation/ci-migrations.tf`, `.github/workflows/deploy-migrations.yml`,
  `scripts/v2/ci/run-migration.mjs` — default-off manual development migration task,
  scoped secret-read IAM and verified private execution (ADR-005 operator boundary).
  기본 비활성 수동 개발 migration·시크릿 한정 IAM·검증된 사설 실행을 담당한다.
- `terraform/foundation/data.tf` — KMS key + alias, DB subnet group, SG,
  Aurora cluster + writer instance, RDS-managed master secret.
- `terraform/foundation/data/schema.sql` — ADR-001 7-table schema + `schema_migrations`
  + P2 `worker_jobs` (idempotent).
- `scripts/v2/migrate.mjs`, `initialize-db.mjs` — atomic empty-DB baseline and checksum-verified
  ULIDs; `scripts/v2/eks/rds-ca-bundle.pem` is the shared migration TLS trust bundle despite
  the historical `eks/` path. See [migration operations](../../terraform/foundation/migrations/README.md)
  for build/run/env/IAM/network requirements.
  초기화·ULID 적용·TLS는 migration runtime이 담당하며 `eks/`의 CA bundle을 공용 사용한다.
- `terraform/foundation/migrations/01M1B3NB288P56BDR1GMEN9GH9_inventory_sync_freshness.sql`
  — additive durable inventory success fields, `partial` status, and the safe explicit-column
  `sql_reader.inventory_sync_runs` view.
- The root `.gitignore` `data/` rule has a `!terraform/foundation/data/` carve-out,
  so `schema.sql` is source-controlled (same pattern as `infra-cdk/data/`).
- `web/lib/db.ts` — node-pg connection (consumed in P1d, not P1c).

## Status / 상태

- **P1c** ✅ — cluster provisioned + 7-table schema applied.
- **PostgreSQL 15 → 17.9 major in-place upgrade** ✅ — Serverless v2 retained,
  endpoint and master secret unchanged.

## Learnings & gotchas / 학습·함정

**Major-upgrade procedure (reuse-critical) / 메이저 업그레이드 절차 (재사용 핵심):**

1. Set the **EXACT minor** (`engine_version = "17.9"`, not `"17"`) +
   `allow_major_version_upgrade = true` + `apply_immediately = true`.
2. **Apply FIRST** — this performs the upgrade (a synchronous reboot, not deferred
   to a maintenance window).
3. **THEN** add `lifecycle { ignore_changes = [engine_version] }` to **BOTH** the
   `aws_rds_cluster` and the `aws_rds_cluster_instance` — this absorbs future AWS
   auto-MINOR upgrades (17.x→17.y) without surfacing Terraform drift.

**Other gotchas / 기타 함정:**

- Pinning just `"17"` **misbehaves on `aws_rds_cluster`** — the provider's prefix
  diff-suppress is implemented only for `aws_db_instance`. Use the exact minor.
- SG `description` is **immutable** — changing it forces a replace.
- `deletion_protection = false` + `skip_final_snapshot = true` are **dev-only** —
  flip both (and set `final_snapshot_identifier`) for prod.
- A **pre-upgrade manual snapshot is the rollback anchor** — a major in-place
  *downgrade* is impossible.
- Use the migration runner with private connectivity and verified RDS CA/hostname. Check the
  approved host/task SG and private endpoint when connectivity fails; do not broaden ingress
  or bypass TLS. Existing INTEGER ledgers use the separate controller-confirmed BOOTSTRAP gate.
  승인된 사설 SG/endpoint를 확인하고 TLS/ingress 보호를 완화하지 않는다.
  기존 INTEGER 원장은 controller가 확인한 별도 BOOTSTRAP 절차로 전환한다.

## Source / 출처

- `docs/history/archive/2026-05-31-awsops-v2-p1c-aurora.md` (archived P1c plan).
- Verified against `terraform/foundation/data.tf`,
  `terraform/foundation/data/schema.sql`, and the root `CLAUDE.md` Aurora-upgrade
  gotcha ("알려진 이슈" / known issues).
