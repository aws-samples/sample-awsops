# Tempo query generation

## Symptoms

Explore generates a query with an invalid attribute scope or literal type, or keeps asking for a schema refresh without finding the requested attributes.

Distinguish a generation error, `could not generate a valid query: TraceQL ...` (HTTP 502), from `Tempo HTTP 400` after the user executes a generated draft.

## Candidate causes

- The web app, Tempo connector Lambda, and schema cache have not all been updated.
- Empty results with `names_truncated: true` or `truncated: true` indicate incomplete discovery, not a confirmed empty observation; a proxy's HTML error response can cause this state.
- Schema discovery samples the last **hour**. AWSops's Tempo Explore currently has no time-range control and searches the last hour. Attributes present only in older traces may be absent from this cache.
- `attributes` contains custom attributes only; the v2 response's `intrinsic` scope is omitted. A response containing only intrinsics does not establish custom-attribute availability. The web app validates custom names and types in generated queries.
- Type sampling covers only the discovered `span.http.status_code`, `span.http.response.status_code`, `resource.service.name`, and `span.service.name` attributes, retaining types from at most 32 values each. Sample values are neither returned in the schema nor cached; limited or missing samples cannot establish a definitive type.

Neither name nor type discovery requests `maxStaleValues` early termination, so repeated values do not hide later names or types. Name requests have a **12-second** timeout; each type request has a **4-second** timeout. Count and response-size caps remain, so discovery does not guarantee a complete schema inventory.

## Verification

**The Integrations UI has no schema-refresh control.** An authenticated admin can call `GET /api/integrations/schema` for cached summaries shaped as `{ schemas: [...] }`. Check each row's `integrationId`, `kind`, `fetched_at`, and `summary`. The browser command under Action performs this GET before and after refreshing.

In refreshed summaries, `attributes` is a **count** of custom attributes. `names_truncated`, `types_truncated`, and `truncated` are booleans for name-discovery limits, type-sampling limits, and their combined state. Refresh older caches with absent fields; absence does not mean `false`. This API exposes neither full schema names/types nor raw sample values, and the UI does not provide that inspection.

Observed attributes remain usable for AI generation even when name discovery is limited. If a requested attribute is absent from that inventory, generation returns explicit discovery-limit guidance without retrying the model against the same incomplete evidence. Name discovery currently retains at most **200 custom attributes and 64 kB (64,000 bytes)** from the last hour, so an unobserved name does not prove absence. Refreshing can hit the same limits. Verify that attribute through the Grafana/Tempo API paths below, then use a manually reviewed query.

Inspect actual names/types in traces through **Grafana Explore** on the same datasource, or through an approved Tempo API access path. Use the v2 tag-name API `/api/v2/search/tags` and typed-value API `/api/v2/search/tag/<URL-encoded TraceQL identifier>/values` with matching `start` and `end` bounds (Unix seconds). Specify those bounds on `/api/search` for historical traces too. `{ duration > 500ms }` works without an attribute schema; it is not a substitute for an HTTP 500 filter.

### Model attempts and fallback

Query generation uses GPT-6.1 Terra first and Claude Sonnet 5.5 as fallback.
Each TraceQL model can receive an initial request and one correction request
(**at most four generations total**). A provider failure may end a model's attempt
earlier. The fallback reruns generation and validation against the same bounded
schema; it never executes the query. `DATASOURCE_QUERYGEN_MODEL_ID` selects the
primary model and `DATASOURCE_QUERYGEN_FALLBACK_MODEL_ID` selects the fallback.
Unset fallback uses Sonnet 5.5; an explicit empty value disables fallback.
Overrides outside the task role's curated model grant fail authorization.

Missing, empty, incomplete or name-limited evidence that cannot establish the
requested attributes raises `SchemaEvidenceError` and skips fallback. The model
cannot recover uncollected evidence. A model draft that fails to preserve a status
filter despite complete observed evidence permits fallback, including observed
nonstandard fields whose HTTP meaning still requires user review. Logs record
model IDs and a fixed failure category, never provider error text, user requests,
schema or draft contents.

### Draft validation errors

