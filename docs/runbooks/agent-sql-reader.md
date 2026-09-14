# Runbook: `awsops_sql_reader` (에이전트 `execute_sql` / `inventory-read`)

에이전트의 read-only SQL 경계는 **DB 롤**이며 어휘 가드가 아니다. 마이그레이션
`01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql` 이 `awsops_sql_reader` 를 만든다
(`NOSUPERUSER … NOBYPASSRLS`, `default_transaction_read_only = on`, `sql_reader` 스키마의 뷰에만
SELECT). RDS Data API 는 Secrets Manager 시크릿을 요구하므로(그 경로에 IAM DB auth 가 없다) 이 롤만
비밀번호를 갖는다 — Terraform 이 생성하고 `scripts/v2/migrate.mjs` 의 `syncSqlReaderPassword` 가 DB
롤을 그 시크릿으로 수렴시킨다.

The agent's read-only SQL boundary is a **DB role**, not a lexical guard: migration
`01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql` creates `awsops_sql_reader`
(`NOSUPERUSER … NOBYPASSRLS`, `default_transaction_read_only = on`, SELECT only on the
`sql_reader` schema's views). The RDS Data API needs a Secrets Manager secret (there is no
IAM DB auth on that path), so this one role has a password — Terraform generates it and
`syncSqlReaderPassword` in `scripts/v2/migrate.mjs` converges the DB role onto the secret.

## 실행 순서 — 마이그레이션이 먼저 / Enable order — migrations first

Dev Deploy AgentCore runs the reusable private `deploy-migrations.yml` workflow before its build/provision phases. Before dispatch, set `CI_MIGRATIONS_ENABLED_DEV=true` and apply a reviewed plan with `ci_migrations_enabled=true`; the applied `migration_job` output must be non-null. The default-off
migration infrastructure blocks dev deployment until applied. Main/preview and direct CLI on a host with private DB access use: dev Deploy AgentCore는 사설 재사용 migration workflow를 먼저 실행한다. 사전에 `CI_MIGRATIONS_ENABLED_DEV=true`를 설정하고 `ci_migrations_enabled=true`인 검토된 계획을 적용해 `migration_job`
출력이 null이 아니어야 한다. 기본 비활성 인프라가 적용되지 않으면 dev 배포는 차단된다. main/preview와 DB에 접근 가능한 호스트의 직접 CLI는 다음 순서를 따른다:

```
terraform -chdir=terraform/foundation apply tfplan   # reader 시크릿 생성 / creates the reader secret
make migrate                                            # 롤 생성 + 비밀번호 동기화 / creates the ROLE + syncs its password
make agentcore                                          # 게이트웨이/타겟 프로비저닝 / provisions the gateways/targets
```

`make agentcore` 자체는 마이그레이션이나 비밀번호 동기화를 실행하지 않는다. 사설 workflow 또는 앞선 `make migrate`를 생략하면 다음과 같은 인증 오류가 날 수 있다:

`make agentcore` itself does not run migrations or sync passwords. Skipping the private workflow or preceding `make migrate` can surface as these authentication failures:

| 증상 / Symptom | 원인 / Cause |
|---|---|
| `execute_sql`·`inventory-read` 가 Data API **auth** 오류 / fail with a Data API **auth** error | 롤 부재 또는 비밀번호 ≠ 시크릿 / role absent, or its password ≠ the secret |
| `sql-reader sync enabled but awsops_sql_reader is missing` | 동기화가 켜졌지만 롤 부재 — exit 1, `make deploy`도 중단 / enabled sync with absent role — exit 1, also blocks `make deploy` |
| `sql-reader: password sync disabled` | 명시적 disabled 모드 또는 정의된 빈 Terraform reader output / explicit disabled mode or a defined empty Terraform reader output |

