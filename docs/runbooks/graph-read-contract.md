# Graph read and collection contract

## Symptoms and candidate causes

Missing graph clocks can mean legacy rows without collection state; missing metadata is unknown, not collection failure. A stale publication can have a newer attempt or failed producer. A busy/failed read describes the API, not a collection outcome.

## Request contract

`GET /api/graph` reads nodes, edges and collection state in one repeatable-read
transaction. The shared helper bounds statements, lock waits and transaction
duration, handles checked-out client errors, and discards failed connections. At most two graph
requests per pool are admitted, leaving one of the three pool slots for auth; others receive 503 without queueing a checkout. Request
statements/idle time are bounded to 1.5s, total transaction to 2s; the new companion publication helper has separate bounds; the legacy writer in this
reader prerequisite does not use that helper yet. Serialization happens after release. Reads cap nodes/raw edges at
4000/8000 plus a sentinel; returned edges reference visible nodes. Infra class reads rank
VPC/subnet/SG container kinds first so resource IDs cannot alphabetically exclude all placement targets. Read limits and
500/503 failures are disclosed separately from collector status.
PostgreSQL 17 is required for the total transaction timeout.

The reader supports flow, infra and trace metadata. Missing state remains unknown;
an account union does not borrow the host's publication clock. Inventory publication
is supplied by the separate graph-publication change. This reader prerequisite does
not activate its writer or schedule. Source integration does not execute migration,
Lambda or Runtime deployment.

`01M2FV44NER7VC3CTX2ZMT9FZG_topology_inventory_evidence.sql` widens only the existing
SQL-reader collection projection with bounded scalar metadata. It adds no base-table
or public grants. `INVENTORY_STALE_AFTER_MINUTES` governs inventory source age
independently of the graph publication cadence. A producer must be succeeded with
ok/empty source evidence and valid clocks; published-source clocks remain visible.
Future timestamps are conservatively stale, not assumed provider clock skew. A zero
requires empty status, zero count, a succeeded producer and a valid last-success clock;
optional non-null capture clocks must also be valid. Nonempty/malformed reason lists
are incomplete evidence. Recognized malformed or unknown-vocabulary metadata is
disclosed by metadataTruncated in both HTTP and SQL projections.

## Bounded inventory-read primitives

`web/lib/graph-inventory-read.ts` provides internal account discovery, count reconciliation,
projected snapshots and an attempt-evidence calculation for flow/infra callers. Callers use the
existing `self` host sentinel and the exported SDK host-only type filter. A member needs current
registered participation evidence; an aggregate zero alone does not establish participation.
Count proof is reused only when the snapshot observes the identical ledger row version.
The helper returns source clocks/completeness, not a freshness or deployment verdict.

Snapshots project consumed fields before SQL byte guards: both classes allow 8,192 rows
plus a sentinel, within the existing 64KiB per-row and 8MiB projected data/identifier
budgets (excluding the result envelope). Flow projection preserves listener/API-route
labels. Target-health arrays retain every Id, Port and State in order while dropping
unconsumed diagnostic fields. A row withheld by its own byte limit does not consume the
later-row budget. `truncatedTypes` identifies incomplete payload types in the same snapshot;
only those source item counts become unknown. Any truncation still withholds publication.
A readable snapshot can exceed the caller's graph-size limit; these bounds do not promise
an unlimited graph. Inspect the affected type's paginated Inventory view when a cap is hit. Request and background transaction
helpers share two admissions per pool, reserving the third ordinary slot for authentication;
request limits stay 1.5s statements/2s total, background limits 2s statements/4s total.

These primitives do not write graph/state rows or wire the legacy materializer to new
publication behavior. Existing timer/defaults and AWS permissions are unchanged. Callers
must enforce their scope and interpret clocks before publication. Offline PG tests use the
same private socket/admin marker below and a distinct `awsops_inventory_read_test` database
marked `awsops-disposable-inventory-read-test` before any reset. Run from `web/`:
`npx vitest run lib/graph-inventory-read-postgres.test.ts lib/graph-read-postgres.test.ts`.

## Source completeness and retained publication

