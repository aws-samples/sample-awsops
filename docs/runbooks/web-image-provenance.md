# Web image provenance helper contract

## Status and symptoms

`scripts/v2/ci_web_image.py` is a preparatory library/CLI. **No deployment workflow calls it yet.** Existing releases retain their current behavior until a separately reviewed wiring change supplies this contract. Do not describe this helper as a deployed migration or ECS release pipeline.

| Failure | Required action |
| --- | --- |
| Missing producer receipt/steps | Complete the wiring prerequisites below; existing builds do not gain receipts retroactively |
| Expired, missing or unverifiable receipt | Rebuild current source through receipt-enabled wiring; do not use a mutable tag as fallback |
| Development account missing/mismatched | Supply the protected 12-digit repository secret, including for main's exclusion check |
| Migration receipt missing | The future dev web caller must run its private migration phase and pass its successful SHA/project outputs |
| `Branch moved; dispatch current HEAD` | Stop a superseded push run and use the newer HEAD's release; do not rerun the obsolete SHA. For manual dispatch, start a new run at current HEAD and repeat validation |
| Schema acknowledgement missing | Do not promote an older image until compatibility is explicitly approved |
| Preflight digest missing/changed | Revalidate before migration; omitted or empty values cannot bypass the digest guard |
| Image registry/media/schema/platform mismatch | Verify the protected account/project and the retained image; rebuild if it is not a supported Linux ARM64 image |
| `Image provenance provider request failed [operation]` | Use the fixed operation label to check credentials, permissions, tool availability and provider status privately; raw provider output is withheld |
| `Image publication could not be confirmed` | Check provider status, credentials, local temporary-file access and the expected tag/digest. Once resolved, repeat the guarded selection/promotion with fresh validation; this diagnostic does not call for rebuilding the candidate |
| `Web image provenance or promotion failed` | Stop and inspect invocation/response shape and local filesystem failures privately; this generic fallback does not establish receipt expiry |
| Existing `web-build.json` (`O_EXCL`, surfaced through the generic fallback) | Use a fresh owned attempt directory; clean a confirmed leftover only through the owned receipt procedure below |
| `Producer attempt changed` | Stop this promotion; after the producer completes, start a new dispatch at current HEAD and repeat preflight before further migration/promotion |
| `Producer must be a completed same-repository, branch and source Deploy Web run` | Confirm the producer identity and completed status. A rerun still in progress reaches this check before attempt comparison; select an eligible completed producer or start a new dispatch after completion |

## Candidate causes

Receipt failures can mean incomplete publication, an ineligible producer, or a changing run.
Image validation failures concern the selected evidence; publication confirmation failures can
instead mean a transient request failure or a tag that still identifies the prior image.
Account/role permission alone does not establish which stack a branch may publish to.

## Verification and prerequisites

From the repository root:

```bash
python3 -m pytest -q scripts/v2/test_ci_web_image.py
```

These offline tests use no AWS/GitHub calls but require **jq**, Linux `/proc`, and **curl** on the pinned provider PATH for the localhost stdin/process-argument fixture. The CLI requires Python 3.12, AWS CLI, GitHub CLI and curl; `gh --jq` filters responses locally before the Python output cap. STS/ECR calls and config-download host validation are fixed to **`ap-northeast-2`**.

Supply `GH_TOKEN` for GitHub API calls, with `contents: read` for source checks. The receipt-producing `build` job and any consumer job that supports **reuse** also need `actions: read` for job/artifact metadata; a dedicated fresh-only consumer does not need that permission. A job supporting both fresh and reused images must retain it for the reuse path. OIDC jobs also retain `id-token: write`. AWS credentials come from the reviewed role for that specific job; credentials are never written into receipts. Build/deploy identity checks do not provision IAM.

The promoting role needs `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` and `ecr:PutImage` on the selected web repository; a read-only preflight needs the first two. **Each operation must target the one independently verified branch stack repository.** Any new grants must use that repository's exact ARN. The existing samples dev deployer has an `AdministratorAccess` baseline, and the build role's ECR policy covers repositories across the CI account; these broad permissions are not stack-selection authority or a claim of single-repository IAM isolation. Dev/preview branches share the account and repo-wide role configuration, so the caller's branch/stack checks remain essential. This helper adds no grants or IAM restrictions.

