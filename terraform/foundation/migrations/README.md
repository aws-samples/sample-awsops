# DB migrations (`make migrate`)

Collision-free, fail-loud DB migrations applied by `scripts/v2/migrate.mjs` (run via `make migrate`,
and automatically before `make deploy`). Decision record: `docs/reviews/2026-06-11-migration-mechanism-consensus.md`.

## Why this exists
The legacy single `schema.sql` used sequential integer versions (`v8`, `v9`, …) + `INSERT … ON CONFLICT
DO NOTHING`. Concurrent branches kept **preempting the same integer** (manual renumber every time) and the
`ON CONFLICT` **silently masked** duplicates. This directory replaces that for all NEW migrations.

## Authoring a migration
1. Generate a **ULID** id (sortable, collision-proof across concurrent branches):
   ```
   node -e "import('ulid').then(m=>console.log(m.ulid()))"   # or any ULID generator
   ```
2. Create `terraform/foundation/migrations/<ULID>_<snake_name>.sql`, e.g.
   `01J9Z8XK3P7QF2VN6T0BC4D5EH_opencost_config.sql`.
3. Put **only DDL/data** in the file. **Do NOT** write `schema_migrations` — the runner stamps it
   (version + sha256 checksum) in the same transaction for ordinary files. Do NOT use `ON CONFLICT DO NOTHING` on the ledger.
4. Non-transactional statements (`CREATE INDEX CONCURRENTLY`, some `ALTER TYPE … ADD VALUE`) — put
   `-- migrate:no-transaction` as the first line; the standalone runner runs that file in autocommit,
   with a separate ledger write. These files require manual failure/retry review and are refused in automatic mode.
5. Declare the release with a `-- since: <semver>` header (e.g. `-- since: 2.1.0`) — the version the
   migration is introduced in. Recorded in the `app_version` ledger column at apply. Optional: with no
   header the runner stamps the deploying app's version (`web/package.json`) instead.

## Rules
- **Never edit an applied migration** — the runner stores a sha256 (LF-normalized) and aborts on drift.
- One migration = one logical change. Additive-forward preferred; destructive ops need a deliberate review.
- IDs must be unique ULIDs — the runner aborts before connecting if two files share an id.

## Apply
- Install locked runtime dependencies first: `npm ci --prefix scripts/v2 --ignore-scripts --no-audit --no-fund`.
- `make migrate` — apply pending after nonblocking `pg_try_advisory_lock(4729411)` admission.
  A busy lock fails immediately instead of queueing; that runner performs no initialization, DDL or reader sync.
  The owner holds the session lock through reader password synchronization. `make deploy` runs migration first.
- `make migrate-status` — offline summary: the deploying app version + each migration's declared release. No DB.
- `DRY_RUN=1 make migrate` — list pending + SQL, no exec; automatic admission still applies if enabled.
  `DRY_RUN=1 OFFLINE=1` — no DB connection or admission check.
- `BOOTSTRAP=1 make migrate` — **one-time, controller-confirmed**: migrates the legacy `schema_migrations.version`
  INTEGER→TEXT + adds the `checksum` + `app_version` columns + a `baseline` marker. Run during a coordinated quiet
  window (concurrent sessions may still INSERT integer rows). Legacy integer rows (v1..vN) are preserved as applied;
  the baseline `schema.sql` stays as the one-time bootstrap of those tables.

### Automatic migration admission

`AUTOMATIC_MIGRATION=1` opts into the conservative policy in `scripts/v2/automatic-migration-policy.mjs`. Under the session lock, after checksum validation, it checks **all ledger-derived pending files**, including gaps below newer applied IDs. Only supported `CREATE TABLE` definitions and ordinary, non-unique, column-only B-tree `CREATE INDEX` statements are admitted. Allowlisted built-in column types, constant defaults, and new-table `NOT NULL`/`PRIMARY KEY`/`UNIQUE` constraints are supported; indexes may use ordering, `INCLUDE`, and `IF NOT EXISTS`. This is a limited syntax subset, not complete schema validation.

