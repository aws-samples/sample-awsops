# Graph read and collection contract

## Symptoms and candidate causes

Missing graph clocks can mean legacy rows without collection state; missing metadata is unknown, not collection failure. A stale publication can have a newer attempt or failed producer. A busy/failed read describes the API, not a collection outcome.

## Request contract

`GET /api/graph` reads nodes, edges and collection state in one repeatable-read
transaction. The shared helper bounds statements, lock waits and transaction
duration, handles checked-out client errors, and discards failed connections. Reads and rebuild
transactions share at most two admissions per pool, reserving one of the three pool slots for auth.
Excess reads receive typed 503/busy and rebuilds report busy/skipped without queueing a checkout. Request
statements/idle time are bounded to 1.5s, total transaction to 2s; publication helpers have a 2s checkout deadline, 2s statements, a 4s PostgreSQL transaction
budget and a 6s caller watchdog, separately from the stricter request budget. Serialization happens after release. Reads cap nodes/raw edges at
4000/8000 plus a sentinel; returned edges reference visible nodes. Infra class reads rank
VPC/subnet/SG container kinds first so resource IDs cannot alphabetically exclude all placement targets. Read limits and
500/503 failures are disclosed separately from collector status.
PostgreSQL 17 is required for the total transaction timeout.

The reader supports flow, infra and trace metadata. Missing state remains unknown;
an account union does not borrow the host's publication clock. Inventory publication is implemented in `web/lib/graph-store.ts`; it requires the separately
authorized schedule/manual invocation. The reader does not activate that schedule. Source integration does not execute migration,
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
disclosed by metadataTruncated in HTTP/SQL projections and the service-network client's
normalization. This flag does not certify which upstream layer omitted or could not confirm a field.

Publication versions must strictly advance per account/class under the class advisory lock. An equal
or older attempt keeps both graph and state unchanged. The trace rebuild reports
`published: 0`, `skipped: 1`, `reasons: ['superseded']` and a fixed skip diagnostic;
zero returned nodes in this outcome do not mean an empty graph was published.

## Bounded inventory-read primitives

`web/lib/graph-inventory-read.ts` provides internal account discovery, count reconciliation,
projected snapshots and an attempt-evidence calculation for flow/infra callers. Callers use the
existing `self` host sentinel and the exported SDK host-only type filter. Every selected slice, including `self`, needs a current participation snapshot; members
also require registration. Its `scope: account` and item count describe that slice, not
the global producer ledger. Aggregate zero alone never proves slice participation. The real producer writes each proved host
snapshot before finalizing success. A failed host data-path probe records `partial` and
preserves the earlier snapshot; readers must not reinterpret that as confirmed empty.
Repair legacy host registration/rendering through the existing onboarding contract rather
than injecting snapshot rows. `test_empty_inventory_sync_uses_real_identity_probe` pins
successful and failed empty VPC/Route53/other SQL paths and snapshot-before-finalize order.
Count proof is reused only when the snapshot observes the identical ledger row version.
The snapshot records its queried types; an attempt cannot narrow that set to hide a failed source.
The helper returns source clocks/completeness, not a freshness or deployment verdict.
Running/partial producer states report `incomplete_collection` before unresolved scope;
confirmed empty additionally requires known-zero unknown attributes and matched counts.
`inventoryAccounts` returns null if the state schema is unavailable; otherwise it returns
at most 100 `accounts` plus `truncated`, detected with a 101st sentinel. Unattempted keys
precede oldest recorded attempts, then self/account-ID tie breaks. Callers must record
actual attempts to advance this bounded selection. The publisher's `recordUnattempted`
preserves the prior real attempt as `lastSourceAttemptedAtMs`; skip timestamps do not
move previously attempted accounts ahead of accounts never read.

Snapshots project consumed fields before SQL byte guards: both classes allow 8,192 rows
plus a sentinel, within the existing 64KiB per-row and 8MiB projected data/identifier
budgets (excluding the result envelope). Flow projection preserves listener/API-route labels and the placement/display fields
consumed from `meta.row`. Target-health arrays retain every Id, Port and State in order while dropping
unconsumed diagnostic fields. A row withheld by its own byte limit does not consume the
later-row budget. `truncatedTypes` identifies incomplete payload types in the same snapshot;
only those source item counts become unknown. Any truncation still withholds publication.
A readable snapshot can exceed the caller's graph-size limit; these bounds do not promise
an unlimited graph. Inspect the affected type's paginated Inventory view when a cap is hit. Request and background transaction
helpers share two admissions per pool, reserving the third ordinary slot for authentication;
Request limits stay 1.5s statements/2s total including checkout. Background checkout
expires after 2s; an acquired transaction separately retains 2s statements and PG's 4s
transaction limit, with a six-second caller watchdog across both phases. The transaction callback
must perform only bounded SQL/local work. An expired checkout never starts abandoned
work; its admission remains held until the late connection is returned.
All helpers can reject with `GraphReadBusy`; callers classify it as skipped/busy, never
successful empty collection. `GraphReadDeadline` identifies checkout or watchdog timeout and returns skipped work with
`rebuild_deadline`; it does not overwrite saved state with a false collection failure. Do not nest these helpers
inside an already-admitted transaction.

