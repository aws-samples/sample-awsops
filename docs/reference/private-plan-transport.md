# Private plan transport helper

`scripts/v2/ci_private_plan.py` is an **unwired module prerequisite**. The current
`.github/workflows/terraform.yml` still uses its existing encrypted GitHub artifact
flow: it does **not** call this helper, publish private S3 plans or produce a private
`reference.json`. This module provisions no bucket, IAM policy, role or workflow.
Do not use its operator commands against that base workflow; the consumer integration
must land and produce the required artifacts first. Existing operator procedures remain
separate.

## Four modes and their boundaries

| Mode | Required contract | Result |
|---|---|---|
| `policy` | Authenticated publisher CI context, private `--backend`, selected `--role-arn`, new destination | Private store and restrictive session-policy files; no AWS call or role assumption |
| `publish` | Publisher context, validated private `--store`, exact checkout, CI HMAC key and installed scoped credentials | Verifies the encrypted handoff, uploads private versioned S3 objects and writes a public-safe reference file |
| `inspect` | Local operator only, explicit `--profile`, **required** private `--backend`, exact checkout with provider schemas already installed, new destination | Private plan text/JSON and an `inspected_not_approved` receipt; no CI HMAC key or approval |
| `restore` | Protected consumer CI context, private `--backend`, exact checkout, CI HMAC key and private reviewed plan hash | Verifies and restores the exact plan/assets; no Terraform apply |

All modes bind repository, branch, commit, source run and scope. The authenticated
source supplies its attempt; callers cannot choose an independent attempt. Backend
parsing accepts only supported static fields and the default workspace. Inspection
and restore validate the backend before any command or network request; there is no
bucket enumeration/discovery fallback. Publication uses the policy mode's validated
backend store. Callers must protect backend/configuration inputs and generated files.

## Required future workflow integration

The consumer must retain the existing manual-dispatch, branch/SHA, authorization,
DNS/runtime and exact reviewed-plan gates. It must provide:

1. Source workflow `.github/workflows/terraform.yml`, successful job display name
   `Plan`, and publisher job ID `publish` with display name **`Publish private plan`**.
   `policy`/`publish` authenticate the in-progress publisher and completed Plan;
   inspection/restore require successful completion of both jobs and the source run.
   The source branch must still match the requested commit.
2. An attempt-specific artifact **`tfplan-${GITHUB_RUN_ATTEMPT}`** containing exactly
   `tfplan.enc` and `tfassets.enc` before publication. Only after confirmed publication
   may the consumer overwrite it with exactly `reference.json`. The helper verifies
   authenticated artifact identity, complete bounded enumeration, expiry and ZIP digest;
   it does not upload, replace or delete GitHub artifacts itself.
3. A fresh, protected deployer session using the generated nonempty policy. Its scope
   is the selected bucket's posture reads, this run's object prefix and constrained KMS
   use, not backend state access or infrastructure/IAM mutation. Required bucket posture
   requires owner/region agreement, Enabled versioning, all four public-access blocks,
   BucketOwnerEnforced and matching default SSE-KMS settings. Existing role/key policies
   must grant the required S3/KMS operations; the session policy only restricts them.
   This module installs none of those prerequisites.
4. `TF_PLAN_ENC_KEY` for publish/restore and the existing plan packing operation.
   Publication decrypts the handoff and verifies the existing authenticated asset
   archive before storage writes; restore verifies the same plan/context/asset contract.
   Local inspection does not require or read this CI key.
5. Private handling of the reviewed plan hash, backend, policy and rendered outputs.
   Mask private inputs **before** step-environment logging and prevent shell tracing.
   Helper stdout cannot redact a caller's logs. Apply must use the restored saved plan,
   retain all existing gates and own its final cleanup; restore is not apply authority.

These names and boundaries are executable helper requirements, not claims that the
base workflow already implements them. Consumer workflow tests belong with that
integration, not this module.

## Public and private data

The public reference has exactly `schema`, `storage`, `context` and `manifest`.
`context` contains only repository, branch, commit, run ID, attempt and scope;
`manifest` contains only its opaque `sha256` and `bytes`. There is no public plan hash,
backend/bucket hash, region, bucket name, account ID, ARN, state key or object version.
Successful CLI results expose fixed status and local output paths, not those private
hashes or storage identities.

The private manifest binds the backend/account and content-addressed plan/assets with
exact versions, sizes and hashes. Consumers compare every normalized backend field
and the authenticated account before using it. S3 body reads pin a version and verify
bounded size, encryption metadata and content hash. Writes require confirmed versions
and checksums. The backend state object is never read.

Local rendered outputs and receipts are mode0600 in a new mode0700 destination.
The receipt carries the private plan/backend hashes for review, explicitly marked
`inspected_not_approved`; it is not human attestation. Limits are 2 MiB metadata,
16 KiB reference/manifest, 64 MiB plan, 136 MiB assets and 32 MiB per rendered file.
The five-day reference age/expiry checks do not install or prove an S3 lifecycle policy.

Errors use fixed categories without provider output. Cleanup covers only owned local
scratch/output paths. Partial uploads never produce a success reference and are not
automatically deleted. There is **no orphan recovery/delete mode**, and no promise that
an incomplete publication or a legacy artifact can be recovered with this helper.

## Offline verification

Use the existing Python test dependencies in `scripts/v2/requirements-test.txt`,
OpenSSL and the repository's Terraform test version (1.15.7). These tests use fake
GitHub/AWS CLI responses, real local crypto/archive checks and local Terraform fixtures:

```bash
python3 -m pytest -q -p no:cacheprovider \
  scripts/v2/test_ci_private_plan.py scripts/v2/test_ci_tf_assets.py \
  scripts/v2/test_ci_plan_inspect.py scripts/v2/test_ci_plan_context.py
```

This adds no Python dependency. Runtime integration additionally needs authenticated
GitHub CLI, AWS CLI and Terraform/provider schemas in the appropriate protected
environment; the offline tests neither install that consumer nor prove live access.