Config verification downloads only the manifest-referenced config blob from ECR's signed S3 URL; it checks size/hash and `linux/arm64` without downloading image layers.

Provider subprocesses pin `PATH` to `/usr/local/bin:/usr/bin:/bin`, matching the runner's installed AWS CLI, gh and curl; caller PATH/GITHUB_PATH additions cannot replace those tools. Caller `HOME` is omitted, never reassigned; `TMPDIR` and locale remain unchanged. AWS requires the complete exported `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` triple supplied by the earlier OIDC step; missing values stop before execution. AWS config/shared-credential/Boto files are disabled, configured endpoints are ignored, and instance metadata credentials are disabled. Profile, endpoint, model-path, credential-provider, proxy, CA and command-hook environment overrides are not inherited. AWS children pin `AWS_MAX_ATTEMPTS=1`, including the initial request, so the CLI cannot automatically retry mutations. These commands do not select a profile or assume another role.

This is a **CI environment-only credential contract**: setting local `AWS_PROFILE` alone does not authenticate the helper. An operator-invoked reviewed controller must explicitly export an approved temporary session before invoking it. For example, capture `aws configure export-credentials --profile <approved-profile> --format process` stdout/stderr in memory, require all three nonempty fields, and map `AccessKeyId`, `SecretAccessKey`, `SessionToken` into the corresponding `AWS_*` child environment variables above. Pass that environment directly to the helper process; never print the export, place credentials in argv, or persist them in files or shell configuration. For an in-process `promote(env, ...)` call, the mapping supplies deployment context/selection; child authentication still comes from `os.environ`. Export the approved session and GitHub token into that process before calling; credentials placed only in the mapping are insufficient. The existing validated workflow/role/source/digest inputs remain required; exporting credentials supplies authentication, not a provenance bypass.

GitHub receives only its explicit `GH_TOKEN` (or `GITHUB_TOKEN` alias), with an empty private config directory and prompting disabled. AWS credentials never reach gh/curl; the GitHub token never reaches aws/curl. Child stdin is closed with `DEVNULL` except for the explicit curl config payload. The signed URL is escaped into that private stdin payload for `curl -q -K -`, never placed in argv or a file; `-q` disables default curl configuration. Control characters in provider URLs are rejected, and provider stdout/stderr remain captured behind fixed diagnostics. Transport failures carry fixed STS/ECR/ECS operation labels, or a generic tool label for other operations; these labels introduce no shared AWS verb restriction.

`AWS_ACCOUNT_ID_DEV` must be a valid 12-digit **repository secret available to every helper invocation, including main**. Non-main roles must match it; main must differ. Main still requires the production role and target-stack checks in its caller. Do not define this secret only in the development environment or replace it with an invalid production override.

| CLI mode | Job context and prerequisites |
| --- | --- |
| `check-role` | Before assuming credentials: validates protected Deploy Web branch/workflow context, the role configured for this job in `CI_ROLE_ARN`, and `AWS_ACCOUNT_ID_DEV`; makes no provider call |
| `verify-role` | After OIDC: the same context plus actual STS credentials for that role; no receipt/GitHub metadata read |
| `receipt --output <private-directory>/web-build.json` | Inside `GITHUB_JOB=build` while it is running, after the build push; `CI_ROLE_ARN` is the selected **ci-build role**, with its STS credentials, `AWS_ACCOUNT_ID_DEV`, `GH_TOKEN`, `actions: read`, `IMAGE_PROJECT`, actual `IMAGE_DIGEST`, and GitHub run/SHA/attempt context |
| `promote` | Reviewed release job with the selected **deployer role**, STS credentials, GitHub read permissions, repository ECR scopes and every promotion input below, including the mandatory preflight digest |

## Required workflow wiring

`IMAGE_PROJECT` must come from **branch-selected authenticated Terraform outputs**, or a verified job output derived from that authenticated stack context, **never `inputs.*` or an unverified environment override**. Before calling `promote`, independently cross-check the selected project against the branch's Terraform `ecr_web_uri` and corresponding ECS cluster/service outputs. Do not manufacture all of these values from the same caller-supplied project string. A verified job must perform these checks before publishing its project output. The helper validates the value's shape and derives `<IMAGE_PROJECT>-web`; it does not query Terraform or establish branch-to-stack authority itself.

