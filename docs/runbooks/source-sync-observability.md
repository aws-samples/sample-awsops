# Public source integration and observability rollout / 공개 원본 통합과 관측성 적용

## Source scope / 원본 범위

This change reconciles the public `samples/dev` tree with `origin/main` at
`940772e13f33494e512c4a03935b7e4487313c8f`, using the previous public import
`a4a41440` as the content baseline. The destination baseline is
`8a9a6e0e70b807da2c12c4d84e1ef0345f5d6ae3`.

기존 공개 import를 기준으로 원본의 변경과 samples 고유 변경을 함께 반영한다. 비공개 원본
커밋 이력은 공개하지 않으며, 기존과 동일하게 내용만 스쿼시한다.

- Preserve samples CI/OIDC, branch/deployment policy and `terraform/foundation`.
- Keep private ADR/review/planning and local agent-tooling directories excluded.
- Preserve existing SQL migration bytes and release headers.
- `upstream/v2` at `f22be3a0` is already included in the destination, including Direct Connect topology.
- `upstream/main` at `b3ee1109` was reviewed separately because it is the retired v1 line.
  Its missing Chinese blog metadata is moved into the current `docs-site/i18n/zh` locale,
  and its PDF network-isolation fix is implemented in the v2 worker.
- The current v2 brochure, translations, report exports and runtime supersede the old v1 equivalents.
  Retired `src/`, root package manifests, systemd/watchdog code and old operational screenshots
  are not restored.

samples의 CI·OIDC·브랜치/배포 정책과 Terraform 경로를 유지한다. upstream/v2의 변경은 이미
포함되어 있다. v1인 upstream/main에서는 현재 구조에 필요한 중국어 메타데이터와 PDF 요청
격리만 이식하며, 폐기된 실행 경로와 오래된 운영 자료는 복원하지 않는다.

## Additive migrations / 추가 마이그레이션

- `01M2GRW64VTMC9AC8M7T9MZKQ4_graph_attempt_disclosure.sql`: bounded `sourceAttempted`, `not_attempted` and `count_not_confirmed` disclosure in the existing collection view; no grant changes.

- `01M2FV44NER7VC3CTX2ZMT9FZG_topology_inventory_evidence.sql`: current collection-state view with bounded flow/infra source clocks, scope, producer status and saved-source provenance; no raw provider JSON or new grants.

- `01M279W0J9HNG1QT0MAS60KV8K_topology_graph_collection_state.sql`: collection attempts,
  explicit graph evidence counts, and projected SQL-reader views.
- `01M27B0000C6QWJ50NRJ8YAH9D_trace_queue_claim_provenance.sql`: queue claimed account/region
  derived only from destination ARN qualifiers and constant `telemetry_claim` provenance in the
  SQL-reader projection, including retained snapshots; idempotent view-only SELECT grant.
- `01M27AQXZKQQ5J611R01BEFHPD_worker_jobs_lifecycle_timestamps.sql`: first worker-start and
  terminal timestamps, stamped by the existing ledger's status transitions.

The samples web deployment workflow does not run migrations. Run the existing `make migrate`
from the authorized VPC/operator context to activate these metadata contracts. Existing workers
continue to operate before migration; new timing reads remain unknown, and trace collection
waits for its state schema. Historical timestamps are not backfilled.

samples 웹 배포 워크플로는 마이그레이션을 실행하지 않는다. 승인된 VPC/운영자 환경에서
기존 `make migrate`를 실행해야 새 관측 계약이 활성화된다. 적용 전에도 기존 워커는 동작하며,
시간 값은 미확인으로 표시하고 트레이스 수집은 상태 스키마가 준비될 때까지 대기한다.
과거 시각을 추정해 채우지 않는다.

Deploy the web/graph writer and redeploy the `inventory_read_mcp` Lambda through the existing
Terraform operator flow. `make agentcore` alone does not ship this Lambda code. The projection
migration corrects retained-row claims at read time without requiring a graph rebuild.
웹/그래프 writer와 `inventory_read_mcp` Lambda도 배포한다. Lambda 코드는 기존 Terraform
운영 절차로 배포하며 `make agentcore`만으로 반영되지 않는다. projection 마이그레이션은
그래프 재구축 없이도 보존된 행의 claim을 읽을 때 바로잡는다.

After deployment, the datasource index rebuilds catalog-v3 queries to retain optional span
metadata and metric scope labels. Before reindexing, older cached queries can provide less evidence.
카탈로그 v3 재색인 이후 선택적 span 메타데이터와 메트릭 스코프가 보존된다. 이전 캐시 질의는
더 적은 근거를 제공할 수 있다.

## What the views establish / 관측의 의미

