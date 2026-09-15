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

- `01M279W0J9HNG1QT0MAS60KV8K_topology_graph_collection_state.sql`: collection attempts,
  explicit graph evidence counts, and projected SQL-reader views.
- `01M27AQXZKQQ5J611R01BEFHPD_worker_jobs_lifecycle_timestamps.sql`: first worker-start and
  terminal timestamps, stamped by the existing ledger's status transitions.
- `01M27B0000C6QWJ50NRJ8YAH9D_trace_queue_claim_provenance.sql`: queue claimed account/region
  derived only from destination ARN qualifiers and constant `telemetry_claim` provenance in the
  SQL-reader projection, including retained snapshots; idempotent view-only SELECT grant.
- `01M2FV44NER7VC3CTX2ZMT9FZG_topology_inventory_evidence.sql`: collection-state projection for flow/infra, bounded source clocks/status/scope, saved sources, loss counters and failure reasons; existing grants remain unchanged.
- `01M2GRW64VTMC9AC8M7T9MZKQ4_graph_attempt_disclosure.sql`: bounded sourceAttempted/not_attempted/count_not_confirmed metadata, unchanged from the prepared publisher contract.
- `01M2GTT5VHHH3TZ4PDJS99HWMJ_graph_read_indexes.sql`: class-ordered indexes for bounded graph reads; no writer or schedule activation.
- `01M2HM8BR5ZC0JZWGQ9ZFV1WT2_graph_projection_parity.sql`: matching HTTP/SQL vocabulary, nullable source clocks and computed metadataTruncated; existing grants unchanged.

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
`GRAPH_REBUILD_INTERVAL_MINS`. Their graph-publication freshness threshold is twice that cadence with a 15-minute
minimum; zero retains that minimum. For example, a successful 20-minute-old snapshot is current
at a 30-minute cadence in both readers. Failed/partial/retained evidence keeps its existing gates.
Apply the Lambda environment binding through Terraform along with the reader code deployment;
updating the code alone does not configure the cadence.

웹과 inventory-reader Lambda에 같은 `graph_rebuild_interval_mins`를 전달한다. 그래프 게시 시점의 신선도 기준은
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
as processing limits. The panel groups positive loss counters and unavailable inventory context in its Collection limitations list, renders
source windows separately from publication/capture clocks, and does not infer retention
from losses. `retainedPrevious` alone establishes that a saved graph is being reused.
The typed collection contract also describes optional additive producer fields; unknown
runtime data remains defensively normalized. Source-detail totals count displayed rows:
identical current/saved lists appear once with saved provenance, while differing or saved-only
lists remain separate. Status counts summarize latest-attempt sources. A shared saved list
does not add a second saved-count chip to the collapsed summary.
Verify locally with `cd web && npx vitest run components/topology/GraphCollectionStatus.test.tsx`;
the regression uses the real graph-state reader with a database boundary fixture.