The current Deploy Web job/step names include `Build & push (arm64)` and `Build and push (arm64)`. The following two required producer steps **do not exist in the current workflow** and must be added before reuse can work:

1. `Record the image producer`: invoke `python3 scripts/v2/ci_web_image.py receipt --output <private-directory>/web-build.json` in job ID `build`, taking `IMAGE_DIGEST` from the successful `steps.<build-push-step>.outputs.digest`, not `imageid` or a config digest.
2. `Retain the build receipt for explicit reuse`: use the repository's current `actions/upload-artifact@v4` producer to upload exactly `web-build.json` as artifact `web-build-<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>`, with 90-day retention. Its published Artifact API `digest` must be a valid SHA-256 of the downloadable ZIP bytes; missing or mismatched metadata blocks reuse. The action major version alone is not evidence that this field is available.

Those exact job/step names are part of `BUILD_JOB`/`BUILD_STEPS`; renaming them requires updating this contract and its tests. The receipt records the real build job ID and attempt. Reuse validates artifact SHA-256, one-file archive shape, repository/branch/source/project, actual producing attempt, successful build/publication steps and artifact creation during that job.

### Owned receipt output and retries

`receipt` uses `O_CREAT|O_EXCL` and never overwrites an existing output. In the configured producer job, allocate a fresh private directory and carry that exact path to its upload and cleanup steps:

```bash
umask 077
receipt_dir=$(mktemp -d "${RUNNER_TEMP:?}/web-proof-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-XXXXXX")
python3 scripts/v2/ci_web_image.py receipt --output "$receipt_dir/web-build.json"
```

Cleanup may remove only the regular receipt file and then the empty directory recorded as owned by that run/attempt, after upload is confirmed or the attempt is deliberately abandoned. Confirm ownership, the run/attempt path and absence of symlinks or an active publisher; preserve the retained GitHub artifact. If ownership cannot be established, use a new private directory instead of deleting it. Never sweep shared `RUNNER_TEMP`. After `Producer attempt changed`, let the producer finish and start a **new dispatch** from current HEAD; repeat receipt/ECR preflight and the required migration procedure, without copying stale preflight or migration assertions into the new run.

The future caller must validate the selected fresh build or reused receipt and its ECR content **before** running migrations, then pass that selection as `PREFLIGHT_DIGEST` (CLI) or `expected_digest` (controller) to prevent promotion from selecting a different digest afterward. The digest is mandatory for **every** promotion, including rollback; an explicit empty `expected_digest` fails even when the environment contains a valid digest. This helper does not implement that preflight/migration controller. For current dev source the controller must run the private migration phase and pass its real success outputs. Current Deploy Web does not produce `MIGRATED_SHA`/`MIGRATED_PROJECT`; never manufacture these values to activate the helper early. Dev migration wiring requires `CI_MIGRATIONS_ENABLED_DEV=true`, applied `ci_migrations_enabled=true`, and a non-null `migration_job` output as described in [CI setup](dev-repo-setup.md).

The reusable `deploy-migrations.yml` currently exposes no `workflow_call` outputs either. Its integration must add success-only source/project evidence after verifying the actual migration task, or pass equivalent verified controller results; copying the requested SHA/project without successful execution is not a migration receipt.

In future workflow wiring, `MIGRATED_SHA`/`MIGRATED_PROJECT` must come from `needs.<verified-migration-job>.outputs.source_sha` / `.project`, and `PREFLIGHT_DIGEST` from `needs.<verified-image-proof-job>.outputs.digest`. These jobs must verify their work before exposing successful outputs. Never source these assertions from `inputs.*` or fabricate them from the requested SHA/project. An in-process controller must use the equivalent verified results.

## Promotion entrypoint

Use `python3 scripts/v2/ci_web_image.py promote` from the protected integration, or `promote(env, expected_digest=...)` from its reviewed controller. This entrypoint enforces:

