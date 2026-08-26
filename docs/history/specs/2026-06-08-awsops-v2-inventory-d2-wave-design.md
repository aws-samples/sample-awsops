# AWSops v2 — D2 Inventory Wave Design

**Status:** Accepted (co-agent panel: codex+gemini unanimous on Q1–Q4; kiro abstained [stdin quirk]; Claude chair verified). 2026-06-08.

**Goal:** Extend the D1 inventory substrate (warm Steampipe Fargate → sync Lambda → Aurora `inventory_resources` ← BFF) from 1 type (ec2) to **13 types**, rebuilding the core of the v1 dashboard breadth, with a **generic registry-driven page** and a **fan-out sync** so adding a type is config, not new infra.

**Builds on D1** (deployed GREEN): `terraform/foundation/steampipe.tf` (warm Steampipe Fargate, sync Lambda, Aurora schema, EventBridge), `scripts/v2/steampipe/sync_lambda.py` (QUERIES map, advisory-lock per type, UPSERT+delete-stale, inventory_sync_runs), `web/lib/inventory.ts` (readResources/triggerSync), `web/app/api/inventory/[type]/{route.ts,refresh/route.ts}`, `web/components/ui/{RefreshButton,DataTable}.tsx`. The Steampipe **image is unchanged** — the aws plugin already exposes all 487 tables; D2 only adds SQL + columns + IAM + UI.

---

## Decisions (co-agent validated)

