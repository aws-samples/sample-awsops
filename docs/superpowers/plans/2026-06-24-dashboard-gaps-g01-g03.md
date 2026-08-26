# Plan — Dashboard Parity Gaps g-01 / g-02 / g-03 (read-only)

> **머지 시점 정정 (2026-06-24)**: g-01(`ecs_service`)은 동시 세션이 base(`feat/v2-architecture-design`)에
> 먼저 구현·머지했다(cluster+service 합성 키 `service_key` 방식 — 본 계획의 ARN 키와 동일한 충돌을 다르게 해결).
> 충돌 해소 시 **base의 ecs_service를 채택**하고 본 브랜치의 ecs_service 중복은 제거했다. 따라서 이 브랜치의
> 순수 net-new는 **g-02(`ebs_snapshot`) + g-03(CVE 결정 문서)**이다. 아래 Task 1·2(g-01)는 이력 보존용이다.

> 원천 / Source: `docs/reviews/2026-06-24-v1-v2-gap-audit.md` + `docs/plans/2026-06-22-phase3-gap-backlog.md`.
> Scope: 우선순위순 read-only 대시보드 갭 — g-01 (P0 ECS service inventory), g-02 (P1 EBS snapshot inventory), g-03 (P1 container CVE scanner **decision-only**).
> Constraints: **read-only only**. AWS resource mutation/autonomy = ADR-005 FROZEN — out of scope. Edits path-scoped to v2 (`web/`, `scripts/v2/`, `docs/`). v1 `src/` untouched. Branch `feat/v2-dashboard-gaps` (isolated worktree).

## Mechanism recap (why these are small)
v2 inventory is registry-driven: a resource type is added by (a) a `QUERIES` entry in
`scripts/v2/steampipe/sync_lambda.py` (Steampipe SQL → `inventory_resources`), and (b) an
`INVENTORY_TYPES` entry + nav placement in `web/lib/inventory-types.ts`. The generic
`/inventory/[type]` page and `/api/inventory/[type]` route render any registered type. No new
page/route/terraform is required — both g-01 and g-02 are read-only Steampipe-sourced types.
`inventory-types.test.ts` hardcodes the type count (31) and ECS subgroup membership, so those
assertions move with each addition.

### Conventions verified against the current code (from the P2 consensus gate)
- `columns[]` is a **curated subset** for the table view — the page prepends `resource_id`
  (= the type's id_col), so the id_col is **omitted** from `columns[]` (cf. `ecs_cluster`
  omits `cluster_name`). Full synced fields still live in the `data` jsonb for the detail panel.
- There is **no `iconKind` map** in `inventory-types.ts` — do NOT add one (NavLeaf has no icon field).
- `LAYOUTS` (the `layoutOf` archetype map, ~line 401) and `HIGHLIGHTS` (~line 331) are optional
  per type (unmapped → `'directory'`; no HIGHLIGHTS → generic state tiles) — **not** build-breaking,
  but we add explicit entries for parity UX (this is the whole point of g-01: surface
  desired/running/pending). The `every risk-archetype type has a danger highlight` test only
  constrains `'risk'` types; the new types are `'chart'`/`'capacity'`, so no danger highlight is required.
- `_ALLOWED = set(QUERIES) | set(SDK_SYNCS)` auto-includes new `QUERIES` keys (no extra edit).

## Out of scope / FROZEN guardrails
- No AWS resource mutation, no autonomy, no remediation enablement (ADR-005 FROZEN).
- No flag flips (`steampipe_enabled` etc. unchanged); new types sync only when inventory sync already runs.
- No edits to `terraform/foundation/ai.tf`, `remediation*.py`, datasource-diag files (concurrent-session WIP).
- v1 `src/` untouched.

### Task 1: g-01 sync — ecs_service Steampipe query (test-first)

**Files:**
- Create: `scripts/v2/steampipe/test_sync_inventory_additions.py`
- Modify: `scripts/v2/steampipe/sync_lambda.py`

Add a read-only `ecs_service` type to the inventory sync so the dashboard can show ECS service
`desired/running/pending` counts and launch type (v1 parity gap g-01).

- [ ] Write `test_sync_inventory_additions.py`: assert `"ecs_service" in sync_lambda.QUERIES`, `"ecs_service" in sync_lambda._ALLOWED`; the SQL string references `aws_ecs_service` and selects `desired_count`, `running_count`, `pending_count`, `launch_type`, `status`; id_col == `"service_name"`, region_col == `"region"`.
- [ ] Add to `QUERIES`: `SELECT service_name, region, account_id, arn, cluster_arn, status, desired_count, running_count, pending_count, launch_type, task_definition, scheduling_strategy, created_at, tags FROM aws_ecs_service ORDER BY service_name` with id=`service_name`, region=`region`. (Use only columns confirmed present on Steampipe `aws_ecs_service`; drop any that error.)
- [ ] Run `python3 -m pytest scripts/v2/steampipe/test_sync_inventory_additions.py -q` → green.
- [ ] Commit: `feat(inventory): sync ecs_service (desired/running/pending/launch_type) [g-01]`

### Task 2: g-01 web — ecs_service InvType + ECS nav subgroup (test-first)

**Files:**
- Modify: `web/lib/inventory-types.test.ts`
- Modify: `web/lib/inventory-types.ts`

Register the `ecs_service` inventory type and place it in the Compute > ECS nav subgroup.

