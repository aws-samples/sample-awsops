# E2E observability implementation plan / E2E 관측성 구현 계획

**Goal / 목표:** Connect workload evidence, execution state, changes and cost without treating
missing observations as healthy. 관측 부재를 정상으로 판정하지 않고 워크로드의 실행 상태,
근거, 변경과 비용을 연결한다.

**Architecture / 설계:** Keep the existing read-only datasource adapters, Aurora materialized
graphs and asynchronous workers. Normalize identity and collection coverage before building
graphs or evaluating invariants. 기존 읽기 전용 수집기·Aurora 그래프·비동기 워커를 유지하고,
그래프 생성과 진단에 앞서 식별자와 수집 범위를 정규화한다.

**Tech stack:** Next.js/TypeScript, Python, PostgreSQL, existing ClickHouse/Tempo/Prometheus/Mimir
connectors. No new telemetry backend or AWS-mutating tool.

## Constraints / 제약

- Preserve ADR-005: diagnosis and remediation proposals only. AWS mutation stays frozen.
- Use `terraform/foundation/`; merged migration bodies and `-- since:` headers stay immutable.
- Keep `samples/dev` CI, OIDC, deployment roles and branch strategy.
- Preserve the public export boundary; private upstream history and decision bodies are not published.
- Distinguish observed zero, successful empty, unavailable, failed, partial and stale observations.
- Keep bounded queries; a cap or failed source must be visible to API, UI and diagnosis consumers.

## Current correlation module boundary

`web/lib/e2e-topology.ts` and `web/lib/e2e-topology-types.ts` are a pure, **unwired**
prerequisite. They consume already-loaded configuration graphs, service snapshots and
network observations; they make no SDK/API calls and activate no page or canvas.
Existing routes, collection metadata and their authorization remain separate contracts.
Future consumers must validate their API envelopes and retain collection/unknown states.

`buildE2eGraph` keeps source records and evidence classes separate. Account, region/VPC,
pod/workload agreement and existing ownership/read-gap vetoes govern identity edges.
Cached configuration stays context and cannot become live/exclusive ownership.
Source capture times and observation windows retain their distinct meanings.
The non-self composition guard is not an authorization boundary.

`filterE2eGraph` and `matchesE2eQuery` expose eligible evidence for consumers.
`mainE2eConnection(nodes)` chooses a primary observation before display caps: prefer
`DATA_TRANSFERRED`, then sort metric and unit groups lexically; within a group choose
the largest finite nonnegative value, with stable ID ties. Empty metadata unit falls
back to the row unit. Invalid measurements are not a main flow. Values are not compared
across metric/unit groups or normalized into a common time window.
`rankE2eConnections(nodes)` exposes the same deterministic complete order without mutating
the input.

`selectE2eGraph` retains the focused node and fitting non-network query hits, then fits
complete matching network groups before residual explicit hits and optional neighbors.
Reserved group edges survive the edge cap. Tiny budgets may keep partial explicit hits.
Context attaches once and never grants transit reachability. Defaults remain 350 nodes
and 700 edges. `omittedCategories: Record<string, number>` counts observations hidden
**or incompletely displayed** by those caps after eligibility/focus/query filtering.
Each affected observation counts once, even when several endpoints/edges are omitted;
configuration nodes and filtered-out observations are excluded. Missing category metadata
uses `UNKNOWN`. Consumers must label this as display limitations, not entirely absent
categories or source-collection loss. `omittedNodes` and `omittedEdges` retain their
separate display counts.

Regression coverage is in `web/lib/e2e-topology.test.ts`, including seven categories
with 50 rows each, reversed input order, metric/unit selection, explicit priorities and
identity vetoes. `web/lib/flow-layout.ts` remains a generic layout helper; its immutable
node-size regression is in `web/lib/flow-layout.test.ts`. These tests establish module
contracts, not completed API/UI integration or live AWS traffic coverage.

