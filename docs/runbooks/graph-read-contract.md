# Graph read and collection contract

## Symptoms and candidate causes

Missing graph clocks can mean legacy rows without collection state; missing metadata is unknown, not collection failure. A stale publication can have a newer attempt or failed producer. A busy/failed read describes the API, not a collection outcome.

### Placement and live VPC connections

`/topology/infra` defaults to the persisted placement view from
`GET /api/graph?class=infra`. It shows resource placement relationships such as
VPC, subnet and security-group membership. The separate
`/topology/infra?view=vpc` tab renders active peering and TGW attachment
relationships from `GET /api/vpc-connectivity`. Those live results are not
persisted as graph nodes or edges; enabling placement collection does not import
them into the default graph.

In the reported dev investigation on 2026-09-16, an authenticated placement read
returned zero nodes and edges with `collection.attempted_at=null`, while
`graph_rebuild_interval_mins` was 0. A separate scoped connectivity read returned
one TGW with two peer VPCs and no operational read gaps. The disabled timer
explained the lack of a scheduled placement attempt; the empty placement response
was not evidence that TGW or peering connections were absent. These observations
do not establish later timer activation, publication or deployment.

For the same symptom, inspect collection status and the running web task's
`GRAPH_REBUILD_INTERVAL_MINS`. Null attempt metadata alone cannot distinguish a
disabled timer from legacy/missing state. A successful live connectivity read
does not prove that a materialized graph rebuild ran. The placement view's
**Open VPC connection graph** empty-state action opens the VPC tab, which loads
inventory choices only until an explicit connection query. Clicking a placement
VPC node passes its raw ID; the tab queries only after resolving exactly one
current-scoped inventory choice. Qualified links from the VPC section preserve
the account/region/VPC selection key. See the
[VPC connectivity reference](../reference/vpc-connectivity.md) for identity,
lifecycle, display caps and partial-result semantics.

## Request contract

`GET /api/graph` reads nodes, edges and collection state in one repeatable-read
transaction. The shared helper bounds statements, lock waits and transaction
duration, handles checked-out client errors, and discards failed connections. Reads and rebuild
transactions share at most two admissions per pool, reserving one of the three pool slots for auth.
Excess reads receive typed 503/busy and rebuilds report busy/skipped without queueing a checkout. Request
statements/idle time are bounded to 1.5s, total transaction to 2s; publication helpers have a 2s checkout deadline, 2s statements and a 4s PostgreSQL transaction
budget. Their 6s watchdog starts after checkout, leaving response margin; an in-flight write
COMMIT settles by its server/transport response, without forced release or a guessed skipped outcome. Serialization happens after release. Reads cap nodes/raw edges at
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

## Recognized provider-secret fields

Graph full/subgraph responses and generic inventory pages share `inventory-redaction.ts`.
It removes `CustomHeaders`/`OriginCustomHeaders` and `ClientSecret` keys, including case,
underscore/hyphen variants and legacy JSON-string copies. New snapshot/publication projection also
removes these fields. Old database rows need not be rewritten for HTTP masking to work;
the default-off timer is not a prerequisite. Routing fields, public OIDC identifiers and
snapshot/count/clock evidence remain. Omission does not prove a header or secret is absent.

This is targeted structured-field projection, not a free-text or comprehensive secret detector.
Malformed JSON-looking roots/known containers fail closed with fixed errors. The projection
limits each encoded string to 262,144 UTF-16 code units. Each record/metadata projection
allows 32 nested levels and 20,000 visited values. It refuses unsafe metadata instead of returning a truncated credential prefix. SQL-reader named-key views remain mandatory, and raw provider rows remain sensitive.

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
at most 100 `accounts` plus `truncated`, detected with a 101st sentinel. Infra reserves
one slot for `self`; up to 99 members rotate by actual attempt recency. Flow retains its
unattempted/oldest-first ordering, with self/account-ID tie breaks. Callers must record
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
transaction limit. Its six-second watchdog starts after checkout; an in-flight write COMMIT
awaits its response instead of forced cancellation. The transaction callback
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
Flow and infra execute sequentially. Infra always selects `self` within the 100-account
budget. `selfInfraStatus` describes that cycle's host publication: `complete` uses current
infra context; **published** `degraded` or `stale` permits only telemetry-derived partial
trace, with `infraUnavailable: true` and no infra rows/correlation. It never becomes fresh
healthy evidence. Qualified empty/unproven telemetry retains the previous graph.
Failed, retained, skipped or unattempted host infra still withholds trace collection.
A clean confirmed-empty host publication is valid; zero nodes alone are not proof.
Member-only gaps remain in fleet-wide counts/reasons and CLI exit 1/2. None of these
presentation rules relaxes the strict 43-type, zero-unknown runtime release gate.

