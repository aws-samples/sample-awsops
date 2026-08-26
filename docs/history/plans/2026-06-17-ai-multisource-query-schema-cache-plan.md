# Plan: AI Multi-Source Query + Datasource Schema Cache

> Spec: `docs/superpowers/specs/2026-06-17-ai-multisource-query-schema-cache-design.md`. Aurora schema
> cache (durable) + on-demand "Refresh schema" (UI→BFF invokes the connector Lambda's `<ds>_schema`
> tool→Aurora) + agent reads cache via payload-injected context + monitoring/data query-language guidance.
> Branch `fix/v2-upgrade-snapshot-id`.

## Grounding (verified)
- Migrations: `terraform/foundation/migrations/<ULID>_*.sql` (ULID prefix); itests `scripts/v2/migrations-*.itest.mjs` (PG17 container).
- Connectors (clickhouse/prometheus/loki/tempo/mimir/opensearch) on `datasource_http.py` have discovery
  tools + `_get`/`load_datasource`/`assert_host_allowed` to reuse for `<ds>_schema`.
- agent.py: role prompts in `SKILL_BASE` (monitoring at ~L229); `build_skill_prompt` appends tools +
  `COMMON_FOOTER` + `account_directive`; handler reads payload fields (~L665). Default chat uses these
  (NOT systemPromptOverride). `web/lib/agent-resolver.ts renderIntegrationContext` is the CUSTOM path.
- Single secret + INTEGRATIONS_SECRET_NAME wired; web task role lacks lambda:InvokeFunction.

## P2 consensus gate — round 1 findings & resolutions (kiro opus; glm NO BLOCKING; kimi no-output)
- **MAJOR (opus, valid) — schema injection must traverse `web/lib/agentcore.ts`.** The chat route → runtime
  channel is `invokeAgent()`; its `InvokeInput` + body assembly has NO `extraContext`, and agent.py reads
  only systemPromptOverride/toolAllowlist/etc. → the injected block is dropped. **Resolution: Task 5 ALSO
  edits `web/lib/agentcore.ts` (add `extraContext?: string` to `InvokeInput` + `if (input.extraContext) body.extraContext = …`),
  and agent.py appends `payload.get("extraContext")` to `system_prompt` AFTER the if/else so it reaches BOTH
  the built-in and override branches (no-op when absent).**
- **MINOR (opus, valid) — accountId server-derived.** **Resolution: Task 3 refresh route derives
  `accountId` from `currentAccountId()` server-side (NEVER the request body), identical to the chat route,
  so the `(account_id, slug)` write/read PK aligns.**

## Tasks (TDD; per-task commit; itest/unittest/vitest/catalog_check/`terraform validate` green)

### Task 1: Aurora datasource_schemas table + web lib
**Files:** Create `terraform/foundation/migrations/<ULID>_datasource_schemas.sql`; Create `web/lib/datasource-schema.ts`; Test `web/lib/datasource-schema.test.ts`; Create `scripts/v2/migrations-datasource-schemas.itest.mjs`
- [ ] Migration (idempotent): `datasource_schemas (account_id text NOT NULL, slug text NOT NULL, kind text,
  schema jsonb NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id, slug))`.
  Generate a real ULID for the filename. PG17 itest: applies idempotently (twice = no error), upsert works.
- [ ] `web/lib/datasource-schema.ts`: `upsertSchema(accountId, slug, kind, schema)` (ON CONFLICT update),
  `getSchema(accountId, slug)`, `listConfiguredSchemas(accountId)` → `[{slug,kind,fetched_at,schema}]`.
  Cap stored schema size (reject > e.g. 256 KB). node-pg via getPool. vitest with mocked pool.
- [ ] `cd web && npx vitest run lib/datasource-schema.test.ts` + `node scripts/v2/migrations-datasource-schemas.itest.mjs` → green.
- [ ] Commit: `feat(integrations): datasource_schemas Aurora table + schema cache lib`.

### Task 2: per-connector `<ds>_schema` introspection tool
**Files:** Modify `agent/lambda/{clickhouse,prometheus,loki,tempo,mimir,opensearch}_mcp.py` + their tests
- [ ] Add a `<ds>_schema` tool to each connector returning a NORMALIZED, BOUNDED schema (reusing its own
  `_get`/discovery): clickhouse→`{tables:[{name,columns:[{name,type}]}]}` (SHOW TABLES + DESCRIBE, cap
  tables≤100 & cols≤200); prometheus/mimir→`{metrics:[…≤500], labels:[…≤200]}`; loki→`{labels:[…≤200]}`;
  tempo→`{tags:[…≤200]}`; opensearch→`{indices:[…≤100]}`. Register in each `_TOOLS`. Errors (not-connected/
  SSRF) handled by the existing handler.
- [ ] Per-connector unittest: `<ds>_schema` builds the right introspection calls + bounds the result.
- [ ] `cd agent/lambda && python3 -m unittest <the touched tests>` → green.
- [ ] Commit: `feat(agent-platform): <ds>_schema introspection tool on each datasource connector`.

