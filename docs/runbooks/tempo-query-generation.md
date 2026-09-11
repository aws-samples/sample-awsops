# Tempo 쿼리 생성 / Tempo query generation

## 증상 / Symptoms

Explore의 AI 생성 결과가 속성 범위·타입 오류로 실행되지 않거나, 스키마를 새로고침해도 속성을 사용할 수 없다는 안내가 반복된다.

Explore generates a query with an invalid attribute scope or literal type, or keeps asking for a schema refresh without finding the requested attributes.

## 원인 후보 / Candidate causes

- 웹·Tempo 커넥터 Lambda·스키마 캐시 중 일부만 갱신됐다. / The web app, Tempo connector Lambda, and schema cache have not all been updated.
- 빈 결과에 `names_truncated: true` 또는 `truncated: true`가 있으면 정상적인 빈 관측이 아니라 불완전한 수집이다. 프록시의 HTML 오류 응답 등도 이 상태가 될 수 있다. / Empty results with `names_truncated: true` or `truncated: true` indicate incomplete discovery, not a confirmed empty observation; a proxy's HTML error response can cause this state.
- 스키마 수집은 최근 **1시간**의 제한된 관측이다. 현재 AWSops의 Tempo Explore는 시간 범위를 선택할 수 없으며 검색도 최근 1시간을 사용한다. 오래된 트레이스에만 있는 속성이 최근 캐시에 없을 수 있다. / Schema discovery samples the last **hour**. AWSops's Tempo Explore currently has no time-range control and searches the last hour. Attributes present only in older traces may be absent from this cache.
- `attributes`에는 사용자 정의 속성만 들어가며, v2 응답의 `intrinsic` 범위는 제외한다. 내장 필터만 있는 응답은 사용자 정의 속성의 존재를 증명하지 않는다. 웹은 생성된 쿼리의 사용자 정의 속성명·타입을 검증한다. / `attributes` contains custom attributes only; the v2 response's `intrinsic` scope is omitted. A response containing only intrinsics does not establish custom-attribute availability. The web app validates custom names and types in generated queries.
- 타입 표본은 수집된 속성 중 `span.http.status_code`, `span.http.response.status_code`, `resource.service.name`, `span.service.name`만 대상으로 한다. 각 최대 32개 값에서 타입만 보존하며, 값 자체는 스키마에 반환하거나 캐시하지 않는다. 표본 제한 또는 미수집은 타입을 확정할 근거가 아니다. / Type sampling covers only these four discovered attributes, retaining types from at most 32 values each. Sample values are neither returned in the schema nor cached; limited or missing samples cannot establish a definitive type.

속성명·타입 조회 모두 `maxStaleValues` 조기 종료를 사용하지 않는다. 반복된 값 뒤에 나오는 새 속성명·타입을 놓치지 않도록 하며, 속성명 요청은 **12초**, 타입 요청은 각각 **4초**로 제한한다. 개수·응답 크기 제한도 유지되므로 완전한 스키마 목록을 보장하지 않는다.

Neither name nor type discovery requests `maxStaleValues` early termination, so repeated values do not hide later names or types. Name requests have a **12-second** timeout; each type request has a **4-second** timeout. Count and response-size caps remain, so discovery does not guarantee a complete schema inventory.

## 확인 / Verification

**Integrations UI에는 스키마 새로고침 제어가 없다.** 관리자 세션으로 `GET /api/integrations/schema`를 호출하면 `{ schemas: [...] }` 형식의 캐시 요약을 받는다. 각 행의 `integrationId`, `kind`, `fetched_at`, `summary`를 확인한다. 아래 조치의 브라우저 명령은 갱신 전후에 이 GET을 실행한다.

**The Integrations UI has no schema-refresh control.** An authenticated admin can call `GET /api/integrations/schema` for cached summaries shaped as `{ schemas: [...] }`. Check each row's `integrationId`, `kind`, `fetched_at`, and `summary`. The browser command under Action performs this GET before and after refreshing.

갱신된 요약의 `attributes`는 사용자 정의 속성 **개수**다. `names_truncated`, `types_truncated`, `truncated`는 각각 이름 수집 제한, 타입 표본 제한, 통합 제한을 나타내는 불리언이다. 필드가 없는 이전 캐시는 `false`로 해석하지 말고 갱신한다. 이 API는 전체 스키마의 속성명·타입 목록이나 원시 표본 값을 반환하지 않으며 UI가 이를 표시한다고 가정하지 않는다.

In refreshed summaries, `attributes` is a **count** of custom attributes. `names_truncated`, `types_truncated`, and `truncated` are booleans for name-discovery limits, type-sampling limits, and their combined state. Refresh older caches with absent fields; absence does not mean `false`. This API exposes neither full schema names/types nor raw sample values, and the UI does not provide that inspection.

