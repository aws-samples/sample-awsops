# 서비스·네트워크 통합 토폴로지 / Service and network topology

## 목적 / Purpose

사용자는 서비스 그래프의 중심을 트래픽 흐름으로 두고, Network Flow Monitor의 관측과 결합한 E2E 그래프를 토폴로지에서 요청했다. 기존 트래픽·서비스 그래프를 재사용하고, 근거가 있는 지점에서 연결한다.

The requested feature combines the existing front-door topology, service observations, and Network Flow Monitor (NFM) traffic in an opt-in topology view. It correlates identities without claiming that independent observations represent one traced request.

## 화면 / User flow

- `/topology?view=e2e`: **서비스 + 네트워크** 보기. 기본 `/topology`는 기존 구성 흐름을 유지한다. / The query parameter opts into the new view; the existing default view remains available.
- 모니터 하나, 메트릭 하나, 15분·30분·1시간, 목적지 분류를 선택하고 조회한다. 분류 전체는 기존 7개 분류이며 동시 요청은 3개 이하이다. / Select one monitor, one metric, a supported window, and one/all destination categories; at most three category requests run concurrently.
- 서비스 관측과 구성 흐름은 독립적으로 로드한다. NFM 부재·실패·부분 실패가 다른 계층을 지우지 않는다. / Source failures remain independent.
- 검색·노드 선택·근거 필터로 경로를 좁힌다. 상세에는 로컬/원격, 포트, 단위, 조회 구간, SNAT/DNAT, 경유 구성요소, 연결 근거를 표시한다. / Search, focus, evidence filters, and a detail panel expose the provenance of each connection.
- 네트워크 모니터·서비스 맵에서 통합 보기로 이동하는 링크를 제공한다. / Existing source pages link to the integrated view.

## 데이터 계약 / Data contract

기존 인증 API만 사용한다: 구성은 기존 `/topology`의 인벤토리 로더, 서비스는 `/api/graph?class=trace`, NFM은 `/api/nfm`과 `/api/nfm/query`.

Use existing authenticated APIs. No new API route, AWS resource, IAM permission, database migration, or dependency is introduced. New NFM query timestamps/cap metadata are additive and cached with the original result.

구성·서비스·네트워크 노드는 이름공간을 분리한다. 관계는 `configuration`, `service`, `network`, `identity`, `context`로 나눈다. 서비스 호출 화살표와 구성 관계의 방향은 보존한다. NFM의 로컬/원격을 요청의 발신자/수신자로 단정하지 않는다.

Namespace nodes by source. Preserve configuration/service direction, but represent NFM traffic as nondirectional local/remote observations. A per-flow connection node owns the selected metric, avoiding the false impression of per-hop measurements.

경유 구성요소는 연결 노드에 붙는 문맥 관계이다. 목록 순서를 패킷 경로 순서로 해석하지 않는다. SNAT/DNAT 주소를 서비스 식별자로 사용하지 않는다.

Traversed constructs attach as context, not an ordered packet trace. NAT aliases are displayed, never used as identity joins. Context edges must not make unrelated services reachable through a shared NAT/TGW during focus traversal.

## 식별자 연결 / Identity correlation

- 호스트 계정 `self`에서만 NFM·서비스 계층을 결합한다. 다른 계정/전체 계정 선택은 구성 계층만 표시하고 지원 범위를 명시한다. / Cross-account observation attribution is not implemented by the existing sources and must not be invented.
- 구성 타깃의 IP·instance ID는 TG의 region/VPC 문맥과 함께 비교한다. 필수 문맥이 없거나 후보가 여러 개면 연결하지 않고 미확인으로 표시한다. / Require exact endpoint identity plus matching network scope; ambiguous matches stay unlinked.
- `service.name`과 Kubernetes Service 이름이 같다는 이유로 합치지 않는다. 서비스 그래프의 workload는 cluster·namespace·pod의 정확한 일치로 연결한다. / Never join application and Kubernetes services by name alone.
- A monitor-name-derived cluster is a hint, not ownership evidence. Both local and remote workload links require an independently corroborated configured endpoint with matching cluster, namespace and pod; otherwise leave the observation unlinked.
- RDS DNS와 IP, S3 범주와 특정 bucket 등은 현재 데이터로 입증되지 않으면 별개 노드로 남긴다. / Preserve unresolved database and managed-service identities.

## 제한·실패 상태 / Bounds and failures

NFM은 상위 기여자 데이터이며 전체 트래픽 목록이 아니다. 서비스 그래프도 최근 표본/저장된 스냅샷이다. 정상 빈 결과, 미설정, 조회 실패, 부분 성공을 구분한다.

Do not infer idle resources from missing observations. Show each source's capture/query window and truncation. Keep all loaded data searchable before applying display limits (350 nodes, 700 edges). Drop dangling edges when bounding a view and show omitted counts.

모니터 변경·계정 변경·조회 조건 변경 시 이전 응답이 새 범위에 표시되지 않게 취소/세대 검사를 적용한다. 계정 전환 직후에도 이전 계정의 구성 그래프를 결합하지 않는다.

Guard response races and account transitions. A changed filter is applied only on explicit query; labels derive from the applied result, not unsubmitted controls.

## 검증 / Verification

순수 그래프 테스트: 설정/관측 구분, scope 충돌, 이름만 같은 서비스, local/remote 클러스터 구분, NAT 비식별, 경유 순서 비보장, 빈 소스, 제한 이전 검색.

Client tests cover bounded concurrency, mixed category outcomes, auth/error envelopes, aborts, and stale results. NFM tests verify original query-window timestamps survive cache hits. Browser fixtures exercise a front door → workload → network observation → downstream workload/service graph, its detail panel and metric filters, empty/error states, and desktop/mobile layout. Fixture checks do not establish live AWS collection completeness.

관련 원칙 / Related decisions: ADR-005 read-only posture; ADR-007 governed external data; ADR-043 existing topology layers. ADR bodies remain in the private upstream repository.