Every `-- migrate:no-transaction` file is rejected, even if its SQL could run transactionally. `CREATE INDEX CONCURRENTLY` is rejected with or without that header or `IF NOT EXISTS`. All `ALTER TABLE` statements, including nullable `ADD COLUMN`, require standalone review: base-column changes and their `sql_reader` view/grant refresh must remain together. Do not remove a paired refresh to pass admission. Destructive SQL, procedural/dynamic SQL, data statements and other unsupported forms also require the manual path.

A rejected file produces only safe file/id/reason metadata and fixed guidance, before any pending DDL, ledger upgrade or reader sync. Online `DRY_RUN=1` still rejects disallowed pending files instead of printing SQL; one rejected pending file stops the entire online preview. Unset `AUTOMATIC_MIGRATION` for a reviewed standalone migration or full SQL preview. Checksums and the lock still apply. `--status`/`STATUS=1` and offline preview inspect files without validating live pending admission. False positives intentionally require manual review; never edit immutable SQL/headers or ledger checksums to bypass them.

### Empty database / 빈 데이터베이스

From an approved host with private Aurora connectivity, use `INITIALIZE_EMPTY_DB=1 make migrate`
once for a new, empty database. For host commands and ordinary deployment services, this is a
one-shot operator choice rather than a persistent setting.
The initializer refuses an absent ledger if any user object exists, including global default ACLs,
custom schemas, routines, extensions, large objects, foreign wrappers or subscriptions in this database. Investigate or restore such
a database; do not delete objects/ledger rows to force the guard through.

Aurora에 사설 연결 가능한 승인된 호스트에서 새 빈 DB에 한해
`INITIALIZE_EMPTY_DB=1 make migrate`를 한 번 실행한다. 호스트 명령이나 일반 배포 서비스에는
상시 초기화 설정으로 두지 않는다.
원장이 없어도 사용자 객체(전역 default ACL·스키마·함수·확장·large object·해당 DB의 subscription 등)가 있으면 거부한다.
강제로 통과시키려고 객체나 원장 행을 지우지 말고 상태를 조사하거나 복원한다.

The frozen baseline's one legacy BEGIN/COMMIT pair is removed **only in memory**. All baseline
sections, INTEGER→TEXT ledger conversion and the baseline checksum commit atomically. ULIDs then
commit individually under the same session lock (`4729411`), held through reader synchronization.
A concurrent runner fails immediately before initialization; it does not wait for this lock.
A later ULID failure leaves the committed baseline/prior ULIDs available for retry. Existing ledgers
skip initialization; existing INTEGER ledgers still require the separate `BOOTSTRAP=1` gate.
The trusted empty-only baseline hook precedes automatic pending-SQL admission: a fresh baseline
may remain committed when an unsafe pending ULID is rejected. Recurring `INITIALIZE_EMPTY_DB=1`
on the dedicated CI template is not itself an automatic-mode rejection.
`INITIALIZE_EMPTY_DB=1` cannot be combined with an online `DRY_RUN=1`; `--status`/`STATUS=1`
and `DRY_RUN=1 OFFLINE=1` remain credential-free inspection modes.

기존 SQL 파일을 바꾸지 않고 메모리에서만 wrapper를 제거한다. baseline 전체·TEXT 변환·checksum은
한 트랜잭션으로 반영하고, advisory lock(4729411)을 대기 없이 획득한 실행만 잠금을 유지해
ULID별 적용과 reader 동기화를 진행한다. 잠금이 사용 중이면 초기화 전에 즉시 실패한다.
후속 ULID 실패 시 완료된 baseline/이전 ULID는 유지되어 재시도 가능하다. 원장이 있으면 초기화를
건너뛰며 INTEGER 원장은 별도 `BOOTSTRAP=1`이 필요하다. 온라인 dry-run과 초기화는 함께 쓰지 않는다.
상태 조회와 오프라인 preview에는 자격증명이 필요 없다.