- **Q1 = A** — ONE generic page `web/app/inventory/[type]/page.tsx` driven by a per-type **column registry** (`web/lib/inventory-types.ts`); nav generated from the registry; adding a type = one registry entry. `/ec2` redirects to `/inventory/ec2`. *(DRY over bespoke per-service UX; matches the generic `inventory_resources` shape.)*
- **Q2 = A** — each Steampipe table is its own independent **type** (a `vpc` group = separate `vpc`, `subnet`, `security_group` types), preserving D1's per-resource-row + advisory-lock + delete-stale model. Nav **folders** related types under a group label. *(Row-level correctness over nested-JSONB partial-freshness.)*
- **Q3 = B** — single EventBridge rule fires `{type:"all"}` → the sync Lambda in **dispatch mode** async **self-invokes** once per registered type (`InvocationType='Event'`). Each per-type invoke runs the normal advisory-locked sync within its own 120s budget. *(No SQS — lighter than the panel's SQS suggestion; reuses the existing function; per-type failure isolation; avoids the sequential-timeout risk of one big invocation.)*
- **Q4 = B** — curated per-service least-privilege on the **Steampipe task role**, using **service-level verb wildcards** (`s3:GetBucket*`, `rds:Describe*`, …) not action enumeration, to keep maintenance low while excluding the broad surface of AWS-managed `ReadOnlyAccess` (no Secrets Manager / KMS / data-plane reads). *(Security posture over a small per-wave IAM edit.)*

**Scope (this wave, 13 types):** ec2 (existing) + **s3, lambda, rds, ebs_volume, vpc, subnet, security_group, iam_role, iam_user, dynamodb, ecs_cluster, ecr**. **Deferred to D3:** WAF, CloudFront, ElastiCache, OpenSearch, MSK, CloudWatch-alarms, CloudTrail, TGW/NAT/IGW/route_table, ELB/ALB/NLB. Special pages (cost, EKS in-cluster, agent/chat, security-posture, compliance) are out of the inventory wave (handled by P3-B/P3-D/P3-C).

---

## Per-type catalog (verified against live Steampipe aws@0.142.0 columns)

Each entry: `type` → (Steampipe table, `id_col`, `region_col`, SELECT columns, display columns for the registry). `id_col`/`region_col` form the PK with resource_type+account_id. IAM-global tables carry `region='global'` — fine for the PK.

| type | table | id_col | region_col | SELECT columns (stored in `data` JSONB) | display columns (key → label) |
|------|-------|--------|-----------|------------------------------------------|-------------------------------|
| ec2 *(exists)* | aws_ec2_instance | instance_id | region | instance_id, instance_type, instance_state, region, account_id, private_ip_address, public_ip_address, vpc_id, launch_time | instance_type→Type, instance_state→State, private_ip_address→Private IP, vpc_id→VPC |
| s3 | aws_s3_bucket | name | region | name, region, account_id, creation_date | creation_date→Created |
| | | | | *(revised at deploy: versioning_enabled/bucket_policy_is_public dropped — they trigger per-bucket GetBucketVersioning/GetBucketPolicyStatus, which a restrictive bucket resource policy can explicit-deny, failing the whole query)* | |
| lambda | aws_lambda_function | name | region | name, region, account_id, runtime, memory_size, timeout, last_modified, state, package_type | runtime→Runtime, memory_size→Mem(MB), timeout→Timeout(s), state→State |
| rds | aws_rds_db_instance | db_instance_identifier | region | db_instance_identifier, region, account_id, engine, engine_version, class, status, multi_az, allocated_storage | engine→Engine, engine_version→Version, class→Class, status→Status, multi_az→Multi-AZ |
| ebs_volume | aws_ebs_volume | volume_id | region | volume_id, region, account_id, volume_type, size, state, encrypted, availability_zone | volume_type→Type, size→Size(GB), state→State, encrypted→Encrypted, availability_zone→AZ |
| vpc | aws_vpc | vpc_id | region | vpc_id, region, account_id, cidr_block, state, is_default, instance_tenancy | cidr_block→CIDR, state→State, is_default→Default, instance_tenancy→Tenancy |
| subnet | aws_vpc_subnet | subnet_id | region | subnet_id, region, account_id, vpc_id, cidr_block, availability_zone, available_ip_address_count, map_public_ip_on_launch | vpc_id→VPC, cidr_block→CIDR, availability_zone→AZ, available_ip_address_count→Free IPs, map_public_ip_on_launch→Auto-public-IP |
| security_group | aws_vpc_security_group | group_id | region | group_id, group_name, region, account_id, vpc_id, description | group_name→Name, vpc_id→VPC, description→Description |
| iam_role | aws_iam_role | name | region | name, arn, region, account_id, role_id, create_date, path | create_date→Created, path→Path, role_id→Role ID |
| iam_user | aws_iam_user | name | region | name, arn, region, account_id, user_id, create_date, mfa_enabled, password_last_used | create_date→Created, mfa_enabled→MFA, password_last_used→Last PW use |
| dynamodb | aws_dynamodb_table | name | region | name, region, account_id, table_status, billing_mode, item_count, table_size_bytes, read_capacity, write_capacity | table_status→Status, billing_mode→Billing, item_count→Items, table_size_bytes→Size(B) |
| ecs_cluster | aws_ecs_cluster | cluster_name | region | cluster_name, region, account_id, status, running_tasks_count, pending_tasks_count, active_services_count, registered_container_instances_count | status→Status, running_tasks_count→Running, active_services_count→Services, registered_container_instances_count→Instances |
| ecr | aws_ecr_repository | repository_name | region | repository_name, region, account_id, repository_uri, image_tag_mutability, created_at | repository_uri→URI, image_tag_mutability→Tag mutability, created_at→Created |

> SQL form (mirror D1's ec2 query): `SELECT <cols> FROM <table> ORDER BY <sensible col>`. Use `ORDER BY` on a stable column (e.g. creation/create_date DESC where present, else the id_col). Steampipe always also exposes region/account_id; select them explicitly so the row dict carries them.

### Registry groups (nav folders)
- **Compute:** ec2, lambda, ecs_cluster, ecr
- **Storage & DB:** s3, ebs_volume, rds, dynamodb
- **Network:** vpc, subnet, security_group
- **Security:** iam_role, iam_user

---

## Steampipe task-role IAM (curated, service-level wildcards)

Add to `aws_iam_role_policy.steampipe_task` (one statement, `Resource:"*"` — these read APIs don't support resource-level scoping). `ec2:Describe*` already present (covers ec2/vpc/subnet/security_group/ebs). **New actions:**

```
s3:ListAllMyBuckets, s3:GetBucket*, s3:GetAccountPublicAccessBlock, s3:GetEncryptionConfiguration,
lambda:List*, lambda:GetFunction*, lambda:GetPolicy,
rds:Describe*, rds:ListTagsForResource,
dynamodb:List*, dynamodb:Describe*,
ecs:List*, ecs:Describe*,
ecr:Describe*, ecr:List*, ecr:GetLifecyclePolicy, ecr:GetRepositoryPolicy,
iam:List*, iam:Get*, iam:GenerateCredentialReport
```

All are read-only metadata actions; none read object data, secrets, or KMS. Far narrower than `ReadOnlyAccess`.

---

## Sync fan-out (Q3 = B, self-invoke)

`sync_lambda.py`:
- `QUERIES` grows to 13 entries (above).
- `lambda_handler(event, ctx)`:
  - `t = (event or {}).get("type", "all")`.
  - if `t == "all"`: for each `rt in QUERIES`, `_lambda.invoke(FunctionName=ctx.invoked_function_arn, InvocationType="Event", Payload=json.dumps({"type": rt}).encode())`; return `{"status":"dispatched","types":list(QUERIES)}`. (Fire-and-forget; each child does the real sync.)
  - else: `return sync(t)` (existing path; unknown type → `{"error": ...}`).
- boto3 lambda client created lazily (module-level `_lambda = boto3.client("lambda", region_name=...)`).

`steampipe.tf`:
- `inv_sync` inline policy gains `lambda:InvokeFunction` on `aws_lambda_function.inv_sync[0].arn` (self-invoke).
- EventBridge target `input` changes from `{type:"ec2"}` to `{type:"all"}`.

A single `/refresh` from the BFF still triggers ONE type (`triggerSync(type)` → `{type:x}` → normal sync) — unchanged. The "all" mode is only the scheduled path (and a manual `{type:"all"}` invoke).

---

## BFF (web)

- **`web/lib/inventory-types.ts`** — `export const INVENTORY_TYPES: Record<string, {label, group, columns: {key,label}[]}>` for the 13 types (display columns above). Plain data; imported by client (page, nav) and server (route allow-list).
- **`web/app/inventory/[type]/page.tsx`** — `'use client'`; reads route param `type`; if not in registry → render a "Unknown inventory type" message (the GET also guards). Reuses D1's fetch/refresh logic (GET `/api/inventory/[type]`, POST `…/refresh`), maps `rows[].{resource_id,region,...data}`, renders `<DataTable>` with `INVENTORY_TYPES[type].columns` (resource_id + region prepended) + `<RefreshButton>`. Title = `INVENTORY_TYPES[type].label`.
- **GET `/api/inventory/[type]`** — add allow-list: `if (!(type in INVENTORY_TYPES)) return 404`. (Refresh route inherits the same guard.)
- **`web/components/shell/TopNav.tsx`** — keep `Overview / EKS / Jobs / Cost`; add an **Inventory** section generated from `INVENTORY_TYPES` grouped by `group` (links to `/inventory/<type>`). Implementation can be a simple grouped list/dropdown consistent with existing nav styling.
- **`web/next.config.mjs`** — `redirects()` async: `/ec2 → /inventory/ec2` (permanent:false). Remove `web/app/ec2/page.tsx` (superseded by the generic page).

---

## Testing
- Unit (vitest): registry integrity (every type has ≥1 column, unique types); generic page renders rows + handles unknown type; GET 404 on unknown type. Reuse D1's route test pattern. Build must stay clean and list `/inventory/[type]`.
- Live (deploy, controller): `terraform apply` (Lambda code via `archive_file` + IAM + EventBridge input) → `make deploy` web → invoke `{type:"all"}` → wait → assert `inventory_resources` has rows for all 13 types + `inventory_sync_runs` all succeeded → `/inventory/<type>` routes 302 (edge). Watch: any wrong column / missing IAM surfaces as that type's `inventory_sync_runs.status='failed'` with the error — fix that type's SQL/IAM and re-sync.

## Out of scope (D3+)
WAF/CloudFront/ElastiCache/OpenSearch/MSK/CloudWatch-alarms/CloudTrail/TGW/ELB; per-resource drill-in detail panels; metrics/cost (separate); multi-account; the v1 `/inventory` aggregate rollup + `/topology` graph.