- Service maps distinguish collection failure, partial results, successful empty results and stale
  snapshots. A retained graph does not establish present traffic. Unqualified messaging destinations
  do not imply a shared broker.
- Job wait is acceptance to the first observed worker start, including queue and scheduling.
  Worker lifecycle is start to terminal completion, including retries and delays; it is not CPU time.
- The completion objective covers jobs accepted in the selected window. Overdue active work misses
  the objective; work not yet due is pending. Missing terminal timing and truncated samples prevent
  unsupported aggregate claims.
- A finding disappearing from a FinOps scan does not prove realized savings. Workload cost allocation
  and deployment-event correlation require additional source data and are not supplied by job timing.
- The evaluation CLI uses explicitly synthetic cases. Fixture tests prove evaluator behavior;
  actual diagnostic accuracy requires model predictions, and production accuracy requires real
  incident evaluation.

서비스 맵은 수집 상태를, 작업 화면은 명시된 실행 경계의 시간을 보여준다. 이전 그래프·관측
누락·부분 표본을 정상 근거로 사용하지 않는다. 완료 목표는 선택 기간에 접수된 작업 기준이며,
기한 초과와 아직 기한이 남은 작업을 구분한다. FinOps 권장 조건 해소는 실제 절감 검증이
아니며, 업무 원가 배분·배포 이벤트 연계는 별도 원천 데이터가 필요하다. 합성 평가의 테스트
통과를 운영 진단 정확도로 해석하지 않는다.


The web task and inventory-reader Lambda both receive `graph_rebuild_interval_mins` through
`GRAPH_REBUILD_INTERVAL_MINS`. Their freshness threshold is twice that cadence with a 15-minute
minimum; zero retains that minimum. For example, a successful 20-minute-old snapshot is current
at a 30-minute cadence in both readers. Failed/partial/retained evidence keeps its existing gates.
Apply the Lambda environment binding through Terraform along with the reader code deployment;
updating the code alone does not configure the cadence.

웹과 inventory-reader Lambda에 같은 `graph_rebuild_interval_mins`를 전달한다. 신선도 기준은
수집 주기의 두 배이며 최소 15분이고, 0에서도 이 최소값을 유지한다. 30분 주기에서 정상적으로
수집된 20분 전 스냅샷은 양쪽에서 최신으로 판정한다. 실패·부분·보존 데이터의 기존 판정은
유지하며, 코드 배포와 함께 Terraform의 Lambda 환경설정도 반영해야 한다.

## Inventory freshness and retained evidence

`inventory_stale_after_minutes` binds `INVENTORY_STALE_AFTER_MINUTES` in both the web
workload and inventory-reader Lambda (default 30, integer 1–1440). It independently gates
flow/infra source clocks and completeness; the graph-cadence threshold above still gates
saved publication age. A recent graph publication cannot make old or incomplete source
evidence fresh. Environment/source integration does not establish an applied rollout.

Hard input/graph budgets and failed collection preserve last-good evidence. Repeated
retentions never authorize an empty publication or unproven sweep. A job-level aggregate
zero does not prove an unobserved member participated. Unsupported/missing evidence must
remain explicit; no retry count converts it into success. The request and publication
transaction helper requires PostgreSQL 17 for `transaction_timeout` (the stack default is 17.9).

## Trace identity boundaries / 트레이스 식별 경계

- Queue ARNs join across caller accounts/regions only within the same datasource/environment.
  The same ARN can therefore have separate nodes in different datasource/environment scopes.
  `claimedAccountId` and `claimedRegion` come only from parsed destination ARN qualifiers, with constant
  `identityProvenance: telemetry_claim`; even a host-account match does not verify a claim.
  Non-ARN broker destinations and missing qualifiers have null claims. Reporter account/region and
  stored legacy/current claim fields are never fallbacks. The UI displays the values beside the disclaimer.
  Queues have no AWS-inventory bridge. The graph row's `account_id = self` is snapshot storage
  scope, not evidence of queue ownership. Apply the new projection migration before relying on
  direct SQL-reader queries; the API and AI tool also rederive claims from retained destinations.
- DB hostname matching adds a new host-configured branch: an explicit account matching
  configured `HOST_ACCOUNT_ID`, alongside the existing absent-account and `self` branches.
  Set `HOST_ACCOUNT_ID` from trusted
  deployment configuration for manual graph rebuilds, never from a span. The resulting DB link
  is a host-name correlation, not validation of arbitrary telemetry or a queue-identity rule.
- Tempo search may omit leading hex zeros or return a 64-bit trace ID. Normalize trace hex up
  to 32 digits to full 16-byte identity; span hex and base64 bytes keep their strict widths.
  Opaque nonhex legacy IDs stay exact. A full zero parent means no parent; zero trace/child IDs
  are invalid and contribute no graph identity.

