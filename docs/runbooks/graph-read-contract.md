# Graph read and collection contract

`GET /api/graph` reads nodes, edges and collection state in one repeatable-read
transaction. The shared helper bounds statements, lock waits and transaction
duration, handles checked-out client errors, and discards failed connections.
PostgreSQL 17 is required for the total transaction timeout.

The reader supports flow, infra and trace metadata. Missing state remains unknown;
an account union does not borrow the host's publication clock. Inventory publication
is supplied by the separate graph-publication change. This reader prerequisite does
not activate its writer, schedule, migration or Lambda deployment.

`01M2FV44NER7VC3CTX2ZMT9FZG_topology_inventory_evidence.sql` widens only the existing
SQL-reader collection projection with bounded scalar metadata. It adds no base-table
or public grants. `INVENTORY_STALE_AFTER_MINUTES` governs inventory source age
independently of the graph publication cadence.

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
