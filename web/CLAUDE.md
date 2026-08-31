# Web Module

## Role
Next.js 14 thin-BFF. Serves at the root path (`/`) — no basePath, fetch is `/api/*`. Standalone build deployed as an arm64 container to ECS Fargate. Heavy or long-running work is never run inline — it's enqueued to the worker tier. The generic `POST /api/jobs` accepts only allowlisted (`noop`-family) job types; domain jobs like `report`/`compliance` go through their own ownership-checked dedicated routes instead (ADR-009).

## Key Files
- `middleware.ts` — global 2MB body cap over all of `/api/*` (defense-in-depth above each route's own `readJsonBounded`).
- `instrumentation.ts` — server-boot hook: runs the periodic graph rebuild, default off (`GRAPH_REBUILD_INTERVAL_MINS`).
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
  Tests are colocated with source as `*.test.ts(x)`.
- Deploy from the repo root with `make deploy` — arm64 buildx → ECR push → ECS rolling deploy → smoke `/api/health`. arm64 is required.
- On container deploy, set `HOSTNAME=0.0.0.0` as a task-def runtime env — image-level ENV alone is insufficient (ECS overwrites it with the ENI IP → healthCheck UNHEALTHY).
- App state lives in Aurora (node-pg, `lib/db.ts`) — v1's `data/*.json` / Steampipe pg Pool pattern does not apply here.
- All components use `export default`, built for production standalone.
