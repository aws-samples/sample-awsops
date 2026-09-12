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
- `01M27B0000C6QWJ50NRJ8YAH9D_trace_queue_claim_provenance.sql`: queue claimed account/region
  and constant `telemetry_claim` provenance in the SQL-reader projection, including retained snapshots.
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


## Trace identity boundaries / 트레이스 식별 경계

- Queue ARNs join across caller accounts/regions only within the same datasource/environment.
  `claimedAccountId` and `claimedRegion` come from telemetry, with constant
  `identityProvenance: telemetry_claim`; even a host-account match does not verify a claim.
  Queues have no AWS-inventory bridge. The graph row's `account_id = self` is snapshot storage
  scope, not evidence of queue ownership. Apply the new projection migration before relying on
  direct SQL-reader queries; the API and AI tool also relabel legacy retained queue metadata.
- DB hostname matching retains its existing host-scope eligibility: absent account, `self`, or
  an explicit account matching configured `HOST_ACCOUNT_ID`. Set `HOST_ACCOUNT_ID` from trusted
  deployment configuration for manual graph rebuilds, never from a span. The resulting DB link
  is a host-name correlation, not validation of arbitrary telemetry or a queue-identity rule.
- Tempo search may omit leading hex zeros or return a 64-bit trace ID. Normalize trace hex up
  to 32 digits to full 16-byte identity; span hex and base64 bytes keep their strict widths.
  Opaque nonhex legacy IDs stay exact. A full zero parent means no parent; zero trace/child IDs
  are invalid and contribute no graph identity.

큐 ARN은 같은 데이터소스·환경에서만 호출자의 계정·리전을 넘어 연결된다. 계정·리전은
텔레메트리가 주장한 값이며 호스트 계정과 같아도 검증되지 않는다. 큐를 AWS 인벤토리로
연결하지 않고, 행의 `self`는 저장 범위일 뿐 소유권 증명이 아니다. 직접 SQL 조회는 새
projection 마이그레이션을 적용해야 하며 API와 AI 도구는 이전 큐 메타데이터도 주장 값으로
표시한다. DB 호스트명 매칭의 기존 범위(계정 부재·`self`·설정된 호스트 계정)는 유지한다.
수동 그래프 재구축의 `HOST_ACCOUNT_ID`는 배포 설정에서 가져오며 span에서 설정하지 않는다.
이 DB 링크는 호스트명 상관관계이고 임의 텔레메트리 검증이나 큐 식별 규칙이 아니다.
Tempo의 짧은 hex trace ID는 16바이트로 정규화하고 span/base64 너비 검증은 유지한다.
비-hex 레거시 ID는 그대로 보존하며, 전체 0 부모는 부재이고 0 trace/child는 무효이다.

## Frozen approval contract / 동결된 승인 계약

ADR-005 deliberately leaves `awaiting_approval` unclaimable in `db.claim_running`, even after
an approval callback. The retained remediation ASL is dark substrate, not a supported execution
path. SQL tests exercise the actual predicate before/after lifecycle migration; enabling this
path or widening the predicate is outside these review fixes.

ADR-005에 따라 승인 콜백 이후에도 `awaiting_approval`은 의도적으로 claim할 수 없다.
남아 있는 remediation ASL은 비활성 코드이며 실행을 지원하는 경로가 아니다. 실제 SQL
테스트는 lifecycle 마이그레이션 전후의 거부와 원래 행 보존을 확인한다. 이 경로 활성화나
조건 확대는 이번 검토 수정의 범위가 아니다.