The web app checks syntax with a pinned Grafana TraceQL parser, then observed
custom names, compatible types, and retention of the requested status value for
complete affirmative HTTP templates (for example, `HTTP 500 response spans`).
An observed nonstandard field is a candidate only when compared for equality to
that value; its HTTP meaning remains user review. Unrelated attributes grant no
blanket exemption, and every OR result branch must retain the value. An AND branch
referencing standard HTTP attributes must retain the value through a standard
predicate; a custom value of 500 cannot override a standard 404 condition.
Negation, ranges, and general language remain model/user review tasks. A syntax,
schema, or filter error gets one correction request per model, except deterministic
schema-evidence failures. If all enabled model attempts fail, the generation API
returns 502 without running a Tempo search. `SCHEMA_REQUIRED` and missing names in
a limited inventory go directly to schema-refresh/manual-query guidance. A draft
that omits the required status filter against complete evidence can use fallback
as described above.

Limited qualifiers such as `today`, `yesterday`, and `last hour/day/week`, and their Korean equivalents, are recognized only to preserve the status predicate. Generation does not change search time bounds; use explicit historical bounds in Grafana or the Tempo API as described below.

- `syntax error`: Check scopes, quoting, and operators. The pinned parser does not cover every server version; verify newer syntax through Grafana Explore on the same Tempo.
- `schema mismatch`: Verify the observation window, names, and types using the API procedure above, refreshing when needed. `.key` can match span/resource observations; event/link/instrumentation retain explicit scopes.
- `HTTP-status filter is missing or broadened`: Preserve the requested status code when regenerating or manually enter reviewed TraceQL. `status = error` or `{}` does not preserve an HTTP 500 condition.

After deployment and refresh, regenerate “HTTP 500 response spans” and verify that the draft uses observed HTTP attributes and types. An `&&` query can legitimately combine service and HTTP conditions on separate spans. A successful generation does not guarantee server acceptance; review the draft and inspect its execution result. If execution still returns 400, inspect the Tempo error and server version.

### Search completion and publication

`tempo_search` requests **20** traces by default and clamps supplied integer limits to
**1–50**. Non-integer or over-16-character limit inputs return HTTP 400. Reaching the requested limit, HTTP 206, output truncation, warnings or an explicit
partial signal remains incomplete. Search returns bounded first matches, not a deterministic
latest/top or exhaustive set. Existing query windows remain fixed bounds.

