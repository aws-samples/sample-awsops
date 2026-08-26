# Account and Region Scope Selector Design

## Context

AWSops v2 currently has an admin account registry and a single global account selector.
The account registry stores one `region` column per account, so it cannot represent
multiple enabled regions for the same AWS account. The existing selector stores one
active account value in local storage and serializes it as `?account=<id>` for BFF
routes that already support account scoping.

The target UX is broader: operators should be able to choose one or more accounts,
all accounts, one or more regions, or all enabled regions from a shared app scope.
Global services such as IAM must not be duplicated across selected regions.

AWSops remains read-only. This design does not enable remediation, mutation, BYO-MCP,
or any reversed ADR-029/036 path.

## Goals

- Add a first-class app scope model with independent account and region dimensions.
- Support `All accounts`, multiple accounts, `All enabled regions`, and multiple regions.
- Treat global AWS services as account-scoped, not region-scoped.
- Keep `accounts` focused on cross-account trust and AssumeRole metadata.
- Add `account_regions` as the source of truth for regional scan targets.
- Preserve thin-BFF behavior: expensive multi-account/multi-region collection is async.

## Non-Goals

- No mutating actions or remediation enablement.
- No external MCP egress or BYO-MCP behavior.
- No live Steampipe service. The only Steampipe use remains the flag-gated warm
  inventory sync batch.
- No duplicate account rows to represent regions.

## Scope Model

Client scope is represented as structured state, not as a single account string.

```ts
type ScopeSelection = {
  accounts: '__all__' | string[];
  regions: '__all__' | string[];
  includeGlobal: boolean;
};
```

`accounts` contains `self` for the host account and 12-digit account IDs for target
accounts. `regions` contains AWS region IDs such as `ap-northeast-2` and `us-east-1`.
`includeGlobal` controls whether rows stored with `region = 'global'` are included
when regional filters are active.

Default behavior:

- `accounts: ['self']`
- `regions: '__all__'`
- `includeGlobal: true`

The selector may expose `All accounts` only when more than one enabled account exists.
It may expose `All enabled regions` when the selected account set has at least one
enabled region.

## Data Model

Keep the existing `accounts` table as account identity and trust metadata:

- `account_id`
- `alias`
- `is_host`
- `role_name`
- `external_id`
- `enabled`
- verification fields

Add an `account_regions` table:

```sql
CREATE TABLE IF NOT EXISTS account_regions (
  account_id text NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  region text NOT NULL CHECK (region ~ '^[a-z]{2}-[a-z]+-[0-9]+$'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, region)
);
```

The host account seed should also seed the deployment region into `account_regions`.
Registering a target account should add its submitted region as the first enabled
region. Adding another region later should not re-run STS trust verification because
trust is account-level; it should validate the account exists and the region name is
syntactically valid.

Do not store `global` in `account_regions`. Global is not an AWS region and should
remain a resource scope marker in `inventory_resources.region`.

## Resource Scope Rules

Inventory sync should classify resource types by collection scope:

```ts
type ResourceScope = 'regional' | 'global';
```

Global resource types are collected once per account and persisted with
`region = 'global'`. Regional resource types are collected once per
`(account_id, region)`.

Initial global types:

- `iam_role`
- `iam_user`
- `route53`
- `cloudfront`
- `cloudfront_vpc_origin`

Initial regional types are all other inventory resource types unless a future AWS
service-specific exception is added.

IAM handling:

- IAM users and roles are never duplicated per selected region.
- Security findings such as `iam_no_mfa` read the single `global` row set.
- UI labels should display `Global` rather than a concrete region for IAM rows.

## API Behavior

Add an authenticated account-regions API:

- `GET /api/accounts/regions` returns enabled regions grouped by account.
- `POST /api/accounts/regions` adds or enables a region for an account; admin-only.
- `DELETE /api/accounts/regions?accountId=...&region=...` disables or deletes a
  region; admin-only. Host account deletion remains forbidden at the account level.

Existing `/api/accounts` remains the account trust endpoint. Its POST path continues
to verify AssumeRole and should also ensure the submitted initial region exists in
`account_regions` after the account row is inserted.

Routes that read `inventory_resources` should accept scope parameters. The preferred
wire format is a compact query string:

- `accounts=self,210987654321` or `accounts=__all__`
- `regions=ap-northeast-2,us-east-1` or `regions=__all__`
- `includeGlobal=1|0`

Server-side helpers should resolve `__all__` into enabled account IDs and enabled
regions from Aurora, then apply SQL filters:

```sql
WHERE account_id = ANY($accounts)
  AND (
    region = ANY($regions)
    OR ($include_global AND region = 'global')
  )
```

Routes that cannot safely aggregate multiple accounts or regions inline must keep the
thin-BFF rule. They should either return 400 with a clear message or enqueue an async
job depending on the workflow.

## UI Behavior

Replace the single `AccountSelector` with a `ScopeSelector` mounted in the app shell.
It should render compact controls:

- Account trigger: `Host account`, `2 accounts`, or `All accounts`
- Region trigger: `ap-northeast-2`, `2 regions`, or `All enabled regions`
- Global services toggle, default on

Each trigger opens a checkbox menu. The account menu lists host and target accounts.
The region menu lists enabled regions derived from the current selected account set.
When `All accounts` is active, the region menu shows the union of enabled regions
across those accounts.

The selector stores state in localStorage and dispatches one browser event, replacing
the account-only event:

- key: `awsops:scope`
- event: `awsops:scopechange`

Existing pages can migrate incrementally by using a compatibility helper that returns
the first selected account or `__all__` where old code expects an account string.

## Collection Flow

Inventory refresh should be planned by resource scope:

- Global types: one job per `(account_id, resource_type)`.
- Regional types: one job per `(account_id, region, resource_type)`.

The existing `inventory_resources` primary key already includes
`(resource_type, account_id, region, resource_id)`, so it can store multi-region and
global rows without schema changes.

`inventory_sync_runs` currently keys by `(resource_type, account_id)`. It should be
extended to include `region` so regional runs have independent freshness and failure
state. Global runs use `region = 'global'`.

## Error Handling

- Invalid account IDs return 400.
- Unknown accounts return 404 or 400 before any AWS call.
- Invalid region strings return 400.
- Empty resolved scope returns an empty dataset, not a broad unscoped query.
- `includeGlobal=false` excludes `region='global'` rows even when `regions=__all__`.
- IAM/global sync failures should not mark every regional run failed.

## Testing

Unit tests should cover:

- `account_regions` CRUD and admin authorization.
- Scope query parsing and fail-closed behavior.
- `__all__` account and region resolution.
- SQL filters include global rows only when requested.
- IAM/global types are planned once per account, not once per region.
- Regional types are planned once per enabled account-region pair.
- Existing account selector compatibility for pages not yet migrated.

Verification commands:

```bash
cd web && npm test -- --run
cd web && npm run build
terraform -chdir=terraform/foundation validate
```

Terraform plan verification remains required before approval when schema or infra
changes are included.