- [ ] Update `inventory-types.test.ts`: bump every `31` to `32` (the `has the 31 wave types` **description string**, the `toBe(31)` count, the `placed.length` `toBe(31)`, and the `— 31 total` comment); change the ECS subgroup assertion to `['ecs_cluster', 'ecs_service', 'ecs_task']`; add `expect(keys).toContain('ecs_service')`.
- [ ] Add `ecs_service` to `INVENTORY_TYPES` (group `Compute`, stateKey `status`, distKey `launch_type`, columns: `status`, `desired_count`, `running_count`, `pending_count`, `launch_type`, `cluster_arn` — **omit `service_name`**, it is the id_col/resource_id).
- [ ] Add `ecs_service: 'chart'` to `LAYOUTS` (next to `ecs_cluster`), and a `HIGHLIGHTS.ecs_service` entry: `[{kind:'sum',label:'Desired',col:'desired_count'},{kind:'sum',label:'Running',col:'running_count'},{kind:'sum',label:'Pending',col:'pending_count'},{kind:'distinct',label:'런치타입',col:'launch_type'}]`.
- [ ] Add `'ecs_service'` to the ECS subgroup `types` array in `navTree()` (between `ecs_cluster` and `ecs_task`). No iconKind — that map does not exist.
- [ ] Run `cd web && npx vitest run lib/inventory-types.test.ts` → green.
- [ ] Commit: `feat(inventory): ecs_service type + ECS nav subgroup + highlights [g-01]`

### Task 3: g-02 sync — ebs_snapshot Steampipe query (test-first)

**Files:**
- Modify: `scripts/v2/steampipe/test_sync_inventory_additions.py`
- Modify: `scripts/v2/steampipe/sync_lambda.py`

Add a read-only `ebs_snapshot` type (account-owned snapshots only) — v1 parity gap g-02.

- [ ] Extend the test: assert `"ebs_snapshot" in sync_lambda.QUERIES` and `_ALLOWED`; SQL references `aws_ebs_snapshot` and `aws_caller_identity` (the owner pushdown guard) and selects `volume_id`, `volume_size`, `state`, `encrypted`, `start_time`; id_col == `"snapshot_id"`.
- [ ] Add to `QUERIES`: `SELECT snapshot_id, region, account_id, arn, volume_id, volume_size, state, progress, encrypted, start_time, description, owner_id, tags FROM aws_ebs_snapshot WHERE owner_id = '{account_id}' ORDER BY start_time DESC` with id=`snapshot_id`, region=`region`. **The `owner_id` qual must be a LITERAL constant** so Steampipe pushes `OwnerIds=self` down to `DescribeSnapshots`; without it Steampipe fetches every public AWS snapshot (throttle/OOM). A subquery (`(SELECT account_id FROM aws_caller_identity)`) or bound param is evaluated post-fetch by the FDW and does **NOT** push down (adversarial-review finding). `sync()` renders the `{account_id}` placeholder via `_inject_account(sql, _caller_account())` — STS-resolved, 12-digit-validated literal.
- [ ] Run pytest → green.
- [ ] Commit: `feat(inventory): sync ebs_snapshot (account-owned) [g-02]`

### Task 4: g-02 web — ebs_snapshot InvType + Storage nav (test-first)

**Files:**
- Modify: `web/lib/inventory-types.test.ts`
- Modify: `web/lib/inventory-types.ts`

Register the `ebs_snapshot` inventory type in the Storage group, adjacent to `ebs_volume`.

- [ ] Update `inventory-types.test.ts`: bump `32`→`33` (the `toBe` count, `placed.length`, and the description/comment prose); assert `ebs_snapshot` placed in the Storage group.
- [ ] Add `ebs_snapshot` to `INVENTORY_TYPES` (group `Storage & DB`, stateKey `state`, distKey `state`, columns: `volume_id`, `volume_size`, `state`, `progress`, `encrypted`, `start_time`, `description` — omit `snapshot_id`, it is the id_col).
- [ ] Add `ebs_snapshot: 'capacity'` to `LAYOUTS` (next to `ebs_volume`), and `HIGHLIGHTS.ebs_snapshot`: `[{kind:'sum',label:'총 용량',col:'volume_size',suffix:' GB'},{kind:'countWhere',label:'완료',col:'state',eq:'completed',tone:'accent'},{kind:'countWhere',label:'미암호화',col:'encrypted',eq:'false',tone:'danger'},{kind:'distinct',label:'볼륨 수',col:'volume_id'}]`.
- [ ] Place `ebs_snapshot` next to `ebs_volume` in the Storage nav group. No iconKind.
- [ ] Run `cd web && npx vitest run lib/inventory-types.test.ts` → green.
- [ ] Commit: `feat(inventory): ebs_snapshot type + Storage nav + highlights [g-02]`

### Task 5: g-03 decision — container CVE scanner recommendation (design-only, no code)

**Files:**
- Create: `docs/reviews/2026-06-24-container-cve-scanner-decision.md`

Document a read-only scanner decision to replace v1 Trivy/Steampipe CVE data. **No code, no
enablement, no terraform** — a decision input for owner review under ADR-007 governance.

- [ ] Write the KO/EN decision doc: recommend **ECR enhanced scanning (Amazon Inspector)** — API-pull (Steampipe `aws_ecr_image_scan_finding` / Inspector2 ListFindings), zero in-cluster agent, read-only. Sketch the future `ecr_image_finding` inventory type (repo, image_digest, severity, cve_id, package, fix_available) and the sync path.
- [ ] State explicitly: **NOT enabling anything in this PR**; requires owner approval + ADR-007 governance + (if a new flag) a gated terraform change before implementation.
- [ ] Commit: `docs(decision): container CVE scanner = ECR enhanced scanning recommendation [g-03]`
