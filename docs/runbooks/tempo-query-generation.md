# Tempo 쿼리 생성 / Tempo query generation

## 증상 / Symptoms

Explore의 AI 생성 결과가 속성 범위·타입 오류로 실행되지 않거나, 스키마를 새로고침해도 속성을 사용할 수 없다는 안내가 반복된다.

Explore generates a query with an invalid attribute scope or literal type, or keeps asking for a schema refresh without finding the requested attributes.

## 원인 후보 / Candidate causes

- 웹·Tempo 커넥터 Lambda·스키마 캐시 중 일부만 갱신됐다. / The web app, Tempo connector Lambda, and schema cache have not all been updated.
- 스키마 수집은 최근 **1시간**의 제한된 관측이다. 현재 AWSops의 Tempo Explore는 시간 범위를 선택할 수 없으며 검색도 최근 1시간을 사용한다. 오래된 트레이스에만 있는 속성이 최근 캐시에 없을 수 있다. / Schema discovery samples the last **hour**. AWSops's Tempo Explore currently has no time-range control and searches the last hour. Attributes present only in older traces may be absent from this cache.
- 타입 표본은 수집된 속성 중 `span.http.status_code`, `span.http.response.status_code`, `resource.service.name`, `span.service.name`만 대상으로 한다. 각 최대 32개 값에서 타입만 보존하며, 값 자체는 반환하거나 캐시하지 않는다. 표본 제한 또는 미수집은 타입을 확정할 근거가 아니다. / Type sampling covers only these four discovered attributes, retaining types from at most 32 values each. Values are neither returned nor cached; limited or missing samples cannot establish a definitive type.

## 확인 / Verification

선택한 Tempo 인스턴스와 스키마 갱신 시각을 확인한다. 최근 트레이스가 없는 경우, Grafana Explore에서 같은 Tempo 데이터소스와 과거 범위를 선택해 실제 속성명·타입을 확인하거나, Tempo 검색 API에 `start`·`end`(Unix 초)를 명시한다. `{ duration > 500ms }`는 속성 스키마 없이 사용할 수 있지만 HTTP 500 필터와 같은 의미는 아니다.

Check the selected Tempo instance and schema refresh time. If recent traces are absent, select that datasource and a historical range in Grafana Explore, or call Tempo's search API with explicit `start` and `end` bounds (Unix seconds), to verify attribute names and types. `{ duration > 500ms }` works without an attribute schema; it is not a substitute for an HTTP 500 filter.

로컬 회귀 검증 / Local regression checks, from the repository root:

```bash
(cd agent/lambda && python3 -m pytest test_tempo_mcp.py -q)
(cd web && npx vitest run lib/datasource-schema.test.ts lib/datasource-querygen.test.ts app/api/datasources/generate/route.test.ts)
```

## 조치 / Action

이미 구성된 v2 환경에서 운영자가 승인된 릴리스의 Terraform 계획을 검토한다. `ai.tf`의 `aws_lambda_function.agent["tempo-mcp"]`는 커넥터 소스와 공유 HTTP 모듈을 패키징한다. 계획에 예상하지 않은 변경이 있으면 원인을 확인한 후 적용한다.

For an existing v2 deployment, the operator reviews the Terraform plan for the approved release. `aws_lambda_function.agent["tempo-mcp"]` in `ai.tf` packages the connector and shared HTTP module. Resolve unexpected changes before applying.

```bash
terraform -chdir=terraform/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/foundation validate
terraform -chdir=terraform/foundation plan -out=tfplan
terraform -chdir=terraform/foundation show tfplan
```

계획 검토 후 컨트롤러가 저장된 계획을 적용하고 웹을 배포한다. / After reviewing the saved plan, the controller applies it and deploys the web app:

```bash
terraform -chdir=terraform/foundation apply tfplan
make deploy
```

`make deploy`는 웹을 배포하고 `make agentcore`는 에이전트 이미지·프로비저닝을 처리한다. 둘 다 위 Terraform의 커넥터 Lambda 코드 배포를 대체하지 않는다. 기존 연결의 권한·게이트웨이·기능 플래그를 바꿀 필요는 없다.

`make deploy` ships the web app; `make agentcore` handles the agent image and provisioning. Neither replaces Terraform's connector Lambda code deployment. Existing connection permissions, gateways, and feature flags do not need changing for this update.

이후 Integrations에서 **해당 Tempo 인스턴스**의 스키마를 새로고침한다. 관측된 속성은 범위와 함께 표시되며, `names_truncated`는 속성명 수집 제한, `types_truncated`는 타입 표본 제한을 나타낸다. 이전 캐시는 호환되지만 새 메타데이터는 갱신 후에 생긴다.

Then refresh the schema for **that Tempo instance** in Integrations. Discovered attributes retain their scope; `names_truncated` records name-discovery limits and `types_truncated` records type-sampling limits. Older caches remain compatible, but the new metadata requires a refresh.

최근 구간이 계속 비어 있으면 반복 새로고침으로 과거 속성을 복구할 수 없다. 과거 조회는 **Grafana Explore 또는 명시적인 `start`·`end`를 사용하는 Tempo 검색 API**에서 수행한다. AWSops에서 TraceQL을 직접 입력해도 현재 검색 범위는 최근 1시간이다. 최근 조회에는 질문에 맞는 내장 필터를 사용하고, 새 트레이스 유입 후 스키마를 갱신한다. AI 생성은 초안만 반환하고 검색을 자동 실행하지 않는다.

If the recent window remains empty, repeated refreshes cannot recover historical attributes. Use **Grafana Explore or Tempo's search API with explicit `start` and `end`** for historical queries. Manually entering TraceQL in AWSops still searches only the last hour. Use suitable intrinsic filters for recent queries and refresh after new traces arrive. AI generation returns a draft and never executes a search automatically.

## 관련 파일 / Related files

- `agent/lambda/tempo_mcp.py`
- `web/lib/datasource-schema.ts`
- `web/lib/datasource-querygen.ts`
- `web/app/api/datasources/generate/route.ts`
- `terraform/foundation/ai.tf`

관련 결정 / Related decisions: ADR-005 (read-only diagnosis), ADR-007 (governed external data access). ADR bodies are maintained in the private upstream repository.
