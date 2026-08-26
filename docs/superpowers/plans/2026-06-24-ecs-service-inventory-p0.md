# ECS Service Inventory P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing read-only ECS service inventory type to v2, visible at `/inventory/ecs_service` and queryable through AgentCore inventory-read.

**Architecture:** Reuse the existing Aurora `inventory_resources` inventory path. Add one Steampipe sync query for `ecs_service`, register the type in the web inventory catalog/sidebar, and update the AgentCore inventory-read advertised resource type text. Do not add schema migrations, topology graph nodes, AWS mutation, scaling, or remediation.

**Tech Stack:** Python 3 Lambda sync (`scripts/v2/steampipe/sync_lambda.py`), Next.js/TypeScript catalog (`web/lib/inventory-types.ts`), Vitest, Python unittest/pytest-compatible tests.

---

## File Structure

- `scripts/v2/steampipe/sync_lambda.py`: add the read-only `aws_ecs_service` query to `QUERIES`.
- `scripts/v2/steampipe/test_sync_lambda_queries.py`: add an import-safe regression test for the new query.
- `web/lib/inventory-types.ts`: add `ecs_service` metadata, Compute > ECS sidebar placement, highlights, and layout.
- `web/lib/inventory-types.test.ts`: update registry count and ECS subgroup assertions.
- `agent/lambda/inventory_read_mcp.py`: update docs for `query_inventory`; do not add a topology allowlist entry.
- `agent/lambda/test_inventory_read_mcp.py`: verify `ecs_service` query handling and catalog advertisement.
- `scripts/v2/agentcore/catalog.py`: update the AgentCore tool description for `query_inventory`.

## Task 1: Web Inventory Registry

**Files:**
- Modify: `web/lib/inventory-types.test.ts`
- Modify: `web/lib/inventory-types.ts`

- [ ] **Step 1: Write failing registry tests**

In `web/lib/inventory-types.test.ts`, update the registry test to expect 32 types and include `ecs_service`:

```ts
it('has the 32 wave types (31 + ecs_service)', () => {
  const keys = Object.keys(INVENTORY_TYPES);
  expect(keys).toContain('ec2'); expect(keys).toContain('s3'); expect(keys).toContain('iam_role');
  expect(keys).toContain('cloudfront'); expect(keys).toContain('cloudwatch_alarm'); expect(keys).toContain('msk');
  expect(keys).toContain('target_group'); expect(keys).toContain('route53'); expect(keys).toContain('ecs_task');
  expect(keys).toContain('ecs_service');
  expect(keys).toContain('apigatewayv2_api'); expect(keys).toContain('apigatewayv2_integration'); expect(keys).toContain('cloudfront_vpc_origin');
  expect(keys).toContain('apigatewayv2_route'); expect(keys).toContain('alb_listener_rule');
  expect(keys).toContain('s3_public_access');
  expect(keys.length).toBe(32);
});
```

Update the placement test:

```ts
expect(placed.length).toBe(32);
```

Update the Compute > ECS subgroup assertion:

```ts
expect(ecs.items.map((l) => l.type)).toEqual(['ecs_cluster', 'ecs_service', 'ecs_task']);
```

Add a layout expectation:

```ts
expect(layoutOf('ecs_service')).toBe('chart');
```

- [ ] **Step 2: Run the focused test to verify failure**

Run:

```bash
(cd web && npx vitest run lib/inventory-types.test.ts)
```

Expected: fails because `ecs_service` is not registered and count/placement/layout do not match.

- [ ] **Step 3: Register `ecs_service` in the catalog**

In `web/lib/inventory-types.ts`, add this entry after `ecs_cluster` and before `ecs_task`:

```ts
  ecs_service: { label: 'ECS Services', group: 'Compute', stateKey: 'status', distKey: 'launch_type', columns: [
    { key: 'service_name', label: 'Service' }, { key: 'status', label: 'Status' },
    { key: 'desired_count', label: 'Desired' }, { key: 'running_count', label: 'Running' },
    { key: 'pending_count', label: 'Pending' }, { key: 'launch_type', label: 'Launch' },
    { key: 'scheduling_strategy', label: 'Strategy' }, { key: 'cluster_arn', label: 'Cluster' },
    { key: 'task_definition', label: 'Task def' }, { key: 'created_at', label: 'Created' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'service_name', 'region', 'status'] },
      { label: 'Capacity', keys: ['desired_count', 'running_count', 'pending_count', 'launch_type', 'scheduling_strategy'] },
      { label: 'Runtime', keys: ['cluster_arn', 'task_definition', 'created_at'] },
    ] },
```

