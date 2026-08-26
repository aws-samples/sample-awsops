# Runbook: Onboard a target account (multi-account) / 타깃 계정 온보딩

AWSops reads connected accounts cross-account by assuming a **read-only** role (`AWSopsReadOnlyRole`)
in each target account. Trust is pinned to the host task roles; an **ExternalId** (confused-deputy
guard) is **optional for 1st-party accounts** and **required for 3rd-party/shared accounts**
(ADR-011 amended 2026-06-26). AWSops never mutates target-account resources.

## Prerequisites
- Admin access to AWSops (`/accounts` is gated by Cognito `ADMIN_GROUP` or the SSM email allowlist).
- The **host web task role ARN** — full ARN `arn:aws:iam::<host>:role/awsops-v2-task` (Terraform output `web_task_role_arn`).
  (When the multi-account inventory fan-out ships, the steampipe task role is added then.)
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
       ExternalId=<YOUR_EXTERNAL_ID>   # OMIT this line for 1st-party (no-ExternalId) onboarding
   ```
   The stack outputs `RoleArn` (`arn:aws:iam::<target>:role/AWSopsReadOnlyRole`).
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