A recognizable, validated synchronous HTTP 200 `SearchResponse` establishes query completion
when no negative signal is present. At pinned Tempo commit
`f227ccdf89c1ef2b059520b678c1f639aef7cc09`,
[HTTPFinal](https://github.com/grafana/tempo/blob/f227ccdf89c1ef2b059520b678c1f639aef7cc09/modules/frontend/combiner/common.go#L159-L190)
checks errors and finalizes before returning 200. Its
[JSON marshaler](https://github.com/grafana/tempo/blob/f227ccdf89c1ef2b059520b678c1f639aef7cc09/modules/frontend/combiner/common.go#L315-L343)
can omit empty/default fields; the
[empty-response test](https://github.com/grafana/tempo/blob/f227ccdf89c1ef2b059520b678c1f639aef7cc09/modules/frontend/combiner/search_test.go#L268-L281)
reports completed jobs without a total. Therefore an explicit traces list can omit metrics,
and recognized metrics can accompany omitted empty traces. Bare `{}` or unrecognized messages remain unknown; an explicit empty `metrics` object
is a recognizable response shape. This is source evidence, not live acceptance of every Tempo deployment.

Known [SearchMetrics counters](https://github.com/grafana/tempo/blob/f227ccdf89c1ef2b059520b678c1f639aef7cc09/pkg/tempopb/tempo.proto#L170-L184)
retain bounded protobuf integer validation, including decimal-string 64-bit values.
Unknown metric keys are ignored and omitted, not hard validation failures and never
completion evidence. Unknown-only metrics without a traces list remain unverified.
A positive `totalJobs` with fewer completed jobs is partial; contradictory or malformed
known counters remain unknown. Inspected bytes/blocks and counter presence alone do not
prove completion. No additional query is issued to manufacture that proof.

Unknown searches carry `completionReason: search_response_unverified`; adapters retain
the existing `count_not_confirmed` reason vocabulary for this broader unverified-response
state. Explicit query errors remain errors. Only complete `ok`/`empty` query results can
certify empty data; malformed children, missing children and unmarked empty children still
retain prior graph data even alongside useful siblings.

| Producer path | Bound and omission contract |
|---|---|
| Tempo search/trace payload | **1,000,000 serialized UTF-8 bytes** (`MAX_TOTAL_BYTES`), below the Lambda transport limit. Successful search/trace payloads have no raw non-JSON fallback or truncated text preview. HTTP errors retain the existing bounded error excerpt. |
| Oversized `tempo_get_trace` | Structured OTLP projection retains IDs, timings, kinds, status codes and attributes in `_TRACE_ATTRIBUTES`; at most **64 links per span**, keeping link trace/span IDs. Events, status messages, link attributes, unrecognized attributes and optional span names over **1,024 serialized bytes** are omitted. Identity values are never shortened. |
| Prometheus/Mimir query/discovery result | **1,000,000 serialized UTF-8 bytes** (`MAX_RESULT_BYTES`); fixed markers replace omitted/malformed result data. Query arrays retain at most **50 series**, **500 points per series** and **5,000 total samples**. Matrix/vector queries require string metric-label keys/values and sample-value strings of at most **128 characters**; invalid series become null markers. Scalar/string values retain their separate **4,096 UTF-8 byte** bound. Metric-producer `err()` messages over **400 characters** are replaced with a fixed diagnostic. A bounded result is not an absence claim. |

Projection validates each encountered span's identity/timing, requested trace-ID agreement,
and present parent/link/status fields before admitting it. Canonical hex, shortened trace
hex and protobuf base64 IDs remain supported. Unvisited rows beyond the bound are unassessed.
A validated span that cannot fit produces `tracePayloadTruncated: true`, `truncated: true`
and `partial`. A locally omitted unverified projection instead carries the producer-owned
`tracePayloadUnverified: true`, `truncated: true` and `unknown` marker. Both are spanless
and retain previous data; foreign or malformed evidence never authorizes replacement.

The producer strips upstream copies of its collection/projection/omission controls before
forming a response. Explicit upstream `truncated: true` remains negative evidence and
computes a partial response; malformed truncation values compute unknown status. An upstream
`collectionStatus: unknown` cannot soften a malformed child. The adapter accepts the soft
unknown-shape path only with the producer-owned omission marker; ordinary malformed JSON
shapes retain their hard integrity reason. Valid projected spans remain usable partial
evidence under the existing [publication contract](graph-read-contract.md#source-completeness-and-retained-publication).

Local regression checks, from the repository root:

```bash
(cd agent/lambda && python3 -m pytest test_tempo_mcp.py test_prometheus_mcp.py test_mimir_mcp.py test_graph_source_producer_contract.py test_collection_markers.py test_collection_boundaries.py test_tempo_trace_budget.py -q)
(cd web && npx vitest run lib/trace-source.test.ts lib/tempo-schema.test.ts lib/datasource-schema.test.ts lib/datasource-querygen.test.ts app/api/datasources/generate/route.test.ts app/api/integrations/schema/route.test.ts)
# Add the disposable PostgreSQL suite using graph-read-contract.md; never use an application DB.
python3 -m pytest scripts/v2/workers/test_datasource_index.py scripts/v2/workers/test_graph_catalog.py scripts/v2/workers/test_card_catalog.py scripts/v2/workers/diagnosis/test_signal_catalog.py -q
```

## Action

Deploy the sanitized connector Lambda **before** the web adapters that trust its omission
marker, using the existing approved v2 release procedure below. Then deploy the matching
web/worker release and reconcile Gateway descriptions. This change introduces no new IAM
action, endpoint, or activation flag; existing deployment permissions are still required.
Do not deploy the marker-aware adapter alone against a legacy passthrough producer.
Source changes and local tests are not evidence that this rollout has completed.

A confirmed empty custom-attribute cache uses a **60-second TTL**. After expiry, the next generation request can trigger background rediscovery; this is not a timer that polls every 60 seconds. Incomplete empty results are eligible for rediscovery without waiting for that TTL. Tempo background refreshes use a one-minute per-instance cooldown to avoid per-request retries while retaining the short confirmed-empty TTL. The admin POST below performs an immediate refresh without waiting for expiry.

For an existing v2 deployment, the operator reviews the Terraform plan for the approved release. `aws_lambda_function.agent["tempo-mcp"]` in `ai.tf` packages the connector and shared HTTP module. Resolve unexpected changes before applying.

```bash
terraform -chdir=terraform/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/foundation validate
terraform -chdir=terraform/foundation plan -out=tfplan
terraform -chdir=terraform/foundation show tfplan
```

```bash
terraform -chdir=terraform/foundation apply tfplan
make deploy
make agentcore
```

`make deploy` ships the web app. **`make agentcore` is required for this change** because it also updates the affected Tempo, ClickHouse, Prometheus and Mimir tool descriptions (including the search default, limits and collection-status guidance) in `scripts/v2/agentcore/catalog.py`. The provisioner fingerprints tool names, descriptions, and input schemas and reconciles the descriptions on existing gateway targets. Neither command replaces Terraform's connector Lambda code deployment. Before running the provisioner, verify the deployment identity's `bedrock-agentcore:GetGateway` grant as described in [Provisioner reconciliation](../reference/05-agentcore.md#provisioner-reconciliation). This tool-description change adds no feature flag.

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

For 401, check sign-in; for 403, check admin access. HTML instead of JSON, redirects, or network failures require checking the login or proxy path. Investigate POST errors for connection, authentication, or response problems before retrying. A successful refresh advances the GET timestamp even if counts are unchanged. Check the booleans as well: `attributes: 0` and incomplete discovery are different states. If summary fields remain absent after refresh, verify the deployed web and connector versions.

Schema refresh also requests indexing when datasource diagnosis is enabled. Tempo's signal, graph, and card catalogs depend only on successful introspection, so sampled types, limit markers, and changing recent-window attributes do not rebuild identical content. Switching from the old full-schema hash can rebuild once; catalog versions and the corresponding generation flags still invalidate it. The full cache for query generation continues to refresh.

If the recent window remains empty, repeated refreshes cannot recover historical attributes. Use **Grafana Explore or Tempo's search API with explicit `start` and `end`** for historical queries. Manually entering TraceQL in AWSops still searches only the last hour. Use suitable intrinsic filters for recent queries and refresh after new traces arrive. AI generation returns a draft and never executes a search automatically.

## Related files

- `agent/lambda/tempo_mcp.py`
- `agent/lambda/test_tempo_trace_budget.py`
- `agent/fixtures/tempo-trace-budget-contract.json`
- `agent/lambda/test_graph_source_producer_contract.py`
- `agent/fixtures/tempo-topology-contract.json`
- `web/lib/tempo-schema.ts`
- `web/lib/tempo-schema.test.ts`
- `web/lib/datasource-schema.ts`
- `web/lib/datasource-querygen.ts`
- `web/app/api/datasources/generate/route.ts`
- `web/app/api/integrations/schema/route.ts`
- `web/app/api/integrations/schema/route.test.ts`
- `scripts/v2/agentcore/catalog.py`
- `scripts/v2/agentcore/provision.py`
- `scripts/v2/workers/datasource_index.py`
- `scripts/v2/workers/diagnosis/signal_catalog.py`
- `scripts/v2/workers/graph_catalog.py`
- `scripts/v2/workers/card_catalog.py`
- `terraform/foundation/ai.tf`
- `agent/fixtures/tempo-child-contract.json`
- `agent/lambda/test_collection_boundaries.py`
- `agent/lambda/test_collection_markers.py`
- `web/lib/trace-source.ts`
- `web/lib/trace-source.test.ts`
- `web/lib/graph-read-postgres.test.ts`
- `scripts/v2/workers/diagnosis/sources.py`

Related decisions: **ADR-005 freezes AWS-resource mutation and autonomy**. **ADR-007 permits external data reads and governed external writes**; this procedure reads Tempo data only. The controller's approved release deployment does not enable autonomous product remediation. ADR bodies are maintained in the private upstream repository.
