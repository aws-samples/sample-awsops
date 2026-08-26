# D2 Inventory Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. The authoritative per-type SQL/column/IAM catalog is in the spec `docs/superpowers/specs/2026-06-08-awsops-v2-inventory-d2-wave-design.md` — read the relevant section per task.

**Goal:** Extend D1's inventory substrate from 1 type (ec2) to 13, with a generic registry-driven page + fan-out sync + curated IAM.

**Architecture:** generic `/inventory/[type]` page ← column registry; EventBridge `{type:"all"}` → sync Lambda self-invokes per type; Steampipe task role gets curated per-service read; Steampipe image UNCHANGED.

**Tech stack:** Terraform (gated by existing `var.steampipe_enabled`), Python (sync Lambda, pg8000), Next.js 14 BFF (vitest), Aurora PG17.

---

### Task 1: `sync_lambda.py` — +12 QUERIES + fan-out dispatch

**Files:** Modify `scripts/v2/steampipe/sync_lambda.py`

Read the spec's **Per-type catalog** + **Sync fan-out** sections for the exact columns.

- [ ] **Step 1:** Add 12 entries to `QUERIES` (s3, lambda, rds, ebs_volume, vpc, subnet, security_group, iam_role, iam_user, dynamodb, ecs_cluster, ecr). Each value = `(SQL, id_col, region_col)` exactly like the existing `ec2` entry. SQL = `SELECT <spec columns> FROM <table> ORDER BY <stable col>`. Example for s3:
```python
    "s3": (
        "SELECT name, region, account_id, creation_date, versioning_enabled, bucket_policy_is_public "
        "FROM aws_s3_bucket ORDER BY creation_date DESC",
        "name", "region",
    ),
```
Use the spec table for every type's columns/id_col/region_col. For `iam_role`/`iam_user` the region column is `region` (Steampipe returns `'global'`). Order by `create_date DESC` (iam), `creation_date DESC` (s3/dynamodb), `created_at DESC` (ecr), else the id_col.

- [ ] **Step 2:** Add a module-level lambda client + fan-out in `lambda_handler`:
```python
_lambda = boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))

def lambda_handler(event, ctx):
    rtype = (event or {}).get("type", "all")
    if rtype == "all":
        for rt in QUERIES:
            _lambda.invoke(FunctionName=ctx.invoked_function_arn, InvocationType="Event",
                           Payload=json.dumps({"type": rt}).encode())
        return {"status": "dispatched", "types": list(QUERIES)}
    return sync(rtype)
```
(Keep the existing `sync()` untouched. `_lambda` placed near `_sm`.)

