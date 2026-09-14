# 05. AgentCore Agents — v2 Reference

<!-- Legacy fragment anchors preserve incoming links; visible guidance is English. -->

The GitHub deploy job prepares its host provisioner with Python 3.12 and the hash-pinned `scripts/v2/agentcore/requirements-provision.txt` closure through `scripts/v2/ci/setup-provision-python.py`. Before credential setup or agent image work in that job, local preflight checks the provisioner's complete `ctrl` operation references, the runtime smoke operation, exact SDK versions and imports. This follows the separate private migration job. The owned SDK environment is cleaned afterward; package-cleanup warnings do not overwrite deployment results.

<a id="purpose--목적"></a>

## Purpose

The AI brain of AWSops v2: a Strands agent on **AgentCore Runtime** fronted by domain
**gateways** that expose read-only MCP tools, plus a **Memory** store and a **Code
Interpreter**. v2 replaces v1's hand-run CLI/`06*` scripts and `config.json` ARN
injection with a single **idempotent boto3 provisioner** driven from Terraform outputs,
with all config delivered through SSM.

<a id="current-design--현행-설계"></a>

## Current design

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

For CloudFront, optional `query_inventory.resource_id` performs a validated, parameterized
identity lookup (one row, no origins/aliases). Responses mark `projection=identity_only` and
echo the ID; omitted attributes are outside this projection. **Deployment gate:** first apply the
reviewed Terraform plan for the inventory Lambda, then run AgentCore deployment (`make agentcore`)
to update the gateway schema. `make agentcore` does not ship Lambda code. Schema-first rollout lets
the old Lambda ignore the ID and return an unmarked bulk list. Consumers must require
`projection=identity_only` and a matching echoed ID; missing/mismatched metadata means unverified,
never an exact result or absence proof. Existing sql_reader views/grants suffice; no mutation or migration is added.
A miss includes a fixed note directing readers to freshness/direct reads, not an AWS-absence verdict.

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

**Terraform-owned parts** (`terraform/foundation/ai.tf`): dual-tier ECR
(`awsops-v2-agentcore`), the AgentCore IAM role (Runtime + gateways), the agent Lambda
role + the Lambda slices (`for_each` over `local.agent_lambdas` + `archive_file` + permission), 3 SSM placeholder
params (`ignore_changes = [value]`), and the web task-role SSM read grant. Control-plane
resources are **not** Terraform-native, so they live in `provision.py`.

**Config source of truth = SSM**, at `/ops/awsops-v2/agentcore/{runtime_arn,
interpreter_id, memory_id}`. The web BFF reads these at **runtime** via the task role —
**not** ECS `valueFrom` — to avoid a task-start race. Placeholders are written by
Terraform; `provision.py` overwrites with real values.

<a id="decisions-adrs--결정"></a>

## Decisions (ADRs)

ADR bodies live in the private upstream repository; the paths below are reference identifiers,
not files in this public checkout.

- **ADR-004** — AgentCore gateways & runtime, incl. runtime-customizable agents & skills
  (Aurora catalog + resolver + registry-agnostic `agent.py`; built-in vs custom tiers;
  per-account Agent Spaces; BYO-MCP). `../decisions/004-agentcore-gateways-runtime.md`
- **ADR-004** — gateway role split (note the **2026-06-03 correction: 7 → 8 gateways**).
  `../decisions/004-agentcore-gateways-runtime.md`
- **ADR-003** — AI agent routing (hybrid routing & multi-route parallel synthesis; the
  classifier picks built-in routes + enabled custom agents).
  `../decisions/003-ai-agent-routing.md`
- **ADR-021** — quota-isolated inventory reads; Phase 1 repository implementation complete,
  limited ops Aurora reader coexists with direct targets, Phase 2/3 cutover pending.
  ADR-021 (private upstream decision)

<a id="key-files--핵심-파일"></a>

## Key files

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

<a id="status--상태"></a>

## Status

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

<a id="learnings--gotchas--학습함정"></a>

## Learnings & gotchas

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

<a id="source--출처"></a>

## Source

Consolidates three source docs (now archived):
- `docs/history/archive/2026-05-31-awsops-v2-p1f-agentcore-provisioner.md` (primary)
- `docs/history/archive/2026-05-31-custom-agents-skills-design.md`
- `docs/history/archive/2026-05-31-adr-031-phase1.md`

Review: `v2-p1f-scope-architecture-review` (private upstream repo)
(3-AI cross review — MID-minus scope decision, least-privilege roles, SSM-not-valueFrom).

<a id="deployment-readiness-mode--배포-검증-모드"></a>

## Deployment readiness mode

`agent/readiness.py` implements bounded, default-off `mode=deployment_readiness`. Before the
mandatory dev Deploy Web gate, explicitly apply `ci_readiness_enabled=true` with AgentCore
enabled, then provision. `CI_READINESS_ENABLED_DEV=true` supplies this separate opt-in in public dev CI.
Only the applied `agentcore.deployment_readiness_enabled` sets `DEPLOYMENT_READINESS_ENABLED`; shell overrides are ignored.
Fixed MCP tools read one CloudFront identity; producer freshness and bounded inference leave unknown attributes unassessed.
Nonce/account-bound responses retain completed checks on timeout; administrator or deployment-verifiers
membership, one in-flight request and a 60-second process cooldown are required. The owned synchronous
CloudFront probe must succeed with zero unknown attributes and produce a post-marker known record.
Capture fresh web-role SSM and nonce-bound AgentCore/model proof before the catalog wait. Durable
post-marker CloudFront success survives a later scheduled attempt; other catalog types require
last success within thirty minutes. Disclose current degradation with completeness `unknown`.
Both owned Lambda and Fargate jobs must succeed. See the
[collection contract](../runbooks/runtime-foundation.md#collection-contention--수집-경합).
An opt-in apply creates the verifier group only with readiness and AgentCore enabled; membership
additionally requires the managed demo flag. No admin/IAM role is granted. Public CI permits
readiness only on dev. CI_READINESS_ENABLED_DEV is a dedicated true/false override; empty/unset
preserves explicit Terraform configuration and default false. The runtime profile alone does not enable it.
The release controller verifies the group/membership; it does not provision them. Do not separately
create the Terraform-managed group. Adopt an existing group or managed-demo membership using the
[reviewed import procedure](../runbooks/runtime-foundation.md#adopting-an-existing-verifier-group--기존-검증-그룹-채택).
Use a fresh login after membership changes. Removing membership does not rewrite issued ID-token
group claims, which can persist for their remaining configured 12-hour lifetime unless session
revocation rejects them; [runtime disablement is independent](../runbooks/runtime-foundation.md#readiness-capability).
Web invocation validates the runtime ARN before caching; `PENDING` or malformed values fail.
Status discovery only extracts a runtime ID and does not perform that full ARN validation.
Both honor an explicitly empty `SSM_RUNTIME_ARN_PARAM`, which the web task receives when
AgentCore is disabled. The separate `AGENTCORE_RUNTIME_ARN_PARAM` alias and incident bridge's
literal project paths are unchanged; other control-plane status reads can still run.