After empty-only initialization, every online run, including preview, checks stored non-null
baseline and ULID checksums before pending ledger changes or password sync. Legacy null baseline checksums remain supported; this is not
permission to retag/edit existing SQL or to rewrite ledger checksums.
빈 DB 전용 초기화 후 모든 온라인 실행은 preview를 포함해 pending ledger 변경이나 비밀번호 동기화 전에 저장된 non-null baseline/ULID checksum을 검증한다. 레거시 null checksum은
허용하지만 기존 SQL의 `-- since:` 변경·수정이나 원장 checksum 덮어쓰기는 허용하지 않는다.

### Runtime configuration / 런타임 설정

With **none** of `AURORA_ENDPOINT`, `AURORA_DATABASE`, `AURORA_SECRET_ARN` present, the CLI reads
Terraform outputs `aurora_endpoint`, `aurora_secret_arn`, `agent_sql_reader_secret_arn` and uses
database `awsops`. A defined empty reader output disables password sync; a missing/failed output
is a hard failure. Presence of **any** runtime variable, even an empty value, selects runtime mode;
incomplete configuration fails without a Terraform fallback.

세 Aurora 변수가 모두 없으면 기존 Terraform output CLI 모드이고 DB는 `awsops`다.
reader output이 정의된 빈 문자열이면 비밀번호 동기화를 끄지만 output 조회 실패/부재는 오류다.
하나라도 존재하면(빈 값 포함) 런타임 모드이며 불완전한 설정에서 Terraform으로 폴백하지 않는다.

| Variable | Runtime contract / 런타임 계약 |
| --- | --- |
| `AWS_REGION` | Required target Region / 대상 리전 필수 |
| `AURORA_ENDPOINT` | Required writer DNS hostname, no scheme/path/port / writer DNS 이름, 경로·포트 금지 |
| `AURORA_DATABASE` | Required literal `awsops`; other names fail before secret lookup / `awsops`만 허용 |
| `AURORA_SECRET_ARN` | Required **master** secret identifier; JSON `username` must be `awsops_admin`, password a nonempty string / `awsops_admin` master 시크릿 |
| `SQL_READER_SYNC_MODE` | Explicit `secret` or `disabled`; no runtime `terraform` mode / 명시적 모드 필수 |
| `SQL_READER_SECRET_ARN` | Required only with `secret`; omit or empty with `disabled`. JSON username must be exactly `awsops_sql_reader`, password a nonempty string / reader 전용 시크릿 |
| `INITIALIZE_EMPTY_DB` | Optional `1` for verified empty DB; one-shot host command, retained in the private CI template for manual and guarded current-source dev web releases / 검증된 빈 DB에만 선택적으로 `1`; 호스트에서는 일회성 명령으로 사용하며 private CI 템플릿에서는 수동 및 검증된 현재 소스 dev 웹 배포에 유지 |
| `BOOTSTRAP` | Optional controller-confirmed `1` for legacy INTEGER ledger / 기존 INTEGER 원장 전환 |
| `AUTOMATIC_MIGRATION` | Optional literal `1` restricts all pending files to supported transactional new tables and ordinary non-unique indexes. Unset preserves reviewed standalone SQL; online dry-run also enforces the policy above. |
| `APP_VERSION` | Optional release stamp fallback; otherwise `web/package.json`; `-- since:` takes precedence / release 기록 |
| `STATUS`, `DRY_RUN`, `OFFLINE` | `1` enables the inspection modes described above / 위 조회 모드 |

The immutable SQL corpus refers to database `awsops` and default privileges owned by
`awsops_admin`; these match the foundation's fixed database/master settings. Credential
validation rejects other names before connecting or initializing a ledger. Renaming them
requires a separately reviewed migration design, not a runtime environment override.

