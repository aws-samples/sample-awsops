# 05. AgentCore Agents — v2 Reference

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

**Provisioner:** `scripts/v2/agentcore/{catalog.py, provision.py}` — `catalog.py` holds
the 9 gateway names + the target tool schemas; `provision.py` does boto3 `list →
create/update` for Runtime, the 9 gateways, the target slices, Memory, and the Code
Interpreter, then writes ARNs to SSM and prints a per-resource diff report
(CREATED/EXISTS/UPDATED/ERR). `make migrate` must run FIRST — it creates the `awsops_sql_reader` role and syncs its password, and
`make agentcore` does neither; skipping it leaves `execute_sql` and `inventory-read` failing Data API
auth (see `docs/runbooks/agent-sql-reader.md`). Then `make agentcore` (via
`scripts/v2/agentcore.mjs`) builds +
pushes the **arm64** agent image, then runs the provisioner; `make agentcore SMOKE=1`
also invokes the runtime end-to-end. **Everything is gated by `agentcore_enabled`**
(default `false` → `count`/`for_each` = 0, a no-op).

**Terraform-owned parts** (`terraform/foundation/ai.tf`): dual-tier ECR
(`awsops-v2-agentcore`), the AgentCore IAM role (Runtime + gateways), the agent Lambda
role + the Lambda slices (`for_each` over `local.agent_lambdas` + `archive_file` + permission), 3 SSM placeholder
params (`ignore_changes = [value]`), and the web task-role SSM read grant. Control-plane
resources are **not** Terraform-native, so they live in `provision.py`.

**Config source of truth = SSM**, at `/ops/awsops-v2/agentcore/{runtime_arn,
interpreter_id, memory_id}`. The web BFF reads these at **runtime** via the task role —
**not** ECS `valueFrom** — to avoid a task-start race. Placeholders are written by
Terraform; `provision.py` overwrites with real values.

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
| `scripts/v2/agentcore.mjs` | `make agentcore` entry — build+push arm64 image → run provisioner |
| `scripts/v2/agentcore/catalog.py` | 9 gateway names + GW descriptions + target tool schemas |
| `scripts/v2/agentcore/provision.py` | Idempotent boto3 provisioner (Runtime/Gateways/Targets/Memory/Interpreter), SSM write, diff report, `--smoke` |
| `agent/agent.py` | Strands agent (reused as-is; receives `GATEWAYS_JSON`) |
| `agent/lambda/` | Agent tool Lambda sources — full fleet (30 slices; e.g. `aws_iam_mcp.py`, `flowmonitor.py`, connector lambdas, `cross_account.py`) |

## Status / 상태

**P1f ✅ — A7 GREEN** (historical milestone record — the provisioner's *first* verified
run, back when only the 2 bootstrap slices existed; see Current design above for the
fleet's present size).
- `provision` first run: 0 errors; smoke OK (runtime → security gateway → `list_roles` →
  real IAM data).
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
  `create_gateway_target` throw `ValidationException`. Resolved by re-running: the
  provisioner is idempotent and re-runnable.
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
