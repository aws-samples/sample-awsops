# Discovery observations implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Supply accurate DNS/network/workload dependencies and memory evidence to bounded six-pillar diagnosis while bounding existing caches.

**Architecture:** Keep Aurora graph storage and project read-only observations into the existing evidence bundle. Reuse shared specialist context; preserve identity, source windows and incomplete coverage. Bound local caches and measure repeated reads before selecting shared infrastructure.

**Tech Stack:** Python 3.12, boto3/botocore, pg8000, TypeScript, Vitest, PostgreSQL 17, Terraform.

**Spec:** `docs/superpowers/specs/2026-11-05-discovery-observations-design.md`

## Global constraints

- Read-only; no deployment, apply, paid live probe or publication.
- Existing loop and new DNS/NFM source gate default off.
- Preserve account registration, external ID and fail-closed member reads.
- Retain source clocks/caps; cache access never advances capture time.
- English developer docs; keep unrelated source-checkout changes intact.

## Review focus

- Stale IP reuse and duplicate scoped endpoints must not establish identity.
- Missing/ambiguous memory dimensions must continue to veto sizing.
- Dense EC2 inventory must not consume every database/workload slot.
- Cache expiry, capacity and in-flight errors must not grow retained maps.
- Failed member access must make no subsequent host data call.

### Task 1: Bound local observation caches

**Files:** create `web/lib/bounded-cache.ts`, `web/lib/bounded-cache.test.ts`; modify `web/lib/nfm.ts`, `web/lib/dns-logs.ts`; add an offline benchmark under `scripts/v2/`.

**Interfaces:** `BoundedTtlCache<T>` owns TTL, retained-value capacity and in-flight capacity; `get(key, loader): Promise<T>`, `clear()`. Consumers preserve current query keys and original source windows.

- [x] Write behavioral tests for expiry pruning, least-recently-used eviction, deduplicated loads, rejected-load retry and clear during a pending load.
- [x] Run the new test and confirm expected failure before implementation.
- [x] Implement and wire both existing cache consumers; keep four-minute TTL.
- [x] Verify cache, DNS, NFM and topology tests; run benchmark and label it synthetic.
- [x] Review spec/quality and commit only Task 1 files.

### Task 2: Collect measured EC2 memory

**Files:** create `scripts/v2/workers/diagnosis/memory_metrics.py` and tests; modify only `discovery.py:_metrics` and related metric tests.

**Interfaces:** memory collector accepts a scoped CloudWatch client, resources, UTC start/end and remaining budget; returns measured per-resource metric facts and explicit coverage/gaps. Normalize `mem_used_percent` to `MemoryUtilization.Maximum` without losing provider dimensions.

- [x] Write tests that a uniquely scoped complete fourteen-day series enables memory evidence and missing/duplicate/foreign/partial series cannot.
- [x] Confirm expected failure, implement bounded ListMetrics/GetMetricData collection, then integrate with existing native metrics.
- [x] Keep `missing_memory` true unless measured evidence qualifies; do not infer it from CPU or provider recommendations.
- [x] Run discovery, evidence, loop and memory tests; review and commit Task 2 files.

### Task 3: Feed DNS and NFM into diagnosis

**Files:** create `scripts/v2/workers/diagnosis/observations.py` and tests; modify evidence projection/rendering and wire collector in report generation; Terraform worker configuration/policy changes belong to Task 4.

**Interfaces:** `collect(bundle, budget, *, scope, client_factory)` returns a bounded bundle. New reads require `DIAGNOSIS_NETWORK_EVIDENCE_ENABLED=true` and verified host identity. Pure correlation helpers consume projected inventory and provider rows, returning typed evidence/relationships/gaps.

- [x] Write failing tests for DNS resolution plus flow correlation, timestamp/IP conflicts, partial top contributors, absent instrumentation, gate-off and query deadline.
- [x] Implement bounded Resolver-association/log queries and NFM queries with exact SDK schemas; preserve resolution/network/application evidence distinctions.
- [x] Extend the evidence allowlist and controlled read-only follow-up vocabulary only as needed; never promote network traffic to successful SQL.
- [x] Run source, evidence, loop and presentation tests; review and commit Task 3 files.

### Task 4: Improve graph selection and scope integration

**Files:** modify discovery inventory/graph/client paths; add focused identity/scope helpers and tests; modify `terraform/foundation/variables.tf`, `workers.tf` and provider-mock tests; add an English reference and amend the existing diagnosis changelog entry.

**Interfaces:** select fair resource-type seeds, then bounded account-qualified neighborhoods across graph classes. Registered member clients use the existing registry/role contract and never host fallback. Wire Task 2/3 outputs through the admitted bundle.

- [x] Write failing tests for dense fleets preserving DB/workload seeds, focused graph neighborhoods, ECS/Lambda/proxy identities, conflicting endpoints and member assumption refusal.
- [x] Implement explicit bounds and gaps; wire the default-off source gate and minimum read-only policy.
- [x] Add member reads only through verified registered credentials; keep unsupported sources explicit.
- [x] Run full worker/web suites, Terraform validation/provider-mock tests, production web build and benchmark.
- [x] Perform broad code and IaC security review, resolve actionable findings and commit the reviewed result locally.

## Decisions

- ElastiCache/Neptune provisioning is deferred until production measurements establish a benefit. This implements cache bounds and offline measurement rather than creating billed infrastructure.
- Existing graph/worker bounds remain safety limits. Improvements prioritize and disclose evidence rather than claiming unlimited discovery.

## Verification record (2026-11-05)

- Web: 5,558 passed, 279 skipped; production build passed.
- Workers: 2,043 passed, 108 skipped; remaining skips are existing optional suites
  and the dedicated PostgreSQL selector fixture, run separately below.
- Offline CI: 333 passed; three required PostgreSQL CI suites: 73 passed, no skips.
- Dedicated real PostgreSQL inventory/graph regression and related discovery:
  63 passed, including the final IPv6 privacy case.
- Terraform 1.17.1: formatting and validation passed; all 53 provider-mock tests
  passed. Existing Cloud Map deprecation warnings remain unrelated.
- Synthetic cache benchmark reproduced 2,000 → 32 loader calls and one concurrent
  same-key load. These are offline fake-loader counts, not production speed claims.
- Independent reviews covered cache, memory, observation integration and IaC/account
  boundaries. Early internal IP/ARN redaction, hidden ENI overflow and IPv6 prompt
  exposure were reproduced with failing tests, fixed and independently rechecked.
- Reviewed Task 2 files are integrated with Task 4 because both modify discovery.py;
  the aggregate local commit preserves the shared-file ownership boundary.
- No live AWS calls, deployment, apply, push or publication were performed.
