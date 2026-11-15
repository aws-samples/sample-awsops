# Service discovery remediation

The user approved remediation of the preceding live discovery review on
2026-11-15. Work starts from `origin/dev` in an isolated worktree; unrelated
changes in the original checkout are preserved.

## Scope and decisions

- Preserve read-only product posture, datasource administration, credential
  binding, account boundaries and truthful partial/unknown evidence.
- Use authoritative paginated S3 bucket-list region metadata instead of requiring
  a separately denied location read. Retain the existing fallback for responses
  without that metadata, and retain unknown security attributes.
- Reuse the whole-window ClickHouse aggregation already merged into dev. Extend
  its allowlisted evidence so it does not discard managed inference dependencies.
- Model remote runtime/model calls as telemetry claims, not inventory ownership.
  Keep namespace/account/environment/source isolation and avoid name-only joins.
- Prepare producer identity enrichment in the FSI source repository. Runtime
  resources must not acquire invented Kubernetes identities.
- Register the FSI store only through authorized datasource administration.
  Do not bypass authentication or retrieve unrelated credentials.
- Use existing reviewed release and saved Terraform-plan procedures. A runtime
  readiness failure remains a failure; no override of migration or collection
  gates is introduced.

## Tasks

- [x] S3 inventory: tests for bucket-region metadata, pagination, denied location
  fallback and incomplete enumeration; implement in
  `scripts/v2/steampipe/sync_lambda.py`.
- [x] Inference topology: tests for allowlisted runtime/model attributes,
  malformed/conflicting scope, grouped ClickHouse evidence and bounded output;
  implement in `web/lib/trace-source.ts`, a focused inference-evidence helper and
  `web/lib/trace-graph.ts`, with display support if required.
- [x] Verify existing whole-window aggregation against the observed health-check
  saturation case and preserve explicit partial-result semantics.
- [x] Prepare and verify FSI trace resource enrichment using its GitOps source,
  and examine an authorized datasource registration path.
- [x] Run focused regression suites and build validation; inspect the final diff
  against product and identity constraints.
- [ ] Create reviewable commits/PRs where authorized, run required reviews, and
  deploy only through the existing environment's permitted release process.
- [ ] Recheck DNS/current origins, source registration, source freshness,
  inference graph evidence and bounded synthetic inference where permitted.

## Verification and workflow constraints

Use the locked dependencies and appropriate Python runtime. Tests must first
demonstrate the missing behavior. No live AWS call is made from unit tests.
Real backend probes remain separate from test results.

The user requires immediate subagent closure, while this session exposes no
subagent close operation. Work and local review therefore run inline; no
independent subagent review is claimed. Required repository PR reviews remain
part of delivery.

Operational evidence and account-specific values remain in private scratch
artifacts, not public documentation. Record any deployment or authorization
blocker separately from completed code changes.

## Verification record

- Python 3.12 inventory suite: 279 passed. Loopback tests were rerun outside
  the sandbox after its socket restriction prevented setup.
- Web suite after the final identity-isolation change: 5,912 passed, 281 skipped
  across 382 passed and four skipped files. Skips are not integration evidence.
- Companion producer validation is recorded in its own repository.
- FSI producer changes are in its separate review branch; registration and live
  rollout remain pending and require authorized administrator access.
- No production configuration, app-data registration or graph publication has
  been changed by this task.
- Final web production build passed. Operational measurements remain in private
  review artifacts and are not included in this public plan.
