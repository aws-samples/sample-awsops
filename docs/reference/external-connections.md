# External observability connection contract

This is the source-supported contract for the eight datasource HTTP adapters and
the separate administrator-managed MCP path. Registration, credential presence,
query verification, MCP provisioning and live deployment are different states.

## Datasource scope and identity

Datasource Explore is available to authenticated users. Create, edit, delete,
set-default, connection test and credential operations require administrator
authority. Built-in chat resolves one shared default per kind; selecting an AWS
account does not select a different datasource or tenant.

Explore resolves credentials by instance ID and retains the row's endpoint,
authentication method and settings as authoritative. Lambda/worker requests with
an explicit instance ID fail when that instance is not configured; they cannot
borrow another instance's kind-default credential. The no-ID legacy default path
remains available. Secrets Manager's bounded credential cache does not provide
immediate revocation of previously cached credentials.

Per-account custom integration selection and exposed-tool ceilings are enforced
separately. They do not restrict built-in shared datasource defaults. External
telemetry needs independent account/region evidence before identity correlation.

## Capabilities and query windows

| Kind | Query | Time window | Built-in chat | Private-network option |
|---|---|---|---|---|
| Prometheus | PromQL instant/range | Instant or up to 30 days | `external-obs` | `prometheus_vpc_enabled` |
| Mimir | PromQL instant/range | Instant or up to 30 days | `monitoring` | `mimir_vpc_enabled` |
| Loki | LogQL instant/range | Instant or up to seven days | `monitoring` | `loki_vpc_enabled` |
| Tempo | TraceQL search | One-hour default; up to seven days | `monitoring` | `tempo_vpc_enabled` |
| ClickHouse | Read-only SQL | Time predicates belong to SQL | `external-obs` Lambda | `clickhouse_vpc_enabled` |
| Jaeger | Service-anchored trace search | One-hour default; up to seven days | No built-in target | `jaeger_vpc_enabled` |
| Dynatrace | Environment Metrics API v2 metricSelector | One-hour default; up to 30 days | Separate official MCP preset | `dynatrace_vpc_enabled` |
| Datadog | Metrics REST API query | One-hour default; up to 30 days | Separate official MCP preset | Public endpoint |

`POST /api/datasources/query` accepts `range: false`, legacy `range: true`,
or `{window, step}` in seconds. Search tools receive `start`/`end` independently
of whether a distinct range tool exists. Unsupported SQL API ranges are rejected.
Metadata includes the effective query window and shared scope. Range density
remains bounded; selecting a window does not guarantee complete provider coverage.
Natural-language drafting does not itself change the selected request window.

Explore support does not establish service-graph support. Metrics-based graph
sources require suitable Prometheus/Mimir schema; trace sources require suitable
Tempo or ClickHouse data. Loki, Jaeger, Dynatrace and Datadog have no bundled
service-graph relationship adapter in the current catalog.

## Endpoints and credentials

Endpoints are HTTP(S) datasource bases, optionally including a reverse-proxy
mount. They are validated at registration and DNS-checked/pinned at connection.
Redirects and metadata/loopback/link-local targets are blocked. Datasource HTTP
permits private addresses; reachability still requires operator-managed networks.

Mimir's `settings.apiPrefix` defaults to `/prometheus`. An empty value selects
`/api/v1` at the endpoint base. A non-empty prefix uses slash-separated letters,
digits, underscores and hyphens, up to 128 characters. If the endpoint already
ends in that prefix it is not appended twice.

Generic datasource credentials support none/basic/bearer/custom headers and
an optional tenant header. Datadog's datasource API uses its API/application-key
pair; this differs from the official hosted MCP bearer PAT/SAT. Dynatrace's direct
environment adapter uses `Api-Token`; its official hosted MCP uses a bearer
Platform token. Official MCP credentials remain namespaced under `mcp:<kind>`.

Jaeger currently uses its internal `/api/*` JSON compatibility interface, rather
than the stable v3 interface. A provider version change requires query-envelope
and time-unit validation before claiming compatibility.

## Deadlines and completion

Stored `timeoutS` remains an integer from 1 to 60 for compatibility. The effective
maximum is 55 seconds within the existing Lambda wall limit.

- Prometheus/Mimir/ClickHouse apply a provider execution ceiling on query paths.
  Default is 10 seconds; callers can tighten the ceiling. Their query HTTP
  deadline is aligned above the execution bound.
- Loki/Tempo/Jaeger/Dynatrace/Datadog apply an HTTP response timeout, defaulting to
  12 seconds. This does not establish provider-side query cancellation.
- Schema discovery may use shorter bounded operation deadlines.
- Success bodies are limited to 4 MiB before parsing; error bodies to 64 KiB.
  Overflow fails explicitly and is never represented as an empty dataset.

Connection tests use bounded reads against the actual supported query operation,
with the configured auth and tenant. Verified query access does not establish
access to every metric, trace, dataset or optional tool.

Query producers distinguish verified complete `ok`/`empty` from `partial`,
`unknown` and `error`. Malformed/unrecognized responses cannot establish absence;
usable valid siblings may be retained with uncertainty. Jaeger discloses its
requested limit and retained count; reaching the requested limit is potentially
partial even when no additional trace is proven.
Actual HTTP 206 evidence is retained independently of upstream JSON fields and
cannot certify an empty dataset.

## Private connectivity and MCP governance

Every VPC option defaults false. Jaeger/Dynatrace's new options require both
AgentCore and integrations. An operator must separately verify private DNS,
subnet routing, target ingress and required AWS API access. No SG ingress or
Kubernetes grant is created by registering a datasource.

Official MCP gates, exact read-tool allowlists and endpoint acknowledgements
remain governed by ADR-017. Dynatrace's empty official allowlist still authorizes
zero tools. ClickHouse's stdio official MCP remains frozen dark code.

Custom external MCP registration remains allowed. Its runtime pins a request-local
validated address set with original Host/SNI and certificate verification,
rejects changed origins and redirects, disables proxy routing, and bounds
address fallback without replaying requests after read/write failures.
HTTPX/HTTPcore versions implementing the tested SNI contract are pinned in the
runtime dependencies.

`oauth_3lo` is not executable and is rejected at registration/enablement.
The existing `oauth_client_credentials` transport consumes a previously stored
bearer token; it does not implement issuance or refresh. External write governance,
AWS-mutation freeze and per-account exposed-tool ceilings are unchanged.

## Rollout order

Deploy the helper and Lambda producers before the Web reader/UI. Roll out the
AgentCore image containing the pinned transport separately. Review a saved
Terraform plan before applying optional private-network settings. No source merge
alone proves activation or vendor readiness.
