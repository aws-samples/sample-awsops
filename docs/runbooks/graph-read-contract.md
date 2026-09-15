# Graph read and collection contract

## Symptoms and candidate causes

Missing graph clocks can mean legacy rows without collection state; missing metadata is unknown, not collection failure. A stale publication can have a newer attempt or failed producer. A busy/failed read describes the API, not a collection outcome.

## Request contract

`GET /api/graph` reads nodes, edges and collection state in one repeatable-read
transaction. The shared helper bounds statements, lock waits and transaction
duration, handles checked-out client errors, and discards failed connections. Reads and rebuild
transactions share at most two admissions per pool, reserving one of the three pool slots for auth.
Excess reads receive typed 503/busy and rebuilds report busy/skipped without queueing a checkout. Request
statements/idle time are bounded to 1.5s, total transaction to 2s; publication helpers use 2s statements and a 4s total transaction budget, separately
from the stricter request budget. Serialization happens after release. Reads cap nodes/raw edges at
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
disclosed by metadataTruncated in both HTTP and SQL projections.

Publication versions must strictly advance under the class advisory lock. An equal
or older attempt keeps both graph and state unchanged. The trace rebuild reports
`published: 0`, `skipped: 1`, `reasons: ['superseded']` and a fixed skip diagnostic;
zero returned nodes in this outcome do not mean an empty graph was published.

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
Recognized producer `unknown` uses soft incomplete evidence, not a failed-query diagnosis. Tempo exposes absent/invalid/zero job counts distinctly as `count_not_confirmed`, using the existing HTTP/SQL reason vocabulary.
Producer warnings and partial results use `incomplete_collection`; an empty returned Tempo child also uses it. Failed or malformed children keep their specific failure reasons. The child-fetch path separately sets `canSweep: false` when a child has no fetched spans.

A failed or malformed source, an unconfirmed empty result, or missing-child evidence retains
the entire previous graph and capture clock even when a sibling has useful data. Current
bounded counts/reasons remain attempt evidence; no mixed-generation upsert is performed.

Valid nonempty reads with only caps, payload truncation, warnings or completion-unknown
metadata use the existing atomic **partial snapshot** publication path. They can create and
refresh a graph at the fixed query bounds. The returned bounded generation replaces the prior
one; it is not complete source coverage or evidence that omitted resources disappeared.
Warnings stay partial: the application does not guess that an annotation is benign. Empty
partial results cannot authorize replacement. Only confirmed complete empty results clear a
graph. Actual query/fetch failures and malformed data remain distinct from unknown metadata.
Valid fetched spans outside the query window are not missing children. Existing query
limits and windows remain fixed bounds, not new operator recovery controls.

The existing PostgreSQL suite verifies first and repeated bounded publication, legitimate
complete empty replacement, and all-empty/mixed missing-child retention. Shared fixtures in
`agent/fixtures/` bind real mocked producer bodies to adapter outcomes. See
[source completion and rollout](source-sync-observability.md#producer-completion-and-rollout)
for producer deployment; source merge alone is not live completion proof.

Oversized valid Tempo children keep a bounded structured OTLP projection and can refresh a partial snapshot with their siblings. The byte budget is unchanged; a failed or structurally unusable child still cannot authorize replacement. The [Tempo response-capability table](tempo-query-generation.md#search-result-evidence) distinguishes count-proof absence, unfinished work and byte limits. The shared budget fixture proves the actual producer output is mappable and publishes through PostgreSQL.

The shared query normalizer carries collection status into Explore. Marked partial, unknown or failed empty responses show an uncertainty/failure note instead of an ordinary empty-result claim; useful rows remain visible with the same disclosure. Scalar format failures remain distinct from empty responses.

## Verification commands

Use browser developer tools on an already-authorized page to distinguish HTTP503/busy,
500/timeout, and successful partial reads.401/login redirects require sign-in;403 is access denial; other4xx responses require correcting the request. These are distinct from a read outage. The page preserves the safe envelope and offers
refresh; it does not display a bare status code or treat a failed read as empty collection.
One page read may issue up to five requests within a ten-second client deadline, retrying
only typed 503/busy responses. Base waits are 250/500/1000/2000ms; a positive numeric
`Retry-After` can lengthen a wait, but cannot extend the overall budget. A wait beyond that
budget ends recovery instead of retrying early. Scope changes cancel waits and reads.
Exhaustion preserves the last observed typed `busy` reason. With no such observation
(or after a later non-busy response), the client deadline reports `timeout`; this may occur
without any HTTP500 or SQLSTATE log. Multiple server shed logs can therefore belong to
one bounded client recovery, not multiple independent user actions.
Timeout SQLSTATEs 57014/25P03/25P04/55P03 remain read failures.
Application logs contain fixed `[graph-read] shed` or SQLSTATE diagnostics. In the local
fixture below, run `npx vitest run lib/graph-read-postgres.test.ts lib/graph-fetch.test.ts`
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
  lib/graph-store-postgres.test.ts app/api/graph/route.test.ts lib/graph-state.test.ts
docker rm -f "$graph_test_container"
```

The fixtures create and independently mark `awsops_graph_read_test` and
`awsops_graph_task3`; an existing unmarked database is rejected before schema reset.
The publication suite also invokes `lib/fixtures/graph-fatal-child.mjs`, which checks
both server/target database markers before mutation. It covers atomic publication,
retention, pool admission, truncation and fatal-connection recovery. Without the
socket environment variable, the disposable PostgreSQL suites are skipped explicitly;
the ordinary API and state unit tests still run. These are local contract tests,
not live AWS or deployment acceptance.


## Operator action

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
`web/lib/trace-source.ts`, `web/lib/trace-source.test.ts`, `web/lib/graph-store.ts`, `web/lib/graph-read-postgres.test.ts`,
`web/lib/graph-inventory.ts`, `web/lib/graph-store-postgres.test.ts`, `web/lib/fixtures/graph-fatal-child.mjs`,
`web/components/topology/GraphCollectionStatus.tsx`,
`web/lib/graph-fetch.ts`, `web/lib/graph-fetch.test.ts`,
`agent/lambda/clickhouse_mcp.py`, `agent/lambda/tempo_mcp.py`,
`agent/lambda/prometheus_mcp.py`, `agent/lambda/mimir_mcp.py`,
`agent/lambda/test_collection_markers.py`, `agent/lambda/test_clickhouse_completion.py`, `agent/lambda/test_tempo_trace_budget.py`,
`agent/fixtures/tempo-trace-budget-contract.json`,
`agent/lambda/test_graph_source_producer_contract.py`,
`agent/fixtures/tempo-topology-contract.json`, `agent/fixtures/query-topology-contract.json`.
ADR-005 (read-only product), ADR-004 §7 (SQL-reader projection), ADR-043 (graph reads;
decision bodies are maintained upstream).
