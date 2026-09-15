# Runbook — Steampipe 쿼터 및 인벤토리 신선도 / Steampipe Quota and Inventory Staleness

## Optional host scope / 선택적 호스트 범위

`INVENTORY_HOST_ONLY=true` requires `EXPECTED_HOST_ACCOUNT_ID` and exactly one enabled
host row matching fresh STS identity. Wrong scope or exhausted identity retries prevents
startup or stops collection with exit 1. Transient STS calls get three total attempts;
ordinary SIGTERM remains a graceful exit. Stop and restart share a lock, and crash backoff
is interruptible. Defaults preserve the existing multi-account renderer. Before enabling,
prepare the host registry and ensure the account-management path enforces the intended scope.

`INVENTORY_HOST_ONLY=true`에서는 예상 계정과 활성 호스트 행 하나가 STS 식별자와
일치해야 합니다. 잘못된 범위나 재시도 소진은 시작을 막거나 종료 코드 1로 수집을
중단합니다. 일시적 STS 실패는 총 3회까지만 시도하며 일반 SIGTERM은 정상 종료입니다.
종료와 재시작은 같은 잠금을 사용하고 backoff도 중단됩니다. 기본 다중 계정 동작은
유지하며, 활성화 전에 호스트 행과 계정 관리 경로의 범위 제어를 준비합니다.


> Data-flow diagram / 데이터 흐름 다이어그램: [`docs/diagrams/inventory-freshness-dataflow.html`](../diagrams/inventory-freshness-dataflow.html) (archify — collector → guard → ledger → freshness disclosure)

Phase 1의 Steampipe 인벤토리 sync를 운영하는 절차다. Phase 1 구현은 저장소에 있다. **이 변경을 수행한 에이전트는 Terraform apply를 실행하지 않았으며, controller의 실제 배포 상태는 별도로 확인해야 한다.** 현재 ops gateway의 제한된 Aurora `inventory-read-target`은 direct domain inventory/configuration target과 공존한다.

This runbook operates the Phase 1 Steampipe inventory sync. Phase 1 is implemented in the repository. **The agent making this change did not run Terraform apply; the controller's actual deployment status must be verified separately.** The ops gateway's limited Aurora `inventory-read-target` currently coexists with direct domain inventory/configuration targets.