## Delivery and verification / 구현 및 검증

1. **Source integration / 원본 통합**
   - Reconcile `origin/main` against the last imported snapshot, preserving samples-specific changes.
   - Review `upstream/main` and `upstream/v2`; port applicable fixes to the current v2 implementation.
   - Verify source paths, migration immutability, public boundaries, web/worker tests and build.

2. **Evidence and identity / 근거와 식별자**
   - `SourceRead<T>` carries items, status, source ID, reason codes and the exact time window.
   - Normalize cloud account/region, deployment environment, service namespace and Kubernetes scope.
   - Index spans by source, trace and span identity; preserve asynchronous span links.
   - Keep metric and sampled-span evidence distinguishable.
   - Record graph collection attempts; keep the last successful graph when a source fails.
   - Expose partial/stale/unavailable states alongside graph data, including empty graphs.
   - Regressions: identical service names in different scopes, missing parents, span links, source
     failure versus successful empty, bounded/truncated reads, and malformed observations.

3. **Diagnosis trust / 진단 신뢰성**
   - Carry collector status into deterministic invariant evaluation.
   - Return unknown when an absence-based conclusion lacks complete evidence.
   - The normalized evaluator contract supports positive violations and valid numeric zero.
     This is unit-fixture/direct-caller coverage, not live collector integration.
   - **Pending producer integration:** current X-Ray edges contain `to_ref`, not resolved `to`,
     and inventory has no `unencrypted` aggregate. All six live invariant kinds therefore
     remain `unknown`; empty regressions/improvements do not certify health. The producer
     adapters and collector-to-verdict validation are incomplete.
   - **생성기 연결 미완료:** 현재 X-Ray의 `to_ref`는 `to`로 해석되지 않고 암호화 집계도
     없으므로 운영 불변식 6종은 모두 `unknown`이다. 정규화된 단위 테스트가 운영 지원을
     의미하지 않으며, 빈 회귀·개선 목록을 정상으로 해석하지 않는다.
   - Persist assessed/unassessed counts and unknown reasons independently of the model.
     Render Intended vs Actual deterministically in the report/export, and expose the same
     coverage in the UI; legacy reports without coverage must remain visibly unassessed.
   - 미평가 건수·사유를 모델과 별개로 저장하고 본문·내보내기·화면에 표시한다.
     평가 기록이 없는 과거 보고서를 정상이나 개선으로 해석하지 않는다.
   - Treat missing confidence conservatively; keep the incident feature gate unchanged.
   - Port upstream PDF request isolation into the v2 worker.
   - Regressions: degraded/empty/partial observations and externally referenced report content.

4. **Representative workload / 대표 워크로드**
   - Use AWSops asynchronous diagnosis jobs as the first workload.
   - Preserve correlation across enqueue, dispatch and worker completion.
   - Show queue time, execution time, terminal state and evidence coverage.
   - Validate success, delay, retry and failure without mutating customer resources.

5. **Operational outcomes / 운영 성과**
   - Keep SLO attainment, deployment/change context and allocated cost tied to a workload and window.
   - Label allocated/estimated cost and separate recommendation disappearance from verified savings.
   - Evaluate cause candidates and abstention against labeled scenarios; routing accuracy alone is
     not a measure of diagnosis quality.

## Acceptance / 완료 기준

The public integration must preserve samples deployment behavior and existing ownership checks.
The P0 regressions must be covered by executable tests. E2E and outcome capabilities are complete
only when their producers, read APIs and operator views are connected and tested; interfaces or
documentation alone do not establish completion.

공개 통합은 samples 배포 동작과 소유권 검사를 보존해야 한다. P0 회귀는 실행 가능한 테스트로
검증한다. E2E·성과 기능은 데이터 생성·조회 API·운영 화면이 연결되어 검증되어야 완료이며,
인터페이스나 문서만 추가한 상태는 완료로 간주하지 않는다.