`actual caller → validated context and required preflight digest → current source/migration or rollback checks → matching producer digest → final source/migration recheck → registry/media/schema/ARM64 checks → fresh source-tag binding → ECR publication`.

The repository is always derived as `<validated IMAGE_PROJECT>-web`; callers cannot pass a different repository to `promote`. `pin_image` is a low-level publishing primitive, **not** the supported CI integration API. Do not assemble a weaker guard chain around it.

On success, the library returns and the CLI prints one JSON object with exactly **`{digest, image_sha, rollback}`**: the selected manifest/index digest, source commit SHA, and rollback boolean. It does not capture or return prior tag history or a previous digest. Recovery evidence is the controller/operator's responsibility below.

| Input | Trusted source / meaning |
| --- | --- |
| `GITHUB_*` run/ref/repository/workflow identity | GitHub-provided context for this repository's Deploy Web push/dispatch |
| `CI_ROLE_ARN` | Protected branch role configuration; a same-account role match is not stack authority |
| `IMAGE_PROJECT` | Branch-selected authenticated Terraform output or a verified job output derived from that stack context, independently checked against ECR/cluster/service outputs; never dispatch inputs or unverified environment values |
| `AWS_ACCOUNT_ID_DEV` | Protected 12-digit dev account; mandatory even on main |
| `FRESH_DIGEST`, `FRESH_PROJECT` | Outputs of this run's trusted build job, never free-form dispatch values |
| `IMAGE_BUILD_RUN_ID` | Explicit completed producer run for reuse; cannot be the current run |
| `PIN_SHA` | Full source SHA; defaults to the current GitHub SHA |
| `MIGRATED_SHA`, `MIGRATED_PROJECT` | Verified migration job `needs.*.outputs` matching current dev source/project; never dispatch inputs |
| `ROLLBACK_SCHEMA_COMPATIBLE=true` | Explicit acknowledgement for an older ancestor image |
| `PREFLIGHT_DIGEST` / `expected_digest` | Mandatory digest from verified image-proof `needs.*.outputs` or equivalent verified controller result, never dispatch inputs. Promotion must retain it; a supplied keyword takes precedence and must be nonempty |

Fresh builds can promote only their own current SHA/project, and the registry's `web-<PIN_SHA>` tag must still identify that exact build digest in the verified account/repository immediately before publication. This tag is a second binding check, never a fallback that selects a replacement digest. Reuse remains bound to its retained receipt, including when a later build has replaced the source tag. Reuse is dispatch-only. A successful attempt-1 build remains eligible after a deploy-only attempt-2 retry, but the operator selects that producer in a new dispatch; the same run cannot recover through its own receipt.

The helper supports Docker v2/OCI image manifests and OCI indexes/Docker manifest lists with exactly one `linux/arm64` descriptor. It verifies that child's digest, media and size, then its actual ARM64 config. Other declared platforms may coexist; each retained Buildx `unknown/unknown` attestation descriptor must reference that ARM64 child, not itself, another attestation or another platform. Missing or duplicate ARM64 children and nested indexes fail closed. The **original index digest and bytes** are published, preserving attached build provenance; this is not a signature or attestation-content verification service.

Every ECR read/write pins `--registry-id` to the verified role account and checks registry/repository/digest identity. Manifest reads check SHA-256 and schema 2; any body media declaration must match the supported ECR response media. ECR's media field supplies an omitted body declaration without rewriting manifest bytes. `PutImage` receives the original manifest, explicit digest and `--image-manifest-media-type`. `BatchGetImage` deliberately omits `--accepted-media-types`: its [documented values](https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_BatchGetImage.html) contain image manifests but no index/list values, and AWS documents [no manifest translation on digest pulls](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-manifest-formats.html). Do not copy an image-only accepted-types filter from the provenance-disabled runtime builder into this index-capable helper.

The manifest is passed through an owned 0600 temporary file using `file://`, avoiding the per-argument size limit; normal success and failure clean up that file. A failed `PutImage` still counts as confirmed when an independent `web-latest` read proves the expected identity, digest, bytes and media. A previous, missing or unreadable tag instead produces `Image publication could not be confirmed`, without invalidating the already-verified candidate.