큐 ARN은 같은 데이터소스·환경에서만 호출자의 계정·리전을 넘어 연결되며, 범위가 다르면
같은 ARN도 별도 노드가 된다. 계정·리전 claim은 destination ARN을 파싱해 얻은 값만 사용한다.
비-ARN 브로커 목적지와 누락된 한정자는 null이며 호출자 정보나 저장된 claim으로 폴백하지 않는다.
UI는 값과 미검증 고지를 함께 표시하고, 호스트 계정과 같아도 검증되지 않는다. 큐를 AWS 인벤토리로
연결하지 않고, 행의 `self`는 저장 범위일 뿐 소유권 증명이 아니다. 직접 SQL 조회는 새
projection 마이그레이션을 적용해야 하며 API와 AI 도구도 보존된 destination에서 claim을 재계산한다.
DB 호스트명 매칭에는 기존 계정 부재·`self` 분기에 더해 설정된 `HOST_ACCOUNT_ID`와
명시적 계정이 일치하는 새 분기를 추가한다.
수동 그래프 재구축의 `HOST_ACCOUNT_ID`는 배포 설정에서 가져오며 span에서 설정하지 않는다.
이 DB 링크는 호스트명 상관관계이고 임의 텔레메트리 검증이나 큐 식별 규칙이 아니다.
Tempo의 짧은 hex trace ID는 16바이트로 정규화하고 span/base64 너비 검증은 유지한다.
비-hex 레거시 ID는 그대로 보존하며, 전체 0 부모는 부재이고 0 trace/child는 무효이다.

## Direct Connect assessment scope / Direct Connect 평가 범위

Only `available` and `down` establish deployed connections for health, location summaries and
owned-only SLA counts. All other states, including `deleting`, `unknown`, missing and future values,
are excluded and disclosed as unassessed. A deployed-scope health pass does not certify the whole
inventory. Missing metrics, location/device evidence and failed reads retain their unknown gates;
two observed deployed sites establish a lower bound, not complete inventory coverage.
`totals.connectionsDown`, the scoped down KPI and the deployed-health checklist share this
classification. Excluded lifecycle metadata alone is not a failure. An explicit
`ConnectionState` minimum of zero on an excluded row remains visible as a separate critical
period observation in the KPI area and checklist, without asserting a current deployed failure.
The KPI discloses assessed/excluded/unknown counts; an all-excluded fleet is unassessed, not zero-down healthy.
Graph connections, location links and LAG summaries use the same affirmative evidence.
Only deployed connections with an up metric and no down evidence count as `up`; unknown and
unassessed members are labeled separately, including period-down observations on excluded members.

상태가 `available` 또는 `down`인 커넥션만 배포된 것으로 인정해 상태·위치·owned 전용 SLA를
평가한다. `deleting`·`unknown`·누락·미래 값을 포함한 다른 상태는 제외·미평가로 고지한다.
배포 범위의 정상 판정은 전체 인벤토리의 정상 증명이 아니다. 메트릭·위치·디바이스 근거 누락과
조회 실패의 미확인 판정은 유지하며, 관측된 두 배포 위치는 하한일 뿐 전체 수집을 증명하지 않는다.
`totals.connectionsDown`·범위를 명시한 다운 KPI·배포된 커넥션 상태 체크리스트는 같은
분류를 사용한다. 제외된 수명 주기 상태만으로 장애를 만들지 않는다. 제외 행의
`ConnectionState` 최솟값이 명시적으로 0이면 KPI 영역과 체크리스트에 별도의 중요 기간 관측으로
유지하되 현재 배포 장애로 단정하지 않는다. KPI는 평가·제외·미확인 수를 고지하며,
전부 제외된 인벤토리는 다운 0건 정상 대신 미평가로 표시한다.
그래프 커넥션·로케이션 링크·LAG 요약도 같은 긍정 근거를 사용한다. 배포 상태이고 up 메트릭이
있으며 다운 근거가 없는 커넥션만 `up`으로 세고, 미확인·미평가 멤버와 제외 멤버의 기간 내
다운 관측을 별도로 표시한다.

## Frozen approval contract / 동결된 승인 계약

ADR-005 deliberately leaves `awaiting_approval` unclaimable in `db.claim_running`, even after
an approval callback. The retained remediation ASL is dark substrate, not a supported execution
path. SQL tests exercise the actual predicate before/after lifecycle migration; enabling this
path or widening the predicate is outside these review fixes.

