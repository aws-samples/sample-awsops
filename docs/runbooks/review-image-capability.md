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
in the prompt. The generated evidence directory is 0500 and image 0400; the working
directory is its sibling `base`. All scratch state is inside a new owned 0700 root.
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

Only fixed-field JSON is published: source SHA, requested model, CLI version and proof
booleans or a fixed failure code. It contains no answer, file path, image, raw response,
credentials or provider diagnostics. Failed proof leaves the tool list unknown (`null`),
rather than claiming no tools ran. Raw trace is private and is never uploaded.
An always-run finish step removes only the owned scratch root, including CLI state.
Abrupt runner loss can prevent cleanup; it does not turn missing proof into success.

## Action

After this workflow has completed normal review and merged into `dev`, an authorized
operator selects **Review Image Capability Diagnostic → Run workflow → dev**. There
are no dispatch inputs. Check the authentication step and final safe JSON separately:
`incomplete` can mean preparation/authentication stopped before the model call;
`cli_failed` does not by itself distinguish auth, transport or file access.

A passing proof applies only to that run, CLI and requested model. It does not prove
every image/model can decode every asset and never waives latest-HEAD full review.
Missing CLI flags require the ordinary reviewed runner update, not extra tools.
On failure, preserve the existing review gates and investigate the fixed category.

Offline tests mock every Claude invocation and require Python 3 plus PyYAML:
`python3 -m unittest scripts.v2.test_review_image_capability` from the root, or
`python3 -m pytest test_review_image_capability.py` from `scripts/v2`.
Merge Verify discovers this test file automatically. These tests make no model/AWS calls.
