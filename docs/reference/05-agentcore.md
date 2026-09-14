# 05. AgentCore Agents — v2 Reference

The GitHub deploy job prepares its host provisioner with Python 3.12 and the hash-pinned `scripts/v2/agentcore/requirements-provision.txt` closure through `scripts/v2/ci/setup-provision-python.py`. Before credential setup or agent image work in that job, local preflight checks the provisioner's complete `ctrl` operation references, the runtime smoke operation, exact SDK versions and imports. This follows the separate private migration job. The owned SDK environment is cleaned afterward; package-cleanup warnings do not overwrite deployment results.

## Purpose / 목적

The AI brain of AWSops v2: a Strands agent on **AgentCore Runtime** fronted by domain
**gateways** that expose read-only MCP tools, plus a **Memory** store and a **Code
Interpreter**. v2 replaces v1's hand-run CLI/`06*` scripts and `config.json` ARN
injection with a single **idempotent boto3 provisioner** driven from Terraform outputs,
with all config delivered through SSM.

AWSops v2의 AI 두뇌: AgentCore **Runtime** 위의 Strands 에이전트를, 읽기 전용 MCP 도구를
노출하는 도메인 **게이트웨이**들이 감싸고, **Memory** 저장소와 **Code Interpreter**를 더한
구조. v2는 v1의 수동 CLI/`06*` 스크립트 + `config.json` ARN 손주입을 **멱등 boto3
provisioner** 하나로 대체하고, 모든 설정을 SSM으로 전달한다.

## Current design / 현행 설계

**Components (provisioned skeleton):**
- **AgentCore Runtime** — Strands; reuses `agent/agent.py` as-is. Gateway URLs are
  injected via a `GATEWAYS_JSON` env var (agent.py's documented discovery fallback —
  no awscli-in-image dependency). Runtime name `awsops_v2_agent` (underscores only).
- **9 section gateways** — `awsops-v2-{network,container,data,security,cost,monitoring,iac,ops,external-obs}-gateway`
  (**ADR-004 as amended 2026-06-24: 9 provisioned / 9 routed** — external-obs, hosting the
  Prometheus·ClickHouse connectors, was promoted from a provisioned-only slot into the routing
  set; the chat key `observability` aliases to it). **Integrations is the governance axis**
  (ADR-007/017) — its gated vendor-hosted MCP presets (Datadog·Dynatrace·New Relic,
  `official_mcp_enabled`) attach to the external-obs gateway as `mcpServer` targets when enabled. `monitoring` covers AWS-native monitoring;
  the external-obs plugin datasource registry / OTLP / datasource-diag re-home is the Integrations
  axis (P3).
- **Memory** — `awsops_v2_memory-*`, `eventExpiryDuration = 365` days.
- **Code Interpreter** — `awsops_v2_code_interpreter-*` (underscores only).

