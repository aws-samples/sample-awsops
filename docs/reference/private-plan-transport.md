# Private plan transport helper

## Purpose

`scripts/v2/ci_private_plan.py` implements private saved-plan transport for
`.github/workflows/terraform.yml`. Manual planning publishes through the protected
storage session; local inspection uses the private backend and operator profile;
apply restores exact reviewed bytes with existing gates. The helper itself creates
no bucket, IAM policy or role. Use the [operator prerequisites and procedures](../runbooks/dev-repo-setup.md#private-exact-plan-inspection).

This is operator CI artifact transport, **not an ADR-005 exception** or a product
mutation/autonomy path. The module enables no frozen feature. ADR-005's product
boundary remains unchanged; ADR bodies are maintained in the private upstream repo.
It is also separate from ADR-007's product data connectors and governed external writes.

## Current design

### Four modes and their boundaries

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
The optional backend `encrypt` flag is state-backend metadata, not the artifact
encryption control. Omission normalizes to Terraform's default `false`; explicit
booleans are preserved in the private binding. This changes no backend file or
state encryption setting. Publication and reads still require the private bucket's
SSE-KMS posture, and uploads explicitly request and verify the resolved KMS key.

### Workflow integration contract

The workflow retains the existing manual-dispatch, branch/SHA, authorization,
DNS/runtime and exact reviewed-plan gates. Its required interfaces are:

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
   This integration migrates both Plan publication and Apply download together from
   the former artifact named `tfplan`. The existing
   `ci_plan_inspect.py` hardcodes `tfplan` and remains for historical encrypted artifacts;
   new S3 runs require this helper's `inspect` mode. Do not rename old artifacts or
   use the historical inspector to approve new-format plans.
   `actions/upload-artifact@v4` implements same-run `overwrite: true` through its
   runtime-token artifact client, not a `GITHUB_TOKEN` REST delete. This does **not**
   require increasing `actions: read` to `actions: write`. Keep read permission for
   authenticated run/artifact metadata; a future REST deletion would need a separate
   permission review.
3. A fresh, protected deployer session using the generated nonempty policy. Its scope
   is the selected bucket's posture reads, this run's object prefix and constrained KMS
   use, not backend state access or infrastructure/IAM mutation. A separate PUT
   statement requires explicit SSE-KMS;
   object reads do not require a request encryption header. Bucket posture
   requires owner/region agreement, Enabled versioning, all four public-access blocks,
   BucketOwnerEnforced, a nonpublic bucket policy (or no bucket policy), valid
   default SSE-KMS settings and the plan-prefix lifecycle below. Existing role/key policies
   must grant the required S3/KMS operations; the session policy only restricts them.
   This module installs none of those prerequisites.
   All four dev-family CI branches require the independent configured account ID.
   Bucket-default KMS aliases/IDs/ARNs are resolved with direct `kms:DescribeKey` into an
   enabled symmetric ENCRYPT_DECRYPT key in the expected account/region. The backend's
   state-object key is independently configured and is not compared with that bucket default.
   Existing IAM/key policies must permit DescribeKey; its session statement is separately
   scoped to the account/region's `key/*` ARN pattern, without S3-only encryption-context
   conditions. Policy generation makes no AWS request, so the resolved key is not yet
   known; existing identity/key policies must constrain effective access as appropriate.
   `policy` is publisher-only and cannot generate an Apply/restore policy. The helper
   checks caller identity but cannot prove which session policy was attached: the
   workflow installs the generated policy and tests that wiring. Restore uses the
   separately protected Apply role and its existing deployment authorization.
4. `TF_PLAN_ENC_KEY` for publish/restore and the existing plan packing operation.
   Publication decrypts the handoff and verifies the existing authenticated asset
   archive before storage writes; restore verifies the same plan/context/asset contract.
   Local inspection does not require or read this CI key.
5. Private handling of the reviewed plan hash, backend, policy and rendered outputs.
   Mask private inputs **before** step-environment logging and prevent shell tracing.
   Helper stdout cannot redact a caller's logs. Apply must use the restored saved plan,
   retain all existing gates and own its final cleanup; restore is not apply authority.
6. An owner-reviewed lifecycle configuration, verified by the helper before publication
   and private reads,
   filtered to exactly `ci/tfplans/`: expire current objects after seven days, delete
   noncurrent versions after seven days without retaining a minimum number of versions,
   and abort incomplete multipart uploads after one day. Do not broaden this filter
   to backend state or replace unrelated bucket lifecycle rules. Add expired delete-marker
   cleanup separately if needed. The helper requires `s3:GetLifecycleConfiguration`,
   checks the configured rule and rejects overlapping expiry/archive actions at or
   before the five-day read-window boundary. It installs no lifecycle configuration.
   The workflow retains this fail-closed check and its fixed diagnostics. Owners may
   enable the optional `terraform/bootstrap` retention resource after reconciling
   lifecycle ownership; the workflow never applies that bootstrap configuration.

These names and boundaries are executable helper requirements.
`test_ci_private_plan_workflow.py` checks the consumer wiring, input masking, source
guards and cleanup; helper tests exercise storage integrity independently.

### Public and private data

The GitHub handoff is application-encrypted with `TF_PLAN_ENC_KEY`. Publication
decrypts it in private scratch and stores the plan/assets **without that application
envelope**, using mandatory S3 SSE-KMS encryption at rest and TLS in transit. They are
not unencrypted on S3 storage. Authorized S3 GET returns decrypted bytes: principals
with effective `s3:GetObject`/`s3:GetObjectVersion` and `kms:Decrypt` access to these
objects can read them without the CI key. That reader population can be wider than
the original envelope's key holders, including existing state-bucket administrators.
Review prefix-scoped identity, bucket and key policies before rollout; do not assume
Block Public Access prevents an authorized account principal from reading secrets.
This deliberate tradeoff allows private operator inspection without sharing the CI key.

The public reference has exactly `schema`, `storage`, `context` and `manifest`.
`context` contains only repository, branch, commit, run ID, attempt and scope;
`manifest` contains only its opaque `sha256` and `bytes`. There is no public plan hash,
backend/bucket hash, region, bucket name, account ID, ARN, state key or object version.
Successful CLI results expose fixed status and local output paths, not those private
hashes or storage identities.

The private manifest binds the backend/account and content-addressed plan/assets with
exact versions, sizes and hashes. Consumers compare every normalized backend field
and the authenticated account before using it. S3 body reads pin a version and verify
bounded size, encryption metadata and content hash. Writes require confirmed versions,
KMS key and checksums. At most three identical conditional PUTs are attempted. A 412
is accepted only after a version-pinned private GET proves the existing bytes, size,
hash and encryption key; mismatches fail rather than overwrite. The backend state object
is never read.

Local rendered outputs and receipts are mode 0600 in a new mode 0700 destination.
The receipt carries the private plan/backend hashes for review, explicitly marked
`inspected_not_approved`; it is not human attestation. Limits are 2 MiB metadata,
16 KiB reference/manifest, 64 MiB plan, 136 MiB assets and 32 MiB per rendered file.
The five-day reference age/expiry checks do not install or prove an S3 lifecycle policy.
Seven-day current expiration in a versioned bucket first creates a delete marker;
the bytes then await noncurrent expiration. The seven-day noncurrent clock starts
when the version becomes noncurrent, so eligibility can be about fourteen days
after publication, plus S3's asynchronous deletion delay. Reference expiry is neither
an erasure deadline nor evidence that retained versions were deleted. Lifecycle also
covers orphan uploads; operators must monitor configuration and expired-version cleanup.

Errors use fixed categories without provider output. Cleanup covers only owned local
scratch/output paths. Partial uploads never produce a success reference and are not
automatically deleted. Same-attempt retries can recover a confirmed identical upload;
they do not bypass source/attempt or encrypted-handoff checks. There is **no arbitrary
orphan recovery/delete mode or legacy-artifact fallback**.

## Decisions

Use versioned private S3 storage for key-free operator reads, preserve the authenticated
CI asset contract for publication/restore, and require exact reviewed bytes at Apply.
Grant no IAM permissions or product mutation capabilities from this helper.

## Key files

- `scripts/v2/ci_private_plan.py`: four-mode transport and validation.
- `scripts/v2/test_ci_private_plan.py`: offline transport/security fixtures.
- `scripts/v2/test_ci_private_plan_workflow.py`: workflow adapters and executable operator procedures.
- `scripts/v2/ci_plan_inspect.py`: historical encrypted-artifact inspector.
- `.github/workflows/terraform.yml`: protected publication and exact-plan Apply.
- `terraform/bootstrap/`: optional owner-run plan-prefix retention.
- [CI/OIDC runbook](../runbooks/dev-repo-setup.md): existing operator procedures.

## Status

Workflow integration and offline tests are present. Owners must configure storage
and permissions before use. Source availability alone does not establish a live S3
publication, applied lifecycle configuration or successful deployment.

## Learnings

### Offline verification

Use the existing Python test dependencies in `scripts/v2/requirements-test.txt`,
Node.js, OpenSSL and the repository's Terraform test version (1.15.7). These tests use fake
GitHub/AWS CLI responses, real local crypto/archive checks and local Terraform fixtures:

```bash
python3 -m pytest -q -p no:cacheprovider \
  scripts/v2/test_ci_private_plan.py scripts/v2/test_ci_private_plan_workflow.py \
  scripts/v2/test_ci_tf_assets.py \
  scripts/v2/test_ci_plan_inspect.py scripts/v2/test_ci_plan_context.py
```

This adds no Python dependency. Runtime execution requires authenticated GitHub CLI,
AWS CLI v2 supporting conditional PUT/checksum arguments and Terraform/provider schemas.
Offline tests do not prove live access or successful deployment.

Related decision: ADR-005 — operator-controlled CI transport, not a carve-out.

## Source

- [Terraform 1.15.7 S3 backend](https://github.com/hashicorp/terraform/blob/v1.15.7/internal/backend/remote-state/s3/backend.go):
  `encrypt` is optional and `boolAttr` defaults an omitted value to false.
- [S3 expiration behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html):
  current/noncurrent versions and asynchronous deletion.
- [SSE-KMS permissions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html):
  server-side encryption and authorized reads.
- [Upload action overwrite implementation](https://github.com/actions/upload-artifact/blob/v4/src/upload/upload-artifact.ts)
  and [artifact client's internal deletion](https://github.com/actions/toolkit/blob/main/packages/artifact/src/internal/delete/delete-artifact.ts):
  same-run runtime-token transport is distinct from REST deletion.
