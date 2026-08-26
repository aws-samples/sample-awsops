# Runbook — v1 → v2 Aurora 이력 백필 / v1 → v2 Aurora History Backfill

v1(EC2, `data/*.json`)의 **고가치 이력 4종**을 v2 Aurora의 ADR-001 앱상태 테이블로 일회성·**멱등** 적재한다. Steampipe에는 옮길 영속 데이터가 없으며(라이브 FDW 엔진), v2 라이브 인벤토리 sync(`inventory_resources`)와는 무관하다.
One-time, **idempotent** load of v1's four high-value history stores into v2's ADR-001 Aurora app-state tables. Steampipe holds no durable data (live FDW engine); this is unrelated to the v2 live inventory sync (`inventory_resources`).

| v1 store | → Aurora table |
|---|---|
| `data/inventory/[<acct>/]<YYYY-MM-DD>.json` | `inventory_snapshots` |
| `data/cost/[<acct>/]<YYYY-MM-DD>.json` | `cost_snapshots` |
| `data/alert-diagnosis/<YYYY-MM>/<id>.json` | `alert_diagnosis` |
| `data/event-scaling/<id>.json` | `event_scaling_plans` |

도구 / Tool: `scripts/v2/backfill-v1.mjs` (매핑 = `scripts/v2/backfill-core.mjs`). 설계 = `docs/superpowers/specs/2026-06-12-v1-to-v2-aurora-backfill-design.md`.

---

## 1. 사전 준비 / Prerequisites

- Aurora(:5432)에 도달 가능한 호스트(예: mgmt-vpc 호스트)와 리포지토리 체크아웃 + `scripts/v2/node_modules`(`pg` 포함 — `make deps` 또는 `npm ci --prefix scripts/v2`로 설치).
  A host that can reach Aurora:5432 (e.g. the mgmt-vpc host) with the repo checked out and `scripts/v2/node_modules` (provides `pg` — install via `make deps` or `npm ci --prefix scripts/v2`).
- 자격증명 / Credentials — 아래 순서로 해석되며 **DSN/비밀번호는 절대 로그에 남지 않는다** / resolved in this order, and **the DSN/password is never logged**:
  1. `--dsn <url>` 또는 `BACKFILL_DSN`
  2. `AURORA_SECRET_ARN` + `AURORA_ENDPOINT` (Secrets Manager)
  3. `terraform -chdir=terraform/foundation output -raw aurora_secret_arn|aurora_endpoint` (= `migrate.mjs` 경로)
- 운영 환경에서는 **2번(Secrets Manager) 경로를 우선** 사용하라. `--dsn`은 테스트/고급용이다.
  Prefer the Secrets Manager path in production; `--dsn` is for tests/advanced use.

## 2. v1 데이터 가져오기 / Pull the v1 data (read-only)

v1 인스턴스 `i-0123456789abcdef0`의 `data/`를 로컬로 복사한다(읽기 전용 — v1은 건드리지 않는다).
Copy `data/` off the v1 instance `i-0123456789abcdef0` (read-only — v1 is untouched).

```bash
# SSM 세션 또는 Run Command로 tar 후 내려받기 / tar via SSM then download
INSTANCE=i-0123456789abcdef0
# (옵션 A) SSM Run Command → S3
aws ssm send-command --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["tar -C /home/ec2-user/awsops -czf /tmp/v1-data.tgz data"]'
# (옵션 B) 포트포워딩/세션 후 scp, 또는 s3 cp 로 /tmp/v1-data.tgz 회수
mkdir -p ./v1-data && tar -xzf v1-data.tgz -C ./v1-data --strip-components=1   # → ./v1-data/{inventory,cost,...}
```

> `data/config.json`(시크릿 포함)·`agentcore-stats`·`memory`·`report-schedule`은 **범위 밖**이라 백필되지 않는다.
> `data/config.json` (secrets), `agentcore-stats`, `memory`, `report-schedule` are **out of scope** and not backfilled.

## 3. 드라이런 / Dry-run (no DB)

먼저 무엇이 적재될지 DB 접속 없이 확인한다.
Verify what would load, with no DB connection.

```bash
node scripts/v2/backfill-v1.mjs --data-dir ./v1-data --dry-run
# 단일계정 레이아웃(루트 날짜파일)의 기본 계정 id 지정 / set the account id for the single-account layout:
node scripts/v2/backfill-v1.mjs --data-dir ./v1-data --account-id 123456789012 --dry-run
```

