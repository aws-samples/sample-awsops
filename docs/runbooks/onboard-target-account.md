# Runbook: Onboard a target account (multi-account)

AWSops reads connected accounts cross-account by assuming a **read-only** role (`AWSopsReadOnlyRole`)
in each target account. Trust is pinned to the host task roles; an **ExternalId** (confused-deputy
guard) is **optional for 1st-party accounts** and **required for 3rd-party/shared accounts**
(ADR-011 amended 2026-06-26). AWSops never mutates target-account resources.

With `inventory_host_only=true`, configure the deployment for multi-account collection before
adding enabled target accounts. Foreign account registration returns HTTP 409; the collector
also rejects an enabled foreign scope. Agent MCP IAM grants are unchanged. See [runtime activation](runtime-foundation.md).

## Browser-assisted onboarding

Open `/accounts` as an administrator and enter the target Account ID, alias and region.
The page discovers the current web task role through the authenticated, admin-only
`GET /api/accounts/onboarding` route. No host ARN needs to be copied from Terraform.
It generates an ExternalId for the form and script; under advanced settings, replace it
with the existing role's value. The same-organization omission checkbox stays visible.
Draft ExternalIds are keyed by target Account ID and host role and saved in browser
session storage when available. Checking and unchecking omission preserves the existing
ExternalId, including the value used by an already downloaded script. Omission consent
is never persisted or inherited from a registered account: switching Account ID or
remounting the form requires a fresh explicit choice. Each unseen account gets its own draft.
Role creation and registration remain unavailable until the registered-account lookup finishes.

Choose **Copy AWS CLI commands** or **Download script (.sh)**. The script embeds its
CloudFormation template, so the target administrator does not need a repository checkout.
Run it in the **target account's** CloudShell, or Bash with AWS CLI v2 and target-account
credentials. Upload a downloaded file through **Actions → Upload file**, then execute the
displayed `bash` command. A named CLI profile can be included in advanced settings.
IAM role creation/policy attachment and CloudFormation creation/read permissions are required.

The script checks `GetCallerIdentity.Account` before any deployment and stops on a mismatch.
It creates `awsops-readonly-role` with `create-stack`, waits for creation, pins trust to
the discovered host web role and grants the AWS-managed `ReadOnlyAccess` policy.
That policy permits broad service/resource reads; it is not limited to metadata.
The generated script never updates existing stacks or roles, so it cannot rotate a live
ExternalId or remove an existing trust condition. Same-organization setup omits the
ExternalId parameter, using the template's empty default only for a new stack.
Existing stacks/roles stop creation; inspect them and use their current ExternalId to verify.
The page preserves the stored ExternalId and hides creation controls for registered accounts;
use the registered row's **Test** control for those accounts.

New stacks leave worker trust empty. Worker reads require the additional setup below.
The generated template's deployment contract matches `infra/cfn/awsops-target-account-role.yaml`;
only explanatory template/parameter/output descriptions differ. The required offline
`scripts/v2/test_account_onboarding_template.py` test compares all deployment parameters,
resources, conditions and outputs, including trust and permission policies.

After stack completion, return to the same form and choose **Verify and register**.
Verification failure preserves the fields for retry. A successful registration followed by
a failed list refresh remains successful, prevents repeat registration/script generation
for that account and asks for a page refresh. Delete, connection-test and region-add reload
failures show a refresh error rather than an unhandled rejection or a success message
beside stale rows. When browser session
storage is unavailable or a new session is used, restore the ExternalId from the original
script or target role trust policy. Allow for IAM propagation after creation.

`AlreadyExists` can refer to the **stack name**, even when no role exists. In CloudFormation,
inspect `awsops-readonly-role` and distinguish these cases:

- `ROLLBACK_COMPLETE`: review events to fix the creation failure, and inspect the Resources
  tab to confirm this is the failed onboarding stack with no resources that must be retained.
  Delete **that failed stack only**, wait for deletion to finish, then rerun the same script
  with its original ExternalId. Do not delete a working role or another stack.
- `CREATE_COMPLETE` / `UPDATE_COMPLETE`: retain the working stack/role, match its trust and
  ExternalId, then verify from the form. This create-only script is not an update tool.
- `CREATE_IN_PROGRESS`: wait for the current creation to finish; do not submit another create.
- `ROLLBACK_FAILED` / `DELETE_FAILED`: inspect the failure events and resolve blocked cleanup
  with the target administrator before retrying.

If only an independently managed `AWSopsReadOnlyRole` exists, inspect its trust and ExternalId
without deleting it; its name collision is different from a failed onboarding stack.
Failed-stack cleanup requires `cloudformation:DeleteStack` on that stack and any permissions
needed to remove its owned resources; coordinate this separate action with the target administrator.

Verification proves the **web task role's** AssumeRole and caller-account identity only.
It does not prove inventory collection, worker access or AgentCore MCP access. The selected
region is the initial collection scope; add other regions using the registered row.
Inventory collection is asynchronous and requires its own principal/trust configuration,
including the Steampipe task role. The existing connection renderer does not grant target trust.
Agent Lambda readers currently use a single `AWSOPS_EXTERNAL_ID` setting instead of the
registry's per-account value. An automatically generated per-account ID is not automatically
propagated there. Operators must coordinate the shared reader value and its trusted
principal before expecting AgentCore cross-account reads; the wizard does not configure them.

