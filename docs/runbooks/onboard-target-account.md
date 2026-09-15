# Runbook: Onboard a target account (multi-account) / 타깃 계정 온보딩

AWSops reads connected accounts cross-account by assuming a **read-only** role (`AWSopsReadOnlyRole`)
in each target account. Trust is pinned to the host task roles; an **ExternalId** (confused-deputy
guard) is **optional for 1st-party accounts** and **required for 3rd-party/shared accounts**
(ADR-011 amended 2026-06-26). AWSops never mutates target-account resources.

With `inventory_host_only=true`, configure the deployment for multi-account collection before
adding enabled target accounts. Foreign account registration returns HTTP 409; the collector
also rejects an enabled foreign scope. Agent MCP IAM grants are unchanged. See [runtime activation](runtime-foundation.md).

`inventory_host_only=true`이면 활성 타깃 추가 전에 다중 계정 수집 구성으로 전환합니다.
외부 계정 등록은 HTTP 409로 거부되며 수집기도 활성 외부 범위를 거부합니다. Agent MCP IAM 권한은 유지됩니다.

## Browser-assisted onboarding

Open `/accounts` as an administrator and enter the target Account ID, alias and region.
The page discovers the current web task role through the authenticated, admin-only
`GET /api/accounts/onboarding` route. No host ARN needs to be copied from Terraform.
It generates an ExternalId for the form and script; under advanced settings, replace it
with the existing role's value or explicitly select same-organization omission.

Choose **Copy AWS CLI commands** or **Download script (.sh)**. The script embeds its
CloudFormation template, so the target administrator does not need a repository checkout.
Run it in the **target account's** CloudShell, or Bash with AWS CLI v2 and target-account
credentials. Upload a downloaded file through **Actions → Upload file**, then execute the
displayed `bash` command. A named CLI profile can be included in advanced settings.
IAM role creation/policy attachment and CloudFormation deployment permissions are required.

The script checks `GetCallerIdentity.Account` before any deployment and stops on a mismatch.
It deploys `awsops-readonly-role`, pins trust to the discovered host web role and grants
`ReadOnlyAccess`. Existing `WorkerTaskRoleArn` stack parameter values are preserved on
updates; new stacks leave worker trust empty. Worker reads require the additional setup below.
The generated template in `web/lib/account-onboarding.ts` uses the same role logical ID,
parameters and trust conditions as `infra/cfn/awsops-target-account-role.yaml`.

After stack completion, return to the same form and choose **Verify and register**.
Verification failure preserves the fields for retry. If the page was reloaded, restore
the ExternalId used to create the role. `AlreadyExists` means an existing role must be
checked, not deleted: use its trust policy/ExternalId and verify from the form.
Allow for IAM propagation if verification fails immediately after creation.

Host-only deployments display the restriction before registration and disable the register
button. Script generation remains available for preparation; running it does not change
`inventory_host_only`, collector IAM, or readiness policy. Multi-account activation is a
separate operator configuration step. AWSops itself never executes the generated AWS writes.

## Prerequisites
- Admin access to AWSops (`/accounts` is gated by Cognito `ADMIN_GROUP` or the SSM email allowlist).
- The **host web task role ARN** — full ARN `arn:aws:iam::<host>:role/awsops-v2-task` (Terraform output `web_task_role_arn`).
  (When the multi-account inventory fan-out ships, the steampipe task role is added then.)
- **Optional** — the **host worker task role ARN**, `arn:aws:iam::<host>:role/awsops-v2-worker-task`
  (Terraform output `worker_task_role_arn`): only needed if this target account will be read by a
  WORKER-driven member-account job against it — the sg-rules Athena scan (`sg_rule_scan.py`) or a
  Network Path Check's live-identity resolution (`network_path.py`'s `resolve_live_identity()`/
  `fetch_live_topology()`, see `docs/runbooks/network-path-eks-access.md`). Neither worker's task
  role is trusted by this account until `WorkerTaskRoleArn` below is set — omitting it leaves those
  two features correctly failing closed (AccessDenied) against this account, exactly as if it were
  never onboarded for worker-driven reads at all.
- **3rd-party only**: a chosen **ExternalId** string (≥8 chars), same value in the CFN and `/accounts`.
  1st-party (same-org) accounts can omit it.

## Steps
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
2. In AWSops, open **계정 관리 (`/accounts`)** as an admin → **계정 추가** → enter the target Account ID,
   an Alias, the Region, and the ExternalId. **For 1st-party (no-ExternalId) onboarding: leave
   ExternalId blank AND tick the "1st-party 계정 (ExternalId 생략)" checkbox** — registration is
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