On **2026-09-14**, a read-only check of one two-tag image returned **two rows by digest**, **one row for `web-latest`**, and **one row for its `web-<SHA>` source tag**. Both tag responses identified only the requested tag, and all manifest bytes agreed. The helper accepts multiple digest rows only when every row matches the expected registry/repository/digest and has identical manifest bytes and media; conflicting evidence fails closed. Strict tag matching remains: every returned row must identify the requested tag.

Older-image rollback requires an ancestor SHA, retained successful producer and schema acknowledgement, and rejects any `MIGRATED_*` values. It runs no migrations and does not undo schema changes. The helper performs only ECR publication; the future caller must verify the exact ECS deployment/running digest and authenticated application/DB responses.

The migration receipt check applies to current-source **dev** only. Main/preview migration procedures remain caller/operator responsibilities. Main's account exclusion is not a positive production-account binding; the wiring review must check the protected production role/account and project independently, and grant `actions: read` only to jobs that need receipt metadata.

## Expiry and transition recovery

This preparatory PR removes no existing release or rollback path. A wiring PR must ship its explicit legacy-image recovery procedure before replacing those paths. This helper deliberately cannot validate pre-receipt or expired-receipt images and supplies no bypass.

Before publication, the controller/operator must independently retain the verified candidate source/digest and the trusted source/digest evidence for any prior release that may be needed for recovery. Keep the associated producer receipt or verified release record. The helper does not read the pre-publication tag or maintain history: neither the current `web-latest` value nor an anonymous untagged image establishes the previous release.

For receipt-enabled rollback or a failed deploy retry:

1. Select a completed Deploy Web producer run on the same branch/project and its full source SHA. Dispatch from the current branch HEAD in a **new** run; do not rerun the producer to make it consume its own receipt.
2. For current-source reuse, validate the retained receipt/digest before migrations, run the required dev migration phase, and pass its successful SHA/project outputs. For an older ancestor, omit both migration values and record explicit schema compatibility approval.
3. Run `promote` with the selected producer/SHA and preflight digest. If identity, branch HEAD, receipt, manifest or migration evidence fails, stop before ECS rollout and select/rebuild through the same reviewed path. A fresh build cannot be used as an older-source rollback.
4. After publication, use the future controller's bounded ECS rollout and authenticated verification. If rollout or verification fails after the tag changed, stop further promotion and record the candidate result plus the observed ECS deployment. Select a recovery image only from independently retained, verified source/digest evidence and repeat this procedure's provenance/schema checks. If that evidence is unavailable, stop the recovery path rather than inferring a previous image from the current tag. An ECR tag change is not a service rollback; the helper supplies no automatic recovery or schema reversal.

Reuse examines at most 100 artifacts and 20 matching receipts, with a 1 MiB provider/archive cap and a 4 KiB receipt cap enforced by a bounded 4,097-byte ZIP stream read. Expired receipts and recognized non-successful jobs, including `stale` and `startup_failure`, are skipped; unknown conclusions, incomplete/unverifiable evidence or no remaining successful receipt block reuse. Receipt mode validates context before forming the jobs URL and requires a complete jobs array. Image indexes are capped at 20 descriptors, configs at 1 MiB. Each provider command has a 90-second timeout. The wiring must add an overall job/controller deadline and bounded deployment verification; these per-call limits alone do not bound the whole release. The requested 90-day retention is a wiring setting, not proof that a receipt is still available.

For new receipt-enabled releases, rebuild the current reviewed source or choose another retained successful producer. If neither is possible, stop this helper path. Any separate operator recovery requires independent trusted source/digest evidence, schema approval and scoped write authorization; do not fabricate a receipt, treat an image label as evidence, or silently downgrade to the legacy mutable-tag path.

## Related files and boundary

See `scripts/v2/ci_web_image.py`, `scripts/v2/test_ci_web_image.py`, `.github/workflows/deploy-web.yml`, [CI setup](dev-repo-setup.md), and the AWS [PutImage](https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_PutImage.html) / [GetDownloadUrlForLayer](https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_GetDownloadUrlForLayer.html) contracts. This operator CI publication is not product remediation/autonomy and adds no ADR-005 exception or IAM grant.
