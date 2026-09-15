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
An alias is required for registration, but not for a connection check. The check is available
only for the probe scope described below; creating the target role does not authorize a probe.

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

When the deployed web configuration supplies `INVENTORY_TASK_ROLE_ARN`, the script also
passes that exact host-account principal as `InventoryTaskRoleArn`. Its separate trust
statement uses the same ExternalId condition. An absent parameter preserves the existing
web/worker trust unchanged. Existing stacks require an operator-reviewed change set to add
the collector principal; the browser script remains create-only.

New stacks leave worker trust empty. Worker reads require the additional setup below.
The generated template's deployment contract matches `infra/cfn/awsops-target-account-role.yaml`;
only explanatory template/parameter/output descriptions differ. The required offline
`scripts/v2/test_account_onboarding_template.py` test compares all deployment parameters,
resources, conditions and outputs, including trust and permission policies.

After stack completion, return to the same form and choose **Check connection**, or
**Verify and register** when registration is enabled for that account.
Verification failure preserves the fields for retry. A successful registration followed by
a failed list refresh remains successful, prevents repeat registration/script generation
for that account and asks for a page refresh. Delete, connection-test and region-add reload
failures show a refresh error rather than an unhandled rejection or a success message
beside stale rows. When browser session
storage is unavailable or a new session is used, restore the ExternalId from the original
script or target role trust policy. Allow for IAM propagation after creation.
For a combined registration failure, the page shows a fixed status-specific explanation.
An assume/validation failure offers **Diagnose connection** (Korean: **연결 원인 확인**)
only when the form's target is explicitly allowlisted and its check is available.
Legacy multi-account registration without an allowlist can still be attempted, but a failed
new-target registration cannot use that check. Its fixed recovery message instead points
to the read-only commands, role/trust/ExternalId configuration and operator approval scope.
When available, select the diagnostic explicitly; the page does not automatically repeat
STS requests. Editing only the alias or CLI profile preserves the previous diagnostic;
changing account, region, ExternalId or first-party choice clears it.

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
button. A separate connection check performs no registry writes. The onboarding form offers
it only for an explicitly allowlisted new target; without an applied list that control is disabled.
Registered rows retain their existing **Test** (`PATCH /api/accounts`) action; the onboarding
form does not recreate roles or change saved ExternalIds for those rows.
Script generation remains available for preparation; running it does not change
`inventory_host_only`, collector IAM, or readiness policy. Multi-account activation is a
separate operator configuration step. AWSops itself never executes the generated AWS writes.

## Connection evidence and AI guidance

Diagnostics report `stsRegion` separately from the requested registration/inventory
`region`. Older responses leave the endpoint region unknown. Neither field proves
activation of the requested inventory region.

The admin-only `POST /api/accounts/onboarding` validates the target ID, region and current
ExternalId/first-party choice. Within one 15-second deadline, it verifies the actual host
STS identity, assumes only `AWSopsReadOnlyRole`, then verifies the resulting target account.
All three STS operations use the deployment `AWS_REGION`, defaulting to `ap-northeast-2`,
matching registration. `diagnostic.region` records the selected collection region, not the
STS endpoint; successful identity checks do not prove inventory collection in that region.
Success establishes that web-role connection only; it neither registers the account nor
certifies collection, worker or AgentCore access.

Probe admission follows the applied configuration:

- The caller must be an administrator with a nonempty immutable Cognito `sub`.
- A target must be in `INVENTORY_TARGET_ACCOUNT_IDS` **or** match an enabled, nonhost
  registry entry. An out-of-list registered target can be checked, but this does not
  permit a new registration or change collector/runtime scope.
- After single-flight/cooldown admission, unregistered, unlisted targets return HTTP 409
  with `code: target_not_configured` before STS, including legacy multi-account mode. Missing allowlists do not authorize
  arbitrary diagnostic targets. Invalid configuration or failed registry lookup returns 503.
- Host-account and invalid-input checks remain in place.

The server permits one in-flight probe per process, including its approval lookup, and
at least 60 seconds between admissions. The cooldown begins before lookup, so rejected
or failed registry lookups consume it too. Registry lookup has a separate three-second
deadline: timeout returns fixed `scope_unavailable`/503, releases admission and discards
any checked-out DB connection. A late checkout is released without SQL; a late approval
cannot start STS. The independent 15-second STS budget is unchanged.
A concurrent or cooling-down request returns HTTP 429 with
`probe_in_flight` or `probe_cooldown`, `retryAfterSeconds` and `Retry-After`.
Respect that wait and retry manually; the page never auto-resubmits. The wait is guidance,
not a promise that another administrator's in-flight request will have finished.
These scope/rate rejections contain safe boundary metadata, not an AWS-stage diagnostic.
Unexpected verifier failures return fixed `check_failed`/503, release single-flight,
and preserve the cooldown; provider exception text is never returned.