| Exact diagnostic | Meaning and next check |
|---|---|
| `[graph-rebuild] trace skipped: infra execution failed` | No usable self proof after an execution failure. Inspect the infra result's sanitized failure code and host collection state. |
| `[graph-rebuild] trace skipped: infra publication incomplete` | Self was unattempted, superseded, retained or skipped. Inspect `/api/graph?class=infra` and `selfInfraStatus`; member counters alone are not the dependency gate. |
| `[graph-rebuild] trace qualified: self infra stale` / `degraded` | Published host infra is not trusted for correlation. Useful observed telemetry may refresh only as partial with unavailable infra; repair source freshness/drift before expecting healthy context. |
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
its unexpected failure. The validated `selfInfraStatus`/`selfInfraComplete` fields describe only the host slice;
fleet truncation or member failure never becomes fleet success because trace can refresh.
Qualified stale/degraded context remains incomplete, and other missing/invalid self proof withholds trace. The CLI awaits pool closure and exits **1** for failure,
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

### Optional dev CI timer override

The nonsecret repository variable `CI_GRAPH_REBUILD_INTERVAL_MINS_DEV` supplies
an optional Plan-time override through `scripts/v2/ci_runtime_policy.py` and
`.github/workflows/terraform.yml`. Empty or unset leaves
`graph_rebuild_interval_mins` absent from `ci-runtime.auto.tfvars.json`, preserving
the existing tfvars decision or Terraform default 0. It does not edit
`TF_TFVARS_DEV`.

