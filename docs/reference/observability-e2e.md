# E2E observability implementation plan

**Pending operator integration:** configuration resolution and service/network correlation
are implemented as a data foundation; the combined operator view remains pending. This does
not complete the broader acceptance criteria below. Network evidence keeps closed reason
codes, windows, caps and source quality; query bounds never prove all-traffic coverage.

The host live view arbitrates IP ownership only in the region reported by `/api/eks`.
Unreadable known region/VPC scopes block all matching IPs, including unenumerated ones.
Unknown scope, incomplete enumeration or an unqueried region withholds identity confidence.
The web enumeration reads at most 25 clusters and discloses continuation; legacy responses
without a completeness marker remain conservative at that limit.

Member-account views and materialized flow graphs are configuration-only: their ECS labels
record cached attachment facts, not live EKS arbitration or exclusive ownership. They carry
`ownership_evidence=cached_configuration` and cannot establish E2E identity links.
ECS task/subnet reads use bounded pagination; remaining limits, read errors or changed pages
withhold confidence with a distinct inventory-incomplete reason. The localized user guides
ship with the combined operator view.

**Goal:** Connect workload evidence, execution state, changes and cost without treating
missing observations as healthy.

**Architecture:** Keep the existing read-only datasource adapters, Aurora materialized
graphs and asynchronous workers. Normalize identity and collection coverage before building
graphs or evaluating invariants.

**Tech stack:** Next.js/TypeScript, Python, PostgreSQL, existing ClickHouse/Tempo/Prometheus/Mimir
connectors. No new telemetry backend or AWS-mutating tool.

## Constraints

- Preserve ADR-005: diagnosis and remediation proposals only. AWS mutation stays frozen.
- Use `terraform/foundation/`; merged migration bodies and `-- since:` headers stay immutable.
- Keep `samples/dev` CI, OIDC, deployment roles and branch strategy.
- Preserve the public export boundary; private upstream history and decision bodies are not published.
- Distinguish observed zero, successful empty, unavailable, failed, partial and stale observations.
- Keep bounded queries; a cap or failed source must be visible to API, UI and diagnosis consumers.

## Delivery and verification

1. **Source integration**
   - Reconcile `origin/main` against the last imported snapshot, preserving samples-specific changes.
   - Review `upstream/main` and `upstream/v2`; port applicable fixes to the current v2 implementation.
   - Verify source paths, migration immutability, public boundaries, web/worker tests and build.

2. **Evidence and identity**
   - `SourceRead<T>` carries items, status, source ID, reason codes and the exact time window.
   - Normalize cloud account/region, deployment environment, service namespace and Kubernetes scope.
   - Index spans by source, trace and span identity; preserve asynchronous span links.
   - Keep metric and sampled-span evidence distinguishable.
   - Record graph collection attempts; keep the last successful graph when a source fails.
   - Expose partial/stale/unavailable states alongside graph data, including empty graphs.
   - Regressions: identical service names in different scopes, missing parents, span links, source
     failure versus successful empty, bounded/truncated reads, and malformed observations.

3. **Diagnosis trust**
   - Carry collector status into deterministic invariant evaluation.
   - Return unknown when an absence-based conclusion lacks complete evidence.
   - The normalized evaluator contract supports positive violations and valid numeric zero.
     This is unit-fixture/direct-caller coverage, not live collector integration.
   - **Pending producer integration:** current X-Ray edges contain `to_ref`, not resolved `to`,
     and inventory has no `unencrypted` aggregate. All six live invariant kinds therefore
     remain `unknown`; empty regressions/improvements do not certify health. The producer
     adapters and collector-to-verdict validation are incomplete.
   - Persist assessed/unassessed counts and unknown reasons independently of the model.
     Render Intended vs Actual deterministically in the report/export, and expose the same
     coverage in the UI; legacy reports without coverage must remain visibly unassessed.
   - Treat missing confidence conservatively; keep the incident feature gate unchanged.
   - Port upstream PDF request isolation into the v2 worker.
   - Regressions: degraded/empty/partial observations and externally referenced report content.

4. **Representative workload**
   - Use AWSops asynchronous diagnosis jobs as the first workload.
   - Preserve correlation across enqueue, dispatch and worker completion.
   - Show queue time, execution time, terminal state and evidence coverage.
   - Validate success, delay, retry and failure without mutating customer resources.

5. **Operational outcomes**
   - Keep SLO attainment, deployment/change context and allocated cost tied to a workload and window.
   - Label allocated/estimated cost and separate recommendation disappearance from verified savings.
   - Evaluate cause candidates and abstention against labeled scenarios; routing accuracy alone is
     not a measure of diagnosis quality.

## Acceptance

The public integration must preserve samples deployment behavior and existing ownership checks.
The P0 regressions must be covered by executable tests. E2E and outcome capabilities are complete
only when their producers, read APIs and operator views are connected and tested; interfaces or
documentation alone do not establish completion.
