# Web Module

## Role
Next.js 14 thin-BFF. Serves at the root path (`/`) — no basePath, fetch is `/api/*`. Standalone build deployed as an arm64 container to ECS Fargate. Heavy or long-running work is never run inline — it's enqueued to the worker tier. The generic `POST /api/jobs` accepts only allowlisted (`noop`-family) job types; domain jobs like `report`/`compliance` go through their own ownership-checked dedicated routes instead (ADR-009).

## Key Files
- `app/api/deployment/readiness/route.ts` — authenticated POST limited to administrators or `deployment-verifiers`,
  with one in-flight probe and a process-wide 60-second cooldown.
  `lib/deployment-readiness.ts` verifies the actual web-role STS identity, three fresh SSM reads
  and a nonce/account-bound AgentCore response. Disabled, pending, denied and missing
  dependencies return safe structured failure; chat fallback is never readiness proof.
- `lib/agentcore-config.ts` — validates runtime ARNs before caching. Explicitly empty
  `SSM_RUNTIME_ARN_PARAM` disables discovery, including status-page SSM lookup; undefined retains the legacy project fallback.
- `lib/inventory-collection.ts` — aggregate job-ledger metadata (`scope: aggregate`) in inventory
  summaries. Account/region selections affect resource counts, not this whole-sweep ledger.
  Missing runs and unknown attributes remain unknown. `/api/inventory/summary?view=collection`
  authenticates normally and reads only this sanitized ledger, skipping fleet aggregations.
  The private `scripts/v2/runtime-smoke.mjs` prepare mode checks the host registry; verify
  consumes collection metadata and requires Lambda/Fargate completion checks.
- `middleware.ts` — global 2MB body cap over all of `/api/*` (defense-in-depth above each route's own `readJsonBounded`).
- `instrumentation.ts` — server-boot hook: runs the periodic graph rebuild, default off (`GRAPH_REBUILD_INTERVAL_MINS`).
  Its process-local overlap guard remains in force. `lib/graph-execution.ts` isolates layer failures
  for this timer and the manual CLI, reporting available totals and sanitized diagnostics.
  Legacy node/edge-only results are not collection-completeness or confirmed-empty proof.
- `next.config.mjs` — `output: 'standalone'` + `experimental.instrumentationHook` + legacy-path redirects (`/ec2`, `/opencost`).
- `Dockerfile` — node:20-alpine 2-stage standalone build, `CMD ["node","server.js"]`.

## Rules
- Setup/build/test:
  ```
  npm install
  npm run dev                              # next dev
  npm run build                            # next build (standalone, used by the deploy image)
  npm test                                 # vitest run — full suite (2000+ tests, ~10s)
  ```
  Tests are colocated with source as `*.test.ts(x)`. The required cross-tree
  `scripts/v2/ci/web-db-connection.itest.mjs` also gates `lib/db-connection.ts` using the pinned
  web pg dependency, real PostgreSQL and verified-TLS fixtures; run it from the repository root.
- Deploy from the repo root with `make deploy` — arm64 buildx → ECR push → ECS rolling deploy → smoke `/api/health`. arm64 is required.
- On container deploy, set `HOSTNAME=0.0.0.0` as a task-def runtime env — image-level ENV alone is insufficient (ECS overwrites it with the ENI IP → healthCheck UNHEALTHY).
- App state lives in Aurora (node-pg, `lib/db.ts`) — v1's `data/*.json` / Steampipe pg Pool pattern does not apply here.
- All components use `export default`, built for production standalone.

When `INVENTORY_HOST_ONLY=true`, `POST /api/accounts` rejects onboarding with 409 after
authentication/admin checks and before STS or registry writes. Reads, connection re-tests
and removal retain their behavior. Configure multi-account collection before onboarding.
An explicit `INVENTORY_TARGET_ACCOUNT_IDS` deployment allowlist also gates registration;
malformed configuration fails closed. `INVENTORY_TASK_ROLE_ARN` supplies the exact host
collector principal to the create-only CloudFormation guide.

`GET /api/deployment/member-inventory` authenticates and restricts queries to applied target
accounts. One read-only statement checks enabled account/region scope and exactly matches
the resource ID, returning at most two minimal projections to reject ambiguity. It never
returns full inventory records. The release controller checks identity and post-marker
freshness; the required PostgreSQL/TLS suite covers large inventories and unusable scopes.