기존 SQL은 `awsops` DB와 `awsops_admin`의 default privilege를 참조한다. foundation의 고정
설정과 일치해야 하며 다른 이름은 연결·원장 초기화 전에 거부한다. 이름 변경은 환경변수로
처리하지 않고 별도의 마이그레이션 설계와 검토가 필요하다.

These names define the runtime/controller interface. `AURORA_SECRET_ARN` means the **master** here;
the agent's `AURORA_SQL_READER_SECRET_ARN` is not an alias for `SQL_READER_SECRET_ARN`.
Do not copy the agent's environment block. Role elevation is checked on every non-preview run when
the role exists, **including disabled mode**. Disabled permits an absent role and skips only the
reader secret fetch/password alteration; it does not repair a missing role or password mismatch.
After a disabled-mode installation, complete migrations with reader sync enabled before AgentCore. Dev Deploy AgentCore and current-source dev Deploy Web run the reusable private `deploy-migrations.yml` first; main/preview and direct private-host CLI use `make migrate` before `make agentcore`.
Otherwise Data API auth can fail. The dev workflow requires `CI_MIGRATIONS_ENABLED_DEV=true` and a reviewed apply of `ci_migrations_enabled=true` that persists a non-null `migration_job` output before release.
See `docs/runbooks/agent-sql-reader.md` for recovery and safe diagnostic codes.

이 이름은 runtime/controller의 계약이다. 에이전트 환경변수를 복사하지 않는다.
`disabled`에서도 존재하는 reader 롤의 elevated 속성을 검사한다. 부재한 롤은 허용하고
reader 시크릿 조회/비밀번호 변경만 생략한다. 활성 에이전트의 장애 우회책으로 disabled를 쓰지 않는다.
disabled 설치 후 AgentCore 전에 reader 동기화를 포함한 migration을 성공시켜야 한다. dev workflow 실행 전 `CI_MIGRATIONS_ENABLED_DEV=true`와 검토된 `ci_migrations_enabled=true` 계획을 적용해 `migration_job` 출력이 null이 아니어야 한다. dev는 사설 재사용 workflow를 먼저 실행하고
main/preview·직접 CLI는 `make migrate`를 사용한다. 생략하면 `execute_sql`/inventory-read의 Data API 인증이 실패할 수 있다.

### ARM64 image and private execution / ARM64 이미지·사설 실행

Build from the repository root with Docker/buildx; the image runs as `node` (UID 1000), supports
a read-only filesystem, and uses a replaceable CMD. It contains the frozen SQL, migration files,
locked runtime dependencies and the shared RDS trust bundle `scripts/v2/eks/rds-ca-bundle.pem`.

루트에서 Docker/buildx로 빌드한다. UID 1000·읽기 전용 파일시스템·CMD 실행을 지원하며
SQL·잠긴 의존성·공용 RDS CA bundle을 포함한다(`eks/` 경로지만 migration에서도 사용).

```bash
docker buildx build --platform linux/arm64 --load -t awsops-migration:local \
  -f scripts/v2/ci/Dockerfile.migration .
docker run --rm --network none --read-only awsops-migration:local \
  node scripts/v2/migrate.mjs --status
```

The private development workflow (manual dispatch or the guarded current-source Deploy Web caller) builds/pushes to the selected private ECR repository,
pins the image digest, and runs the default CMD in a private ARM64 Fargate task.
Its task/IAM template is gated by `ci_migrations_enabled` (default false); see the [deployment runbook](../../../docs/runbooks/dev-repo-setup.md).
Task completion must include the migration container's numeric exit code `0`; status output alone
is not a successful migration. Supply the required identifiers/mode above (plus reader ARN
only in secret mode) as nonsecret environment settings; never inject passwords or secret bodies.
The dedicated **Migrate Development Database** template deliberately enables guarded initialization:
each accepted dev migration invocation requests it if needed; explicit older-image rollback skips this workflow. Provisioning the template runs nothing, an existing
ledger skips initialization, and an occupied database without a ledger is refused. This exception
does not apply to ordinary services or scheduled deployment templates.