ADR-005에 따라 승인 콜백 이후에도 `awaiting_approval`은 의도적으로 claim할 수 없다.
남아 있는 remediation ASL은 비활성 코드이며 실행을 지원하는 경로가 아니다. 실제 SQL
테스트는 lifecycle 마이그레이션 전후의 거부와 원래 행 보존을 확인한다. 이 경로 활성화나
조건 확대는 이번 검토 수정의 범위가 아니다.


## Trace collection rendering

When a partial graph lacks an explanation, inspect its existing collection fields:
`nodeDrops`, `edgeDrops`, `orphanSpans`, `invalidSpans`, `unresolvedMessaging`,
`infraUnavailable`, and per-source `windowStartMs/windowEndMs`. Source reasons and these
known loss counters explain partial results; arbitrary numeric metadata is not loss evidence.
Unresolved span parents/links, invalid spans and unresolved messaging spans are not labeled
as processing limits. The panel discloses positive loss counters and unavailable inventory context, renders
source windows separately from publication/capture clocks, and does not infer retention
from losses. `retainedPrevious` alone establishes that a saved graph is being reused.
The typed collection contract also describes optional additive producer fields; unknown
runtime data remains defensively normalized. Source-detail totals include saved sources; latest-attempt status counts have separate labels.
Verify locally with `cd web && npx vitest run components/topology/GraphCollectionStatus.test.tsx`;
the regression uses the real graph-state reader with a database boundary fixture.


## Topology evidence compatibility

**Symptoms:** an IP target remains unresolved, a collection panel omits its query
window, or source details do not explain a partial graph.

**Interpretation:** the configuration topology page requires independently corroborated
region/VPC/subnet evidence from RUNNING ECS tasks and pod inventory for EKS. A repeated IP in another
VPC or an Endpoints row without a corroborating pod cannot establish ownership. The
page uses the hydrated account scope, cancels earlier loads and rejects late results.
EKS failures, partial reads and scope-based opt-outs are explicit. Ordinary `entry-only`
/ `no-entry` clusters are counted as not queried, not failed reads. The existing EKS API
enumerates its configured region only; the panel names that region and declares other
regions unassessed. Inventory reads apply account selection only. Host EKS ownership
is not applied to all/mixed-account targets because their IP key does not establish
account identity. Unknown per-account run health is one scope notice; normal running
syncs are not failures. The self-keyed run ledger is an aggregate sweep across accounts:
its failures/partial results remain visible under every scope, separately from HTTP read
failures; a failed read does not itself add an unknown aggregate-health notice.
Aggregate success does not prove member-account health, and member capture
clocks never borrow its last-success time. Uncorroborated or shared hostNetwork pod IPs
remain unresolved without making a successful EKS read partial.
A failed subnet read or the 500-row response cap is disclosed even for an empty graph, alongside retained
unresolved targets; raw IP labels are not proof that a workload is absent.

For current trace windows and partial-result causes, see [Trace collection rendering](#trace-collection-rendering).
The browser-built configuration graph uses the currently fetched subnet inventory.
Persisted service-map ECS labels change only after the next flow rebuild; a merge alone
does not establish that it completed. Existing web CD may deploy the new image, and an
already-configured graph timer can rebuild after boot. Record CD, migration and rebuild
results separately; no timer configuration or rollout is performed by this source change.

The bounded publication implementation in `web/lib/graph-store.ts` supplies optional inventory capture/sweep
clocks, aggregate/account source scope, saved-source provenance and explicit truncation
flags. The UI accepts those fields without claiming that the producer deployment or
migration is already live. Missing metadata is unknown, not a failed-collector verdict.
The accepted shape is documented in [the API contract](../api-reference.md#graph-collection-metadata).

**Local verification:** from `web/`, run:

```bash
npx vitest run app/topology/page.test.tsx app/topology/subnet-input.test.tsx components/topology/GraphCollectionStatus.test.tsx lib/topology-config.test.ts lib/flow-topology.test.ts
```

These fixtures exercise real page/builder and graph-state-reader boundaries with local
transport/database doubles. They do not establish deployed AWS, Runtime or migration
state. Keep the existing separately authorized rollout procedure above (ADR-005,
ADR-007) and distinguish source integration from activation.


### Bounded rebuild scheduling

Inventory accounts are ordered by their oldest actual attempt, with unattempted reads
prioritized. One account failure does not prevent later accounts from progressing; the
original exception is still returned after that bounded pass. Duplicate admission is per
pool and graph class. Before the run budget is exhausted, a final bounded transaction
records skipped source reads as unavailable with `sourceAttempted=false`; publication
clocks and graph rows remain unchanged. Concurrent newer attempts win. If the database
or class lock prevents that best-effort metadata write, the CLI reports the recording gap.
This is scheduling within the existing invocation, not a new retry loop or publication
permission. Failed collection and hard budget breaches still retain last-good data.