출력의 `would-write / skipped / errored` 카운트를 확인한다. `errored > 0`이면 종료코드 1.
Read the `would-write / skipped / errored` counts. `errored > 0` ⇒ exit code 1.

## 4. 실행 / Run

```bash
# Secrets Manager 경로(권장) — creds 자동 해석 / Secrets Manager path (preferred)
node scripts/v2/backfill-v1.mjs --data-dir ./v1-data --account-id 123456789012

# 특정 소스만 / a single source
node scripts/v2/backfill-v1.mjs --data-dir ./v1-data --only cost

# 명시적 DSN(테스트/고급; Aurora면 sslmode=require) / explicit DSN
node scripts/v2/backfill-v1.mjs --data-dir ./v1-data \
  --dsn 'postgresql://USER:PASS@HOST:5432/awsops?sslmode=require'
```

소스별 요약 `inserted / updated / conflict-skip / skipped / deleted / errored`을 출력한다(DSN 마스킹). **`errored > 0`일 때만 종료코드 1.**
Prints a per-source summary `inserted / updated / conflict-skip / skipped / deleted / errored` (DSN masked). **Exit code 1 iff a file errored.**

전체 TLS 검증이 필요하면 RDS CA 번들을 지정 / for full TLS verification supply the RDS CA bundle:
```bash
PGSSLROOTCERT=/path/rds-ca.pem node scripts/v2/backfill-v1.mjs --data-dir ./v1-data
```

## 5. 검증 / Verify

```bash
# 테이블별 행수 / row counts per table (psql to Aurora)
psql "$DSN" -c "SELECT 'inventory' t, count(*) FROM inventory_snapshots
  UNION ALL SELECT 'cost', count(*) FROM cost_snapshots
  UNION ALL SELECT 'alert', count(*) FROM alert_diagnosis
  UNION ALL SELECT 'scaling', count(*) FROM event_scaling_plans;"
```

**멱등성 / Idempotency:** 같은 `--data-dir`로 재실행하면 최종 상태가 동일하다(인벤토리 = 해당 일자 DELETE 후 재삽입, 비용/스케일링 = UPSERT, 알림 = ON CONFLICT DO NOTHING). 재실행 시 요약은 `inserted=0` + `updated`/`conflict-skip`으로 표시된다.
Re-running with the same `--data-dir` yields the same end state; the re-run summary shows `inserted=0` with `updated`/`conflict-skip`.

## 6. 주의 / 충실도 갭 / Notes & fidelity gaps

- **`--account-id`는 v1 dual-write가 그 일자에 쓰던 id와 일치해야 한다.** 불일치 시 백필 행이 다른 `account_id`로 분기되어 동일-(계정,일자) 멱등 교체 보장이 깨진다(필요 시 `SELECT DISTINCT account_id FROM inventory_snapshots`로 사전 확인).
  **`--account-id` must match the id v1's dual-write used** for those days, or rows fork onto a different `account_id`.
- 알림: v1 `DiagnosisRecord`에는 `source`/`fingerprint`가 없다 → `source`=`--alert-source`(기본 `unknown`), `fingerprint`=`NULL`. 따라서 백필된 알림은 `idx_diag_fingerprint`(partial, `WHERE fingerprint IS NOT NULL`)에 **포함되지 않아** fingerprint 기반 중복제거/검색에서 보이지 않는다.
  Backfilled alerts have `fingerprint=NULL` ⇒ excluded from the fingerprint partial index (invisible to fingerprint dedup/search).
- **읽기 컷오버 없음**: 앱의 source-of-truth는 바뀌지 않는다. **v1 데이터 삭제 없음**. **DSN/자격증명은 절대 출력하지 않는다.**
  No read-cutover; no v1 deletion; never echo the DSN/credentials.

## 7. 테스트 / Tests

```bash
node --test scripts/v2/backfill-core.test.mjs   # 순수 매퍼/분류 단위테스트 / pure unit tests
node scripts/v2/backfill-v1.itest.mjs           # PG17 컨테이너 E2E(멱등성 포함) / PG17-container E2E (sudo docker)
```

## 관련 / Related

- 파일 / Files: `scripts/v2/backfill-v1.mjs`, `scripts/v2/backfill-core.mjs`, `scripts/v2/backfill-v1.itest.mjs`, `terraform/foundation/data/schema.sql`, `src/lib/db/*-writer.ts`
- ADR: **001**(v2 파운데이션 — ECS Fargate + Aurora 앱상태 7테이블). 스펙 = `docs/superpowers/specs/2026-06-12-v1-to-v2-aurora-backfill-design.md`.