A supplied value must be an integer string from **0 to 1440**, and requires
`target=dev`, `plan_scope=full` and `CI_READONLY_RUNTIME_DEV=true`. The helper emits
the numeric `graph_rebuild_interval_mins` into `ci-runtime.auto.tfvars.json`;
invalid values or unsupported helper contexts fail closed. The workflow forwards
this variable only for full dev plans. Existing runtime-profile validation,
image prerequisites and manual login/DB/host-registry preflight remain required.
See the [development variable catalog](dev-repo-setup.md#development-variable-catalog--개발-변수-목록).

For the planned dev rollout, after the source change is merged, the operator sets
the variable to `15`, creates a full saved plan through the existing Terraform
workflow, reviews its complete effects privately and applies that exact plan
through the approved flow. Apply consumes the saved plan, not a newly evaluated
variable or edited tfvars secret. Verify the running web task has
`GRAPH_REBUILD_INTERVAL_MINS=15`, then inspect actual collection attempts,
publication outcomes and source clocks after the initial approximately
60-second attempt and subsequent 15-minute ticks. A variable edit, source merge,
successful plan or elapsed timer interval is not publication proof. To disable
again, plan and apply an explicit `0`; unsetting the variable merely removes the
CI override and preserves any underlying tfvars value.

The existing web-process timer coordinates flow, infra and qualified trace
collection and writes application graph records in Aurora. It does not mutate
AWS resources or enable remediation/autonomy under ADR-005. Its overlap guard,
cross-task write locks, trace dependency gates, retention and read/publication
budgets remain unchanged. The 15-minute cadence does not refresh inventory by
itself or relax source freshness limits: `INVENTORY_STALE_AFTER_MINUTES` and the
existing source-quality/clock rules still apply. These steps describe operator
work to perform; timer activation and a live release require separate evidence.

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

## Model-facing topology reader

`inventory_read_mcp.get_topology` reads the host (`self`) graph through the SQL-reader
views. It shares node/edge and persisted collection fields with HTTP, but has its own
bounded Data API response envelope. It does not inherit the HTTP route's single
repeatable-read transaction.

Omitted or null `resource_id` selects the whole class. A supplied string is trimmed
before lookup and echo; empty, non-string or over-4096-character values return 400.
Exact canonical IDs take precedence. The raw-ID fallback matches only the suffix
after the first kind prefix, so use canonical IDs for composite/multi-segment nodes.
The root and its incoming/outgoing one-hop neighbours are selected before the node cap.

| Field | Reader meaning |
|---|---|
| `selection.status` | `all`, `resolved`, `not_found` or `ambiguous`; an unresolved ID is not an empty graph |
| `requested_id`, `resolved_id`, `matched_by` | Normalized request, selected canonical ID and `canonical`/`raw` resolution |
| `candidate_ids`, `candidates_truncated` | At most two canonical alternatives; the boolean discloses additional ambiguity |
| `truncation.node_limit`, `edge_limit` | 500 nodes and 1000 edges per response |
| `truncation.nodes` | More selected nodes existed than were returned |
| `truncation.edges` | The edge limit or node cap omitted applicable valid edges; a capped isolated node alone does not imply an omitted edge |
| `collection.readOutcome` | Reader-only `state_read_failed` or `publication_changed`; never a stored `failureReason` |
| `collection.snapshotConsistent` | Only `false` is emitted, when flow/infra verification fails or observes a publication change; absence is not a consistency guarantee |

Edges require both endpoints in the returned node set. When nodes are capped, a
bounded `EXISTS` check detects applicable edge loss; dangling records are excluded.
For a focused selection, this check considers edges incident to the selected root.
Flow/infra collection metadata is read before and after graph selection. Two failed
state reads remain unverified even when their fallback dictionaries are identical.
The failure envelope keeps `evidenceKind: inventory`, `stale: true` and readable graph
data. Trace retains its existing collection read and does not gain the flow/infra
publication-change detector. Shared staleness fields do not imply identical read envelopes.

Zero returned nodes/edges does not prove absent inventory, complete collection or a
successful empty source: inspect selection, collection, published sources and truncation.
The existing gated RCA consumer passes its failing entity as `resource_id`, traverses
the resolved canonical ID and returns `topology` selection/truncation/collection/warning
metadata. Missing client/response metadata is disclosed as unavailable or unknown coverage.
The RCA flag remains default-off. These changes do not activate it or add permissions.

### Reader PostgreSQL verification

`TestTopologySelectionSQL` in `agent/lambda/test_inventory_read_mcp.py` executes the
actual reader SQL under view-only grants on disposable PostgreSQL 17. It applies the
current collection, queue-provenance and read-index migrations. It also verifies an
RCA entity beyond the whole-graph page using the actual reader and SDK-shaped fixture
response. The fixture creates/alters cluster roles, so use a dedicated disposable
container, not merely a test database on a shared cluster.

In the Python test environment, from the repository root, preload the official
client image and create an isolated server. The fixture uses `--pull never` for its short-lived psql client:

```bash
(
set -e
python3 -m pip install -r scripts/v2/requirements-test.txt
(cd web && npm ci)
docker pull postgres:17-alpine
reader_test_container=$(docker run -d --rm --network none \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=awsops postgres:17-alpine)
trap 'docker rm -f "$reader_test_container" >/dev/null' EXIT
for attempt in $(seq 1 30); do
  docker exec "$reader_test_container" pg_isready -h 127.0.0.1 -U postgres -d awsops && break
  sleep 1
done
docker exec "$reader_test_container" pg_isready -h 127.0.0.1 -U postgres -d awsops
docker exec "$reader_test_container" psql -U postgres -d awsops \
  -c "COMMENT ON DATABASE awsops IS 'awsops-disposable-graph-test'"
export INVENTORY_TEST_POSTGRES_CONTAINER="$reader_test_container"
unset GRAPH_TEST_POSTGRES_SOCKET
(cd agent/lambda && python3 -m pytest test_inventory_read_mcp.py test_inventory_view_contract.py -q)
(cd agent && python3 -m pytest rca/test_tools.py rca/test_orchestrator.py rca/test_controller.py rca/test_graph.py -q)
)
```

Alternatively, `GRAPH_TEST_POSTGRES_SOCKET` may point at that disposable server's
Unix-socket directory. This path requires `pg8000` (validated with 1.31.5); install it
in the test environment with `python3 -m pip install pg8000==1.31.5`. The socket mode
takes precedence when both variables are present. The server must carry the same
sentinel and must be dedicated to these destructive fixtures.

Without either variable the SQL suite explicitly skips; that is not SQL validation.
Run this opt-in suite for reader selection/projection changes even when default unit
CI is green. Default unit tests separately check null/normalized IDs, query binds,
edge-loss disclosure and reader-error envelopes. Cross-runtime staleness cases also
require the existing `web/node_modules/typescript` dependency (`cd web && npm ci`);
run `cd web && npx vitest run lib/graph-reader-privacy.test.ts lib/graph-state.test.ts`
for the writer-clock privacy/read projection assertions.

The fixture's PREPARE/EXECUTE shim verifies SQL/view semantics; it is not a live RDS
Data API call. Bind-shape unit tests separately verify that identifiers stay in SDK
parameters. None of these checks establishes deployed AWS, Runtime or migration state.
Deploy the matching inventory-reader Lambda through the existing Terraform operator
flow and reconcile its catalog description through `make agentcore`; the RCA consumer
change also requires the matching Runtime image. Source integration performs none of
those rollout steps automatically.

## Related files and decisions

`web/lib/inventory-redaction.ts`, `web/lib/inventory-redaction.test.ts`, `web/lib/inventory.ts`,
`web/app/api/inventory/[type]/route.ts`,
`web/app/api/graph/route.ts`, `web/lib/graph-transaction.ts`, `web/lib/graph-state.ts`,
`web/lib/graph-inventory-read.ts`, `web/lib/graph-inventory-read-postgres.test.ts`,
`web/lib/trace-source.ts`, `web/lib/trace-source.test.ts`, `web/lib/graph-store.ts`, `web/lib/graph-read-postgres.test.ts`,
`web/lib/graph-inventory.ts`, `web/lib/graph-store-postgres.test.ts`, `web/lib/fixtures/graph-fatal-child.mjs`,
`web/lib/graph-execution.ts`, `scripts/v2/graph-rebuild.mjs`, `web/instrumentation.ts`, `web/lib/graph-rebuild-runner.test.ts`, `web/lib/instrumentation-runner.test.ts`,
`scripts/v2/ci_runtime_policy.py`, `.github/workflows/terraform.yml`,
`web/lib/vpc-connection-graph.ts`, `web/components/topology/VpcConnectionGraph.tsx`,
`web/components/inventory/VpcConnectivitySection.tsx`, `web/app/topology/infra/page.tsx`,
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
