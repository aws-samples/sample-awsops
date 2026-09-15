# Graph read and collection contract

## Symptoms and candidate causes

Missing graph clocks can mean legacy rows without collection state; missing metadata is unknown, not collection failure. A stale publication can have a newer attempt or failed producer. A busy/failed read describes the API, not a collection outcome.

## Request contract

`GET /api/graph` reads nodes, edges and collection state in one repeatable-read
transaction. The shared helper bounds statements, lock waits and transaction
duration, handles checked-out client errors, and discards failed connections. At most two graph
requests per pool are admitted, leaving one of the three pool slots for auth; others receive 503 without queueing a checkout. Request
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

## Verification commands

Use browser developer tools on an already-authorized page to distinguish HTTP503/busy,
500/timeout, and successful partial reads.401/login redirects require sign-in;403 is access denial; other4xx responses require correcting the request. These are distinct from a read outage. The page preserves the safe envelope and offers
refresh; it does not display a bare status code or treat a failed read as empty collection.
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
npx vitest run lib/graph-read-postgres.test.ts app/api/graph/route.test.ts lib/graph-state.test.ts
docker rm -f "$graph_test_container"
```

The fixture creates and independently marks `awsops_graph_read_test`. Without the
socket environment variable, the disposable PostgreSQL suite is skipped explicitly;
the ordinary API and state unit tests still run. These are local contract tests,
not live AWS or deployment acceptance.


## Related files and decisions

`web/app/api/graph/route.ts`, `web/lib/graph-transaction.ts`, `web/lib/graph-state.ts`,
`web/lib/graph-read-postgres.test.ts`, `web/components/topology/GraphCollectionStatus.tsx`.
ADR-005 (read-only product), ADR-004 §7 (SQL-reader projection), ADR-043 (graph reads;
decision bodies are maintained upstream).

## Source completeness and retained publication

`empty_not_confirmed` identifies a legacy empty response without affirmative collection proof; `incomplete_collection` includes missing Tempo children and typed partial producer results. Incomplete adapter reads supply `canSweep: false`, so healthy sibling data cannot authorize deleting saved identities. This retains the complete prior graph and capture clock, recording bounded current source counts/reasons rather than mixing generations. See [source completion proof](source-sync-observability.md) for recovery and producer rollout. The existing PostgreSQL suite includes cross-source retention and consumes the real Tempo producer fixture in `agent/fixtures/tempo-topology-contract.json`; run `npx vitest run lib/trace-source.test.ts lib/graph-read-postgres.test.ts` from `web/` with the disposable PostgreSQL socket described above.