런타임 태스크는 `SQL_READER_SYNC_MODE=secret`과 `SQL_READER_SECRET_ARN`을 명시해야 동기화한다.
`disabled`는 롤이 없어도 허용하지만, 존재하는 롤의 `rolsuper/rolreplication/rolbypassrls`
검사는 항상 수행한다(온라인 preview 제외). reader 시크릿 읽기와 비밀번호 변경만 생략한다.
에이전트가 reader를 사용하는 환경에서 장애를 우회하려고 disabled로 바꾸지 않는다.
Terraform 모드에서는 `agent_sql_reader_secret_arn`의 **정의된 빈 값**만 동기화를 끄며,
output 조회 실패는 오류다. 런타임 변수·TLS·IAM은 [migration 안내](../../terraform/foundation/migrations/README.md)를 따른다.

Runtime tasks synchronize only with explicit `SQL_READER_SYNC_MODE=secret` and
`SQL_READER_SECRET_ARN`. Disabled mode permits an absent role but still checks
`rolsuper/rolreplication/rolbypassrls` whenever the role exists (except online preview).
It skips only reader-secret retrieval and password alteration. Do not select disabled to bypass
a broken agent reader. In Terraform mode only a **defined empty** `agent_sql_reader_secret_arn`
disables sync; an output-read failure is an error. See the
[migration guide](../../terraform/foundation/migrations/README.md) for runtime settings, TLS and IAM.

두 도구만 실패한다. 나머지 rds-mcp 도구(`describe_*`, `list_*`)는 reader 시크릿이 아니라 실행
역할을 쓰므로 계속 동작한다 — 그 비대칭이 판별 단서다.

Both tools fail; the other rds-mcp tools (`describe_*`, `list_*`) keep working because they use
the execution role, not the reader secret. That asymmetry is the tell.

## 복구 / Recovery

