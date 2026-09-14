# Private S3 plans implementation plan

> **For agentic workers:** Use subagent-driven development with disjoint file
> ownership. The host reviews changes, runs integration checks and drives native
> PR review through merge and the authorized deployment.

**Goal:** Inspect and apply private S3 saved plans without sharing the CI key.

**Architecture:** Keep read-only planning and CI asset HMAC verification. Publish
through an existing protected deployment role restricted to S3/KMS; replace the
encrypted handoff with a nonsecret reference. Local inspection and exact apply
validate that reference and pinned private objects.

**Tech stack:** Python, existing AWS/GitHub CLIs, Terraform 1.15.7, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-14-private-s3-plans-design.md`

## Global constraints

- No new AWS infrastructure/IAM allow or bucket-configuration mutation.
- Full private plan review; source/attempt/scope/hash binding; no re-plan on apply.
- Keep HMAC/archive safety, protected environments and all existing release gates.
- English maintainer documentation; preserve multilingual product guides.
- No raw private values in logs or public artifacts; 0700/0600 local inspection.
- Supported branches: main, dev, atomoh, ssminji, whchoi.
- Supported plan scopes: full, ecr-bootstrap, runtime-ecr-bootstrap.

## Task 1: Private artifact helper

Files: create `scripts/v2/ci_private_plan.py` and
`scripts/v2/test_ci_private_plan.py`.

Interfaces:

- `policy`: validate CI/backend input and write private store configuration plus
  the scoped session policy; emit only their local paths for the next CI step.
- `publish`: consume the verified attempt-specific encrypted handoff and CI key;
  validate/decrypt/HMAC-check, upload private objects, write `reference.json`.
- `restore`: validate a completed source run/reference, require the reviewed plan
  hash, download pinned objects and restore authenticated assets for apply.
- `inspect`: local-only variant downloading/rendering the plan and review receipt,
  using `--profile` and no client key; optional backend input or bounded bucket-hash
  discovery; no apply or asset restoration.

Use explicit CLI arguments for repository, branch, commit, run ID, scope,
foundation/backend/destination, and reviewed hash where applicable. Workflow
publication obtains attempt/context from immutable GitHub variables; local
inspection resolves and validates the actual run attempt through GitHub.

- [ ] Add red fixtures for provenance, reference parsing, object integrity,
  private-mode handling and accidental disclosure.
- [ ] Implement the four modes with injectable command transports for tests;
  production uses argv arrays, bounded output and fixed error categories.
- [ ] Run the helper suite and the existing artifact/plan-context suites:

```bash
python3 -m pytest -q scripts/v2/test_ci_private_plan.py \
  scripts/v2/test_ci_plan_context.py scripts/v2/test_ci_plan_inspect.py \
  scripts/v2/test_ci_tf_assets.py
```

- [ ] Freeze file hashes and results for host integration; no worker push/apply.

## Task 2: Workflow integration and operator documentation

Files: modify `.github/workflows/terraform.yml`,
`scripts/v2/test_ci_deployment_workflows.py`, the canonical deployment runbooks,
and their CLAUDE/AGENTS contexts.

- [ ] Add workflow assertions before editing YAML: advisory plans cannot publish,
  publication needs the plan job/protected environment, receipt replacement is
  after S3 upload, and exact apply rejects a missing reviewed hash.
- [ ] Add attempt-specific encrypted handoff and required private publisher job.
  Reuse the existing branch role/backend selection and policy-masking pattern.
- [ ] Replace apply's public ciphertext download with the private restore mode.
  Keep branch checks, host verification, DNS/runtime checks and saved `tfplan`.
- [ ] Add the exact local inspection/apply commands and describe private storage,
  reference lifetime and the existing S3 retention policy without inventing expiry.
- [ ] Regenerate changed contexts, run actionlint/shell checks and all Python CI
  tests. Run a provider-free rendering test after deleting a plan's source asset
  to prove private inspection does not need HMAC asset restoration.

## Task 3: Review and deployment

- [ ] Count the complete PR diff and publish within the full-review limit.
- [ ] Resolve valid latest-HEAD Critical/Major feedback and repeat required tests.
- [ ] Merge only with complete latest-HEAD AI coverage and required CI.
- [ ] Run a fresh dev plan; verify successful private publication and safe public
  reference contents.
- [ ] Download/render with `samples`, privately inspect resource changes, and apply
  the exact reviewed SHA-256 through the existing protected workflow.
- [ ] Recheck actual AWS state, then finish full 43-type, login/DB, AgentCore/model
  and both-worker proof. Report remaining prerequisites explicitly.
