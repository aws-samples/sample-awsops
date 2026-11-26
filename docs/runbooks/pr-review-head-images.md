# Claude Code review on Amazon Bedrock

The required `AI Code Review` runs the official Claude Code Action with GitHub OIDC and the existing Bedrock review role in `us-east-1`. The workflow reviews same-repository PRs into dev and main. Automatic review uses trusted default-branch code. The protected recovery environment authorizes each selected recovery SHA. [Environment setup](dev-repo-setup.md)

## Input and coverage

The preparation job compares the immutable merge base and PR HEAD using local Git. It reads literal paths, including deletions and both sides of renames. Generated vendor and build trees and dependency lockfiles carry change metadata and Git object IDs. Binary distribution artifacts carry metadata. Text patches are scrubbed and paginated. Each job returns the exact HEAD, its coverage of correctness, security, data integration and documentation, and its highest finding severity. The validator matches complete page text and normalized image reads to successful Read calls in the official Action’s execution transcript. All jobs have access to the other packets and the target base for cross-file checks.

A page is at most 16 KiB. A job normally takes up to 120 KiB of patch text and 40 pages. A single larger file can occupy a job by itself up to 192 KiB. A file stays within one review. Four jobs can invoke Bedrock concurrently, with at most 128 jobs per run. A larger input fails before invoking a model. Review packets expire after one day. The Actions summary holds the findings. The PR comment links to the run for that commit.

## Changed images

The trusted preparation job stages supported HEAD images from Git blobs using the isolated Docker codec. The manifest records path, blob ID, source and rendered checksums, dimensions and decoder metadata. Static PNG, WebP and single-rendition ICO are supported. Unsupported, animated, malformed and oversized images block the review. At most 32 images are admitted, with 8 MiB per file, 32 MiB total 8,192 pixels per dimension and 16,777,216 pixels per image. Each Claude job reads the normalized images and returns their filenames. The action checks that declaration against the manifest. Pixel inspection remains the reviewer's responsibility.

Use the codec and image fixtures for local verification. The manual capability workflow independently diagnoses runner image support. [Codec sandbox](review-codec-sandbox.md#verification) · [Runner capability](review-image-capability.md)

## Merge gate

Missing input, an incomplete report, a mismatched HEAD or incomplete Read trace, unavailable images, or a CRITICAL or MAJOR finding fails the check. Inspect the failed job summary and push the fix to the PR. A model or infrastructure failure can be retried from Actions. If the target or head changed during review, start a fresh review for the current pair. The final job validates the live PR before publishing its status.

The official action is the live review path. It uses the Read tool with trusted data and target-base scope. The old panel, chair, limits and their regression fixtures are retained for historical maintenance. The CI role invokes Bedrock and these changes grant no product or infrastructure mutation permissions.

With the codec state prepared as documented above, run the fixtures from the repository root:

```sh
python3 -m pip install --require-hashes --only-binary=:all: -r scripts/pr-review/image-requirements.txt
python3 -m unittest scripts.v2.test_claude_review scripts.v2.test_pr_review_head_images scripts.v2.test_pr_review_context
```