- [ ] **Step 3 (self-consistency check, no live AWS):** quick local sanity — every QUERIES value is a 3-tuple, id_col/region_col appear in the SQL. Run:
```bash
cd /home/atomoh/awsops && python3 -c "import ast,sys; src=open('scripts/v2/steampipe/sync_lambda.py').read(); ns={}; 
# lightweight: just import-parse won't run boto3; assert structure via ast
tree=ast.parse(src); print('parse OK')"
```
Expected: `parse OK` (don't import — boto3 client init needs creds-free region only; parsing is enough). Confirm visually that all 13 keys exist and each tuple has 3 string elements.

- [ ] **Step 4: Commit**
```bash
cd /home/atomoh/awsops
git add scripts/v2/steampipe/sync_lambda.py
git commit -m "feat(v2-d2): sync_lambda +12 inventory types (s3/lambda/rds/ebs/vpc/subnet/sg/iam_role/iam_user/dynamodb/ecs/ecr) + fan-out dispatch (type=all -> async self-invoke per type)"
```

---

### Task 2: `steampipe.tf` — curated read IAM + lambda self-invoke + EventBridge `{type:"all"}`

**Files:** Modify `terraform/foundation/steampipe.tf`

Read the spec's **Steampipe task-role IAM** + **Sync fan-out** sections.

- [ ] **Step 1:** In `aws_iam_role_policy.steampipe_task`, extend the single statement's `Action` list (keep `ec2:Describe*`, `sts:GetCallerIdentity`) with the spec's new actions (s3:ListAllMyBuckets, s3:GetBucket*, s3:GetAccountPublicAccessBlock, s3:GetEncryptionConfiguration, lambda:List*, lambda:GetFunction*, lambda:GetPolicy, rds:Describe*, rds:ListTagsForResource, dynamodb:List*, dynamodb:Describe*, ecs:List*, ecs:Describe*, ecr:Describe*, ecr:List*, ecr:GetLifecyclePolicy, ecr:GetRepositoryPolicy, iam:List*, iam:Get*, iam:GenerateCredentialReport). Keep `Resource = "*"`.

- [ ] **Step 2:** In `aws_iam_role_policy.inv_sync` add a statement granting `lambda:InvokeFunction` on `aws_lambda_function.inv_sync[0].arn` (self-invoke for fan-out). (Add to the existing Statement array.)

- [ ] **Step 3:** Change `aws_cloudwatch_event_target.inv_sync` `input` from `jsonencode({ type = "ec2" })` to `jsonencode({ type = "all" })`. (Optionally rename `target_id`/rule comment to reflect "all"; the rule name can stay.)

- [ ] **Step 4: validate + plan** (steampipe_enabled=true is live):
```bash
cd /home/atomoh/awsops/terraform/foundation && export PATH="$HOME/.local/bin:$PATH"
terraform fmt steampipe.tf; terraform validate
terraform plan -no-color -input=false -lock=false 2>&1 | grep -E "will be updated|will be created|Plan:|Error" | head -20
```
Expected: in-place updates to `aws_iam_role_policy.steampipe_task`, `aws_iam_role_policy.inv_sync`, `aws_cloudwatch_event_target.inv_sync`, and the Lambda (source_code_hash change from Task 1). No destroys/replacements of the service/cluster.

- [ ] **Step 5: Commit**
```bash
cd /home/atomoh/awsops
git add terraform/foundation/steampipe.tf
git commit -m "feat(v2-d2): steampipe.tf — curated per-service read IAM (s3/lambda/rds/dynamodb/ecs/ecr/iam) + inv_sync self-invoke (lambda:InvokeFunction) + EventBridge {type:all} fan-out"
```

---

### Task 3: `web/lib/inventory-types.ts` — column registry

**Files:** Create `web/lib/inventory-types.ts`, `web/lib/inventory-types.test.ts`

Read the spec's **Per-type catalog** display columns + **Registry groups**.

- [ ] **Step 1: Failing test** `web/lib/inventory-types.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { INVENTORY_TYPES, inventoryGroups } from './inventory-types';

describe('INVENTORY_TYPES registry', () => {
  it('has the 13 wave types', () => {
    const keys = Object.keys(INVENTORY_TYPES);
    expect(keys).toContain('ec2'); expect(keys).toContain('s3'); expect(keys).toContain('iam_role');
    expect(keys.length).toBe(13);
  });
  it('every type has a label, group, and >=1 column', () => {
    for (const [k, v] of Object.entries(INVENTORY_TYPES)) {
      expect(v.label, k).toBeTruthy(); expect(v.group, k).toBeTruthy();
      expect(v.columns.length, k).toBeGreaterThan(0);
      for (const c of v.columns) { expect(c.key).toBeTruthy(); expect(c.label).toBeTruthy(); }
    }
  });
  it('groups the types', () => {
    const g = inventoryGroups();
    expect(g.find((x) => x.group === 'Compute')?.types).toContain('ec2');
    expect(g.find((x) => x.group === 'Network')?.types).toContain('vpc');
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`cd web && npx vitest run lib/inventory-types.test.ts`)

- [ ] **Step 3: Implement** `web/lib/inventory-types.ts`:
```typescript
export interface InvColumn { key: string; label: string }
export interface InvType { label: string; group: string; columns: InvColumn[] }

// resource_id + region are prepended by the page; columns here are the type-specific extras.
export const INVENTORY_TYPES: Record<string, InvType> = {
  ec2: { label: 'EC2 Instances', group: 'Compute', columns: [
    { key: 'instance_type', label: 'Type' }, { key: 'instance_state', label: 'State' },
    { key: 'private_ip_address', label: 'Private IP' }, { key: 'vpc_id', label: 'VPC' } ] },
  lambda: { label: 'Lambda Functions', group: 'Compute', columns: [
    { key: 'runtime', label: 'Runtime' }, { key: 'memory_size', label: 'Mem(MB)' },
    { key: 'timeout', label: 'Timeout(s)' }, { key: 'state', label: 'State' } ] },
  ecs_cluster: { label: 'ECS Clusters', group: 'Compute', columns: [
    { key: 'status', label: 'Status' }, { key: 'running_tasks_count', label: 'Running' },
    { key: 'active_services_count', label: 'Services' }, { key: 'registered_container_instances_count', label: 'Instances' } ] },
  ecr: { label: 'ECR Repositories', group: 'Compute', columns: [
    { key: 'repository_uri', label: 'URI' }, { key: 'image_tag_mutability', label: 'Tag mutability' },
    { key: 'created_at', label: 'Created' } ] },
  s3: { label: 'S3 Buckets', group: 'Storage & DB', columns: [
    { key: 'creation_date', label: 'Created' }, { key: 'versioning_enabled', label: 'Versioning' },
    { key: 'bucket_policy_is_public', label: 'Public' } ] },
  ebs_volume: { label: 'EBS Volumes', group: 'Storage & DB', columns: [
    { key: 'volume_type', label: 'Type' }, { key: 'size', label: 'Size(GB)' },
    { key: 'state', label: 'State' }, { key: 'encrypted', label: 'Encrypted' }, { key: 'availability_zone', label: 'AZ' } ] },
  rds: { label: 'RDS Instances', group: 'Storage & DB', columns: [
    { key: 'engine', label: 'Engine' }, { key: 'engine_version', label: 'Version' },
    { key: 'class', label: 'Class' }, { key: 'status', label: 'Status' }, { key: 'multi_az', label: 'Multi-AZ' } ] },
  dynamodb: { label: 'DynamoDB Tables', group: 'Storage & DB', columns: [
    { key: 'table_status', label: 'Status' }, { key: 'billing_mode', label: 'Billing' },
    { key: 'item_count', label: 'Items' }, { key: 'table_size_bytes', label: 'Size(B)' } ] },
  vpc: { label: 'VPCs', group: 'Network', columns: [
    { key: 'cidr_block', label: 'CIDR' }, { key: 'state', label: 'State' },
    { key: 'is_default', label: 'Default' }, { key: 'instance_tenancy', label: 'Tenancy' } ] },
  subnet: { label: 'Subnets', group: 'Network', columns: [
    { key: 'vpc_id', label: 'VPC' }, { key: 'cidr_block', label: 'CIDR' }, { key: 'availability_zone', label: 'AZ' },
    { key: 'available_ip_address_count', label: 'Free IPs' }, { key: 'map_public_ip_on_launch', label: 'Auto-public-IP' } ] },
  security_group: { label: 'Security Groups', group: 'Network', columns: [
    { key: 'group_name', label: 'Name' }, { key: 'vpc_id', label: 'VPC' }, { key: 'description', label: 'Description' } ] },
  iam_role: { label: 'IAM Roles', group: 'Security', columns: [
    { key: 'create_date', label: 'Created' }, { key: 'path', label: 'Path' }, { key: 'role_id', label: 'Role ID' } ] },
  iam_user: { label: 'IAM Users', group: 'Security', columns: [
    { key: 'create_date', label: 'Created' }, { key: 'mfa_enabled', label: 'MFA' }, { key: 'password_last_used', label: 'Last PW use' } ] },
};

const GROUP_ORDER = ['Compute', 'Storage & DB', 'Network', 'Security'];
export function inventoryGroups(): { group: string; types: string[] }[] {
  return GROUP_ORDER.map((group) => ({
    group, types: Object.keys(INVENTORY_TYPES).filter((t) => INVENTORY_TYPES[t].group === group),
  })).filter((g) => g.types.length > 0);
}
```

- [ ] **Step 4: Run — verify PASS (3)**

- [ ] **Step 5: Commit**
```bash
cd /home/atomoh/awsops
git add web/lib/inventory-types.ts web/lib/inventory-types.test.ts
git commit -m "feat(v2-d2): inventory-types registry (13 types, 4 groups; columns + nav grouping)"
```

---

### Task 4: generic `/inventory/[type]` page + GET allow-list + `/ec2` redirect

**Files:** Create `web/app/inventory/[type]/page.tsx`; Modify `web/app/api/inventory/[type]/route.ts`, `web/next.config.mjs`; Delete `web/app/ec2/page.tsx`

- [ ] **Step 1: GET allow-list** — in `web/app/api/inventory/[type]/route.ts`, after the auth gate, add:
```typescript
import { INVENTORY_TYPES } from '@/lib/inventory-types';
// ... inside GET, after verifyUser check:
  if (!(params.type in INVENTORY_TYPES)) {
    return Response.json({ status: 'error', message: 'unknown type' }, { status: 404 });
  }
```
(The refresh route may stay as-is; triggerSync on an unknown type returns the Lambda's `{error:...}` — acceptable, but you MAY mirror the guard for symmetry.)

- [ ] **Step 2: Generic page** `web/app/inventory/[type]/page.tsx` — adapt D1's `app/ec2/page.tsx` to read `params.type`, look up `INVENTORY_TYPES[type]`, and build the DataTable columns as `[{key:'resource_id',label:'ID'},{key:'region',label:'Region'}, ...INVENTORY_TYPES[type].columns]`. Title = the type's label. Unknown type → an "Unknown inventory type" message. Fetch `/api/inventory/${type}` and `/api/inventory/${type}/refresh`. Keep the `(d.rows as ...).map((x)=>({resource_id:x.resource_id, region:x.region, ...(x.data as object)}))` shaping. `'use client'`, `export default`. (Mirror D1 ec2 page structure; param via `useParams()` from `next/navigation` OR the page receives `params`.)

- [ ] **Step 3: redirect + remove old page** — `web/next.config.mjs` add:
```javascript
  async redirects() {
    return [{ source: '/ec2', destination: '/inventory/ec2', permanent: false }];
  },
```
Then `git rm web/app/ec2/page.tsx`.

- [ ] **Step 4: Build** — `cd /home/atomoh/awsops/web && npm run build` → clean; manifest lists `/inventory/[type]` (dynamic) and the `/ec2 → /inventory/ec2` redirect. Fix any TS error minimally.

- [ ] **Step 5: Commit**
```bash
cd /home/atomoh/awsops
git add web/app/inventory web/app/api/inventory/\[type\]/route.ts web/next.config.mjs
git add -u web/app/ec2  # stage the deletion
git commit -m "feat(v2-d2): generic /inventory/[type] page (registry-driven columns) + GET allow-list (404 unknown) + /ec2->/inventory/ec2 redirect"
```

---

### Task 5: TopNav registry-driven Inventory nav + build/unit gate

**Files:** Modify `web/components/shell/TopNav.tsx`

- [ ] **Step 1:** Keep the existing top-level links (Overview `/`, EKS `/eks`, Jobs `/jobs`, Cost `/cost`). Add an **Inventory** area built from `inventoryGroups()` — for each group, render the group label and its types as links to `/inventory/<type>` using `INVENTORY_TYPES[type].label`. Match existing nav styling (the current `LINKS.map` + `usePathname` active state). A simple grouped row or a dropdown is fine; keep it `'use client'` if it already is. Remove the old static `/ec2` link (now under Inventory→Compute→EC2).

- [ ] **Step 2: Full unit gate** — `cd /home/atomoh/awsops/web && npm run test` → all pass (D1/P3 baseline + inventory-types 3 + any page test). Report the count.

- [ ] **Step 3: Build** — `npm run build` → clean; `/inventory/[type]` present; no broken imports.

- [ ] **Step 4: Commit**
```bash
cd /home/atomoh/awsops
git add web/components/shell/TopNav.tsx
git commit -m "feat(v2-d2): TopNav registry-driven Inventory nav (grouped Compute/Storage&DB/Network/Security)"
```

---

### Task 6: Deploy + verify (CONTROLLER — real infra)

> No Steampipe image rebuild (aws plugin already exposes all tables). Lambda code ships via Terraform `archive_file` + source_code_hash.

- [ ] **Step 1:** `terraform apply` the saved plan (Lambda code update + steampipe task IAM + inv_sync self-invoke + EventBridge `{type:all}`). Controller-run; expect in-place updates only.
- [ ] **Step 2:** `make deploy` web (generic page + nav) → services-stable → `/api/health` 200.
- [ ] **Step 3:** Invoke the sync once for all types: `aws lambda invoke --function-name awsops-v2-inv-sync --payload '{"type":"all"}' ...` → wait ~60-90s for the fan-out children → then for each type query `inventory_sync_runs` and assert `status='succeeded'`; query `inventory_resources` counts per type. **Any `failed` type → read its `error`, fix that type's SQL or add the missing IAM action, re-apply/re-invoke.**
- [ ] **Step 4:** Edge check: `/inventory/ec2`, `/inventory/s3`, `/inventory/iam_role`, and `/ec2` (redirect) → 302/redirect (edge-protected). 
- [ ] **Step 5:** Report GREEN + per-type row counts. No commit (deploy only).

---

## Self-Review
- Spec coverage: every spec decision (Q1 generic page=T4, Q2 per-type=T1/T3, Q3 fan-out=T1/T2, Q4 IAM=T2) and all 13 types (T1 QUERIES + T3 registry) are covered. ✓
- Type consistency: `INVENTORY_TYPES` keys (T3) === `QUERIES` keys (T1) === GET allow-list (T4). The 13 keys must match exactly across Python QUERIES and TS registry — implementers cross-check against the spec catalog. ✓
- No placeholders: all code shown or pinned to the spec catalog. ✓