### Task 3: BFF schema route (refresh + read) + web task invoke IAM scope
**Files:** Create `web/app/api/integrations/schema/route.ts`; Test `web/app/api/integrations/schema/route.test.ts`; Create `web/lib/connector-invoke.ts` (+ test)
- [ ] `connector-invoke.ts`: `invokeConnectorTool(slug, toolName, args)` → `LambdaClient.invoke`
  `FunctionName=${project}-agent-${slug}-mcp` (project/region from env), parse the `{statusCode,body}` →
  return parsed body or throw on error. Lazy client (mirror lib/admin.ts). Allowlist slug ∈ KNOWN_CONNECTOR_SLUGS.
- [ ] `route.ts`: `POST {slug}` (isAdmin) → `accountId = currentAccountId()` (server-side, NOT request body)
  → `invokeConnectorTool(slug, '${slug}_schema', {})` → `upsertSchema(accountId, …)`;
  returns `{ok, fetched_at, summary}` (counts only — NEVER raw credential/values). `GET` (isAdmin) →
  `listConfiguredSchemas` summaries (slug, kind, fetched_at, counts). Bad slug → 400.
- [ ] Failing tests (mock connector-invoke + datasource-schema): admin-gate 403; POST invokes the right
  tool + upserts + returns summary (no schema values leaked beyond counts); GET returns summaries.
- [ ] `cd web && npx vitest run app/api/integrations/schema/route.test.ts web/lib/connector-invoke.test.ts` → green.
- [ ] Commit: `feat(integrations): admin schema refresh/read route (invoke connector <ds>_schema → Aurora)`.

### Task 4: Connectors UI — "Refresh schema" button + status
**Files:** Modify `web/app/customization/page.tsx`
- [ ] Per datasource connector card (slug with an `endpoint` field): a "Refresh schema" button → `POST
  /api/integrations/schema {slug}`; show `fetched_at` + count summary from `GET /api/integrations/schema`.
  Disabled until the connector is configured (credConfigured includes the slug).
- [ ] `npx tsc --noEmit` adds no new errors in the changed file; build sanity.
- [ ] Commit: `feat(integrations): Connectors UI — Refresh schema button + cached-schema status`.

### Task 5: agent query-language guidance + cached-schema injection (default chat)
**Files:** Modify `agent/agent.py`; Test `agent/test_agent.py` (or a new test); Modify `web/lib/agentcore.ts`
(add `extraContext` to `InvokeInput` + body); Modify the chat route (`web/app/api/chat/route.ts`) that builds the payload
- [ ] agent.py: extend the `monitoring` (and `data`) SKILL_BASE prompt with a **datasource query guide**
  (port v1 datasource-prompts): tool→query-language map (PromQL/LogQL/TraceQL/SQL), WHEN to use each,
  and a multi-source **incident correlation** pattern (metrics→logs→traces→SQL); instruct it to use the
  provided "## Datasource schemas" block. Handler appends an optional payload `extraContext` (bounded)
  to `system_prompt` **AFTER the if/else** (so it reaches BOTH the built-in `build_skill_prompt` path and
  the `systemPromptOverride` path); no-op when absent. Also add `extraContext?: string` to
  `web/lib/agentcore.ts InvokeInput` + `if (input.extraContext) body.extraContext = input.extraContext`.
- [ ] Chat route: when building the default-chat payload for monitoring/data, read
  `listConfiguredSchemas(accountId)` and pass a bounded `extraContext` = "## Datasource schemas (cached)\n…"
  (counts + names, NOT full dumps; cap bytes). No agent→Aurora.
- [ ] Tests: agent unit asserts the monitoring prompt names PromQL/LogQL/TraceQL/SQL + appends extraContext;
  a web test asserts the chat route includes the schema block when datasources are configured.
- [ ] Commit: `feat(agent-platform): datasource query-language guidance + cached-schema injection (default chat)`.

### Task 6: register `<ds>_schema` tools in catalog + web task invoke IAM
**Files:** Modify `scripts/v2/agentcore/catalog.py`; Modify `terraform/foundation/ai.tf`
- [ ] catalog: add the `<ds>_schema` tool (no required props) to each datasource target's tool list. catalog_check OK.
- [ ] ai.tf: add `aws_iam_role_policy.task_connector_invoke` (count=integ_count, on the web task role)
  granting `lambda:InvokeFunction` on `arn:aws:lambda:…:function:${project}-agent-*` ONLY. No Principal:*.
- [ ] fmt + validate (off & on) → green.
- [ ] Commit: `feat(agent-platform): <ds>_schema in catalog + web task lambda:InvokeFunction (scoped, integ-gated)`.

## Manual / live: `terraform -target` apply (migration runs via make migrate/deploy) + `make deploy` +
`make agentcore`; Connectors → Refresh schema per datasource → chat "what's spiking at 3:30 across metrics+logs?".