`empty_not_confirmed` is a soft reason for legacy unmarked empty results.
Recognized producer `unknown` uses soft incomplete evidence, not a failed-query diagnosis. Tempo exposes an unverified response (`completionReason: search_response_unverified`) as `count_not_confirmed` in HTTP/SQL source reasons; missing protobuf default counters alone do not invalidate synchronous completion.
Producer warnings and partial results use `incomplete_collection`; an empty returned Tempo child also uses it. Failed or malformed children keep their specific failure reasons. The child-fetch path separately sets `canSweep: false` when a child has no fetched spans.

A failed or malformed source, an unconfirmed empty result, or missing-child evidence retains
the entire previous graph and capture clock even when a sibling has useful data. Current
bounded counts/reasons remain attempt evidence; no mixed-generation upsert is performed.

Valid nonempty reads with only caps, payload truncation, warnings or completion-unknown
metadata use the existing atomic **partial snapshot** publication path. They can create and
refresh a graph at the fixed query bounds. The returned bounded generation replaces the prior
one; it is not complete source coverage or evidence that omitted resources disappeared.
Warnings stay partial: the application does not guess that an annotation is benign. Empty
partial attempts with no useful items cannot authorize replacement. A byte-omitted Tempo child (`tracePayloadTruncated: true`, partial) has no attributable
spans and retains the previous graph even when siblings have useful data. Only confirmed complete
empty results clear a graph. Actual query/fetch failures and malformed data remain distinct from unknown metadata.
Valid fetched spans outside the query window are not missing children. Existing query
limits and windows remain fixed bounds, not new operator recovery controls.