Update the Compute subgroup:

```ts
subgroups: [{ key: 'ecs', labelKey: 'group.compute.ecs', types: ['ecs_cluster', 'ecs_service', 'ecs_task'] }],
```

Add highlights:

```ts
  ecs_service: [
    { kind: 'sum', label: 'Desired', col: 'desired_count' },
    { kind: 'sum', label: 'Running', col: 'running_count' },
    { kind: 'sum', label: 'Pending', col: 'pending_count' },
    { kind: 'distinct', label: 'Clusters', col: 'cluster_arn' },
  ],
```

Add layout:

```ts
  ec2: 'chart', lambda: 'chart', ecs_cluster: 'chart', ecs_service: 'chart', cloudwatch_alarm: 'chart',
```

- [ ] **Step 4: Run the focused test to verify pass**

Run:

```bash
(cd web && npx vitest run lib/inventory-types.test.ts)
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add web/lib/inventory-types.ts web/lib/inventory-types.test.ts
git commit -m "feat(web): register ecs service inventory"
```

## Task 2: Steampipe Sync Query

**Files:**
- Create: `scripts/v2/steampipe/test_sync_lambda_queries.py`
- Modify: `scripts/v2/steampipe/sync_lambda.py`

- [ ] **Step 1: Write failing sync query test**

Create `scripts/v2/steampipe/test_sync_lambda_queries.py`:

```py
import importlib.util
import sys
import types
from pathlib import Path


def load_sync_lambda():
    root = Path(__file__).resolve().parent
    sys.modules.setdefault("boto3", types.SimpleNamespace(client=lambda *a, **k: object()))
    sys.modules.setdefault("pg8000", types.SimpleNamespace(native=types.SimpleNamespace(Connection=object)))
    sys.modules.setdefault("pg8000.native", types.SimpleNamespace(Connection=object))
    sys.modules.setdefault("botocore", types.SimpleNamespace())
    sys.modules.setdefault("botocore.exceptions", types.SimpleNamespace(ClientError=Exception))
    spec = importlib.util.spec_from_file_location("sync_lambda_under_test", root / "sync_lambda.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


def test_ecs_service_query_registered_readonly():
    mod = load_sync_lambda()
    sql, id_col, region_col = mod.QUERIES["ecs_service"]
    assert "FROM aws_ecs_service" in sql
    assert "(cluster_arn || '/' || service_name) AS service_key" in sql
    assert id_col == "service_key"
    assert region_col == "region"
    for col in [
        "service_name", "cluster_arn", "status",
        "desired_count", "running_count", "pending_count",
        "launch_type", "scheduling_strategy", "task_definition", "created_at",
    ]:
        assert col in sql
    assert "service_arn" not in sql
```

- [ ] **Step 2: Run the test to verify failure**

Run:

```bash
python3 -m pytest scripts/v2/steampipe/test_sync_lambda_queries.py
```

Expected: fails with `KeyError: 'ecs_service'`.

- [ ] **Step 3: Add the ECS service query**

In `scripts/v2/steampipe/sync_lambda.py`, add this `QUERIES` entry after `ecs_cluster` and before `ecr`:

```py
    "ecs_service": (
        # v1 parity: ECS service inventory (desired/running/pending + launch type). Read-only
        # aws_ecs_service describe/list data, materialized into Aurora like other inventory types.
        "SELECT (cluster_arn || '/' || service_name) AS service_key, "
        "service_name, cluster_arn, region, account_id, status, "
        "desired_count, running_count, pending_count, launch_type, scheduling_strategy, "
        "task_definition, created_at, tags "
        "FROM aws_ecs_service ORDER BY cluster_arn, service_name",
        "service_key",
        "region",
    ),
```

- [ ] **Step 4: Run the sync query test to verify pass**

Run:

```bash
python3 -m pytest scripts/v2/steampipe/test_sync_lambda_queries.py
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/v2/steampipe/sync_lambda.py scripts/v2/steampipe/test_sync_lambda_queries.py
git commit -m "feat(inventory): sync ecs services"
```

## Task 3: AgentCore Inventory-Read Wiring

