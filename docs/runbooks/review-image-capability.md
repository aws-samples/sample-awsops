# Authenticated runner image capability

## Symptoms

A reviewer cannot establish whether Claude can Read a staged image outside its working
directory. A local-machine test or an unauthenticated pod exec is not proof for CI.

## Verification

`review-image-capability.yml` is a separate, manual-only diagnostic. It runs only for
`aws-samples/sample-awsops`, `refs/heads/dev` and `workflow_dispatch`, checking out that
dispatch's `github.sha` without persisted Git credentials. It neither changes the
existing PR review workflow nor satisfies any required panel, chair or CI gate.

Before credentials, the Python standard-library helper creates a random six-digit
304×72 PNG under `RUNNER_TEMP`. The expected answer stays in private control data, never
in the prompt or child environment. The generated evidence directory is 0500 and
image 0400. The model runs in the validated absolute `GITHUB_WORKSPACE` checkout;
only the unauthenticated version preflight uses the owned `base` directory.
CLI `TMPDIR` is the owned `client/tmp`, while `CLAUDE_CONFIG_DIR` remains `client`.
Canonical paths must keep the image outside both the checkout and CLI temp, checked
before credentials and again before the model call. All scratch state is in a 0700 root.
No Pillow, repository image, PR-head code or user-supplied path/prompt/model is used.

The job reuses `ci-review-auto` and `AWS_CI_REVIEW_ROLE_ARN`, with fresh OIDC credentials
in `us-east-1`, account masking and existing credentials disabled. It adds no IAM,
trust, runner or tool permissions. A trust rejection is an authentication failure,
not evidence that Read cannot open the file; do not expand policy to make it pass.

One Claude invocation requests `us.anthropic.claude-fable-5`, the current default chair
model. It keeps the review panel's `Read,Grep,Glob`, `--strict-mcp-config` and empty
`--setting-sources` flags. An owned empty CLI config directory and disabled session
persistence keep diagnostic state private. The model gets no GitHub command channels
or tokens. Only the fresh AWS session is forwarded for authentication.

The job has a five-minute backstop; the model call has a 110-second deadline, two-turn
limit and 1 MiB combined stdout/stderr bound. The parser accepts at most 128 JSON trace
events and requires exactly one Read of the exact generated path, a successful image
tool result, matching digits and successful final result/CLI exit. Any other invoked
tool, including Grep/Glob, invalid trace, missing proof or wrong answer fails.

Only fixed-field JSON is published: source SHA, requested model, CLI version, observed
CLI exit code, proof observations and fixed failure/cleanup codes. Boolean observations
are `true` or `false` only when established; otherwise they are `null`. For example,
an `answer_mismatch` after verified Read retains `read_exact_file: true` and verified
workspace boundaries, with `answer_matches: false`. Tool labels record the observed
trace prefix as Read/Grep/Glob/other; `null` means no reliable tool observation, not zero
invocations. A failed/invalid trace does not claim that this prefix covers all activity.
No answer, path, image, raw response, credentials or provider stderr is published.

Read proof and cleanup are independent. The always-run finish step retains valid proof
even if removal fails, reporting `cleanup_status: failed` and `residue_possible: true`.
The job fails unless Read proof passed **and** cleanup is `removed`. An absent root
returns `incomplete` with `not_needed`; an unsafe/unverifiable root reports cleanup
`unavailable` and unknown residue. Raw trace is private, never uploaded, and removed
with owned CLI state on normal cleanup. Abrupt runner loss can prevent cleanup.
Investigate possible owned residue privately; never publish the trace to explain failure.

## Action

The workflow must exist on the repository's default branch, which is **dev** for this
repository; `main` promotion is not a prerequisite. After normal review and merge into `dev`, an authorized
operator selects **Review Image Capability Diagnostic → Run workflow → dev**. There
are no dispatch inputs. Check the authentication step and final safe JSON separately:
`incomplete` can mean preparation/authentication stopped before the model call or the
root/proof is missing. `cli_failed` includes an observed numeric exit code but does not
by itself distinguish auth, transport or file access. `invalid_trace` describes a schema
or declaration problem; it does not establish that Read is unsupported.
`invalid_state` rejects malformed private control data without a traceback; malformed
or missing persisted proof returns `incomplete`.
`reused_root` rejects repeated attempts or pre-existing proof/trace, prevents another
model call and prevents an old passing proof from being published. Start a fresh dispatch.
`diagnostic_unavailable` is the outer fixed failure category when normal proof handling
cannot complete. No category exposes raw stderr or overrides required review.

A passing proof applies only to that run, CLI and requested model. It does not prove
every image/model can decode every asset and never waives latest-HEAD full review.
Missing CLI flags require the ordinary reviewed runner update, not extra tools.
On failure, preserve the existing review gates and investigate the fixed category.

Offline tests mock every Claude invocation and require Python 3, PyYAML and Linux/POSIX
process groups, permissions and pipes:
`python3 -m unittest scripts.v2.test_review_image_capability` from the root, or
`python3 -m pytest test_review_image_capability.py` from `scripts/v2`.
Merge Verify discovers this test file automatically. These tests make no model/AWS calls.

## Related files and ADRs

- [Manual workflow](../../.github/workflows/review-image-capability.yml)
- [Diagnostic helper](../../scripts/pr-review/image_capability.py)
- [Offline tests](../../scripts/v2/test_review_image_capability.py)
- [Role/environment consumer catalog](dev-repo-setup.md#review-ci-protection-and-recovery--리뷰-ci-보호복구)
- [Existing panel flags](../../scripts/pr-review/run-panel.sh) and [chair model](../../scripts/pr-review/synthesize.sh)
- [Existing protected-subject policy helper](../../scripts/v2/ci_review_access.py)

ADR-005: this is an operator CI diagnostic using existing grants, not product autonomy,
an AWS-resource mutation exception or a review-gate substitute. ADR bodies remain private;
no new IAM/trust policy or product permission is authorized here.