Host-only deployments display the restriction before registration and disable the register
button. Script generation remains available for preparation; running it does not change
`inventory_host_only`, collector IAM, or readiness policy. Multi-account activation is a
separate operator configuration step. AWSops itself never executes the generated AWS writes.

## Prerequisites
- Admin access to AWSops (`/accounts` is gated by Cognito `ADMIN_GROUP` or the SSM email allowlist).
- For the manual CLI path below: the **host web task role ARN** — full ARN `arn:aws:iam::<host>:role/awsops-v2-task` (Terraform output `web_task_role_arn`). The browser path discovers it automatically.
  The generated template does not add the separate Steampipe collector principal.
- **Optional** — the **host worker task role ARN**, `arn:aws:iam::<host>:role/awsops-v2-worker-task`
  (Terraform output `worker_task_role_arn`): only needed if this target account will be read by a
  WORKER-driven member-account job against it — the sg-rules Athena scan (`sg_rule_scan.py`) or a
  Network Path Check's live-identity resolution (`network_path.py`'s `resolve_live_identity()`/
  `fetch_live_topology()`, see `docs/runbooks/network-path-eks-access.md`). Neither worker's task
  role is trusted by this account until `WorkerTaskRoleArn` below is set — omitting it leaves those
  two features correctly failing closed (AccessDenied) against this account, exactly as if it were
  never onboarded for worker-driven reads at all.
- **3rd-party only**: a chosen **ExternalId** string (8–1224 ASCII letters, digits or `_+=,.@:/-` for the browser path), same value in the CFN and `/accounts`.
  1st-party (same-org) accounts can omit it.

## Manual CLI alternative
1. In the **target account**, deploy the CloudFormation template:
   ```
   aws cloudformation deploy \
     --template-file infra/cfn/awsops-target-account-role.yaml \
     --stack-name awsops-readonly-role \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides \
       HostTaskRoleArn=arn:aws:iam::<host>:role/awsops-v2-task \
       WorkerTaskRoleArn=arn:aws:iam::<host>:role/awsops-v2-worker-task \
       ExternalId=<YOUR_EXTERNAL_ID>
   ```
   Omit `WorkerTaskRoleArn` unless a worker job needs the account. Omit `ExternalId` for
   explicitly selected first-party onboarding. Keep line continuations only between actual arguments.
   The stack outputs `RoleArn` (`arn:aws:iam::<target>:role/AWSopsReadOnlyRole`). Re-running
   `aws cloudformation deploy` with the SAME `--stack-name` against an already-onboarded account is
   an in-place update — adding `WorkerTaskRoleArn` to an existing stack is additive and does not
   revoke the existing web-task-role trust.
2. In AWSops, open **Accounts (`/accounts`)** as an admin → **Connect an AWS account**
   (Korean: **AWS 계정 연결**) → enter the target Account ID, alias and initial region.
   In **Advanced: ExternalId · AWS CLI profile**, enter the ExternalId already used above.
   For first-party onboarding, explicitly select the visible same-organization checkbox;
   the submitted ExternalId becomes empty while the draft value is retained. Then select
   **Verify and register** (Korean: **연결 확인 및 등록**). Registration is
   rejected (400) if ExternalId is empty and that box is unchecked, so omission is an explicit
   choice. AWSops assumes the role and confirms `GetCallerIdentity.Account` matches the submitted ID
   (status → `verified`) before saving.
3. Use the **global account selector** (sidebar) to switch the active account, or pick **All accounts**
   to aggregate cost / Bedrock across every enabled account (the dashboard aggregates client-side).

## Notes
- **ExternalId is not a secret** — it is a confused-deputy guard, stored in plaintext so AWSops can pass
  it to `sts:AssumeRole`. Treat it like a coordination value, not a credential.
- Host account: no role needed (AWSops uses its own task-role credentials for the host).
- To remove an account, use the **제거** button on `/accounts` (the host row is protected).
- The host web task role is granted `sts:AssumeRole` only on `arn:aws:iam::*:role/AWSopsReadOnlyRole`
  (read-only assume). Tighten the wildcard to specific account IDs if your account set is fixed.

## Related files and decisions

- `web/app/accounts/AccountOnboarding.tsx` and its test: setup, draft ExternalIds and explicit consent.
- `web/app/accounts/page.tsx` and its test: account actions and reload failures.
- `web/app/api/accounts/onboarding/route.ts`: authenticated admin discovery.
- `web/lib/account-onboarding.ts`: generated create-only script and input contract.
- `infra/cfn/awsops-target-account-role.yaml` and `scripts/v2/test_account_onboarding_template.py`: canonical template parity.
- ADR-011: explicit first-party omission and third-party ExternalId requirements.
- ADR-005: target administrators execute the generated script outside AWSops; this is not a product mutation exception.
