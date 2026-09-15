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

The job has a five-minute backstop; the model call has a 110-second deadline, three-turn
limit and 1 MiB combined stdout/stderr bound. The parser accepts at most 128 JSON trace
events and requires exactly one Read of the exact generated path, a successful image
tool result, matching digits and successful final result/CLI exit. Any other invoked
tool, including Grep/Glob, invalid trace, missing proof or wrong answer fails.
Three turns provide room for a text preamble; they do not guarantee model completion.
The one-call limit, wall deadline, tool list and existing grants are unchanged.

Only fixed-field JSON is published: source SHA, requested model, CLI version, observed
CLI exit code, proof observations and fixed failure/cleanup codes. Boolean observations
are `true` or `false` only when established; otherwise they are `null`. For example,
an `answer_mismatch` after verified Read retains `read_exact_file: true` and verified
workspace boundaries, with `answer_matches: false`. Tool labels record the observed
trace prefix as Read/Grep/Glob/other; `null` means no reliable tool observation, not zero
invocations. A failed/invalid trace does not claim that this prefix covers all activity.
No answer, path, image, raw response, credentials or provider stderr is published.
Bounded stdout from a completed nonzero CLI exit is kept privately and parsed for
observations and reported negative outcomes. It can never make the run pass:
a valid-looking trace with a nonzero exit remains `cli_failed`. Malformed failed stdout
also remains `cli_failed`; explicit validated failures can retain their specific code.
Timeout/output-limit failures do not reinterpret a truncated trace as complete evidence.

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
use the fixed-code table below, together with observations, CLI exit and cleanup status.
No category exposes raw stderr or overrides required review.

A passing proof applies only to that run, CLI and requested model. It does not prove
every image/model can decode every asset and never waives latest-HEAD full review.
Missing CLI flags require the ordinary reviewed runner update, not extra tools.
On failure, preserve the existing review gates and investigate the fixed category.

Offline tests mock every Claude invocation and require Python 3, PyYAML and Linux/POSIX
process groups, permissions and pipes:
`python3 -m unittest scripts.v2.test_review_image_capability` from the root, or
`python3 -m pytest test_review_image_capability.py` from `scripts/v2`.
Merge Verify discovers this test file automatically. These tests make no model/AWS calls.

## Outcome codes

This table covers every helper `CODES` value; the offline suite enforces set equality.
Preparation/context failures can reach the reduced outer `diagnostic_unavailable` payload
before a normal proof is available. Treat omitted observations there as unknown.

| Code | Meaning and next step |
|---|---|
| `read_verified` | Exact Read/image/answer and zero CLI exit were verified. Also require cleanup `removed`; this is not full-review or deployment approval. |
| `incomplete` | Root/proof is absent or persisted proof is malformed; preparation/authentication may have stopped earlier. Check the preceding workflow step and use a fresh dispatch. |
| `unsafe_context` | Internal repository/event/ref/SHA guard rejected the invocation. Use the exact guarded dev dispatch; the outer CLI may report `diagnostic_unavailable`. |
| `unsafe_path` | An owned path or checkout/CLI-temp boundary could not be verified. Correct runner scratch/workspace layout without expanding Read privileges. |
| `invalid_state` | Private control data or internal state is malformed. No traceback is published; inspect owned state privately and start fresh. Invalid persisted proof becomes `incomplete` at finish. |
| `cli_unavailable` | CLI launch/version could not be verified. Use the normal reviewed runner update; a preparation failure may instead reach the outer fallback. |
| `cli_failed` | Nonzero CLI exit without a more specific validated negative outcome, including a valid-looking trace that exited nonzero. Retained observations do not override the exit. Check existing authentication/runtime setup; no raw stderr is published. |
| `timeout` | The bounded process exceeded its wall deadline. Partial output is not proof; inspect runner/provider availability before retrying within the existing limit. |
| `output_limit` | Combined stdout/stderr exceeded the bound. No truncated completion is accepted; investigate output volume without raising limits to obtain a pass. |
| `invalid_trace` | JSON/envelope/result schema or declaration is invalid, including absent/non-string final text or an ill-typed denial list. This is not evidence that Read is unsupported; malformed stdout accompanying nonzero exit remains `cli_failed`. |
| `unexpected_tool` | A tool, Read input, count or message shape violated the single exact-Read contract. Do not add tools to make the probe pass. |
| `read_unavailable` | The matching Read result failed, lacks image evidence or has a malformed tool-error flag. It does not establish a general filesystem/Read capability limit. |
| `answer_mismatch` | A present string answer differs from the private expected digits. Verified Read/boundary observations remain intact; do not reinterpret missing/non-string answers as misreads. |
| `cancelled` | A handled interruption stopped execution. There is no success proof; require cleanup or investigate possible owned residue before another dispatch. |
| `auth_unavailable` | Required fresh AWS session fields were absent before the call. Check the existing credential step; do not borrow runner/job credentials or expand IAM. |
| `reused_root` | A prior attempt/proof/trace was found. No new call or stale passing publication is allowed; use a fresh dispatch. |
| `diagnostic_unavailable` | The outer handler could not produce a normal proof. The reduced payload leaves detailed observations/cleanup unknown; check preparation/context and possible owned residue privately. |
| `permission_denied` | A typed nonempty CLI tool-denial list was reported. This need not concern Read or this image, and is not an AWS IAM diagnosis; retain the generic code and existing grants. |
| `turn_budget` | The CLI reported `error_max_turns`. This is bounded incomplete execution, not a schema defect or proof of denied Read; the three-turn/110-second limits remain in force. |

`permission_denials` may be absent or a list of objects with a nonempty string
`tool_name`. Explicit null, scalars and malformed entries are invalid, never an empty
denial list. A nonempty valid list takes priority over a simultaneous turn-budget report.
No raw denial arguments or tool-provided paths are published.

## Observation and cleanup interpretation

The boundary fields (`outside_cwd`, `cwd_is_github_workspace`, `outside_cli_temp`)
describe locally checked path relationships, not CLI permission or successful Read.
They may be true before the model call. Null means unestablished, never false/inside.
`read_exact_file` requires the matching image-result observation; `answer_matches`
requires an observed string result. A prefix of observed tools is not whole-trace coverage.

Read status and cleanup status are independent. `removed` confirms owned cleanup;
`not_needed` means no root was available to remove, not that an unpublished preparation
directory could never have existed. `failed` preserves Read evidence
while setting possible residue and failing the job; `unavailable` leaves residue unknown
because safe cleanup could not be established. Abrupt runner loss remains unconfirmed.

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