Typed busy-read recovery is a bounded browser operation, not a collection retry. See
[the graph read contract](graph-read-contract.md#browser-recovery-and-source-evidence)
for its cancellation, timeout and read-status behavior.


Tempo `count_not_confirmed` identifies an unverified response, not a query failure. Valid synchronous responses can omit default protobuf job counters. Valid oversized trace children expose `projection: "bounded_otlp"` and remain usable partial evidence. See the [canonical completion contract](tempo-query-generation.md#search-completion-and-publication).

## Topology evidence compatibility

**Symptoms:** an IP target stays unresolved, inventory shows a read/scope warning,
Refresh retains the previous graph, or source details do not explain partial coverage.

**Interpretation:** inventory rows and the global per-type sweep ledger are read by one
SQL statement through `pool.query`, so each page uses one PostgreSQL statement snapshot
without holding a connection across application-managed transaction commands. Critical
target-group/ECS-task/subnet pages require `consistency: "statement-snapshot"` and a stable
succeeded ledger version across pages. The ledger is keyed under `self` for the whole
account sweep; its count is neither the selected account's count nor this page's count.
The collector marks that ledger running before mutating rows. This supports cross-page
version rejection, not a claim that every page/type or live AWS resource is one snapshot.
See the [single API contract](../api-reference.md#inventory-pagination-and-sweep-ledger).

All inventory and enrichment requests share two browser request lanes. Critical types
page sequentially within a lane, at most 20 × 500 rows; other display types stop at 500.
The browser's shared 30-second deadline also covers EKS. A real remaining cap is disclosed
with its configured limit (10,000 for critical types); an incomplete first page is not
reported as reaching that full cap. Missing/changed metadata and unsuccessful reads
withhold ownership. Authentication, scope checks and read-only policy remain unchanged.

| Signal | Meaning and verification/action |
|---|---|
| `<type>: invalid inventory response` | Inspect that authenticated inventory request's status/envelope. A critical response needs the statement-snapshot marker and valid ledger fields. Missing/older markers may indicate mixed deployed versions; keep attribution withheld and retry after the reviewed web rollout completes. Do not bypass authentication or invent empty success. |
| Running/partial/failed or changed ledger | The global sweep is incomplete or changed while paging. Inspect collection status and retry after it completes. Cached rows are display context, not exclusive ownership or per-account success. |
| `cluster_not_connected` | The listed cluster was not queried because onboarding/access is incomplete. It is distinct from a transport failure, but its known network scope still blocks IP ownership, including unseen IPs. Check the EKS access/onboarding status and use the existing separately authorized procedure. |
| `cluster_unreadable` / `cluster_limit_possible` | EKS reads, metadata or enumeration coverage are unavailable/incomplete. Known failed region/VPC scopes block matching IPs; unknown scope or truncated enumeration blocks the map. Check EKS status/permissions and the returned region/truncation metadata; do not assume missing clusters own no IPs. |
| `eks_not_enumerated` / `ownership_reason` | Host EKS evidence is not joined to member/mixed/all-account inventory or unqueried regions. Use an appropriate host scope for host checks; cached configuration labels do not establish live ownership. |
| Ambiguous IP | Only independently listed active pods or RUNNING tasks with complete scope can be candidates. Succeeded/Failed pods and STOPPED/DELETED tasks do not claim old IPs; unknown states/references remain unverified. The same IP in two clusters within one region/VPC stays withheld even if labels match; distinct addresses/scopes remain independent. |
| Retained-data notice | A failed/incomplete refresh that would yield an empty graph keeps the prior nonempty graph only for the same account, including its original evidence. Current attempt errors are separate. Complete empty results replace it; account changes discard it. Retention does not establish current traffic. |
| Old/unknown capture time | Refresh freshness comes from source capture/eligible host last-success time, never the new read's clock. Member clocks do not borrow the aggregate success timestamp. `targetCapturedAt` dates only the target-group row, not task/subnet/pod ownership evidence. |

The hydrated account scope controls inventory reads; earlier loads are cancelled and
late responses rejected. Aggregate run health is shown under every scope, separately
from HTTP failures and unknown per-account health. Running syncs and ordinary ambiguous
pod IPs are not failed collections. Raw IP labels are not evidence that a workload is absent.
A manual Service endpoint without a pod reference cannot supply pod ownership or rename a
pod across namespaces; unresolved explicit pod references still withhold attribution.

For trace query windows and partial-result causes, see
[Trace collection rendering](#trace-collection-rendering). Current/saved source reasons,
assembly-loss counters and optional clocks remain bounded, explicit evidence. Optional
metadata support does not claim that every producer emits it. The browser uses fetched
configuration; persisted service-map labels change only after a flow rebuild, which this
source integration does not trigger. SQL-reader projections omit ownership provenance;
see [the agent contract](agent-sql-reader.md#current-topology-evidence-contract).

The bounded publication implementation in `web/lib/graph-store.ts` supplies optional inventory capture/sweep clocks, aggregate/account source scope, saved-source provenance and explicit truncation flags. Missing metadata remains unknown; producer deployment and migration are separately verified. See [the API contract](../api-reference.md#graph-collection-metadata).

**Local verification:** from `web/`, run:

```bash
npx vitest run lib/inventory.test.ts app/topology/page.test.tsx app/topology/page-ownership.test.tsx app/topology/subnet-input.test.tsx components/topology/GraphCollectionStatus.test.tsx lib/topology-config.test.ts lib/flow-topology.test.ts
```

These fixtures exercise real page/builder and graph-state-reader boundaries with local
transport/database doubles.

From the repository root, with locked web/scripts dependencies and local Docker:

```bash
node --test scripts/v2/ci/migration.itest.mjs scripts/v2/ci/web-db-connection.itest.mjs
```

The latter uses disposable PostgreSQL 17, including the connected-client ordering case,
empty/ledger results, worst-first ordering, concurrent-writer consistency and pool reuse.
These checks do not establish deployed AWS, Runtime or migration state. Keep the existing
separately authorized rollout procedure above (ADR-005/ADR-007); source integration is
not activation.

### Bounded rebuild scheduling

Inventory accounts are ordered by their oldest actual attempt, with unattempted reads
prioritized. One account failure does not prevent later accounts from progressing; the
returned summary includes the unexpected-account-error `failed` count and first sanitized `failureCode`. Duplicate admission is per
pool and graph class. Before the run budget is exhausted, a final bounded transaction
records skipped source reads as unavailable with `sourceAttempted=false`; publication
clocks and graph rows remain unchanged. Concurrent newer attempts win. If the database
or class lock prevents that best-effort metadata write, the CLI reports the recording gap.
This is scheduling within the existing invocation, not a new retry loop or publication
permission. Failed collection and hard budget breaches still retain last-good data.

### Graph read rollout and source age

Apply the named collection projection and read-index migrations through the existing authorized `make migrate` operator flow before relying on the widened SQL-reader view and indexed read plan. The reader remains compatible with missing state as unknown; the flow/infra publisher still requires its separately authorized schedule/manual invocation. Source integration and automatic web CD do not prove these migrations ran.

Separately, `inventory_stale_after_minutes` supplies `INVENTORY_STALE_AFTER_MINUTES` to the web task and inventory-reader Lambda (default 30, 1–1440). Applying the reviewed Terraform environment change, deploying the web image, and redeploying the updated `inventory_read_mcp` Lambda code through the operator-owned Terraform release flow are separate steps. The Lambda code update is required for its future-clock and metadata-omission staleness checks; web or AgentCore Runtime image deployment does not deliver it. The shared number is an age threshold, not identical status algorithms: the graph also requires a succeeded producer and ok/empty published-source evidence, valid source clocks and a fresh graph publication. Unknown attributes produce partial source evidence, not fresh completeness. Future clocks remain unknown/stale conservatively.

See [graph read contract](graph-read-contract.md) for request budgets, read-vs-collection disclosure, legacy display clocks and the disposable PostgreSQL tests. No repeated retention count permits an unproven empty publication or sweep.

### Source proof before graph publication

Graph adapters honor typed collection status and withhold empty publication when a legacy empty or zero-only result lacks affirmative completion evidence. ClickHouse, Tempo and Prometheus/Mimir adapters report `empty_not_confirmed` rather than interpreting delivery success as collection success. Useful nonempty data and existing error/truncation signals remain intact. Sync results and per-account snapshots count the same unique account/region/resource identities persisted by the upsert, preserving last-row-wins data.

The PostgreSQL read-contract suite also exercises real graph publication against the shared producer fixture and a legacy unmarked-empty response. Producer/source integration does not deploy Lambda code; rollout remains separately controlled.

The shared `agent/fixtures/tempo-topology-contract.json` fixture binds actual producer bodies to adapter and PostgreSQL publication regressions; the source-only producer check ships with the prerequisite and Runtime receipt-wire tests follow the Runtime core. Account discovery uses scan-scope registry entries plus current inventory and saved graph/state keys. Per-account inventory snapshots are queried only after selection to prove participation, including first-collection zeros. Discovery alone never grants participation or empty proof; current-account/snapshot/count checks remain mandatory. Zero-row inventory with unknown attribute completeness retains last-good data.

#### Producer completion and rollout

Prometheus/Mimir instant scalar and string results preserve one timestamp/value sample, with a 4096-byte UTF-8 value bound. Invalid matrix/vector metric-label maps or samples use a fixed null marker instead of echoing arbitrary upstream content; malformed or oversized scalar pairs remain unknown. Diagnosis counts a valid scalar pair as one sample and still excludes its raw value; Explore renders it as one row. Range queries retain their series-only contract. Native `histogram`/`histograms` output is explicitly unsupported and rejected before serialization; request float-valued output rather than treating an unsupported histogram as unknown collection.

Catalog guidance accompanies every affected ClickHouse query/tables/describe and Prometheus/Mimir query/query-range/labels/series tool, as well as Tempo search. Run existing AgentCore provisioning to reconcile all these descriptions after the producer code rollout. Partial/unknown/error evidence cannot establish absence or full coverage.


The query/discovery paths in the paired `prometheus_mcp`, `mimir_mcp`, `tempo_mcp` and `clickhouse_mcp` modules compute `collectionStatus` from their own validated responses, warnings, limits and completion evidence. They do not copy a datasource-supplied `collectionStatus`. `ok`/`empty` permit complete results; `partial`, `unknown` and `error` cannot certify an empty graph. Deploy the producer Lambda code before expecting confirmed-empty behavior; old unmarked empty/zero-only results intentionally remain unconfirmed during rollout. No connector activation or IAM change is implied.

An observed zero sample remains a zero sample. It does not prove the entire query was complete when an old wrapper discarded upstream warnings or accepted missing success status. Paired metric producers preserve those conditions; complete zero-only responses remain `ok`, while incomplete responses preserve the zero data with a partial marker. Tempo search IDs followed by no fetched spans are incomplete regardless of the parent search marker. The source-only producer contract test exercises the shared fixture's upstream-to-body mapping; Runtime receipt-wire tests remain with the later Runtime/producer stages.

Publication versus retention is defined in the
[graph read contract](graph-read-contract.md#source-completeness-and-retained-publication).
Missing-child/unconfirmed-empty/failed-source evidence retains the prior graph despite useful
siblings; valid nonempty bounded reads publish partial snapshots. This is not accumulating
old generations or upgrading warnings/unknown metadata to complete coverage.

HTTP 206 and explicit upstream warnings/partial signals cannot establish complete empty
collection. Error envelopes remain errors even when they also contain an empty array.
Prometheus/Mimir retain outer success and warning/info evidence before unwrapping query
results. Matrix/vector metric-label keys/values must be strings and sample-value strings must not exceed 128 characters; invalid series become fixed null markers while valid sibling series remain available. Metric-producer errors longer than 400 characters become a fixed diagnostic.
Query/label/series outputs are byte-bounded without raw previews. Instant scalar/string results are one bounded sample, never two records. Diagnosis
keeps only the count and type; its raw value is excluded. Explore drops and counts invalid series, samples and log entries, preserves usable siblings, and marks normalization loss unknown (or retains an existing error). The displayed omission count measures discarded response entries, not total missing traffic.
Their label/series endpoints also propagate `error` and `unknown` without converting them
to empty. Tempo treats malformed/null completion metrics as unknown and unfinished jobs
as partial. `tempo_get_trace` retains bounded structured spans when possible; a no-fit byte
omission is partial, never complete/empty. A spanless no-fit marker retains the previous graph even with useful siblings; only
actual parsed structured spans can support partial publication. Encountered malformed projected spans make the whole producer projection unknown, which remains unverified evidence rather than a fabricated query failure. Unvisited tail data is not represented. Unmarked-empty/missing/failed children retain even
with useful siblings. `tempo-child-contract.json` binds the actual producer envelope to
adapter and PostgreSQL retention tests.

ClickHouse's upstream JSON `rows` must be an integer equal to `data.length`, and `meta`
must contain nonempty column names/types. A valid zero uses `rows: 0` and a real column
schema; missing, contradictory or malformed counts/metadata cannot certify it. Preserve
the connector's existing bounded rows and `truncated` field alongside `collectionStatus`.
`agent/fixtures/query-topology-contract.json` and the existing Tempo fixture bind mocked
HTTP payloads to actual producer bodies and TypeScript adapter outcomes. The producer
regressions retain valid-zero, nonempty, warning/error, malformed-metadata and limit cases;
the PostgreSQL regressions independently enforce missing-child retention.

### Explore evidence display

`NormalizedResult` retains the validated collection status and a localized disclosure. Explore shows it for both empty and nonempty results, while boolean truncation remains visible. Unknown/error/partial empty bodies are not rendered as plain no-results; confirmed empty and unmarked legacy display behavior remain distinct. Scalar/string format validation precedes the empty-list shortcut. Non-boolean truncation flags receive an unverified-state disclosure, without discarding useful rows.

### Diagnosis signal completeness

Any loss during record validation is disclosed as incomplete regardless of producer-marker presence, including Loki/legacy bodies. Valid unmarked records retain their previous count behavior; malformed nonempty lists cannot become a clean zero.


Observed counts exclude null/empty placeholders. Known metric records require a metric object and usable numeric sample, trace records require a valid nonzero hex trace identity, and log streams require a usable timestamp/line pair. Generic table/aggregate counts include nonempty structured rows only. A missing validated count is not a confirmed zero.


The diagnosis worker preserves connector `collectionStatus` and truncation before preparing model evidence. Partial/unknown results carry `incomplete: true`, not a query-error signal; nonempty observed records remain as `observedCount`, never a complete zero. `collectionStatus: error` keeps a fixed error signal. Known `ok`/`empty` results retain their counts. Raw rows, trace payloads, sample values and upstream error text are not copied into these summaries. Deploy the worker source update with the connector producer changes. Verify offline with `PYTHONPATH=scripts/v2/workers python3 -m pytest scripts/v2/workers/diagnosis/test_datasources.py -q`.

Tempo search uses validated synchronous HTTP 200 completion, not a mandatory job-counter pair. Missing protobuf default fields can be valid; malformed or unrecognized responses remain unknown, explicit unfinished work remains partial. See [the canonical Tempo runbook](tempo-query-generation.md#search-completion-and-publication) for exact shape, limit and omission semantics. Deploy the producer Lambdas and reconcile all affected Gateway descriptions through the existing AgentCore provisioning flow; a source merge does not update deployed tools.

Unmarked responses use the same structural validation. Valid, untruncated output keeps a `count` field without asserting collection completion. Validation loss or truncation produces incomplete evidence and only a validated nonzero `observedCount`, even for Loki or pre-rollout bodies. A legacy unmarked literal empty list still has its existing compatibility behavior; this does not introduce affirmative empty proof. `observedCount` counts validated returned records, not automatically violations; interpret it with the query scope.