**Files:**
- Modify: `agent/lambda/inventory_read_mcp.py`
- Modify: `agent/lambda/test_inventory_read_mcp.py`
- Modify: `scripts/v2/agentcore/catalog.py`

- [ ] **Step 1: Write failing AgentCore tests**

In `agent/lambda/test_inventory_read_mcp.py`, add this handler test:

```py
    def test_query_inventory_returns_ecs_service_rows(self):
        seen = {}
        def fake(sql, params=None):
            seen["sql"], seen["params"] = sql, params
            return [{"data": {"service_name": "api", "desired_count": 2, "running_count": 1}}]
        inv._execute_override = fake
        import json as _j
        out = inv.lambda_handler({"tool_name": "query_inventory", "arguments": {"resource_type": "ecs_service"}}, None)
        self.assertEqual(out["statusCode"], 200)
        body = _j.loads(out["body"])
        self.assertEqual(body["resource_type"], "ecs_service")
        self.assertEqual(body["resources"][0]["service_name"], "api")
        self.assertEqual(seen["params"], [{"name": "rt", "value": {"stringValue": "ecs_service"}}])
        self.assertNotIn("ecs_service", seen["sql"])
```

Add this catalog wiring test near the bottom of the same file:

```py
class TestCatalogWiring(unittest.TestCase):
    def test_inventory_read_catalog_advertises_ecs_service(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "v2", "agentcore"))
        import catalog
        t = catalog.TARGETS.get("inventory-read-target")
        self.assertIsNotNone(t, "inventory-read-target missing from catalog.TARGETS")
        tool = next(x for x in t["tools"] if x["name"] == "query_inventory")
        self.assertIn("ecs_service", tool["description"])
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
python3 -m pytest agent/lambda/test_inventory_read_mcp.py
```

Expected: catalog test fails because the description does not advertise `ecs_service`.

- [ ] **Step 3: Update AgentCore docs/allowlist text**

In `agent/lambda/inventory_read_mcp.py`, update the tool list comment:

```py
  - query_inventory       : list/filter synced resources by type, including ecs_service
```

Leave `TOPOLOGY_TYPES` unchanged. Do not add `ecs_service` there because topology expansion is out
of scope and `query_inventory` does not use that allowlist.

In `scripts/v2/agentcore/catalog.py`, update the `query_inventory` description:

```py
{"name": "query_inventory", "description": "List synced resources of one type (alb, nlb, target_group, cloudfront, ec2, ebs, security_group, route53, lambda, ecs_task, ecs_service, s3)", "inputSchema": {"type": "object", "properties": {"resource_type": _p("string", "Resource type to list"), "limit": _p("integer", "Max rows (default 200, cap 500)")}, "required": ["resource_type"]}},
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
python3 -m pytest agent/lambda/test_inventory_read_mcp.py
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add agent/lambda/inventory_read_mcp.py agent/lambda/test_inventory_read_mcp.py scripts/v2/agentcore/catalog.py
git commit -m "feat(agent): advertise ecs service inventory"
```

## Task 4: Final Verification

**Files:**
- Read/verify only.

- [ ] **Step 1: Run focused tests**

```bash
(cd web && npx vitest run lib/inventory-types.test.ts)
python3 -m pytest scripts/v2/steampipe/test_sync_lambda_queries.py agent/lambda/test_inventory_read_mcp.py
```

Expected: all pass.

- [ ] **Step 2: Run broader build/test checks if dependencies are present**

```bash
(cd web && npm run build)
(cd web && npx vitest run)
```

Expected: build and tests pass. If pre-existing type/test noise appears, capture the exact failure and do not hide it.

- [ ] **Step 3: Review final diff for posture**

Run:

```bash
git diff origin/feat/v2-architecture-design...HEAD
```

Expected: changes are limited to the ECS service inventory read path, web registry/tests, AgentCore inventory-read text/tests, and docs. There must be no AWS mutation, remediation enablement, arbitrary AWS CLI execution, or topology expansion.

- [ ] **Step 4: Push branch and open PR**

```bash
git push -u origin feat/v2-ecs-service-inventory-p0
gh pr create --base feat/v2-architecture-design --head feat/v2-ecs-service-inventory-p0 --title "feat(v2): add ECS service inventory" --body "Adds the P0 read-only ECS service inventory slice: Steampipe sync, web inventory registry, AgentCore query_inventory advertisement, and focused tests."
```

Expected: branch is pushed and a PR URL is returned.