두 증상의 조치가 **다르다** — 이전 리비전은 둘 다에 `make migrate` 를 권했지만 두 번째는 그것으로
고쳐지지 않는다(PR #197 리뷰 MAJOR).

The two symptoms have **different** fixes — an earlier version of this runbook offered
`make migrate` for both, which cannot fix the second one (PR #197 review MAJOR).

### 비밀번호 불일치 → `make migrate` / Password mismatch → `make migrate`

동기화가 켜진 비-preview 실행에서는 pending 유무와 무관하게 비밀번호를 동기화한다.

With sync enabled, every non-preview run synchronizes the password, even without pending migrations:

```
make migrate            # ALTER ROLE awsops_sql_reader WITH PASSWORD <secret>
```

**시크릿을 바꾸는 모든 작업 후**에 실행한다 / Do this after **anything that changes the secret**:

- Terraform 이 `agent_sql_reader_secret_arn` 을 재생성/회전 / Terraform regenerates or rotates it
- 시크릿을 백업에서 복원 / the secret is restored from a backup
- 롤 비밀번호를 손으로 변경 / the role's password was changed by hand

### 롤 부재 → 마이그레이션 적용 여부에 따라 다르다 / Role absent → depends on whether the migration already applied

`migrate.mjs` 는 **pending** 마이그레이션만 실행하고 적용된 것에는 checksum 불변성을 강제하므로,
이미 기록된 마이그레이션의 롤은 재실행으로 **다시 만들어지지 않는다**. 동기화가 켜져 있으면
`sql-reader sync enabled but awsops_sql_reader is missing`으로 exit 1하며,
`migrate`에 의존하는 `make deploy`도 중단된다.

`migrate.mjs` runs only **pending** migrations and enforces checksum immutability on applied ones, so
re-running it will NOT recreate a role whose migration is already recorded. Enabled sync fails
with `sql-reader sync enabled but awsops_sql_reader is missing` and exit 1.
Because `make deploy` depends on `migrate`, deployment also stops.

```
DRY_RUN=1 make migrate  # 01KYVY9J…_agent_sql_reader_role 이 LIVE DB 기준으로 아직 pending 인가?
```

`make migrate-status` 가 아니다(PR #197 리뷰 MAJOR) — 그 타겟은 명시적으로 오프라인이며
(`Makefile`: "no DB connect"), 디스크의 마이그레이션 파일과 앱 버전만 비교한다. **이 환경의**
데이터베이스에 실제로 적용됐는지는 답할 수 없고, 그것이 이 단계가 필요한 질문이다.
`DRY_RUN=1 make migrate` 는 접속해서 live `schema_migrations` 원장과 비교하며 아무것도 실행하지
않는다.

Not `make migrate-status` (PR #197 review MAJOR) — that target is explicitly offline (`Makefile`: "no DB
connect"; it only compares the app version to migration files on disk). It cannot tell you whether a
migration was actually applied to THIS environment's database, which is exactly the question this
step needs answered. `DRY_RUN=1 make migrate` connects and diffs against the live
`schema_migrations` ledger without executing anything.

- **아직 pending**(새 환경, 또는 마이그레이션 미실행): `make migrate` 가 적용하며 롤을 만든다. 끝.
  **Still pending** (fresh environment, or migrations never ran): `make migrate` applies it and
  creates the role. Done.
- **이미 적용됨**인데 롤이 없다(손으로 DROP, 또는 그 이전 스냅샷에서 복원): 기록된 checksum 때문에
  그 파일은 재실행 불가다. 롤·`sql_reader` 뷰·grant 를 다시 만드는 **신규 repair 마이그레이션**을
  추가한다. 손으로 잘못 재생성한 롤 등을 복구하면서 `DROP ROLE` 이 필요하다면, 그 **직전에**
  `DROP OWNED BY awsops_sql_reader` 를 먼저 실행해야 한다. 그러지 않으면 남아 있는 뷰 grant 때문에
  `DROP ROLE` 이 실패한다. 롤이 애초에 생성된 적이 없거나 이미 부재한 경우에는 이 단계가 필요 없다.
  DDL 은 현재 수정된 `01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql` 과 **같은 패턴**을
  따라야 한다: 롤은 `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'awsops_sql_reader')` 로
  가드된 `DO` 블록 안에서 만들되(Postgres 에 `CREATE ROLE IF NOT EXISTS` 는 없다),
  `ALTER ROLE` 에서 SUPERUSER/REPLICATION/BYPASSRLS 를 다시 명시하지 않는다. `CREATE ROLE` 자체의
  기본값이 NOSUPERUSER/NOREPLICATION/NOBYPASSRLS 이며, 셋 중 하나라도 다시 명시하면
  `01KYVY9J…` 에 설명된 같은 이유로 Aurora master user 에서 실패한다. 각 뷰는 `CREATE` 앞에
  `DROP VIEW IF EXISTS` 한다. 그 다음 `make migrate`. 재생성된 롤이 잘못된 상태라면
  `01KZ87KAJFA2Y27KY0QSMVBBDS_agent_sql_reader_elevated_attr_guard.sql` 과 `migrate.mjs` 의
  매 실행 `syncSqlReaderPassword` 검사가 큰 소리로 실패한다.
  **원본 파일은 수정하지 않는다**: `migrate.mjs` 가 checksum drift 로 거부하고, 다른 모든 환경의
  이력까지 바꾸게 된다.
  또한 `01M1B3NB288P56BDR1GMEN9GH9_inventory_sync_freshness.sql` 과
  `01M1FV21NGHGPVQVA86PKNBSJP_inventory_sync_unknown_attrs.sql` 이 `sql_reader.inventory_sync_runs`
  뷰를 공동 소유한다(각각 `last_success_at`/`last_success_row_count`,
  `unknown_attribute_count` 추가) — repair 마이그레이션은 freshness 컬럼과
  `unknown_attribute_count` 를 포함한 현재 뷰 정의로 재생성해야 하며, `01KYVY9J…` 시점의 컬럼
  목록으로 만들면 복구 '성공' 후 `_sync_freshness()` 가 조용히 깨진다.
  **Already applied** but the role is gone (dropped by hand, restored from a snapshot predating it):
  the recorded checksum makes that file un-runnable. Add a **new repair migration** that recreates
  the role, its `sql_reader` views and the grants. If recovery from a bad manual recreation requires
  `DROP ROLE`, first run `DROP OWNED BY awsops_sql_reader` **immediately before it** or the outstanding
  view grants will make `DROP ROLE` fail. This step is not needed when the role never existed or is
  already absent. Follow the **same pattern** as the now-fixed
  `01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql`: create the role inside a `DO` block guarded
  by `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'awsops_sql_reader')` (Postgres has no
  `CREATE ROLE IF NOT EXISTS`), but do not restate SUPERUSER/REPLICATION/BYPASSRLS via `ALTER ROLE`.
  `CREATE ROLE` already defaults to NOSUPERUSER/NOREPLICATION/NOBYPASSRLS, and restating any of the
  three fails against the Aurora master user for the reason documented in `01KYVY9J…`. Drop each
  view with `DROP VIEW IF EXISTS` before recreating it, then run `make migrate`. The
  `01KZ87KAJFA2Y27KY0QSMVBBDS_agent_sql_reader_elevated_attr_guard.sql` migration and the standing
  `syncSqlReaderPassword` check in `migrate.mjs` fail loud if the recreated role is in a bad state.
  Do not edit the original file: `migrate.mjs` will refuse on checksum drift, and editing it would
  also change history for every other environment. Note that
  `01M1B3NB288P56BDR1GMEN9GH9_inventory_sync_freshness.sql` and
  `01M1FV21NGHGPVQVA86PKNBSJP_inventory_sync_unknown_attrs.sql` co-own the
  `sql_reader.inventory_sync_runs` view (they add `last_success_at`/`last_success_row_count` and
  `unknown_attribute_count` respectively) — a repair migration must recreate the view with the
  freshness columns AND `unknown_attribute_count`, not the pre-freshness column list, or
  `_sync_freshness()` silently breaks after an apparently successful recovery.

회전 시 자동 수렴 훅은 **의도적으로 없다**. Terraform 쪽 비밀번호 변경과 다음 `make migrate` 사이의
창은 알려진 갭이며, 없애기보다 수용했다 — 닫으려면 Aurora 에 `ALTER ROLE` 권한을 가진 회전 트리거
Lambda 가 필요하고, 그것이 막으려는 실패(멱등 명령 한 번 돌 때까지 read-only 도구 2개가 오류)보다 큰
변경이다.

There is deliberately **no** automatic converge-on-rotation hook. The window between a
Terraform-side password change and the next `make migrate` is a known gap, accepted rather than
engineered away — closing it would need a rotation-triggered Lambda with `ALTER ROLE` rights on
Aurora, which is a larger change than the failure it prevents (two read-only tools erroring until
one idempotent command runs).

## 확인 / Verify

```
make migrate            # 기대: "sql-reader: password synced from Secrets Manager"
```

그 다음 에이전트로 `execute_sql`(예: `SELECT 1`)을 호출한다. foundation 클러스터나 미설정 env 를
지목하는 `400` 은 인증 오류가 아니라 설정 오류다 — `agent/lambda/aws_rds_mcp.py` 참조. 호스트 자신의
foundation Aurora 클러스터만 도달 가능하고, cross-account 와 호출자가 준
`secret_arn`/`database` 는 fail-closed 다.

Then invoke `execute_sql` (e.g. `SELECT 1`) through the agent. A `400` naming the foundation
cluster or an unset env var is a configuration error, not an auth error — see
`agent/lambda/aws_rds_mcp.py`. Only the host's own foundation Aurora cluster is reachable;
cross-account and caller-supplied `secret_arn`/`database` are fail-closed.

### 안전한 오류 진단 / Safe failure diagnostics

로그는 고정 작업/목적, 허용된 SDK code/name, 숫자 HTTP 상태, SQLSTATE, 정규화된 boolean을
남긴다. 검토된 baseline/마이그레이션 SQL 실행 중에만 NOTICE 감사 내용과 P0001 복구 안내
(입력 2048자 제한, JSON 인코딩·제어 문자 이스케이프), 검증된 severity/schema/table/column/constraint를
보존한다. 연결·시크릿·reader 동기화 단계의 임의 오류 원문, 시크릿 본문·비밀번호·Terraform stderr는 출력하지 않는다.
출력되지 않는 원문을 얻으려고 secret dump나 SDK 디버그 로깅을 켜지 않는다.

Logs retain fixed operation/purpose context, recognized SDK identifiers, numeric HTTP status,
SQLSTATE and normalized booleans. Only while executing reviewed baseline/migration SQL do they
retain NOTICE audit content, P0001 repair guidance (2048 input characters, JSON-encoded with
control characters escaped), and validated severity/schema/table/column/constraint fields.
Connection, secret and reader-sync phases suppress arbitrary error text; secret bodies/passwords,
detail/hint/where/query fields and Terraform stderr remain excluded. Do not dump secrets or enable SDK debug logging
to recover suppressed text.

| Safe diagnostic / 안전한 진단 | Action / 조치 |
| --- | --- |
| `Aurora master credentials` or `SQL-reader password synchronization` + `GetSecretValue` + `AccessDeniedException` | Check the indicated purpose's exact secret/task-role policy and CMK decrypt scope / 해당 시크릿·task role·CMK 범위 확인 |
| `ResourceNotFoundException`, `HTTP=400` | Check selected secret identifier and Region; do not substitute another role's secret / 식별자·리전 확인, 다른 롤 시크릿 대체 금지 |
| `CredentialsProviderError`, `ExpiredTokenException` | Restore the intended local session/task credentials / 의도한 로컬 세션·태스크 자격증명 복구 |
| `sql-reader: password synchronization failed: SQLSTATE=42501` | Connected DB user lacks role authority; inspect approved grants and elevated attributes / DB 사용자 권한·elevated 속성 확인 |
| `elevated attributes (rolsuper=…, rolreplication=…, rolbypassrls=…)` | Stop; use the reviewed role-repair path above. `true` identifies the attribute; disabled mode cannot bypass it / 중단 후 검토된 롤 복구, disabled 우회 불가 |
| `Connect to Aurora failed` + TLS code | Check private endpoint, CA and hostname; retain verification / 사설 endpoint·CA·호스트 검증 유지 |
| `Aurora connection error` / `Aurora connection cleanup failed` | Run failed, including idle secret-fetch or cleanup errors; inspect connectivity before retrying / 시크릿 조회 대기·정리 중 오류도 실패이며 연결 상태 확인 후 재시도 |
| `ENOENT` / `EACCES` | Check runtime SQL/CA assets and file permissions for the named operation / 표시된 작업의 SQL·CA 파일 및 읽기 권한 확인 |
| `Acquire migration advisory lock failed: SQLSTATE=55P03` | Inspect the existing migration session before retrying; do not bypass its lock / 실행 중 세션 확인 후 재시도 |
| `Terraform output … unavailable (category=backend-initialization, exit=…)` | Initialize the intended backend under the normal operator procedure / 승인된 backend 초기화 절차 |
| `category=missing-output` / `executable-unavailable` / `command-failed` / `command-terminated` | Check state/output version, installed Terraform, approved backend access or termination; exit is numeric when available / 상태·output 버전·Terraform 설치·backend 접근·중단 확인 |

`unclassified error` means no recognized safe code was available; the operation/purpose remains.
Migration failure output includes rollback vs non-transactional status and SQLSTATE. Reviewed SQL
notices retain disabled schedule row IDs and skipped view-refresh audit records. Connection error
events are handled throughout cleanup; the runner reports success only after cleanup completes.
Test fixtures reproduce a non-superuser role-authority denial and
successful synchronization after explicit authorization; they do not emulate all Aurora managed roles.

`unclassified error`는 안전하게 분류 가능한 code가 없다는 뜻이며 작업 목적은 남는다.
마이그레이션 오류는 rollback 여부·SQLSTATE를 남기고 검토된 SQL notice에는 disabled schedule
행 ID·view 갱신 생략 기록을 보존한다. 연결 오류 이벤트는 정리 완료까지 처리하며 완료 후에만
성공을 보고한다. 로컬 테스트는
non-superuser 권한 거부와 명시적 권한 부여 후 동기화를 재현하며 Aurora 관리 롤 전체를 모사하지 않는다.

## 실제 Postgres 17 로 검증함 / Verified against a real Postgres 17

마이그레이션과 투영을 `postgres:17-alpine` 에서 **실행**했다(2026-08-03) — 읽어본 것이 아니다.
`agent/lambda/test_inventory_view_contract.py` 의 계약 테스트는 마이그레이션 **텍스트**를 매칭하므로
SQL 이 파싱되는지는 알려주지 못하며, 그래서 리뷰 중 파싱을 깨는 버그가 두 번 실려나갔다(이스케이프
안 된 인용부호, 그 다음 감싸는 DO 블록을 닫아버린 태그 없는 dollar delimiter).

The migration and its projections were executed on `postgres:17-alpine` (2026-08-03), not just
inspected — the contract test in `agent/lambda/test_inventory_view_contract.py` matches migration
TEXT and cannot tell you whether the SQL parses, which is how two separate parse-breaking bugs
shipped during review (an unescaped quote, then an untagged dollar delimiter closing the enclosing
DO block).

`data/schema.sql` + 37 개 ULID 마이그레이션을 순서대로 적용했다. 롤 마이그레이션 3 개와 이 파일은 RDS
가 제공하는 롤(`rds_iam`, `awsops_admin`)을 필요로 하므로 vanilla 서버에서는 먼저 만들어야 한다. 그
다음 `awsops_sql_reader` 로:

Applied `data/schema.sql` + all 37 ULID migrations in order. Three role migrations plus this one need
roles RDS provides (`rds_iam`, `awsops_admin`); create them first on a vanilla server. Then, as
`awsops_sql_reader`:

These are the recorded 2026-08-03 baseline results, not a new execution of the current
projection. The current view owner and test limitations are described below.

| 검사 / Check | 결과 / Result |
|---|---|
| `SELECT ... FROM public.inventory_resources` | `ERROR: permission denied for table` |
| `UPDATE sql_reader.inventory_resources` | `ERROR: permission denied for view` |
| `SELECT task_token FROM sql_reader.worker_jobs` | `ERROR: column "task_token" does not exist` |
| CloudFront `data` 투영 / projection | `{"id","aliases","enabled","origins":[{"DomainName":...}]}` — `CustomHeaders` 값 부재, `cache_behaviors` 부재 / value absent, absent |
| `topology_nodes.meta` projection | Baseline fixture retained `invType` and omitted the whole-row `row` copy; this is not the complete current named-key schema. |

origins 케이스는 그 투영을 수정할 때마다 다시 돌려볼 값어치가 있다: `DomainName` 은 유지해야 하고
("CloudFront (empty origin)" finding 이 그것을 읽는다) `CustomHeaders[].HeaderValue`(origin secret)는
빠져야 한다. 리뷰 중 **양쪽 다** 틀린 적이 있다.

The origins case is the one worth re-running after any edit to that projection: it must keep
`DomainName` (the "CloudFront (empty origin)" finding reads it) while dropping
`CustomHeaders[].HeaderValue` (an origin secret). Both halves failed at some point during review.

### Current topology evidence contract

The current owner of `sql_reader.topology_nodes.meta` is
[`01M27B0000C6QWJ50NRJ8YAH9D_trace_queue_claim_provenance.sql`](../../terraform/foundation/migrations/01M27B0000C6QWJ50NRJ8YAH9D_trace_queue_claim_provenance.sql).
It selects named JSON keys with type checks for telemetry fields and a trace-queue
exception. The current materialized flow writer persists `ownership_evidence` and
`targetCapturedAt` on **target nodes**, with VPC/subnet or ambiguity metadata where
applicable. `targetCapturedAt` dates only the target-group inventory row; it does not
date the independent task/subnet/pod evidence or establish current ownership. Host ECS
snapshot target labels are cached configuration as well. `candidate` is page-only
out-of-region context, not materializer output. The view excludes these fields along
with `vpcId`, `subnetId` and `ambiguity`; older retained `capturedAt` fields are also unlisted.
It can expose bare `region`, `cluster`, `ecsService` and `task` fields: these do not
establish complete network scope or current ownership when the provenance fields are absent.
Any other unlisted key remains excluded. Exposing another key requires a reviewed
additive migration; this document changes no projection or grant (ADR-004 §7, maintained
in the private upstream repository).

The projection is not an ownership validator:

- `class='flow'` and `class='infra'` describe cached configuration relationships,
  not exclusive or live ownership.
- Trace service account/region and Kubernetes names come from telemetry. Any such
  fields present on other trace nodes, including database nodes, remain telemetry
  claims; the current database writer does not populate every allowed identity key.
  A database `infra_ref` is inferred from an eligible host-name/prefix match, not
  independent AWS identity proof.
- Trace queues explicitly expose `identityProvenance='telemetry_claim'` and nullable
  destination-ARN-derived `claimedAccountId`/`claimedRegion`. Queue `accountId`,
  `region` and `infra_ref` are removed. Neither parsed ARN syntax nor a storage
  partition's `account_id` proves telemetry ownership.

The node's exposed `captured_at` is graph materialization time, not its underlying
inventory capture or observation time. For trace collection quality, consult
`sql_reader.topology_graph_state`: status, attempt/publication times, observation
window, retained flag and projected source reasons. The current writer records only
`class='trace'`; a missing flow/infra state row is not evidence of complete or empty
coverage. Missing qualifiers or timestamps never establish confidence.

`agent/lambda/test_inventory_view_contract.py` still reads the original
`01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql` for its topology assertions.
Those baseline text assertions do **not** enforce the current topology projection.
Inspect the current migration and the queue/view cases in
`scripts/v2/workers/test_graph_collection.py`; this clarification does not retarget
tests or claim a fresh PostgreSQL execution.

### Trace queue projection / 트레이스 큐 투영

`01M279W0J9HNG1QT0MAS60KV8K_topology_graph_collection_state.sql` extends graph evidence;
`01M27B0000C6QWJ50NRJ8YAH9D_trace_queue_claim_provenance.sql` supersedes its node projection.
After `make migrate`, spot-check `sql_reader.topology_nodes` where `class='trace' AND kind='queue'`:
`claimedAccountId/claimedRegion` must match only parsed destination ARN qualifiers, including
retained rows; non-ARN/malformed destinations have null claims and no reporter fallback.
`identityProvenance` is always `telemetry_claim`; `accountId`, `region`, `infra_ref` and whole-row
copies stay absent for trace queues. SELECT is granted only on the view, never the base table.
`scripts/v2/workers/test_graph_collection.py` exercises this contract on disposable PostgreSQL,
including grant restoration, reapplication, denied base-table reads and denied view writes.

그래프 근거 마이그레이션 이후 `01M27B...`가 노드 투영을 갱신한다. 적용 후 보존된 행을 포함해
큐 claim이 destination ARN의 한정자와만 일치하는지 확인한다. 비-ARN·잘못된 ARN은 null이고
호출자 폴백은 없어야 한다. 출처는 항상 `telemetry_claim`이며 trace 큐의 `accountId`·`region`·
`infra_ref`·전체 행 복사본은 노출되지 않는다. SELECT는 뷰에만 부여하며 위 SQL 테스트가
재적용·권한 복구·기본 테이블 접근 거부를 검증한다. AI 도구 반영에는 `inventory_read_mcp`
Lambda도 배포해야 한다. [적용 절차 / Rollout](source-sync-observability.md).

## 관련 / Related

- [Original reader-role/view migration](../../terraform/foundation/migrations/01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql)
- [Current topology-node projection](../../terraform/foundation/migrations/01M27B0000C6QWJ50NRJ8YAH9D_trace_queue_claim_provenance.sql)
- [Trace collection-state and edge projections](../../terraform/foundation/migrations/01M279W0J9HNG1QT0MAS60KV8K_topology_graph_collection_state.sql)
- `scripts/v2/migrate.mjs` (`syncSqlReaderPassword`) — 동기화 / the sync
- ADR-004 §7 — SQL reader security model; the ADR body is maintained in the private upstream repository.