Each result includes a check ID, UTC timestamp, verification stage, fixed failure code,
duration and an AWS request ID when available. The web log event is
`account_connection_check` with the same bounded fields plus the requesting administrator's
`actor_sub`. Scope/rate rejections use `account_connection_rejected` with the actor,
check ID, target ID and fixed code. Provider exception text,
temporary credentials and the ExternalId value are excluded from these diagnostics.
`access_denied` is evidence of rejection, not proof of which policy caused it: compare the
source role permission, target trust, current ExternalId and organization/session boundaries.
Credential failures, timeouts and identity mismatches have separate classifications.

In the deployed web log group, select a bounded time range and correlate the returned
check ID using CloudWatch Logs Insights. Rejected checks omit AWS-stage fields when no
STS request ran; missing fields are not successful verification.

```text
fields @timestamp, event, checkId, accountId, actor_sub, stage, code, awsRequestId, durationMs
| filter event in ["account_connection_check", "account_connection_rejected"]
| filter checkId = "<check-id>"
| sort @timestamp desc
| limit 50
```

The troubleshooting panel provides read-only target-account CLI commands and an AI
assistant draft containing only validated evidence. The draft is reviewed in the composer
before sending; opening it does not invoke a model. The draft is a single section-pinned
line of at most 500 characters and requests read-only analysis/check commands. Do not paste
credentials, raw errors or the ExternalId into an AI request.

The copied diagnostic commands run inside a child Bash heredoc, so a wrong-account
`exit 1` does not close the parent CloudShell session or leave its variables behind.
The role query displays principal metadata and condition operator/key names only, never
condition values. Failure/preflight events use
`aws cloudformation describe-events --stack-name awsops-readonly-role --filters FailedEvents=true`;
the projection omits raw reason/property fields and shows at most 50 events, not a complete history.

For deployments with an explicit `INVENTORY_TARGET_ACCOUNT_IDS` allowlist, registration
is limited to the applied accounts. Its value must be a JSON array of at most five unique
12-digit account-ID strings, excluding the host. An explicit `[]` permits no new targets.
Absent/empty environment values retain legacy scope; whitespace-only, malformed JSON,
wrong types, duplicate IDs or the host ID fail closed with 503. Do not turn malformed
configuration into an unrestricted default. Host-only registration and out-of-list targets
return 409 before STS or database writes.

Terraform supplies `INVENTORY_TASK_ROLE_ARN` when Steampipe is enabled and derives
`INVENTORY_TARGET_ACCOUNT_IDS` from nonempty `runtime_verification_targets` for both the web
and collector tasks. The collector role is the **Steampipe task role**
(`${project}-steampipe-task`); `InventoryTaskRoleArn` is its target-template parameter name,
not a separate role. Read its ARN from the `inventory_task_role_arn` Terraform output.
The dev/full `CI_RUNTIME_TARGETS_DEV` input, saved-plan binding and strict member runtime
proof are documented in [runtime activation](runtime-foundation.md). Rebuild and pin the
reviewed ARM64 Steampipe image containing the scope guard before applying member scope.
The role trust, source permission, registry and release proof must agree; role creation alone
does not complete activation. No app request changes these deployment settings.
The collector's existing 300-second watchdog reloads approved account/region changes;
observe fresh target evidence before release verification. Coordinate any ExternalId
rotation between target trust and the registered web/collector value. Explicit first-party
omission removes that condition from both trust statements.

The onboarding list is not a retroactive revocation mechanism for existing registered-account
reads or PATCH re-tests. Collector and CI scope are enforced separately. Review/remove or
disable obsolete registered scope through the existing operator procedure rather than assuming
an allowlist edit revokes every previously configured read path.

## Prerequisites

- Admin access to AWSops (`/accounts` is gated by Cognito `ADMIN_GROUP` or the SSM email allowlist).
- For the manual CLI path below: the **host web task role ARN** — full ARN
  `arn:aws:iam::<host>:role/awsops-v2-task`, in Terraform output
  `runtime_deployment.web.task_role_arn`. The browser path discovers it automatically.
  The host-side projection below uses Terraform and `jq`.
- For inventory collection, the exact **host inventory task role ARN** must be supplied as
  `InventoryTaskRoleArn`. This is the Steampipe task role, exposed through
  `inventory_task_role_arn` and the applied web configuration.
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

1. In the **host checkout with its configured backend**, read the nonsecret role identities:
   ```bash
   terraform -chdir=terraform/foundation output -json runtime_deployment \
     | jq -er '.web.task_role_arn | select(type == "string")'
   terraform -chdir=terraform/foundation output -raw inventory_task_role_arn
   ```
   Inventory must be enabled; a null or unavailable collector role is not a valid principal.
   After adding this output to an older applied stack, persist the reviewed output before using it.
   The already-applied `runtime_deployment.inventory.task_role_arn` is also the collector's
   identity, available through `terraform -chdir=terraform/foundation output -json runtime_deployment`.
   Do not substitute a guessed ARN. Record these nonsecret values for the target-account step.