These primitives do not write graph/state rows. The bounded publisher in `graph-store.ts`
consumes their results; scheduling records stay in `graph-inventory.ts`. Existing timer/defaults and AWS permissions are unchanged. Callers
must enforce their scope and interpret clocks before publication. Offline PG tests use the
same private socket/admin marker below and a distinct `awsops_inventory_read_test` database
marked `awsops-disposable-inventory-read-test` before any reset. Run from `web/`:
`npx vitest run lib/graph-inventory-read-postgres.test.ts lib/graph-read-postgres.test.ts`.

## Source completeness and retained publication

Inventory aggregate counts use one fulfilled proof per class/pass in a bounded read transaction;
a failed proof read is not cached, so later accounts can retry while the original failure is reported.
Each account snapshot must observe the same ledger row version before reusing that proof:
the producer marks a run active before modifying inventory and finalizes the ledger afterward.
A changed ledger invalidates the proof until the next pass; it never authorizes an empty sweep.
`retainedPrevious` requires an actual publication clock or saved graph rows. With neither,
an unproven first collection is skipped (`retained: 0`, `skipped: 1`), preserving CLI exit 2.
Truncated snapshots disclose partial source evidence with unknown (`null`) item counts, including
types omitted by the row ordering boundary. They never certify those sources as empty.
Discovery uses current eligible accounts, inventory and saved graph keys; daily snapshots are
read only for a selected account's participation proof, not scanned for historical account discovery.

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

## Rebuild capacity

Flow and infra input allow 8192 rows within the same bounded read envelope. The 64KiB-per-row and 8MiB projected-data/identifier limits still apply, as do the
4000-node/8000-edge/8MiB graph limits. A source-proof or capacity failure retains last-good data.
All listed sources feed the builders: a failed/missing source cannot be dropped to authorize replacement,
and elapsed retentions never authorize an unproven sweep. Larger generations need a separately reviewed capacity path.

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
localized Collection limitations list. The standalone panel preserves saved status, scope,
reasons, producer status and supplied source clocks when the lists differ. Before that panel,
`ServiceNetworkTopology.tsx` bounds each source list in `readCollection` to 128 entries and reasons
to 16, maps missing/unrecognized statuses to `unknown`, and omits invalid or unconfirmed
source numbers/clocks and reversed clock pairs. Unconfirmed or truncated fields set `metadataTruncated`;
valid graph rows remain visible, but incomplete metadata cannot authorize identity joins.
Therefore only validated clocks reach this consumer's panel; missing clocks are not fresh evidence.

These UI checks run from `web/` with mocked transport/state and require no PostgreSQL:

```bash
npx vitest run lib/graph-fetch.test.ts components/topology/GraphCollectionStatus.test.tsx components/topology/ServiceNetworkTopology.test.tsx
```

## Layer execution and diagnostics

Run `cd web && npx tsx ../scripts/v2/graph-rebuild.mjs` only from an authorized
VPC/Aurora context with the existing database configuration and `HOST_ACCOUNT_ID`.
The existing web-task principal uses its provisioned Aurora IAM authentication and
curated connector-read permissions; this change creates no principal or grant.
Flow and infra execute sequentially. Trace consumes only host (`self`) infra, so it requires
`selfInfraComplete: true` from that cycle: a successful self publication with no retention,
skip or degradation, and source clocks/counts that pass `inventorySourcesStale`.
A clean confirmed-empty self publication is valid; zero nodes alone are not proof.
Member-only gaps do not invalidate proved self context, but remain in fleet-wide counts,
reasons and CLI exit 1/2. A missing, failed, retained, skipped, degraded or stale self slice
withholds trace. This does not relax the strict 43-type runtime release proof.

| Exact diagnostic | Meaning and next check |
|---|---|
| `[graph-rebuild] trace skipped: infra execution failed` | No usable self proof after an execution failure. Inspect the infra result's sanitized failure code and host collection state. |
| `[graph-rebuild] trace skipped: infra publication incomplete` | Self was unattempted, superseded, retained, skipped, degraded or stale. Inspect `/api/graph?class=infra` source counts/clocks and `selfInfraComplete`; member counters alone are not the dependency gate. |
| `rebuild_deadline` | Checkout or caller watchdog expired. Work is skipped; check DB connection/TLS latency and pool contention before retrying. It is not confirmed empty collection. |

