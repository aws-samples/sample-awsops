# Private S3 Terraform plans

## Decision and scope

The operator requested private S3 storage instead of sharing `TF_PLAN_ENC_KEY`.
Store the exact saved plan and authenticated Lambda assets in the configured
Terraform backend bucket, under a separate `ci/tfplans/` prefix. Inspect the plan
through the operator's AWS profile and SSE-KMS permissions. Apply the exact
reviewed bytes through the existing protected Terraform workflow.

The existing plan role stays read-only. A separate publication job uses the
existing branch-selected deployment role with an S3/KMS-only session policy.
No new bucket, key, IAM allow, bucket policy or lifecycle configuration is needed.
Publication fails unless the existing bucket is private, versioned, same-account
and encrypted with SSE-KMS. Existing production environment protection still
applies to its deployment role.

An encrypted, attempt-specific GitHub artifact is an intermediate handoff between
the two jobs. After S3 publication succeeds, the publisher replaces that artifact
with a small nonsecret reference. Only the reference remains after a successful
run. A failed publication may leave the encrypted handoff for one day. Plaintext
plan/asset data is never uploaded to GitHub or printed in its logs.

This storage change does not relax inventory, deployment, review or branch gates.
Public plan summaries remain advisory; this rollout requires full private review.

## Source and storage contracts

Only successful manual `terraform.yml` plan runs are eligible for inspection or
apply. Bind repository, branch, full commit SHA, run ID, run attempt and plan
scope. Existing supported branches and scopes remain unchanged. Automatic PR/push
plans produce diagnostics but no transferable saved-plan artifact.

Parse the existing static backend configuration without evaluation. Require the
default workspace, its configured region, encryption, and a valid bucket/key;
reject unknown fields, duplicate assignments, interpolation, custom endpoints and
state keys using the reserved artifact prefix.

The private prefix is:

```text
ci/tfplans/<repository>/<branch>/<commit>/<run-id>/<attempt>/
```

The state key is never read or written by the publisher or inspector. The existing
backend bucket's retention applies to these private objects; this change does not
claim an automatic S3 expiry policy. The GitHub reference expires after five days,
after which a new plan is required for deployment.

Upload single objects with explicit SSE-KMS, the expected bucket owner,
`If-None-Match: *` and SHA-256 checksums. Require returned version IDs and retain
them in a private manifest. Objects have content-addressed names. Uncertain or
conflicting writes fail the publication rather than trusting an existing object.

The private manifest contains the source context, backend binding and the exact
key, version ID, byte length and SHA-256 for both plan and asset archive. Its own
content-addressed key and hash are bound by the public reference.

The public reference contains only schema/storage kind, source context, storage
region, bucket-name hash, backend binding hash, manifest hash/length and plan hash. It contains no bucket name,
account ID, ARN, object version ID, configuration value or plan content.

## Publication and verification

1. The plan job creates `tfplan` and packs assets with the existing HMAC contract.
   It encrypts both and uploads `tfplan-<attempt>` with one-day retention.
2. The protected publisher downloads that exact attempt's handoff. It validates
   its own manual-run context and successful plan job, decrypts privately and
   verifies the existing asset HMAC, plan hash, commit and scope before S3 writes.
3. The publisher verifies caller and bucket posture, then uses only the scoped
   S3/KMS session. It uploads the two objects and private manifest, checks the
   returned identity/checksum/version, and emits the safe reference.
4. `actions/upload-artifact@v4` replaces `tfplan-<attempt>` with that reference,
   with five-day retention. Publication is required; it is not advisory.
5. Consumers authenticate the completed source run and publisher job, select the
   unique nonexpired artifact for its current attempt, and verify its ZIP digest,
   sole regular `reference.json` entry, bounded size and exact schema.
6. Consumers derive the private prefix from the verified context, fetch and hash
   the private manifest, and download pinned plan/asset versions with size and
   checksum bounds. No path or endpoint comes from an unchecked reference.

A publisher-only rerun without a matching current-attempt handoff fails and needs
a fresh plan. A failed/skipped publisher, expired reference, moved branch or
missing/mismatched object never becomes an approved plan.

## Private inspection

The inspector runs locally, rejects `GITHUB_ACTIONS=true`, and accepts an explicit
AWS profile, optional backend file, exact checkout and new destination. Without a
backend file it discovers the unique bucket-name hash match from at most 1,000
owned bucket names; incomplete enumeration or ambiguity fails. This metadata-only
discovery reads no Terraform state. An explicit backend remains useful for
operators without bucket-list permission. It downloads only
the plan, then writes `plan.txt`, `plan.json` and a review receipt to a new 0700
directory with 0600 files. Terraform rendering has no deployment credentials,
backend initialization, debug overrides or raw console output.

The operator needs IAM/SSE-KMS read permission, not the client encryption key.
Inspection does not restore assets, approve, re-plan or apply. Its receipt records
the verified source context and plan SHA-256 for the existing apply workflow.

## Exact apply

Add the required `reviewed_plan_sha256` input for apply. This is the tenth dispatch
input; do not add another input or weaken the current source/branch checks.
The apply job retrieves the reference and private objects, requires the supplied
hash, and restores the existing HMAC-authenticated assets using the CI-held key.
It then runs the existing host, DNS/runtime, branch and saved-plan apply checks.
The CI asset authentication key stays inside CI and is not exported to operators.

## Security and failure handling

- Scope S3 access to the selected bucket metadata and exact artifact prefix.
  Scope KMS use to S3 in that region/account and the bucket/object context.
  The publisher cannot mutate application infrastructure through its session.
- Preserve temporary AWS credentials while removing endpoint overrides,
  Terraform/GitHub command channels and unrelated secrets from child commands.
- Use fixed error categories; never echo provider exceptions, URLs containing
  credentials, raw plan output or decrypted data.
- Bound JSON, ZIP and downloaded bytes; reject links, duplicate entries/keys,
  unsafe paths and existing inspection destinations.
- Cleanup owns only this run's private scratch. Runner loss can prevent cleanup;
  neither an `always()` step nor a local finalizer is an unconditional guarantee.
- Preserve the existing HMAC/archive checks and encrypted failure recovery.

## Validation and rollout

Offline tests cover valid publication/download, foreign or stale provenance,
wrong attempts, failed publishers, expired/tampered references, unsafe archives,
wrong backend/caller/bucket posture, missing versions, changed bytes, conflicting
writes, cleanup failures and secret omission. Workflow tests prove that only
manual plans publish, the publisher has protected/scoped credentials, reference
replacement follows successful upload, and apply requires the reviewed hash.

After latest-HEAD AI review and required CI, dispatch a fresh development plan.
Inspect it privately through `samples`, verify the intended resource changes,
apply that exact hash, and confirm actual deployed state. Only then continue
readiness enablement, AgentCore provisioning and mandatory full 43-type/runtime
verification.

## Sources

- `terraform/bootstrap/main.tf`, `.github/workflows/terraform.yml`
- `scripts/v2/ci_plan_context.py`, `ci_plan_inspect.py`, `ci_tf_assets.py`
- `https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html`
- `https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html`
- `https://repost.aws/knowledge-center/decrypt-kms-encrypted-objects-s3`