2. In the **target account**, replace the placeholders and deploy the CloudFormation template:
   ```bash
   aws cloudformation deploy \
     --template-file infra/cfn/awsops-target-account-role.yaml \
     --stack-name awsops-readonly-role \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides \
       'HostTaskRoleArn=<host-web-task-role-arn>' \
       'InventoryTaskRoleArn=<host-steampipe-task-role-arn>' \
       'WorkerTaskRoleArn=<host-worker-task-role-arn>' \
       'ExternalId=<existing-or-new-external-id>'
   ```
   Include `InventoryTaskRoleArn` for inventory collection. Omit it only when collector
   trust is intentionally not being configured; that omission is not collection readiness.
   Omit `WorkerTaskRoleArn` unless a worker job needs the account. Omit `ExternalId` for
   explicitly selected first-party **new-stack** onboarding. Keep line continuations only
   between actual arguments, and keep actual ExternalId values out of shared logs and AI prompts.
   The stack outputs `RoleArn` (`arn:aws:iam::<target>:role/AWSopsReadOnlyRole`). Re-running
   `aws cloudformation deploy` with the SAME `--stack-name` against an already-onboarded account is
   an update: for an existing stack, prepare and inspect a change set before execution.
   Adding the collector/worker principal is additive only when the existing web/worker trust,
   ExternalId condition, role name/identity and `ReadOnlyAccess` policy are preserved.
   Do not change `RoleName` or replace a working role to add trust.
3. In AWSops, open **Accounts (`/accounts`)** as an admin → **Connect an AWS account**
   (Korean: **AWS 계정 연결**) → enter the target Account ID, alias and initial region.
   In **Advanced: ExternalId · AWS CLI profile**, enter the ExternalId already used above.
   For first-party onboarding, explicitly select the visible same-organization checkbox;
   the submitted ExternalId becomes empty while the draft value is retained. Then select
   **Verify and register** (Korean: **연결 확인 및 등록**). Registration is
   rejected (400) if ExternalId is empty and that box is unchecked, so omission is an explicit
   choice. Registration must also be allowed by the applied host/target scope. AWSops assumes the role and confirms `GetCallerIdentity.Account` matches the submitted ID
   (status → `verified`) before saving.
4. Use the **global account selector** (sidebar) to switch the active account, or pick **All accounts**
   to aggregate cost / Bedrock across every enabled account (the dashboard aggregates client-side).

## Notes
- **ExternalId is not a secret** — it is a confused-deputy guard, stored in plaintext so AWSops can pass
  it to `sts:AssumeRole`. Treat it like a coordination value, not a credential.
- The existing web/worker trust statement and the separate collector statement share one
  ExternalId condition. For a first-party new stack, omission removes that condition from
  **both** statements while keeping exact principal ARNs. For an existing stack, omission is
  not a rotation procedure: preserve the current value unless an operator-reviewed change
  deliberately changes it. Coordinate any rotation/removal across both target trust statements,
  the stored account value used by web/Steampipe, worker settings where used, and the separately
  configured Agent Lambda `AWSOPS_EXTERNAL_ID`. The browser create-only script does not
  rotate or remove an existing condition, and checking first-party does not update the target role.
- Host account: no role needed (AWSops uses its own task-role credentials for the host).
- To remove an account, use the **제거** button on `/accounts` (the host row is protected).
- The host web task role is granted `sts:AssumeRole` only on `arn:aws:iam::*:role/AWSopsReadOnlyRole`
  (read-only assume). Tighten the wildcard to specific account IDs if your account set is fixed.

## Related files and decisions

- `web/app/accounts/AccountOnboarding.tsx` and its test: setup, draft ExternalIds and explicit consent.
- `web/app/accounts/page.tsx` and its test: account actions and reload failures.
- `web/app/api/accounts/onboarding/route.ts`: admin discovery and bounded, scoped connection diagnostics.
- `web/lib/account-connection.ts`: bounded STS sequence and safe result classification.
- `web/lib/account-connection-diagnostics.ts` and `web/app/accounts/AccountConnectionDiagnostics.tsx`: client-safe metadata, fixed messages, read-only commands and AI draft.
- `web/lib/account-registration-scope.ts`: fail-closed deployment target parsing.
- `web/lib/account-onboarding.ts`: generated create-only script and input contract.
- `terraform/foundation/steampipe.tf`, `workload.tf` and `runtime-read-scope.tf`: collector identity output, task environment and applied member scope.
- `infra/cfn/awsops-target-account-role.yaml` and `scripts/v2/test_account_onboarding_template.py`: canonical template parity.
- ADR-011: explicit first-party omission and third-party ExternalId requirements.
- ADR-005: target administrators execute the generated script outside AWSops; this is not a product mutation exception.