**Design target:** **9 section agents + 1 incident orchestrator** (the orchestrator is
P4). **Fleet state: complete** — 30 Lambda slices are defined in `ai.tf` `local.agent_lambdas`
(21 gated on `agentcore_enabled`, 9 on `integrations_enabled`; both flags default `false`,
so a fresh `plan` is a no-op). In the **live environment** (flags enabled) all 9 gateways
carry READY MCP targets and all 16 chat section keys are **registered and routable** — fleet
completed 2026-08-02. Note the runtime nuance (matches the customer deck's slide 12):
`aws-data` and the 6 collector keys currently fall back to standard `ops` routing because
the BFF-local live-Steampipe path is closed by design (ADR-001/010, `steampipeAvailable()`
hard-`false`); the 9 gateway-routed keys answer via their own agents.

**2026-08-31 rollout note (ADR-021):** Phase 1's quota guard, structured terminal state,
and freshness threshold are implemented in the repository. The agent making this change did not
run apply; controller deployment status must be verified separately. **Current truth is
coexistence: the ops gateway's limited Aurora-backed `inventory-read-target` is already present
alongside direct domain inventory/configuration control-plane targets.** `query_inventory` and
`inventory_summary` disclose per-type `healthy|degraded|stale|unavailable` using durable
last-success metadata and the oldest current row timestamp. A later failed/partial/running attempt
does not erase a genuine zero-row success, and preserved stale rows cannot be hidden by newer rows.
Phase 2 expands domain-aware Aurora coverage and retires direct targets after parity; Aurora-only
is not live. Phase 3 cache work is also pending.
ADR-005's mutation/autonomy FROZEN posture is unchanged.

**2026-08-31 롤아웃 노트(ADR-021):** Phase 1 쿼터 가드, structured terminal state,
freshness threshold는 저장소에 구현됐다. 이 변경을 수행한 에이전트는 apply를 실행하지
않았고 controller 배포 상태는 별도 확인한다. **현재 ops gateway의 limited Aurora
`inventory-read-target`이 direct domain inventory/configuration target과 공존한다.**
`query_inventory`와 `inventory_summary`는 durable last-success와 현재 row의 가장 오래된
수집 시각으로 type별 `healthy|degraded|stale|unavailable`을 공개한다. 이후
failed/partial/running 실행은 성공한 0-row 기록을 지우지 않으며 새 row가 preserved stale
row를 가리지 않는다. Phase 2가
domain-aware coverage를 확장하고 parity 뒤 direct target을 retirement하므로 Aurora-only는
아직 live가 아니다. Phase 3 cache도 pending이며 ADR-005 FROZEN은 바뀌지 않는다.

For CloudFront, optional `query_inventory.resource_id` performs a validated, parameterized
identity lookup (one row, no origins/aliases). Responses mark `projection=identity_only` and
echo the ID; omitted attributes are outside this projection. **Deployment gate:** first apply the
reviewed Terraform plan for the inventory Lambda, then run AgentCore deployment (`make agentcore`)
to update the gateway schema. `make agentcore` does not ship Lambda code. Schema-first rollout lets
the old Lambda ignore the ID and return an unmarked bulk list. Consumers must require
`projection=identity_only` and a matching echoed ID; missing/mismatched metadata means unverified,
never an exact result or absence proof. Existing sql_reader views/grants suffice; no mutation or migration is added.
A miss includes a fixed note directing readers to freshness/direct reads, not an AWS-absence verdict.

CloudFront의 선택적 `resource_id`는 검증·바인딩된 ID 한 행만 조회합니다. 응답은
identity-only projection과 ID를 명시하므로 속성 누락을 부재로 판단하지 않습니다.
먼저 검토한 Terraform 계획으로 Lambda를 배포하고, 이후 AgentCore 배포(`make agentcore`)로 Gateway
스키마를 갱신한다. 순서를 바꾸면 이전 Lambda가 ID를 무시하고 일반 목록을 반환할 수 있다.
클라이언트는 projection과 ID 일치를 확인하며 누락·불일치는 미확인으로 처리한다.
origin/alias는 이 projection에 없으며 기존 읽기 뷰/권한을 사용한다. AWS 변경·migration은 추가하지 않는다.
미발견 응답은 신선도·직접 조회를 확인하도록 명시하며 AWS에서 리소스가 없다는 뜻이 아닙니다.

**Provisioner:** `scripts/v2/agentcore/{catalog.py, provision.py, provision_report.py}` — `catalog.py` holds
the 9 gateway names + the target tool schemas; `provision.py` does boto3 `list →
create/update` for Runtime, the 9 gateways, the target slices, Memory, and the Code
Interpreter, then writes ARNs to SSM. Public output contains fixed stages/reason codes, catalog resource keys, status counts and an explicit dropped-event
count; no ARNs or raw errors. Migrations must run FIRST — they create the `awsops_sql_reader` role and sync its password, and
`make agentcore` does neither; skipping it leaves `execute_sql` and `inventory-read` failing Data API
auth (see [agent-sql-reader](../runbooks/agent-sql-reader.md)). Dev's workflow reuses the private migration task; main/preview retain `make migrate`. The dev workflow uses `node scripts/v2/agentcore.mjs --build-only`, refreshes the SAME OIDC role, then calls `--provision-only` with the
verified project/digest. The second phase rechecks the commit tag/digest without rebuilding. Fresh sessions and aggregate phase deadlines keep each phase inside one hour. Other stacks keep `make agentcore`; `SMOKE=1` checks after
provisioning. Before dev workflow dispatch, set `CI_MIGRATIONS_ENABLED_DEV=true` and apply a reviewed plan with `ci_migrations_enabled=true`, producing a non-null `migration_job` output. This private-migration prerequisite also applies when smoke is off. The configured dev build role
needs push/BatchGetImage access to the selected `${project}-steampipe` or `${project}-worker` repository; the dev deployer needs those actions on `${project}-agentcore`. Web-only ECR grants do not establish this access. See [CI ECR
scopes](../runbooks/dev-repo-setup.md#4-ecr-permissions-for-the-pin-step--ci-deployer-ecr-권한); the workflows check access but do not grant it.

Dev smoke requires the matching readiness producer and `runtime_deployment` output with inventory enabled; these producer dependencies must land before selecting smoke. The applied `agentcore.deployment_readiness_enabled` output must also be boolean true. The provisioner
maps it to `DEPLOYMENT_READINESS_ENABLED`; missing/false keeps the probe disabled, even if an ambient environment variable says true. Other stacks retain advisory compatibility invocation when readiness is unavailable, and advisory structured
checks when available. Invocation transport failures still fail. **AgentCore foundation resources require `agentcore_enabled`** (default `false` → `count`/`for_each` = 0, a no-op). The dev CI migration task has its own default-off `ci_migrations_enabled` gate.

The structured check traverses the Ops inventory tools and the model through the producer. It accepts one SSE payload (optional data spacing, event/id/comments and `[DONE]`), checks nonce/account and fixed booleans, and
retains a count protocol cap of 500. The current exact lookup reports zero or one identity match; success requires a positive count. `ageMinutes` is bounded to 0–1440 for validation; freshness comes from the MCP producer's `stale_after_minutes`
classifier, not a hard 15-minute client threshold. This optional CLI smoke is not the full web/worker release gate or a Memory/Code Interpreter test.

공개 provisioning 출력은 고정 단계/코드·catalog key·상태별 개수와 dropped 개수만 보존한다. dev는 사설 migration을 재사용하며 main/preview는 `make migrate`를 먼저 실행한다. dev 실행 전 `CI_MIGRATIONS_ENABLED_DEV=true`와 검토된 `ci_migrations_enabled=true` 계획을 적용해 `migration_job` 출력이 null이 아니어야 한다. smoke를 꺼도 필수다. dev build 역할은 선택한 `${project}-steampipe`·`${project}-worker`, dev
deployer는 `${project}-agentcore`에 push·BatchGetImage 권한이 필요하다. web 전용 권한으로는 충분하지 않으며 상세 범위는 CI ECR 절차를 따른다. 워크플로는 접근을 검사하고 IAM은 변경하지 않는다. dev는 `--build-only` 이후 동일 OIDC 역할을 새로 받아 `--provision-only`에 검증된 project/digest를 전달한다. 재빌드 없이 커밋 태그/digest를 다시 확인하며 각 단계는 새 1시간
세션 안의 전체 deadline으로 제한한다. `SMOKE=1`은 provisioning 후 실행한다. dev는 대응 producer·`runtime_deployment`·활성 inventory가 필요하고, 다른 스택은 참고용 호환 검사를 유지한다. 전송 실패는 계속 실패한다. 적용된 `agentcore.deployment_readiness_enabled` 출력도 boolean true여야 한다. provisioner가 이를 `DEPLOYMENT_READINESS_ENABLED`로 전달하며, 누락·false는 주변 환경변수가 true여도
검증 모드를 비활성화한다. 구조화 검사는 Ops inventory 도구와 모델을 거치며 SSE payload 하나·nonce/계정·고정 boolean을 검증한다. count의 프로토콜 상한은 500이지만 현재 정확한 ID 조회는 0 또는 1개 일치를 반환하며, 성공에는 양수 count가 필요하다. ageMinutes 0–1440은 검증 범위다. 실제 freshness는 MCP의 `stale_after_minutes`
분류를 따르며 15분 하드코딩이 아니다. 전체 웹/워커 배포 gate나 Memory/Code Interpreter 기능 검증을 대신하지 않는다.

**Terraform-owned parts** (`terraform/foundation/ai.tf`): dual-tier ECR
(`awsops-v2-agentcore`), the AgentCore IAM role (Runtime + gateways), the agent Lambda
role + the Lambda slices (`for_each` over `local.agent_lambdas` + `archive_file` + permission), 3 SSM placeholder
params (`ignore_changes = [value]`), and the web task-role SSM read grant. Control-plane
resources are **not** Terraform-native, so they live in `provision.py`.

**Config source of truth = SSM**, at `/ops/awsops-v2/agentcore/{runtime_arn,
interpreter_id, memory_id}`. The web BFF reads these at **runtime** via the task role —
**not** ECS `valueFrom` — to avoid a task-start race. Placeholders are written by
Terraform; `provision.py` overwrites with real values.

## Provisioner reconciliation

Before upgrading, verify that the operator-owned deployer has
`bedrock-agentcore:GetGateway` as described in the
[deployment role prerequisites](../runbooks/dev-repo-setup.md#4-ecr-permissions-for-the-pin-step--ci-deployer-ecr-권한).
Existing gateways are read in full before reconciling the applied role and catalog description. Updates preserve
deployed inbound auth/protocol and optional security settings; absent optional
protocol fields are omitted, never invented from create-time defaults. Known IDs
remain available to Runtime routing, pruning and all ADR-017 teardown paths after
read/update failures. Description-only request failures remain warnings.

Role verification is functional, even when the listed description already matches:
a matching label cannot prove that the gateway uses the applied role. Any failed
`GetGateway` request, including a throttle or timeout, therefore records `ERR` and
makes the run exit nonzero while retaining the known ID and baseline teardown.
This does not claim that role drift was observed; it reports that reconciliation
could not be verified. Only after a successful read confirms the role may a
description-only update failure be reported as `WARN`. The old description-only
path's warning policy does not establish a role-verification success.

Lambda target drift covers the applied Lambda ARN, managed credential-provider
type and tool definitions (`name`, `description`, `inputSchema`). Target metadata
and private endpoints are preserved. No new gateway/target wait or automatic
state-based recovery is added. `CREATED`/`UPDATED` mean request acceptance;
`EXISTS` means configuration match. None proves readiness or tool invocation.
Existing Runtime and curated MCP-target readiness/retirement behavior remains.

Runtime construction and ADR-017 enforcement keep their baseline behavior.
There is no new identity-completeness gate or retirement exemption. Explicit
disabled/blocked endpoints, revoked acknowledgments, missing credentials and
tombstones still retire on known gateways; an unconfirmed allowlist-carrying
Runtime still invokes the existing fail-closed retirement policy.

Validation/conflict/not-found/SDK-validation failures have fixed public codes;
raw messages, configuration, credentials and ARNs are not emitted. An old
`operation_failed` record cannot establish its original cause. A persistent
`FAILED` state requires authorized read evidence and operator-approved repair;
the provisioner never automatically deletes/recreates it. Normal configuration
drift may submit an update, with service rejection reported safely.

Offline tests need pytest and the SDK dependencies declared in
`scripts/v2/requirements-test.txt` and `agent/requirements.txt`. Run each file in
its own process, as required by [merge verification](../v2-merge-verification.md):

```bash
for test_file in scripts/v2/agentcore/test_*.py; do
  python3 -m pytest -q "$test_file" || exit
done
python3 -m pytest -q scripts/v2/ci/test_setup_provision_python.py
python3 scripts/v2/ci/runtime-build-provision.test.py
```

API contracts: [UpdateGateway](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_UpdateGateway.html)
and [UpdateGatewayTarget](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_UpdateGatewayTarget.html).

## Decisions (ADRs) / 결정

- **ADR-004** — AgentCore gateways & runtime, incl. runtime-customizable agents & skills
  (Aurora catalog + resolver + registry-agnostic `agent.py`; built-in vs custom tiers;
  per-account Agent Spaces; BYO-MCP). [`../decisions/004-agentcore-gateways-runtime.md`](../decisions/004-agentcore-gateways-runtime.md)
- **ADR-004** — gateway role split (note the **2026-06-03 correction: 7 → 8 gateways**).
  [`../decisions/004-agentcore-gateways-runtime.md`](../decisions/004-agentcore-gateways-runtime.md)
- **ADR-003** — AI agent routing (hybrid routing & multi-route parallel synthesis; the
  classifier picks built-in routes + enabled custom agents).
  [`../decisions/003-ai-agent-routing.md`](../decisions/003-ai-agent-routing.md)
- **ADR-021** — quota-isolated inventory reads; Phase 1 repository implementation complete,
  limited ops Aurora reader coexists with direct targets, Phase 2/3 cutover pending.
  ADR-021 (private upstream decision)

## Key files / 핵심 파일

| File | Role |
|------|------|
| `terraform/foundation/ai.tf` | TF-owned ECR/IAM/Lambda-slice/SSM/web-grant (gated on `agentcore_enabled`) |
| `scripts/v2/agentcore.mjs` | Dev build-only/provision-only phases with verified digest handoff; legacy `make agentcore` elsewhere |
| `scripts/v2/agentcore/catalog.py` | 9 gateway names + GW descriptions + target tool schemas |
| `scripts/v2/agentcore/provision.py` | Idempotent provisioner, SSM writes and post-provision smoke (strict on dev; advisory elsewhere) |
| `scripts/v2/agentcore/provision_report.py` | Fixed stage/error codes, catalog keys and bounded status counts; no raw resource/error output |
| `scripts/v2/ci/runtime-build.mjs` | Dev account checks, BatchGetImage repository preflight, bounded ARM64 build/push and digest verification |
| `agent/agent.py` | Strands agent (reused as-is; receives `GATEWAYS_JSON`) |
| `agent/lambda/` | Agent tool Lambda sources — full fleet (30 slices; e.g. `aws_iam_mcp.py`, `flowmonitor.py`, connector lambdas, `cross_account.py`) |

## Status / 상태

**P1f ✅ — A7 GREEN** (historical milestone record — the provisioner's *first* verified
run, back when only the 2 bootstrap slices existed; see Current design above for the
fleet's present size).
- `provision` first run: 0 errors; historical smoke invoked runtime → security gateway →
  `list_roles`. This historical record is not the current structured-readiness contract.
- Idempotent re-run: every resource `EXISTS`, Runtime `UPDATED` (the update path
  re-passes `roleArn` + `networkConfiguration` — proves the v1 quirk is handled, not a
  ConflictException).
- Intentional schema drift re-run: `update_gateway_target` (`UPDATED ... (schema drift)`)
  — a reconciliation path v1 never had.

Skeleton first verified (P1f) with 9 gateways incl. `awsops-v2-external-obs-gateway`,
runtime ARN + memory id in SSM (not `PENDING`) and an initial 2-slice `lambda_arns =
[iam-mcp, flow-monitor]`; the fleet has since grown to the full 30 slices (2026-08-02).

## Learnings & gotchas / 학습·함정

- **SSM reserved prefix** — SSM rejects any parameter path starting with `aws…`
  (reserved). Use `/ops/${project}/…` (hence `/ops/awsops-v2/agentcore/*`).
- **Gateway not yet READY** — a just-created gateway can make the first
  `create_gateway_target` throw `ValidationException`. Confirm `READY` through an
  authorized read, then re-run the idempotent provisioner. Persistent `FAILED`
  states require diagnosis; request acceptance is not readiness and does not
  authorize destructive recreation.
- **Underscore-only names** — Code Interpreter and Memory names allow underscores only,
  no hyphens (`awsops_v2_code_interpreter`, `awsops_v2_memory`).
- **Memory expiry** — `eventExpiryDuration` ≤ 365 days.
- **Runtime update** — must re-pass `roleArn` + `networkConfiguration` on every update.
- **Name collision avoidance** — gateways were renamed from v1's `awsops-{key}` to
  `awsops-v2-{key}-gateway` to isolate from v1 in the shared account.

**P3 backlog (DO NOT implement — list only; struck items shipped since):**
- ~~Full Lambda tool fleet~~ (shipped 2026-08-02)
- `section = routing`
- Right-docking chat UI
- OpenCost setup = a **read-only out-of-band install bundle** the operator runs (AWS-resource mutation stays FROZEN, ADR-005) — NOT an in-app mutating action

## Source / 출처

Consolidates three source docs (now archived):
- `docs/history/archive/2026-05-31-awsops-v2-p1f-agentcore-provisioner.md` (primary)
- `docs/history/archive/2026-05-31-custom-agents-skills-design.md`
- `docs/history/archive/2026-05-31-adr-031-phase1.md`

Review: `v2-p1f-scope-architecture-review` (private upstream repo)
(3-AI cross review — MID-minus scope decision, least-privilege roles, SSM-not-valueFrom).

## Deployment readiness mode / 배포 검증 모드

`agent/readiness.py` implements bounded, default-off `mode=deployment_readiness`. Apply `ci_readiness_enabled=true` with AgentCore enabled, then provision.
Only the applied `agentcore.deployment_readiness_enabled` sets `DEPLOYMENT_READINESS_ENABLED`; shell overrides are ignored.
Fixed MCP tools read one CloudFront identity; producer freshness and bounded inference leave unknown attributes unassessed.
Nonce/account-bound responses retain completed checks on timeout; admin or separately provisioned deployment-verifiers and process cooldown are required.
Invocation discovery rejects PENDING/malformed ARNs before caching and stops on an explicitly empty runtime parameter.

기본 비활성 모드이며 `ci_readiness_enabled=true`를 적용한 output으로 프로비저닝합니다. 환경변수 덮어쓰기는 무시하고 MCP 지정 ID·원본 신선도·제한된 모델 요청만 사용합니다.
누락 속성은 미평가이며 타임아웃에도 완료 증거를 보존합니다. 관리자/별도 verifier와 호출 간격이 필요하고 PENDING·잘못된 ARN은 캐시하지 않으며 빈 런타임 경로는 호출 조회를 비활성화합니다.
