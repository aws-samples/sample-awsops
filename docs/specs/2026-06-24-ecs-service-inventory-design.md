# ECS Service Inventory P0 Design

> Date: 2026-06-24
> Scope: v2 P0 gap `g-01` from `docs/plans/2026-06-22-phase3-gap-backlog.md`
> Posture: read-only inventory parity. No AWS resource mutation, autonomy, or arbitrary AWS CLI execution.

## Goal / 목표

Implement the missing v2 ECS service inventory slice so operators can inspect ECS services with
desired/running/pending counts and launch type, matching the v1 parity gap without expanding the
scope into remediation or topology changes.

v2에 누락된 ECS 서비스 인벤토리를 추가한다. 운영자는 ECS 서비스의 desired/running/pending 수와 launch type,
status, cluster/task-definition context를 `/inventory/ecs_service`에서 볼 수 있어야 한다.

## Chosen Approach / 선택안

Use the focused P0 slice:

1. Add `ecs_service` to the Steampipe-backed inventory sync.
2. Register `ecs_service` in the web inventory type catalog and Compute > ECS sidebar subgroup.
3. Update the AgentCore inventory-read tool description so `query_inventory` advertises the new type.
4. Add focused tests for registry placement, highlight/layout validity, and MCP catalog/tool text.

Backend-only sync is insufficient because the user-facing P0 gap remains invisible. Topology expansion is
deferred because it adds graph semantics beyond the documented P0.

## Architecture / 아키텍처

The implementation reuses the existing D1 inventory path:

`scripts/v2/steampipe/sync_lambda.py` queries `aws_ecs_service`, then upserts rows into
`inventory_resources` with `resource_type='ecs_service'`. No schema migration is needed because
`inventory_resources.data` already stores type-specific JSONB.

`web/lib/inventory-types.ts` adds `ecs_service` metadata. The generated inventory route
`/api/inventory/[type]` and page `/inventory/[type]` already validate against `INVENTORY_TYPES`, so
the new page appears by catalog registration alone.

`service_key` (`cluster_arn || '/' || service_name`) is the resource id. This avoids depending on a
non-v1 `service_arn` column and prevents same-named services in different clusters from colliding, including
legacy short-ARN accounts.

## Data Shape / 데이터

The sync query should select only read-only service fields:

- `service_key`, `service_name`, `cluster_arn`, `region`, `account_id`
- `status`, `desired_count`, `running_count`, `pending_count`
- `launch_type`, `scheduling_strategy`
- `task_definition`, `created_at`, `tags`

The inventory page columns prioritize operational scan fields: service name, status, desired/running/pending,
launch type, scheduling strategy, cluster ARN, task definition, and created time.

## Error Handling / 오류 처리

The sync follows the existing inventory error path. If the Steampipe query fails, `inventory_sync_runs` for
`ecs_service` is marked `failed`, the error is truncated, and existing rows are not silently treated as fresh.
Unknown type handling remains unchanged.

The web page degrades like existing inventory pages: missing rows render as empty data, failed API calls show
the page-level error, and refresh uses the existing Lambda invoke path.

## Testing / 검증

Focused verification:

- `web/lib/inventory-types.test.ts`: `ecs_service` is registered, placed exactly once under Compute > ECS
  between clusters and tasks, has valid state/dist keys, and resolves to a valid layout.
- `agent/lambda/test_inventory_read_mcp.py`: `query_inventory` can return `ecs_service` rows and binds the
  resource type as a parameter.
- `agent/lambda/test_inventory_read_mcp.py`: catalog wiring coverage verifies the AgentCore
  `inventory-read-target` advertises `ecs_service` as an inventory type.
- Existing web build/tests confirm the generated inventory route and page still type-check.

Manual command set after implementation:

```bash
(cd web && npx vitest run lib/inventory-types.test.ts)
python3 -m pytest scripts/v2/steampipe/test_sync_lambda_queries.py agent/lambda/test_inventory_read_mcp.py
```

Broader `(cd web && npm run build)` and `(cd web && npx vitest run)` should be run before PR if time permits.

## Out Of Scope / 제외

- ECS service topology nodes or ALB target graph rewiring.
- ECS/Fargate cost dashboard.
- ECS service mutation, deployment changes, scaling, or remediation execution.
- Multi-account propagation beyond the current `account_id='self'` inventory convention.

## Co-Agent Note / co-agent 메모

External co-agent fan-out was attempted for this decision, but the available CLIs did not return usable
advisory output in this environment: Codex failed read-only sandbox initialization, Gemini required
non-interactive authentication, and Kiro failed on configured model/network dispatch. The design above is the
chair decision based on the local code and v2 posture.