`recordTraceDependencySkip` records a non-publishing trace attempt with
`sourceAttempted: false` and `failureReason: not_attempted`, retaining rows and the old
capture clock. It invents no telemetry count/window. Missing schema, busy admission or
storage failure can prevent that record; a log line alone is not a persistence receipt.

Registry query errors normally do **not** throw from `loadGraphSources`. The loader
returns a synthetic error source and `registryFailed=true`. Both entrypoints log the
fixed `trace_sources: registry_read_failed` diagnostic and use `recordTraceSourceFailure`
instead of telemetry collection. Its `trace:registry` attempt invents no item count or query
window. Missing schema, busy admission or a failed write may prevent recording; the log
is not a persistence receipt. Unexpected loader exceptions also call the non-publishing
`recordTraceSourceFailure` path before the sanitized diagnostic.

`web/lib/graph-execution.ts` validates the current publishers' nonnegative safe-integer
node/edge and published/degraded/retained/skipped counts, fixed reasons, optional failed-account
count and account-limit flag. It projects only those fields and sanitized failure codes.
Node/edge totals alone are not sufficient. Partial account progress remains visible alongside
its unexpected failure. The separately validated `selfInfraComplete` flag describes only
that cycle’s fresh host infra publication; fleet truncation or member failure never becomes
fleet success merely because host trace can refresh. Missing/invalid self proof withholds trace. The CLI awaits pool closure and exits **1** for failure,
including registry or cleanup failure; otherwise **2** for incomplete publication and
**0** for clean publication. These graph outcomes do not replace full runtime release proof.

The timer remains off when `GRAPH_REBUILD_INTERVAL_MINS` is unset, invalid or nonpositive.
Its Terraform input is `graph_rebuild_interval_mins` (default 0; enabled values are whole
minutes 1–1440). When enabled, the timer retains its initial 60-second delay, process-local
overlap guard and outer catch/finally recovery. Existing per-class advisory locks serialize
writes across ECS tasks; they do not eliminate duplicate cross-task reads. This runs outside
HTTP handlers in the web process, not an async worker. A future EventBridge/ECS worker
path needs separate review if this work outgrows that process. Deploy/apply separately;
source changes do not enable the timer. Offline tests from `web/` exercise the actual
loader, publishers and coordinator with mocked SQL and connector IO:

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
npx vitest run lib/trace-source.test.ts lib/graph-read-postgres.test.ts lib/graph-inventory-read-postgres.test.ts \
  lib/graph-store-postgres.test.ts app/api/graph/route.test.ts lib/graph-state.test.ts
docker rm -f "$graph_test_container"
```

The fixtures create and independently mark `awsops_graph_read_test` and
`awsops_graph_task3`; the latter requires the distinct `awsops-disposable-graph-store-test`
marker. Missing or generic-only target markers reject reset.
The publication suite also invokes `lib/fixtures/graph-fatal-child.mjs`, which checks
both server/target database markers before mutation. It covers atomic publication,
retention, pool admission, truncation and fatal-connection recovery. Without the
socket environment variable, the disposable PostgreSQL suites are skipped explicitly;
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
`web/lib/graph-inventory-read.ts`, `web/lib/graph-inventory-read-postgres.test.ts`,
`web/lib/trace-source.ts`, `web/lib/trace-source.test.ts`, `web/lib/graph-store.ts`, `web/lib/graph-read-postgres.test.ts`,
`web/lib/graph-inventory.ts`, `web/lib/graph-store-postgres.test.ts`, `web/lib/fixtures/graph-fatal-child.mjs`,
`web/lib/graph-execution.ts`, `scripts/v2/graph-rebuild.mjs`, `web/instrumentation.ts`, `web/lib/graph-rebuild-runner.test.ts`, `web/lib/instrumentation-runner.test.ts`,
`web/components/topology/GraphCollectionStatus.tsx`, `web/components/topology/GraphCollectionStatus.test.tsx`,
`web/components/topology/ServiceNetworkTopology.tsx`, `web/components/topology/ServiceNetworkTopology.test.tsx`,
`web/lib/graph-fetch.ts`, `web/lib/graph-fetch.test.ts`,
`agent/lambda/clickhouse_mcp.py`, `agent/lambda/tempo_mcp.py`,
`agent/lambda/prometheus_mcp.py`, `agent/lambda/mimir_mcp.py`,
`agent/lambda/test_collection_markers.py`, `agent/lambda/test_clickhouse_completion.py`, `agent/lambda/test_tempo_trace_budget.py`,
`agent/fixtures/tempo-trace-budget-contract.json`, `agent/fixtures/tempo-child-contract.json`,
`agent/lambda/test_collection_boundaries.py`,
`agent/lambda/test_graph_source_producer_contract.py`,
`agent/fixtures/tempo-topology-contract.json`, `agent/fixtures/query-topology-contract.json`.
ADR-005 (read-only product), ADR-004 §7 (SQL-reader projection), ADR-043 (graph reads;
decision bodies are maintained upstream).