실제 속성명·타입은 같은 데이터소스의 **Grafana Explore**에서 트레이스를 확인하거나, 승인된 Tempo API 접근 경로로 확인한다. v2 태그 이름 API `/api/v2/search/tags`와 타입을 포함하는 값 API `/api/v2/search/tag/<URL 인코딩된 TraceQL 식별자>/values`에 같은 `start`·`end`(Unix 초)를 지정한다. 과거 트레이스는 `/api/search`에도 이 범위를 명시한다. `{ duration > 500ms }`는 속성 스키마 없이 사용할 수 있지만 HTTP 500 필터와 같은 의미는 아니다.

Inspect actual names/types in traces through **Grafana Explore** on the same datasource, or through an approved Tempo API access path. Use the v2 tag-name API `/api/v2/search/tags` and typed-value API `/api/v2/search/tag/<URL-encoded TraceQL identifier>/values` with matching `start` and `end` bounds (Unix seconds). Specify those bounds on `/api/search` for historical traces too. `{ duration > 500ms }` works without an attribute schema; it is not a substitute for an HTTP 500 filter.

로컬 회귀 검증 / Local regression checks, from the repository root:

```bash
(cd agent/lambda && python3 -m pytest test_tempo_mcp.py -q)
(cd web && npx vitest run lib/datasource-schema.test.ts lib/datasource-querygen.test.ts app/api/datasources/generate/route.test.ts)
python3 -m pytest scripts/v2/workers/test_datasource_index.py scripts/v2/workers/test_graph_catalog.py scripts/v2/workers/test_card_catalog.py scripts/v2/workers/diagnosis/test_signal_catalog.py -q
```

## 조치 / Action

확인된 빈 사용자 정의 속성 캐시는 **60초 TTL**을 사용한다. 만료 후 다음 생성 요청에서 백그라운드 재수집 대상이 되며, 60초마다 자동 조회하는 타이머는 아니다. 불완전한 빈 결과는 이 TTL을 기다리지 않고 재수집 대상이 된다. 아래 관리자 POST는 즉시 재수집하므로 TTL 만료를 기다릴 필요가 없다.

A confirmed empty custom-attribute cache uses a **60-second TTL**. After expiry, the next generation request can trigger background rediscovery; this is not a timer that polls every 60 seconds. Incomplete empty results are eligible for rediscovery without waiting for that TTL. The admin POST below performs an immediate refresh without waiting for expiry.

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

배포 후 AWSops에 **관리자로 로그인한 탭**에서 개발자 도구의 Console을 열고 아래 블록 전체를 실행한다. 같은 출처의 세션 쿠키로만 요청하며 토큰·도메인을 붙여 넣지 않는다. 명령은 구성된 Tempo 인스턴스와 기존 캐시 요약을 먼저 출력한다. 프롬프트에 대상 인스턴스의 양의 정수 ID를 입력하면 `POST /api/integrations/schema`에 **`{ id }`**를 보내고, GET으로 다시 읽어 요약·`fetched_at`을 비교한다. 취소하면 POST하지 않는다.

After deployment, open DevTools Console in an AWSops tab **signed in as an admin** and run this entire block. It uses the same-origin session cookie; no pasted token or domain is needed. It first lists configured Tempo instances and existing cache summaries. Enter the target instance's positive integer ID at the prompt to send **`{ id }`** to `POST /api/integrations/schema`, then read GET again to compare summaries and `fetched_at`. Canceling sends no POST.

```javascript
(async () => {
  async function requestJson(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...options.headers },
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`${path}: HTTP ${response.status}; expected JSON. Check sign-in and proxy responses.`);
    }
    if (!response.ok || body?.error) {
      throw new Error(`${path}: HTTP ${response.status}: ${body?.error || response.statusText}`);
    }
    return body;
  }
  async function readSchemas() {
    const body = await requestJson('/api/integrations/schema');
    if (!Array.isArray(body?.schemas)) throw new Error('Invalid cached-schema response');
    return body.schemas;
  }
  function summaryRow(stage, row) {
    return {
      stage, integrationId: row.integrationId, fetched_at: row.fetched_at ?? null,
      tags: row.summary?.tags ?? null,
      attributes: row.summary?.attributes ?? null,
      names_truncated: row.summary?.names_truncated ?? null,
      types_truncated: row.summary?.types_truncated ?? null,
      truncated: row.summary?.truncated ?? null,
    };
  }

  const configured = await requestJson('/api/datasources');
  if (!Array.isArray(configured?.datasources)) throw new Error('Invalid datasource response');
  const tempo = configured.datasources.filter((row) => row.kind === 'tempo');
  console.table(tempo.map(({ id, name, kind }) => ({ id, name, kind })));
  const before = await readSchemas();
  console.table(before.filter((row) => row.kind === 'tempo').map((row) => summaryRow('before', row)));

  const input = prompt('Tempo datasource ID to refresh (positive integer; Cancel to stop):');
  if (input === null) return;
  const value = input.trim();
  const id = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(id)) {
    throw new Error('Enter a valid positive integer datasource ID');
  }
  if (!tempo.some((row) => Number(row.id) === id)) throw new Error('ID is not a listed Tempo datasource');

  const refreshed = await requestJson('/api/integrations/schema', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (refreshed?.ok !== true || refreshed.id !== id || refreshed.kind !== 'tempo') {
    throw new Error('Unexpected schema-refresh response');
  }
  console.log('POST summary:', refreshed.summary);
  const after = (await readSchemas()).find((row) => row.integrationId === id && row.kind === 'tempo');
  if (!after || !Number.isFinite(Date.parse(after.fetched_at))) {
    throw new Error('Refreshed cache row or fetched_at is missing');
  }
  const previous = before.find((row) => row.integrationId === id && row.kind === 'tempo');
  console.table([
    summaryRow('before', previous ?? { integrationId: id }),
    summaryRow('after', after),
  ]);
  if (previous && Date.parse(after.fetched_at) <= Date.parse(previous.fetched_at)) {
    console.warn('fetched_at did not advance; verify the selected deployment and refresh result.');
  }
})().catch((error) => console.error('Tempo schema refresh failed:', error.message));
```

