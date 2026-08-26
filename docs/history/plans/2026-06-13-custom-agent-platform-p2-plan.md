# Implementation Plan — Custom Agent Platform P2 (Integrations axis: management + resolution layer)

> Spec: `docs/superpowers/specs/2026-06-12-custom-agent-platform-design.md` (Pillar 3 §7, ADR-039).
> Strategy: TDD (test-first) + Tidy First. Each task = one local commit. **Code + migration + tests only — NO Terraform/infra apply, NO live deploy.** Every new surface is admin-gated and flag-safe; registered integrations default `enabled=false` and have ZERO runtime effect until enabled in an Agent Space.
> Builds on P1: the `integrations` table exists (egress columns + free-text `kind`); `agent_spaces.enabled_integration_ids` column exists; `agent.py` already enforces `toolAllowlist`; `intersectToolAllowlist`/resolver are live.
> Test substrate: web unit = `cd web && npx vitest run lib/<f>.test.ts`; migration idempotency = PG17 container via `sudo docker` (skip-if-no-docker).

## Scope boundary (what P2 delivers vs what is DEFERRED to "P2-infra")

**IN (this plan — code/migration/tests):** the Integrations **management + resolution data layer** — additive migration (direction + ingress columns + `kind` CHECK), `integrations` CRUD lib + validation + SSRF host-guard (ADR-011) + admin `/api/integrations`, resolver wiring (enabled READ integrations' `exposed_tools` → effective allowlist; `provided_context` → prompt, size-capped), and the admin Integrations UI section (egress/ingress toggle + registration form).

**DEFERRED to P2-infra (controller-run, needs `terraform apply` / IAM / edge) — explicitly OUT of this plan:** Secrets Manager credential write/read + IAM; live `agent.py` connection to a registered external integration MCP endpoint (SigV4 + endpoint passing); the Lambda@Edge ingress carve-out for public SaaS webhooks; the dedicated first-class Integrations page + Settings-hub nav restructure (Q1); the concrete Grafana/Datadog/Notion connectors + ingress wiring to the ADR-032 trigger. **Until P2-infra lands, a registered integration's tool NAMES may enter the allowlist but `agent.py` only resolves tools it can actually reach (gateways), so there is no live external call — safe.**

## Files in scope

- `terraform/foundation/migrations/01KV0JKFF7Q28CMKQ2JGM2D1NK_integrations_p2.sql` — additive ingress/direction columns + `kind` CHECK + index
- `scripts/v2/migrations-p2.itest.mjs` — PG17-container idempotency harness
- `web/lib/integrations.ts` + `web/lib/integrations.test.ts` — catalog CRUD + `getEnabledIntegrations`
- `web/lib/integration-validation.ts` + `web/lib/integration-validation.test.ts` — pure validators
- `web/lib/ssrf-guard.ts` + `web/lib/ssrf-guard.test.ts` — ADR-011 private-host blocklist (pure)
- `web/app/api/integrations/route.ts` + `web/app/api/integrations/route.test.ts` — admin CRUD API
- `web/lib/agent-space.ts` + `web/lib/agent-space.test.ts` — `enabledIntegrationIds`
- `web/lib/agent-resolver.ts` + `web/lib/agent-resolver.test.ts` — integration tools + context injection
- `web/app/api/chat/route.ts` + `web/app/api/chat/route.test.ts` — the resolveAgent caller (fetch + pass enabled READ integrations)
- `web/app/api/customization/route.ts` — `op:'space'` persists `enabled_integration_ids`
- `web/app/customization/page.tsx` — Integrations admin section (egress/ingress toggle + form) + per-space enablement checkboxes

## Tasks

### Task 1: Migration — integrations `direction` + ingress columns + `kind` CHECK (TDD via PG17)

**Files:**
- Create: `terraform/foundation/migrations/01KV0JKFF7Q28CMKQ2JGM2D1NK_integrations_p2.sql`
- Create: `scripts/v2/migrations-p2.itest.mjs`

- [ ] Failing itest (mirror `scripts/v2/migrations-p1.itest.mjs`): PG17 container; load `schema.sql` then the P1 migration then the P2 migration **twice**; assert new columns exist on `integrations` (`direction`, `auth_mode`, `receive_path`, `inbound_auth_ref`, `source_allowlist`, `trigger_target`); the `kind` CHECK + `direction` CHECK exist; idempotent re-apply (no error, identical row count); existing P1 `integrations` columns intact.
- [ ] Migration SQL (`-- since: 2.3.0`): `ALTER TABLE integrations ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'egress'`, `auth_mode TEXT`, `receive_path TEXT`, `inbound_auth_ref TEXT`, `source_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb`, `trigger_target TEXT`. Add pg_constraint-guarded CHECKs (DO block checking `pg_constraint.conname`, like P1): `integrations_direction_check` = `direction IN ('egress','ingress')`; and a **direction-CONDITIONAL `kind` CHECK** (gemini — a flat union would allow an egress row with an ingress kind): `integrations_kind_check` = `((direction='egress' AND kind IN ('grafana','datadog','splunk','prometheus','newrelic','notion','confluence','jira','servicenow','slack','github','gitlab','custom_mcp')) OR (direction='ingress' AND kind IN ('cloudwatch_sns','alertmanager','grafana_alert','pagerduty','datadog_monitor','generic_webhook')))`. `CREATE INDEX IF NOT EXISTS idx_integrations_dir_enabled ON integrations (direction, enabled) WHERE enabled = true`. **Also `ALTER TABLE agent_spaces ADD COLUMN IF NOT EXISTS allow_private_datasource BOOLEAN NOT NULL DEFAULT false` (the ADR-011 private-egress opt-in the SSRF guard reads) and `ALTER TABLE agent_spaces ADD COLUMN IF NOT EXISTS non_admin_authoring BOOLEAN NOT NULL DEFAULT false` (the §10 default-off authoring flag).** No `schema_migrations` write. **Add the P1-style comment `-- SOURCE OF TRUTH: these kind/direction value sets are shared with web/lib/integration-validation.ts INTEGRATION_KINDS_EGRESS/INGRESS — keep in sync`.** NOTE: the P1 `integrations` table has **no `version` column** (unlike skills/agents) — do not add one and do not reference it in upserts.
- [ ] `node scripts/v2/migrations-p2.itest.mjs` green; `DRY_RUN=1 OFFLINE=1 make migrate` lists it. Commit `feat(agent-platform): P2 migration — integrations direction + ingress columns + kind CHECK`.

### Task 2: `integrations.ts` — catalog CRUD + getEnabledIntegrations (TDD)

**Files:**
- Create: `web/lib/integrations.ts`
- Test: `web/lib/integrations.test.ts`

- [ ] Failing vitest (getPool-mock pattern, mirror `catalog.test.ts`): `upsertIntegration` INSERT…ON CONFLICT(name) DO UPDATE **WHERE integrations.tier='custom'** (builtin-collision guard → `if rows.length===0 throw 'name conflicts with a built-in integration'`, like `upsertAgent`; assert the test exercises both the success and no-row throw paths); the upsert **does NOT reference `version`** (the integrations table has no version column); `listIntegrations` maps rows incl. direction/capability/kind/enabled + ingress fields; `setIntegrationEnabled(id,enabled)` custom-only; **`getEnabledIntegrations(accountId)` is per-space-scoped — it returns integrations that are BOTH globally `enabled=true` AND in that account's `agent_spaces.enabled_integration_ids` (no agent_spaces row ⇒ Phase-1 global = all globally-enabled), mirroring `getEnabledCustomAgents`.** Disabled-by-default on insert.
- [ ] Implement `integrations.ts`: `IntegrationInput`/`IntegrationRow` types covering ALL columns including ingress — `{id,name,kind,direction,description,endpoint,transport,credentialsRef,privateConnectionRef,capability,exposedTools,providedContext,writeActionRefs,authMode,receivePath,inboundAuthRef,sourceAllowlist,triggerTarget,enabled,tier}` (includes the P1 `private_connection_ref` column); the SQL above (no version); audit via `import { writeAudit } from '@/lib/catalog'` (objectType:'integration').
- [ ] `cd web && npx vitest run lib/integrations.test.ts` green. Commit `feat(agent-platform): integrations catalog CRUD + getEnabledIntegrations`.

### Task 3: `integration-validation.ts` — pure validators (TDD)

**Files:**
- Create: `web/lib/integration-validation.ts`
- Test: `web/lib/integration-validation.test.ts`

- [ ] Failing tests: `INTEGRATION_KINDS_EGRESS`/`INTEGRATION_KINDS_INGRESS` + `INTEGRATION_TRANSPORTS=['sigv4','oauth_client_credentials','oauth_3lo','api_key']` (the P1 migration's transport CHECK set — source of truth shared with the migration; comment); `validateIntegration` enforces **kind ∈ the set matching `direction`** (egress kind on an ingress row → reject, matching the migration's conditional CHECK), rejects bad name (kebab), `capability`∉{read,read_write}, egress missing `endpoint`/invalid-URL/`transport`∉set, ingress missing `auth_mode`, and a provided `credentialsRef` that is empty or not `^arn:aws:secretsmanager:` / non-empty-string; `triggerTarget` (ingress) ∈ {incident}; accepts well-formed egress + ingress rows.
- [ ] Implement validators (pure, no I/O).
- [ ] `cd web && npx vitest run lib/integration-validation.test.ts` green. Commit `feat(agent-platform): integration validation (kind/direction/capability/transport)`.

### Task 4: `ssrf-guard.ts` — ADR-011 private-host blocklist (TDD)

**Files:**
- Create: `web/lib/ssrf-guard.ts`
- Test: `web/lib/ssrf-guard.test.ts`

- [ ] Failing tests: **implement the ADR-011 blocklist from the ADR spec — there is NO v1 code to mirror** (verified: `src/lib/datasource-client.ts` does not contain it). `isBlockedHost(hostOrIp)` returns true for literal private/link-local IPs — IPv4 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (incl. `169.254.169.254` metadata), `127.0.0.0/8`; IPv6 `::1`, `fc00::/7`, `fe80::/10`; returns false for public IPs / public hostnames. `assertEgressEndpointAllowed(urlString, {allowPrivate})` throws on a blocked literal-IP host unless `allowPrivate` (the per-account `allowPrivateDatasource` opt-in), and on non-https.
- [ ] Implement (pure CIDR/IP classification; document that DNS-resolution-before-request + `redirect:'manual'` are enforced at connection time in P2-infra — this module is the static endpoint-registration guard).
- [ ] `cd web && npx vitest run lib/ssrf-guard.test.ts` green. Commit `feat(agent-platform): ADR-011 SSRF host blocklist for egress integration registration`.

### Task 5: `/api/integrations` — admin CRUD API (TDD)

**Files:**
- Create: `web/app/api/integrations/route.ts`
- Test: `web/app/api/integrations/route.test.ts`

- [ ] Failing tests (mirror `app/api/chat/route.test.ts` / `customization/route.ts` mock style): `gate()` = verifyUser→401, isAdmin→403, AURORA_ENDPOINT→400 (registration is **admin-only**, ADR-023/§10). POST egress → `validateIntegration` (400) → `assertEgressEndpointAllowed(endpoint, {allowPrivate})` where **`allowPrivate` is read from the `currentAccountId()` `agent_spaces.allow_private_datasource`** (fetch the space; default false) (409/400 on blocked private host unless allowPrivate) → `upsertIntegration` (409 on builtin-collision) → audit → 200{id}. POST ingress → validate → **generate a stable server-side `receive_path`** (e.g. `/api/integrations/ingress/<id-or-opaque-token>`, persisted on the row) → `upsertIntegration` → audit → **200{id, receivePath}** (the route/lib generates+persists+returns it; the migration column is the store). GET → `listIntegrations` (includes `receivePath` for ingress). PUT enable/disable (custom-only) + audit. **credentialsRef contract (single, aligned with Task 3): optional at P2 registration; if present it must be a Secrets-Manager-ARN-like or non-empty string; the actual secret write/read is P2-infra.**
- [ ] Implement the route.
- [ ] `cd web && npx vitest run lib/...`/`app/api/integrations/route.test.ts` green. Commit `feat(agent-platform): admin /api/integrations CRUD (SSRF-guarded registration)`.

### Task 6: resolver wiring + end-to-end caller — enabled integrations' tools + context (TDD)

**Files:**
- Modify: `web/lib/agent-space.ts`
- Test: `web/lib/agent-space.test.ts`
- Modify: `web/lib/agent-resolver.ts`
- Test: `web/lib/agent-resolver.test.ts`
- Modify: `web/app/api/chat/route.ts`  <!-- the resolveAgent caller — signature change breaks the build + integrations never reach runtime without this (codex+gemini MAJOR) -->
- Test: `web/app/api/chat/route.test.ts`
- Modify: `web/app/api/customization/route.ts`  <!-- the 'space' op must persist enabled_integration_ids for per-space enablement (codex MAJOR) -->

- [ ] Failing tests: `AgentSpace` gains `enabledIntegrationIds: number[]` + `allowPrivateDatasource: boolean` + `nonAdminAuthoring: boolean` (defaults []/false/false; `getAgentSpace` selects all three, nullish-safe); `upsertAgentSpace` + the customization `op:'space'` PUT persist `enabledIntegrationIds`. **Resolver injection is scoped to `direction='egress' && capability='read'` integrations ONLY** (codex MAJOR — ingress rows default `capability='read'` but MUST contribute NO tools/context to chat; READ_WRITE also contributes no raw tools). `resolveAgent(routeKey, candidates, space?, egressReadIntegrations?)`: skill tools go through `intersectToolAllowlist(gateway, skillTools, space)` (gateway-catalog narrowing); **integration `exposed_tools` are external and MUST BYPASS the `KNOWN_TOOL_CATALOG[gateway]` filter** (gemini MAJOR — else e.g. a `datadog` tool is dropped because it's not in the `security` gateway's 14-tool catalog) — they are unioned in **subject ONLY to the account `space.toolAllowlist` cap** (when non-empty). Final `toolAllowlist = skillEnforced ∪ integrationToolsCappedBySpaceOnly`. `provided_context` from all egress-READ integrations is **joined with `\n\n`, appended after persona+skills, and the COMBINED block is capped at `MAX_PROVIDED_CONTEXT_CHARS=2000`** (truncate+ellipsis). `SAFEGUARD_LINE` first; built-in path byte-identical. **chat/route.ts**: fetch `getEnabledIntegrations(accountId)` (per-space-scoped), pass the `egress`+`read` subset to `resolveAgent`; route test covers an enabled egress-READ integration surfacing a (non-gateway) tool + capped context, an ingress row contributing nothing, and built-in/no-integration paths unchanged.
- [ ] Implement: extend `AgentSpace`/`getAgentSpace`/`upsertAgentSpace` (+ customization `op:'space'`) for `enabled_integration_ids`/`allow_private_datasource`/`non_admin_authoring`; add a resolver helper that unions egress-READ integration tools **bypassing the gateway catalog** (space-cap only) and joins+caps provided_context; wire the `chat/route.ts` caller. Keep `SAFEGUARD_LINE` first. **Resolver parity:** `scripts/v2/incident/agent_bridge.py` integration-context parity is **deferred to P4 (federation, flag-off)** — noted inline so chat and federation don't silently diverge.
- [ ] `cd web && npx vitest run lib/agent-space.test.ts lib/agent-resolver.test.ts app/api/chat/route.test.ts` green. Commit `feat(agent-platform): resolver + chat-route inject enabled-integration tools + capped context`.

### Task 7: Integrations admin UI section

**Files:**
- Modify: `web/app/customization/page.tsx`

- [ ] Add an **Integrations** section to the admin customization page: an **egress/ingress toggle**; egress form (name/kind/endpoint/transport/capability) + **ingress form (name/kind/auth_mode/source_allowlist/trigger_target — and a read-only display of the generated `receive_path` after create)**; list with direction badge + enable/disable; POSTs `/api/integrations`. (The dedicated first-class Integrations page + Settings-hub IA per Q1 is a P2-infra/UI-polish follow-up; this section delivers the function admin-gated now.)
- [ ] Verify: `cd web && npx tsc --noEmit` (my files clean) + `npx next build` compiles. Commit `feat(agent-platform): customization UI — Integrations registration section`.

## Test gate (per commit; full at end)
- Task 1: `node scripts/v2/migrations-p2.itest.mjs`. Tasks 2–6: `cd web && npx vitest run lib/integrations.test.ts lib/integration-validation.test.ts lib/ssrf-guard.test.ts lib/agent-space.test.ts lib/agent-resolver.test.ts app/api/integrations/route.test.ts`. Task 7: `cd web && npx tsc --noEmit && npx next build`. Regression: full `cd web && npx vitest run` stays green (559+).

## Acceptance criteria
- P2 migration idempotent (twice → identical), adds direction/ingress columns + CHECKs on a runner-only DB (Task 1 itest green).
- `integrations` CRUD: register egress/ingress, builtin-collision guard, disabled-by-default, audited (Task 2).
- SSRF guard blocks literal private/metadata-IP egress endpoints unless `allowPrivate` (Task 4); `/api/integrations` is admin-only and SSRF-guards registration (Task 5).
- Enabling a READ integration in an Agent Space surfaces its allowlisted tool names + capped context to the resolver; READ_WRITE adds no raw tools (Task 6).
- Admin UI can register/enable/disable integrations (Task 7).
- No AWS security-mandate violation; no infra apply; no live external call (deferred to P2-infra); full web suite green; no change outside files-in-scope.

## Out of scope (P2-infra / P3)
Secrets Manager credential write/read + IAM; live `agent.py` external-MCP connection (SigV4 endpoint passing); Lambda@Edge SaaS-ingress carve-out; dedicated first-class Integrations page + Settings-hub nav; concrete Grafana/Datadog/Notion connectors; ingress→ADR-032 live wiring; READ_WRITE write-action executors (P3); AI-assist (P3).