**모든 DNS 변경 금지(ALLDNS)가 우선한다.** Steampipe는 Cloud Map에 등록되므로 최초 생성뿐 아니라
운영 중 limiter 튜닝·`fill_rate` 조정·이미지/task 교체·롤백·`steampipe_enabled=false`도
사설 DNS 등록/해제를 일으킬 수 있다. `service_registries`가 동일해도 `allow_dns_changes=false`
계획은 해당 ECS 변경을 차단한다. 사설 DNS 예외나 수동 ECS 명령으로 우회하지 않는다.
금지 중에는 로그·신선도 확인과 변경안 작성만 진행하고, DNS가 바뀌는 적용은 보류한다.
[배포 런북 §5](dev-repo-setup.md#5-deploy-while-dns-changes-are-deferred--dns-변경-보류-상태의-배포)를 따른다.

**ALLDNS takes precedence over this runbook's actions.** Steampipe registers with Cloud Map:
first creation, steady-state limiter/`fill_rate` tuning, image/task changes, rollback and
`steampipe_enabled=false` can register/deregister private DNS. The `allow_dns_changes=false`
gate blocks those ECS changes even when `service_registries` is unchanged. There is no private-DNS
exception or manual ECS bypass. While prohibited, inspect logs/freshness and prepare proposals;
defer DNS-changing applies. Follow [deployment runbook §5](dev-repo-setup.md#5-deploy-while-dns-changes-are-deferred--dns-변경-보류-상태의-배포).

## 1. 변수와 기본값 / Variables and defaults

| Terraform variable | Default | Allowed | Purpose |
|---|---:|---:|---|
| `steampipe_enabled` | `false` | boolean | false이면 Steampipe/sync 인프라와 비용이 0 / false creates no Steampipe/sync resources or cost |
| `steampipe_aws_max_concurrency` | 4 | integer 1–20 | global upstream concurrent-call limit |
| `steampipe_aws_bucket_size` | 4 | integer 1–40 | global burst capacity |
| `steampipe_aws_fill_rate` | 2 | 0.1–20 req/s | token-bucket refill rate |
| `steampipe_sync_reserved_concurrency` | 4 | integer 1–20 | inventory sync Lambda fan-out backpressure |
| `inventory_stale_after_minutes` | 30 | integer 1–1440 | inventory-reader and web graph source-age threshold; graph publication cadence is separate |

관련 고정 동작 / Related fixed behavior:

- EventBridge scheduled sync: `rate(15 minutes)`.
- EventBridge target delivery: maximum event age 900 seconds, zero retries.
- Lambda asynchronous self/manual invocation: maximum event age 900 seconds, zero retries.
- Generated config: exactly one unscoped `limiter "awsops_global"` shared across all rendered AWS connections.
- Manual inventory and security refreshes are admin-only and enqueue the same async Lambda path;
  they do not bypass its reserved concurrency.

## 2. 적용 전 검토 / Review before deployment

공유 인프라는 saved plan으로만 적용하며 `-auto-approve`를 사용하지 않는다. 그러나 이
변경에서는 **plan/apply 자체보다 Aurora migration이 먼저**다. Terraform이
`scripts/v2/steampipe/sync_lambda.py`를 패키징하여 `inv-sync` Lambda를 갱신하고, 새
running UPSERT는 migration이 추가하는 `inventory_sync_runs.run_token`을 요구하기
때문이다.

Apply shared infrastructure only from a saved plan and never use `-auto-approve`. For this
change, however, the Aurora migration must precede the plan/apply. Terraform packages
`scripts/v2/steampipe/sync_lambda.py` and updates the `inv-sync` Lambda, whose new running UPSERT
requires the `inventory_sync_runs.run_token` column created by the migration.

`make deploy`는 migration 뒤 **web ECS service만** build/push/roll하므로 이 Lambda의
배포 순서를 보장하지 않는다. 아래 순서를 만족할 수 없으면 새 Lambda를 배포하지 않는다.

`make deploy` migrates and then builds/pushes/rolls only the **web ECS service**; it does not
roll out this Lambda. If the order below cannot be satisfied, do not deploy the new Lambda.

## 3. limiter 구성 확인 / Inspect limiter configuration

정적 기본 파일은 `scripts/v2/steampipe/aws.spc`다. 실행 중 컨테이너는 Aurora account/Region scope를 읽어 기본 경로 `/home/steampipe/.steampipe/config/aws.spc`에 실제 구성을 생성한다.
The checked-in default is `scripts/v2/steampipe/aws.spc`. The running container reads Aurora account/Region scope and renders the actual configuration at `/home/steampipe/.steampipe/config/aws.spc`.

배포 전 렌더러 검증 / Validate the renderer before deployment:

```bash
python3 -m pytest scripts/v2/steampipe/test_spc_render.py -q
```

ECS Exec는 활성화하지 않는다. 시작 및 scope 재생성 때 컨테이너가 CloudWatch Logs에 남기는 `steampipe_limiter_config` JSON 이벤트로 effective 값을 확인한다.
Do not enable ECS Exec. Inspect the `steampipe_limiter_config` JSON event emitted to CloudWatch Logs at startup and scope regeneration.

```text
fields @timestamp, event, max_concurrency, bucket_size, fill_rate
| filter event = "steampipe_limiter_config"
| sort @timestamp desc
| limit 20
```

다음을 확인한다 / Confirm:

- renderer test가 `plugin "aws"`와 `limiter "awsops_global"`가 정확히 하나임을 검증한다 / the renderer test verifies exactly one `plugin "aws"` and one `limiter "awsops_global"`.
- `max_concurrency`, `bucket_size`, `fill_rate`가 approved Terraform values와 일치한다.
- renderer test가 `scope =` 부재를 검증한다. 계정·리전별 budget 증식이 아니라 하나의 global budget이어야 한다 / the renderer test verifies no `scope =`, preserving one global budget.

## 4. 배포 순서 / Deployment order

### 기존 활성 환경 / Existing environment (`steampipe_enabled=true`)

아래 ECS 적용 단계는 ALLDNS 중 실행할 수 없다. / The ECS apply steps below are blocked under ALLDNS.

1. 새 Steampipe ARM64 이미지를 기존 ECR repository에 build/push하되 ECS service를
   rolling하지 않는다.
2. 현재 foundation outputs를 사용해 `make migrate`를 실행하고 `run_token` migration이
   완료됐는지 확인한다.
3. 그 다음에야 새 Lambda package와 Steampipe task definition을 포함하는 saved Terraform
   plan을 생성·검토하고 controller-approved `apply tfplan`을 수행한다.
4. ECS Steampipe service가 stable이 될 때까지 기다린다.
5. bounded async path로 sync 하나를 trigger하고 freshness/lifecycle log를 확인한다.

1. Build/push the new ARM64 Steampipe image to the existing ECR repository without rolling the
   ECS service.
2. Run `make migrate` against the current foundation outputs and confirm the `run_token` migration
   is applied.
3. Only then create/review and controller-apply the saved Terraform plan that updates the Lambda
   package and Steampipe task definition.
4. Wait for the ECS Steampipe service to become stable.
5. Trigger one sync through the bounded asynchronous path and verify freshness/lifecycle logs.

```bash
# Step 1: build/push only; do not force a service deployment.
docker buildx build --platform linux/arm64 -f scripts/v2/steampipe/Dockerfile \
  -t <steampipe-ecr-uri>:<tag> --push scripts/v2/steampipe

# Step 2: schema first. This must complete before Terraform updates inv-sync.
make migrate

# Step 3: package/roll the Lambda and task definition only after migration.
terraform -chdir=terraform/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/foundation plan -out tfplan
# Controller-approved operation only:
terraform -chdir=terraform/foundation apply tfplan

# Step 4: use the current cluster and awsops-v2-steampipe service.
aws ecs wait services-stable \
  --cluster <ecs-cluster-name> \
  --services awsops-v2-steampipe \
  --region <region>

# Step 5: invoke one type through the existing bounded asynchronous path.
# Use the deployed inv-sync function name from Terraform output.
aws lambda invoke \
  --cli-binary-format raw-in-base64-out \
  --function-name <inv-sync-function> \
  --invocation-type Event \
  --payload '{"type":"ec2"}' \
  /tmp/awsops-inv-sync-response.json
```

### 최초 활성화 / First-time enablement

1. foundation/Aurora를 먼저 `steampipe_enabled=false`로 생성해 migration runner가 사용할
   outputs를 확보한다. 이 상태에서는 sync Lambda/event rule이 없어야 한다.
2. `make migrate`를 실행한다.
3. migration 뒤 repository-only saved target plan으로 Steampipe ECR repository만 생성한다.
   이 bootstrap apply는 Lambda, event rule, task definition, service를 만들지 않는다.
4. Steampipe ARM64 이미지를 생성된 repository에 build/push한다.
5. `steampipe_enabled=true`로 전체 saved plan을 새로 생성·검토하고 controller-approved
   `apply tfplan`을 수행한다.
6. service stability를 기다린 뒤 sync 하나를 trigger하고 freshness/log를 확인한다.

1. Create the foundation/Aurora first with `steampipe_enabled=false`, so the migration runner has
   valid outputs. No sync Lambda/event rule may exist in this state.
2. Run `make migrate`.
3. After migration, use a repository-only saved target plan to create only the Steampipe ECR
   repository. This bootstrap apply must not create the Lambda, event rule, task definition, or
   service.
4. Build/push the ARM64 Steampipe image to that repository.
5. Set `steampipe_enabled=true`, create/review a fresh full saved plan, and have the controller
   apply it.
6. Wait for service stability, trigger one sync, and verify freshness/logs.

```bash
# Preconditions: foundation/Aurora already exist with steampipe_enabled=false.
make migrate

# Repository-only bootstrap after migration; review the saved plan before applying it.
terraform -chdir=terraform/foundation plan \
  -target=aws_ecr_repository.steampipe \
  -var='steampipe_enabled=true' \
  -out tfplan-steampipe-ecr
# Controller-approved operation only:
terraform -chdir=terraform/foundation apply tfplan-steampipe-ecr

docker buildx build --platform linux/arm64 -f scripts/v2/steampipe/Dockerfile \
  -t <steampipe-ecr-uri>:<tag> --push scripts/v2/steampipe

# Now set steampipe_enabled=true in the reviewed configuration.
terraform -chdir=terraform/foundation plan -out tfplan
# Controller-approved operation only:
terraform -chdir=terraform/foundation apply tfplan
```

수동 UI refresh도 동일한 `InvocationType=Event` 경로와 Lambda reserved concurrency를 사용한다. 대량 refresh를 별도 병렬 호출로 우회하지 않는다.
Manual UI refresh uses the same `InvocationType=Event` path and Lambda reserved concurrency. Do not bypass it with a separate bulk parallel invocation.

## 5. 로그와 신선도 확인 / Check logs and freshness

CloudWatch Logs에서 다음 JSON event 이름을 조회한다:

- `steampipe_limiter_config` — effective `max_concurrency`, `bucket_size`, `fill_rate`.
- `inventory_sync_dispatch` — `type=all` fan-out 결과. `status=dispatched|partial|failed`,
  `queued_count`/`failed_count`, `queued_types`/`failed_types`만 포함하며 invoke exception
  text는 포함하지 않는다.
- `inventory_sync_complete` — full success이면 `degraded=false`, `freshness=healthy`, `age_minutes=0`; expected account 일부가 도달 불가한 partial이면 `degraded=true`, `freshness=degraded`, `age_minutes=null`, `unreachable_account_count`가 있고 account ID는 없다. SDK per-resource sub-call partial이면 `failure_count`와 safe `failure_types`만 있으며 stale row pruning과 snapshot replacement를 건너뛴다. `unknown_attribute_count`는 steady-state denial로 blind 처리된 attribute read 수이며, `status=succeeded` 여도 이 값이 0보다 크면 `freshness=degraded`로 공개되고 event의 `degraded` 플래그도 true가 된다(pruning과 `last_success_at`은 막지 않는다 — 2026-09-02 정정: 종전 문구의 `degraded=false` 유지 서술은 코드와 불일치했다).
- `inventory_sync_hydrate_fallback` — (2026-09-02, ADR-010 개정) 하이드레이트 컬럼을 실은 쿼리(현재 `iam_role.attached_policy_arns`)가 실패해 **하이드레이트 없는 폴백 재시도**로 넘어갔다는 뜻. 기본 인벤토리는 그대로 갱신되고(run `succeeded`) 하이드레이트 컬럼만 전 행에서 빠지며, 그 run의 `unknown_attribute_count`가 행 수로 기록되어 위 `succeeded+unknowns→degraded` freshness 공개 채널을 그대로 탄다. `remedy` 필드가 원인별 조치를 안내한다: statement timeout(전 계정 합산 role 수가 예산 초과 — 하이드레이트 예산 180s, 폴백 90s, Aurora 예약 120s, prune 단계 reachability probe는 건당 ≤30s로 모두 남은 Lambda 시간에 클램프) → 리미터 `fill_rate` 상향(0.1–20); SCP/IAM 거부 → `iam:ListAttachedRolePolicies` 권한 부여(rate 조정으로는 해결 불가).
  - `inventory_sync_hydrate_fallback` — (2026-09-02, ADR-010 amendment) a hydrate-carrying query (currently `iam_role.attached_policy_arns`) failed and the sync retried hydrate-free. The base inventory still refreshes (run `succeeded`) with only the hydrate column absent, and that run's `unknown_attribute_count` records the row count so the `succeeded+unknowns→degraded` freshness channel above discloses it. The `remedy` field is cause-specific: statement timeout (aggregate role count over budget — budgets split 180s hydrated / 90s fallback / 120s Aurora reserve, with prune-phase reachability probes ≤30s each, all clamped to remaining Lambda time) → raise the limiter `fill_rate` (0.1–20); SCP/IAM denial → grant `iam:ListAttachedRolePolicies` (rate tuning cannot fix a denial).
- `inventory_sync_busy` — `degraded=true`, `throttled=false`; 해당 type의 advisory lock이 이미 사용 중이며 retry storm을 만들지 않는다.
- `inventory_sync_failed` — `resource_type`, `elapsed_ms`, `error_category`, `error_type`, `degraded=true`, structured `throttled`; raw exception text는 로그에 쓰지 않는다.
  - `error_category=superseded`는 이 실행이 lock을 해제한 뒤 더 새 실행이 같은 ledger row를 교체했다는 뜻이다. stale finalizer는 새 row를 수정하지 않고 안전한 degraded failure 하나만 기록하며 run token/account ID를 로그에 쓰지 않는다.
  - `error_category=superseded` means a newer run replaced the singleton ledger row after this invocation released its lock. The stale finalizer leaves that newer row untouched, records one safe degraded failure, and logs neither the run token nor account IDs.

예시 Logs Insights query / Example Logs Insights query:

```text
fields @timestamp, event, resource_type, row_count, unreachable_account_count,
  unknown_attribute_count, elapsed_ms, degraded, throttled,
  freshness, age_minutes, error_category, error_type,
  max_concurrency, bucket_size, fill_rate
| filter event like /^inventory_sync_/ or event = "steampipe_limiter_config"
| sort @timestamp desc
| limit 100
```

Aurora에서 `inventory_sync_runs`는 resource type별 current-run ledger이며 `last_success_at`/`last_success_row_count`는 running/failed/partial 뒤에도 마지막 full success를 보존한다. 성공한 0-row 실행도 이 필드로 남는다. 각 allowed sync는 내부 non-secret opaque `run_token`을 running UPSERT에 저장하고, advisory unlock/main close 뒤의 fresh finalizer는 같은 token을 조건으로 둔 compare-and-set `UPDATE ... RETURNING`만 수행한다. 따라서 더 새 실행이 row를 교체하면 stale finalizer는 0 rows를 받고 새 상태를 덮어쓰지 않는다. reader는 durable `last_success_at`이 없으면 현재 partial row가 있어도 authoritative data로 보지 않는다. durable success가 있으면 effective timestamp는 `LEAST(last_success_at, COALESCE(oldest_captured_at,last_success_at))`이므로 preserved stale row나 오래된 success를 새 partial row가 가리지 못한다. `query_inventory`와 `inventory_summary`는 `healthy|degraded|stale|unavailable`, `last_success_at`, `last_success_row_count`, `oldest_captured_at`, backward-compatible `latest_success_at`, `age_minutes`를 공개한다. `inventory_summary.current_count`는 Aurora `inventory_resources`의 host/`self` 현재 row 수이고, 기존 `row_count`는 latest run ledger count로 유지된다.

In Aurora, `inventory_sync_runs` is the per-type current-run ledger; `last_success_at` and `last_success_row_count` preserve the latest full success across running/failed/partial attempts, including a successful zero-row inventory. Each allowed sync stores an internal, non-secret opaque `run_token` in the running UPSERT. After advisory unlock and main-connection close, the fresh finalizer performs only a compare-and-set `UPDATE ... RETURNING` for that token, so a stale finalizer gets zero rows and cannot overwrite a newer run. Without durable `last_success_at`, even current rows from a first partial run are not authoritative. With a durable success, the effective timestamp is `LEAST(last_success_at, COALESCE(oldest_captured_at,last_success_at))`, so neither newer partial rows nor a newer success can hide older retained data. `query_inventory` and `inventory_summary` disclose `healthy|degraded|stale|unavailable`, `last_success_at`, `last_success_row_count`, `oldest_captured_at`, backward-compatible `latest_success_at`, and `age_minutes`. `inventory_summary.current_count` is the current host/`self` row count from Aurora `inventory_resources`; the existing `row_count` remains the latest run-ledger count.

- `unavailable`: no durable last success, including a first failed/partial run with current rows.
- `stale`: effective data age is greater than `inventory_stale_after_minutes` (default 30).
- `degraded`: current status is `partial`, `failed`, or `running`, while effective data is still within the threshold — or current status is `succeeded` with `unknown_attribute_count` null or > 0.
- `healthy`: current status is `succeeded`, `unknown_attribute_count` is exactly 0, and effective data is within the threshold.

NULL means unmeasured coverage, including older runs; only a new measured sync can establish zero.
For zero-row Steampipe scans, the pinned AWS plugin v0.142.0 identity table is
`aws_<12-digit-account-id>.aws_sts_caller_identity`, not `aws_caller_identity`.
Exactly one row matching the requested account permits empty-account pruning and a successful
zero-row run. Missing, malformed, duplicate or mismatched identity rows and connection errors
keep the account unverified: the run remains partial and its last-good inventory, snapshot and
last-success fields remain intact. This verifies the same Steampipe connection's identity, not
every service/region read; it does not establish complete collection coverage.
The mandatory dev release synchronously collects every current catalog type and requires
complete post-marker success with known counts and zero unknown attributes for each type.
Hydrate fallback with unknown attributes blocks this gate, even when the producer records
`succeeded`. Partial, failed, stale, missing or unknown evidence cannot pass. Standalone
and release modes use the same strict data criteria; release mode changes only the bounded
collection wait. Runtime/model and both owned worker proofs remain mandatory. See the [release collection contract](runtime-foundation.md#collection-contention--수집-경합)
for the exact boundaries and single confirmed-contention retry.

`unknown_attribute_count`는 steady-state denial(예: SCP로 막힌 bucket의 PAB/policy-status/versioning/encryption/logging 읽기)로 blind 처리된 attribute read 수다. 이 값은 공개되는 freshness를 degrade시키지만 stale row pruning이나 durable `last_success_at`을 막지 않는다 — 하나의 denied bucket이 pruning을 영구히 비활성화하면 안 되기 때문이다. 반대로 transient 실패(throttle 등)로 일부 attribute가 unknown이 된 rec은 아예 upsert하지 않고 건너뛴다: upsert는 `sdk_partial`이 prune을 막기 *전에* 실행되므로, 쓰면 이미 알고 있던 값이 NULL로 덮이면서 `captured_at`은 최신으로 갱신된다. rec을 건너뛰면 counted failure가 run을 partial로 유지하고, 건너뛴 prune이 그 row의 last-known-good 내용을 그대로 보존한다. CloudFront VPC origin의 `get_distribution_config` 실패도 모든 row의 origin-ref 귀속을 불완전하게 만들므로 같은 이유로 rows 전체를 버린다.

`unknown_attribute_count` is the number of attribute reads blinded by steady-state denials (e.g. the PAB/policy-status/versioning/encryption/logging read on an SCP-denied bucket). It degrades the disclosed freshness but never blocks stale-row pruning or the durable `last_success_at` — one denied bucket must not disable pruning forever. Conversely, a rec whose attributes went unknown through a TRANSIENT failure (a throttle) is skipped rather than upserted: the upsert runs *before* `sdk_partial` gates the prunes, so writing it would null out previously-known fields while refreshing `captured_at` to now. Skipping the rec keeps the counted failure making the run partial, and the skipped prunes preserve that row's last-known-good content intact. A CloudFront VPC-origin `get_distribution_config` failure leaves origin-ref attribution incomplete for every row, so the whole row set is dropped for the same reason.

```sql
SELECT resource_type, status, finished_at, row_count,
       last_success_at, last_success_row_count, unknown_attribute_count
FROM inventory_sync_runs
WHERE account_id = 'self'
ORDER BY resource_type;

SELECT resource_type, account_id, region, min(captured_at) AS oldest_captured_at
FROM inventory_resources
GROUP BY resource_type, account_id, region
ORDER BY oldest_captured_at ASC;

SELECT resource_type, count(*)::integer AS current_count
FROM inventory_resources
WHERE account_id = 'self'
GROUP BY resource_type
ORDER BY resource_type;
```

`sql_reader.inventory_sync_runs`는 위 safe operational columns만 명시적으로 노출하며 `error` text와 내부 `run_token`을 노출하지 않는다.
`sql_reader.inventory_sync_runs` explicitly exposes only the safe operational columns above and never exposes `error` text or the internal `run_token`.

The limited ops `inventory-read-target` already returns explicit freshness for `query_inventory` and `inventory_summary`; it never silently falls back to a live API. Direct domain targets still coexist until Phase 2 expands Aurora coverage and retires them. Aurora-only is not live.

### Persisted identity counts

Sync `row_count` and per-account snapshots count unique persisted `(account_id, region, resource_id)` identities. Duplicate rows retain the existing last-row-wins value. For an attribute-hydration fallback, `unknown_attribute_count` uses that same post-filter/post-deduplication count, so duplicate join rows cannot inflate unknown attributes above the persisted population.

This uses ADR-021's persisted freshness-evidence basis; it changes no collection permission or release gate.

## 6. 안전한 튜닝 / Safe tuning

throttling, sync latency 증가 또는 service instability가 보이면 `max_concurrency`, bucket size,
fill rate 또는 reserved concurrency를 낮추는 변경안을 준비한다. **즉시 적용 가능한 예외가 아니다.**
Steampipe ECS를 변경하는 limiter 튜닝과 hydrate-fallback의 `fill_rate` 조치는 ALLDNS 중
차단된다. Lambda reserved concurrency만 바꾸더라도 전체 계획에 DNS 변경이 없는지 확인해야 한다.

When throttling, sync latency or instability increases, prepare lower concurrency/bucket/fill-rate
settings. **This does not authorize immediate application.** Limiter tuning and the hydrate-fallback
`fill_rate` remedy change Steampipe ECS and are blocked under ALLDNS. Even a Lambda-only reserved
concurrency change needs a whole-plan check showing no DNS changes.

**Raising a limit requires observed production headroom.** Increase only after evidence shows the current setting has sustained headroom without AWS throttling, increased sync age, Lambda throttles, or impact to production deployment/scaling operations. Change one control at a time, observe at least a full 15-minute cycle, and retain the prior values for rollback.

The values are safeguards, not assertions of universal AWS quotas; service, operation, account, and Region quotas differ.

## 7. 롤백 / Rollback

롤백은 파괴적 데이터베이스 변경 없이 이전 limiter defaults 또는 AgentCore catalog를 복원하는 방식이다.
Rollback restores prior limiter defaults or catalog state without destructive database changes.

ALLDNS 중에는 이전 limiter 값으로의 ECS 롤백도 보류한다.
사설 Cloud Map DNS 변경이므로 동일한 계획 게이트를 적용한다. 별도 DNS 승인 이후에만 새 계획을
검토하고 계획·적용 dispatch 양쪽에 `allow_dns_changes=true`를 명시한다. 금지 중에는 이 값을
실행하지 않으며 사설 DNS 예외를 추가하지 않는다.

Under ALLDNS, defer ECS rollback to prior limiter settings:
it can change private Cloud Map DNS and must pass the same gate. Only after separate DNS
authorization may a fresh reviewed plan and its apply dispatch **both** set
`allow_dns_changes=true`. Do not exercise that permission while ALLDNS is active or add a
private-DNS exception.

1. 런타임을 유지한 채 limiter/concurrency 또는 이미지 digest를 이전 검토 값으로 되돌린 계획을 만든다. [런타임 롤백](runtime-foundation.md#rollback--롤백)을 따르며 전체 종료는 별도 검토 절차가 필요하다.
2. controller-approved `apply tfplan`으로 적용한다.
3. 필요한 경우 현재 catalog를 유지한다. Phase 2 이후의 별도 catalog cutover가 있다면 이전 target set을 복원한다.
4. Aurora `inventory_resources`, `inventory_sync_runs`, 또는 migration을 삭제·truncate하지 않는다.
5. rollback 뒤 last successful sync와 로그를 확인하고 stale 상태를 사용자에게 명시한다.

Phase 1 alone does not retire any direct AgentCore target, so it has no AgentCore catalog rollback of its own.

Manual dev/preview deployment blocks listed core-runtime deletion/replacement/forget.
There is no retirement marker or supported teardown mode. Keep `steampipe_enabled=true`
for ordinary rollback and restore prior reviewed settings; destructive decommissioning
requires a separate reviewed procedure. This development guard does not apply to main.
수동 dev/preview 배포는 지정 핵심 런타임의 삭제·교체·forget을 차단한다. 종료 marker나
지원되는 teardown 모드는 없다. 일반 롤백은 `steampipe_enabled=true`와 서비스·데이터를
유지하고 이전 검토 설정을 복원한다. 파괴적 종료에는 별도 검토 절차가 필요하며
이 개발 환경 가드는 main에는 적용되지 않는다.

## Related

- ADR-021: `docs/decisions/021-quota-isolated-inventory-reads.md`
- Approved design: `docs/superpowers/specs/2026-08-31-steampipe-quota-safe-aurora-mcp-design.md`
- Renderer: `scripts/v2/steampipe/spc_render.py`
- Sync Lambda: `scripts/v2/steampipe/sync_lambda.py`