The existing PostgreSQL suite verifies first and repeated bounded publication, legitimate
complete empty replacement, and all-empty/mixed missing-child retention. Shared fixtures in
`agent/fixtures/` bind real mocked producer bodies to adapter outcomes. See
[source completion and rollout](source-sync-observability.md#producer-completion-and-rollout)
for producer deployment; source merge alone is not live completion proof.

Oversized valid Tempo children keep a bounded structured OTLP projection and can refresh a partial snapshot with their siblings. The byte budget is unchanged; a failed or structurally unusable child still cannot authorize replacement. The [Tempo completion contract](tempo-query-generation.md#search-completion-and-publication) distinguishes unverified shape, unfinished work and byte limits. The shared budget fixture proves the actual producer output is mappable and publishes through PostgreSQL.

The shared query normalizer carries collection status into Explore. Marked partial, unknown or failed empty responses show an uncertainty/failure note instead of an ordinary empty-result claim; useful rows remain visible with the same disclosure. Scalar format failures remain distinct from empty responses. Non-boolean truncation metadata is unverified, never silently interpreted as complete output.

## Browser recovery and source evidence

The graph consumer retries only a typed HTTP503 admission failure:
`collection.readStatus="unavailable"` together with `collection.readReason="busy"`.
It keeps the same URL/scope and uses at most five requests. Base waits are
250/750/1500/2000 ms, respecting valid Retry-After seconds/dates as a floor and adding
0–125 ms jitter inside one ten-second abort budget. Stop as busy if a wait plus the
two-second read reserve cannot fit; five completed reads are not guaranteed. This client budget is separate
from the server transaction limit. Caller cancellation stops pending waits and reads.
Authentication/rejection responses and generic errors do not enter this recovery loop.
Exhaustion stays unknown/read-unavailable; it does not certify empty collection or expose
an error-body payload. Collection outcome and read availability remain separate.
The budget also bounds a single stalled request. If no typed busy response was confirmed,
expiry can produce a client-side `timeout` without any response or SQLSTATE. Once busy is confirmed,
unfinished recovery keeps the last observed `busy` cause; it does not diagnose why the
final request stalled. Inspect actual HTTP responses/server logs before attributing latency.

The panel displays matching ordered attempted/saved source metadata once. Attempt and
saved-source counts keep separate labels; differing status, reasons or clocks remain
separate. Display comparison does not merge stored provenance or change publication.
Positive panel-valid loss counts and unavailable infrastructure remain in a visible,
localized Collection limitations list. Saved source entries retain status, scope, reasons,
producer status and all six supplied source clocks even when the lists differ.

These UI checks run from `web/` with mocked transport/state and require no PostgreSQL:

```bash
npx vitest run lib/graph-fetch.test.ts components/topology/GraphCollectionStatus.test.tsx
```

## Layer execution and diagnostics

Run `cd web && npx tsx ../scripts/v2/graph-rebuild.mjs` only from an authorized
VPC/Aurora context with the existing database configuration and `HOST_ACCOUNT_ID`.
The existing web-task principal uses its provisioned Aurora IAM authentication and
curated connector-read permissions; this change creates no principal or grant.
Flow and infra execute sequentially. A flow exception does not block infra, but an
infra execution failure skips trace collection and publication for that cycle and
logs `trace skipped: infra execution failed`. Saved trace rows/clocks are untouched
by that skipped stage; stale infra must not become fresh trace context after failure.

Registry query errors normally do **not** throw from `loadGraphSources`. The loader
returns a synthetic error source and `registryFailed=true`. Both entrypoints log the
fixed `trace_sources: registry_read_failed` diagnostic and pass that source to the
existing trace builder, preserving its non-publishing retention path. A missing
schema or failed state write can still prevent recording; the log is not a receipt
that a trace attempt was persisted. Unexpected loader exceptions remain safely logged.

`web/lib/graph-execution.ts` projects only the current builders' nonnegative safe-integer
node/edge totals. Other result fields are unsupported and are not logged. Exceptions
use normalized stage/SQLSTATE diagnostics, never raw provider errors or SQL text.
The CLI awaits pool closure and exits **1** for a thrown/invalid layer execution,
known registry failure, unexpected loader exception or failed cleanup; otherwise it
exits **0**. There is no exit-2 publication contract. In particular, real legacy
retention, missing state schema and confirmed-empty publication can all return the
same zero totals. A source-level error/partial/unavailable response handled internally
by the builder can still exit 0. Inspect the graph API's collection/source metadata;
these execution totals and exit 0 do not prove complete or empty collection.

The timer remains off when `GRAPH_REBUILD_INTERVAL_MINS` is unset, invalid or nonpositive.
Its Terraform input is `graph_rebuild_interval_mins` (default 0; enabled values are whole
minutes 1–1440). When enabled, the timer retains its initial 60-second delay, process-local
overlap guard and outer catch/finally recovery. Existing per-class advisory locks serialize
writes across ECS tasks; they do not eliminate duplicate cross-task reads. This runs outside
HTTP handlers in the web process, not an async worker. A future EventBridge/ECS worker
path needs separate review if this work outgrows that process. Deploy/apply separately;
source changes do not enable the timer. Offline tests from `web/` exercise the actual
legacy loader/builders with mocked SQL and connector IO:

```bash
npx vitest run lib/graph-rebuild-runner.test.ts lib/graph-sources.test.ts lib/instrumentation-runner.test.ts lib/graph-state.test.ts
```

## Verification commands

Use browser developer tools on an already-authorized page to distinguish HTTP503/busy,
500/timeout, client-side deadline expiry without a response, and successful partial reads.
401/login redirects require sign-in;403 is access denial; other 4xx responses require correcting the request. These are distinct from a read outage. The page preserves the safe envelope and offers
refresh; it does not display a bare status code or treat a failed read as empty collection.
Use the single [browser recovery contract](#browser-recovery-and-source-evidence)
for attempt limits, timing, server hints and cancellation when interpreting these logs.
Exhaustion preserves the last observed typed `busy` reason. With no such observation
(or after a later non-busy response), the client deadline reports `timeout`; this may occur
without any HTTP500 or SQLSTATE log. Multiple server shed logs can therefore belong to
one bounded client recovery, not multiple independent user actions.
Timeout SQLSTATEs 57014/25P03/25P04/55P03 remain read failures.
Application logs contain fixed `[graph-read] shed` or SQLSTATE diagnostics. In the local
fixture below, run `npx vitest run lib/graph-read-postgres.test.ts`
to exercise the 5220-node root-cap case, HTTP metadata projection and stalled reads with
an available auth pool slot. These local timings are not an Aurora p99 benchmark;
real-provider tests are separate operator work, and the conservative failure envelope
remains required when a deployed read cannot finish inside the budget.

The request deadline also covers pool acquisition. A late checkout is returned without
starting SQL, and its admission remains held until settlement to prevent a queued backlog.
Annotation normalization and serialization run after release; SQL deadlines remain defense
in depth. The graph-attempt window has labels distinct from each source query window.

## Local PostgreSQL verification

Use a dedicated disposable PostgreSQL 17 instance, never an application database.
The test checks both the Unix socket and database markers before resetting its
dedicated schema. One local Docker example:

```bash
export GRAPH_TEST_POSTGRES_SOCKET="$(mktemp -d)"
chmod 777 "$GRAPH_TEST_POSTGRES_SOCKET"
graph_test_container="awsops-graph-read-test-$$"
docker run -d --rm --name "$graph_test_container" --network none \
  --tmpfs /var/lib/postgresql/data \
  -v "$GRAPH_TEST_POSTGRES_SOCKET:/var/run/postgresql" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=awsops \
  postgres:17 -c listen_addresses=''
for attempt in $(seq 1 30); do
  docker exec "$graph_test_container" pg_isready -U postgres -d awsops && break
  sleep 1
done
docker exec "$graph_test_container" pg_isready -U postgres -d awsops
docker exec "$graph_test_container" psql -U postgres -d awsops \
  -c "COMMENT ON DATABASE awsops IS 'awsops-disposable-graph-test'"
cd web
npx vitest run lib/trace-source.test.ts lib/graph-read-postgres.test.ts \
  app/api/graph/route.test.ts lib/graph-state.test.ts
docker rm -f "$graph_test_container"
```

The fixture creates and independently marks `awsops_graph_read_test`. Without the
socket environment variable, the disposable PostgreSQL suite is skipped explicitly;
the ordinary API and state unit tests still run. These are local contract tests,
not live AWS or deployment acceptance.


## Operator action

Deploy the matching web image to activate the recovery and collection-panel changes.

Apply `01M2FV44NER7VC3CTX2ZMT9FZG_topology_inventory_evidence.sql` and
`01M2GRW64VTMC9AC8M7T9MZKQ4_graph_attempt_disclosure.sql`,
`01M2GTT5VHHH3TZ4PDJS99HWMJ_graph_read_indexes.sql` and
`01M2HM8BR5ZC0JZWGQ9ZFV1WT2_graph_projection_parity.sql` through the existing authorized
`make migrate` flow from the operator/VPC context. Apply the reviewed Terraform web
`INVENTORY_STALE_AFTER_MINUTES` environment binding and deploy the matching web image
separately. Redeploy the updated `inventory_read_mcp` Lambda code through the existing
operator-owned Terraform release flow so its future-clock and metadata-omission
staleness checks match this source version. A web image or AgentCore Runtime image
deployment does not ship that Lambda code. This document supplies no deployment authorization. Check the canonical
[source rollout list](source-sync-observability.md) and [SQL reader contract](agent-sql-reader.md).
A source merge or automatic web CD result is not proof that these steps completed.

## Related files and decisions

`web/app/api/graph/route.ts`, `web/lib/graph-transaction.ts`, `web/lib/graph-state.ts`,
`web/lib/graph-execution.ts`, `scripts/v2/graph-rebuild.mjs`, `web/instrumentation.ts`,
`web/lib/graph-rebuild-runner.test.ts`, `web/lib/instrumentation-runner.test.ts`,
`web/lib/trace-source.ts`, `web/lib/trace-source.test.ts`, `web/lib/graph-store.ts`, `web/lib/graph-read-postgres.test.ts`, `web/lib/graph-fetch.ts`, `web/lib/graph-fetch.test.ts`,
`web/components/topology/GraphCollectionStatus.tsx`, `web/components/topology/GraphCollectionStatus.test.tsx`,
`agent/lambda/clickhouse_mcp.py`, `agent/lambda/tempo_mcp.py`,
`agent/lambda/prometheus_mcp.py`, `agent/lambda/mimir_mcp.py`,
`agent/lambda/test_collection_markers.py`, `agent/lambda/test_clickhouse_completion.py`, `agent/lambda/test_tempo_trace_budget.py`,
`agent/fixtures/tempo-trace-budget-contract.json`, `agent/fixtures/tempo-child-contract.json`,
`agent/lambda/test_collection_boundaries.py`,
`agent/lambda/test_graph_source_producer_contract.py`,
`agent/fixtures/tempo-topology-contract.json`, `agent/fixtures/query-topology-contract.json`.
ADR-005 (read-only product), ADR-004 §7 (SQL-reader projection), ADR-043 (graph reads;
decision bodies are maintained upstream).