401은 로그인 상태, 403은 관리자 권한을 확인한다. JSON 대신 HTML·리디렉션·네트워크 오류가 나면 로그인 또는 프록시 경로를 확인한다. POST 오류는 연결·인증·응답 내용을 조사하고 해결한 후 다시 실행한다. 성공 시 GET의 시각은 갱신되지만 속성 개수는 같을 수 있다. `attributes: 0`과 불완전 수집 표시는 다른 상태이므로 불리언을 함께 확인한다. 갱신 후에도 요약 필드가 없으면 웹·커넥터 배포 버전을 확인한다.

For 401, check sign-in; for 403, check admin access. HTML instead of JSON, redirects, or network failures require checking the login or proxy path. Investigate POST errors for connection, authentication, or response problems before retrying. A successful refresh advances the GET timestamp even if counts are unchanged. Check the booleans as well: `attributes: 0` and incomplete discovery are different states. If summary fields remain absent after refresh, verify the deployed web and connector versions.

스키마 갱신은 활성화된 진단 워커의 색인 작업도 요청한다. Tempo의 신호·그래프·카드 카탈로그는 스키마 수집 성공 여부만 의존하므로, 표본 타입·제한 표시·최근 구간의 속성 변화만으로 재생성하지 않는다. 기존 전체 스키마 해시에서 전환할 때는 한 번 재생성될 수 있으며 카탈로그 버전·해당 생성 플래그 변경은 계속 무효화한다. 쿼리 생성용 전체 캐시는 계속 갱신된다.

Schema refresh also requests indexing when datasource diagnosis is enabled. Tempo's signal, graph, and card catalogs depend only on successful introspection, so sampled types, limit markers, and changing recent-window attributes do not rebuild identical content. Switching from the old full-schema hash can rebuild once; catalog versions and the corresponding generation flags still invalidate it. The full cache for query generation continues to refresh.

최근 구간이 계속 비어 있으면 반복 새로고침으로 과거 속성을 복구할 수 없다. 과거 조회는 **Grafana Explore 또는 명시적인 `start`·`end`를 사용하는 Tempo 검색 API**에서 수행한다. AWSops에서 TraceQL을 직접 입력해도 현재 검색 범위는 최근 1시간이다. 최근 조회에는 질문에 맞는 내장 필터를 사용하고, 새 트레이스 유입 후 스키마를 갱신한다. AI 생성은 초안만 반환하고 검색을 자동 실행하지 않는다.

If the recent window remains empty, repeated refreshes cannot recover historical attributes. Use **Grafana Explore or Tempo's search API with explicit `start` and `end`** for historical queries. Manually entering TraceQL in AWSops still searches only the last hour. Use suitable intrinsic filters for recent queries and refresh after new traces arrive. AI generation returns a draft and never executes a search automatically.

## 관련 파일 / Related files

- `agent/lambda/tempo_mcp.py`
- `web/lib/datasource-schema.ts`
- `web/lib/datasource-querygen.ts`
- `web/app/api/datasources/generate/route.ts`
- `web/app/api/integrations/schema/route.ts`
- `scripts/v2/workers/datasource_index.py`
- `scripts/v2/workers/diagnosis/signal_catalog.py`
- `scripts/v2/workers/graph_catalog.py`
- `scripts/v2/workers/card_catalog.py`
- `terraform/foundation/ai.tf`

관련 결정: **ADR-005는 AWS 리소스 변경과 자율 실행을 동결**한다. **ADR-007은 거버넌스를 따르는 외부 데이터 읽기·쓰기를 허용**하며, 이 절차의 Tempo 접근은 읽기 전용이다. 컨트롤러의 승인된 릴리스 배포는 제품의 자율 복구 기능을 활성화하지 않는다. ADR 본문은 비공개 upstream 저장소에서 관리한다.

Related decisions: **ADR-005 freezes AWS-resource mutation and autonomy**. **ADR-007 permits external data reads and governed external writes**; this procedure reads Tempo data only. The controller's approved release deployment does not enable autonomous product remediation. ADR bodies are maintained in the private upstream repository.