수동 실행 또는 현재 소스 Deploy Web의 보호된 호출로 개발 workflow가 private ECR에 빌드/푸시하고 정확한 digest로 private ARM64 Fargate 태스크를 실행한다.
태스크/IAM 템플릿은 기본 false인 `ci_migrations_enabled`로 제어한다.
성공은 migration 컨테이너의 숫자 exit code `0`까지 확인해야 한다. 환경에는 위 식별자/모드만
전달하고 비밀번호·시크릿 본문을 넣지 않는다. 전용 **Migrate Development Database** 템플릿은
허용된 dev migration 호출마다 필요한 경우의 안전한 초기화를 요청하며 이전 이미지 롤백은 이 workflow를 실행하지 않는다. 템플릿 생성만으로 실행되지
않으며, 원장이 있으면 초기화를 생략하고 원장 없는 비어 있지 않은 DB는 거부한다. 일반 서비스나
예약 배포 템플릿에는 이 예외를 적용하지 않는다.

- **Task role:** `secretsmanager:GetSecretValue` on the exact master secret, plus the exact reader
  secret only in secret mode. CMK secrets need scoped `kms:Decrypt` with Secrets Manager
  `kms:ViaService` and secret encryption-context restrictions. ECS trust must be account scoped.
  **태스크 역할:** 필요한 개별 시크릿 읽기와 CMK decrypt만 허용하며 계정/서비스/암호화 context를 제한한다.
- **Execution role:** approved private ECR pulls and the selected CloudWatch log stream.
  Runtime SDK reads use the task role; no ECS plaintext secret injection.
  **실행 역할:** ECR pull·로그 전용이며 SDK 시크릿 읽기는 task role을 사용한다.
- **Network:** private subnets, no public IP, approved SG-to-SG TCP 5432 access to Aurora;
  DNS resolution and HTTPS paths to Secrets Manager/ECR/Logs (endpoints or approved egress).
  Do not broaden ingress, change SG descriptions, DNS or identity guards to make migrations run.
  **네트워크:** 사설 subnet/승인된 SG 연결과 DNS·HTTPS 경로를 확인하고 보호 설정을 완화하지 않는다.
- **TLS:** verified CA **and hostname** on port 5432. Certificate/hostname errors require correcting
  endpoint/trust configuration; never set `rejectUnauthorized=false` or use a socket bypass.
  **TLS:** 인증서와 호스트 이름 모두 검증하며 오류를 우회하지 않는다.

## Release versioning & upgrades
Migrations are **cumulative**, not version-pair scripts. The `schema_migrations` ledger records which
migration IDs are applied; `make migrate` applies whatever the live DB is *missing*, in ULID (chronological)
order — regardless of which release you started from. So you never author a "2.0.1 → 2.1.5" script:

```
git fetch --tags && git checkout v2.1.5
make migrate-status          # see what 2.1.5 ships + each migration's release
bash scripts/v2/upgrade.sh   # PREVIEW (no writes); then CONFIRM=go bash scripts/v2/upgrade.sh
```

`upgrade.sh` is the safe wrapper for **any** release upgrade: RDS snapshot → `make migrate` (auto-runs the
one-time legacy bootstrap if the ledger is still INTEGER) → idempotency check → `make deploy`. Upgrading
from 2.0.0, 2.0.9, or 2.1.4 to 2.1.5 is the *same* command — the ledger computes the exact delta.

Each applied row carries `app_version` (the migration's `-- since:` release, else the deploying app's
`web/package.json` version), so the ledger answers "which release introduced this / what schema am I on".
List a release's DB changes in `CHANGELOG.md` from the migrations whose `-- since:` matches that version.
