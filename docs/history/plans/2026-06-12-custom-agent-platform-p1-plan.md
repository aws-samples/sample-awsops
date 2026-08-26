# Implementation Plan — Custom Agent Platform P1 (Foundation + gap-closure)

> Spec: `docs/superpowers/specs/2026-06-12-custom-agent-platform-design.md`
> Strategy: TDD (test-first) + Tidy First (pure logic before I/O). Each task is one local commit.
> Scope: P1 only — frontier-agent data model + the security/runtime gap-closure. **Code-only; no new Terraform infra apply, no live deploy.** All new runtime surface is additive and flag-safe (the `integrations` table is created but unused by the runtime in P1).
> Test substrate: web unit = `cd web && npx vitest run <file>`; agent unit = `python3 -m unittest` (stdlib only); migration idempotency = local PostgreSQL 17 container via `sudo docker` (daemon active, sudo confirmed), skip-with-message if unreachable.

## Files in scope

- `terraform/foundation/migrations/01KTY39P4SV1SQES36KCS8BESY_custom_agent_platform_p1.sql` — idempotent drift-fix + additive columns + `integrations` table + frontier-agent seeds
- `scripts/v2/migrations-p1.itest.mjs` — PG17-container migration idempotency harness
- `agent/agent.py` — enforce `toolAllowlist` (the no-op gap)
- `agent/test_agent.py` — stdlib unittest for the pure tool-filter helper
- `web/lib/agent-space.ts` — fill `KNOWN_TOOL_CATALOG` (enumerable gateways)
- `web/lib/agent-space.test.ts` — intersection tests
- `web/lib/catalog.ts` — new fields (agent_type, gateways, response_language, skill agent_types/reference_keys) + `isCustomAgentEnabled`
- `web/lib/catalog.test.ts` — catalog + authoritative-enabled tests
- `web/lib/skill-validation.ts` — validate the new fields
- `web/lib/skill-validation.test.ts` — validation tests
- `web/app/api/customization/route.ts` — accept/pass the new fields
- `web/app/api/chat/route.ts` — fail-closed authoritative enabled re-check before invoking a custom agent
- `web/app/customization/page.tsx` — skill-create form + agent-type + model picker + new agent fields

No `agent.py` multi-gateway execution, no Integrations runtime, no chat agent-picker UI (all P2+). The 5 catalog tables already exist in `terraform/foundation/data/schema.sql` (baseline integer ledger v2/v8); this migration **re-asserts them idempotently** so ULID-runner-only DBs are not missing them, and adds the P1 columns.

## Tasks

### Task 1: ULID migration — drift fix + additive columns + integrations table + frontier seeds (TDD via PG17 container)

**Files:**
- Create: `terraform/foundation/migrations/01KTY39P4SV1SQES36KCS8BESY_custom_agent_platform_p1.sql`
- Create: `scripts/v2/migrations-p1.itest.mjs`

- [ ] Write the failing itest harness first (mirror `scripts/v2/backfill-v1.itest.mjs`): start `postgres:17` via `sudo docker run -d --rm -p 127.0.0.1:<rand>:5432 -e POSTGRES_PASSWORD=<random-runtime> -e POSTGRES_DB=awsops` (pw generated at runtime, never committed); **teardown trap on EXIT/SIGINT/SIGTERM**; skip with a clear message + exit 0 if docker unreachable. Load `terraform/foundation/data/schema.sql`, then apply the P1 migration SQL **twice**.
- [ ] Assertions: the 5 catalog tables exist (`to_regclass` non-null for skills/agents/agent_skills/agent_spaces/customization_audit); new columns present via `information_schema.columns` (agents.agent_type, agents.gateways, agents.response_language; skills.agent_types, skills.reference_keys; agent_spaces.enabled_integration_ids, agent_spaces.response_language); `integrations` table exists; `devops`/`security`/`finops` rows exist with `tier='builtin'`, `enabled=true`, `agent_type='generic'`, non-empty `gateways`; existing 8 gateway agents have `gateways` backfilled = `[gateway]`; **second apply raises no error and row counts are identical** (idempotent).
- [ ] Write the migration SQL: first line `-- since: 2.2.0`. (a) `CREATE TABLE IF NOT EXISTS` for skills/agents/agent_skills/agent_spaces/customization_audit using the **verbatim baseline DDL** (drift fix — no-op where baseline already created them). (b) `ALTER TABLE … ADD COLUMN IF NOT EXISTS`: `agents.agent_type TEXT NOT NULL DEFAULT 'generic'`, `agents.gateways JSONB NOT NULL DEFAULT '[]'::jsonb`, `agents.response_language TEXT`, `skills.agent_types JSONB NOT NULL DEFAULT '["generic"]'::jsonb`, `skills.reference_keys JSONB NOT NULL DEFAULT '[]'::jsonb`, `agent_spaces.enabled_integration_ids JSONB NOT NULL DEFAULT '[]'::jsonb`, `agent_spaces.response_language TEXT`. **(b2) The `agent_type` CHECK is NOT idempotent via plain `ADD CONSTRAINT`** (Postgres has no `ADD CONSTRAINT IF NOT EXISTS` for CHECK) — wrap it: `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agents_agent_type_check') THEN ALTER TABLE agents ADD CONSTRAINT agents_agent_type_check CHECK (agent_type IN ('generic','on_demand','triage','rca','mitigation','evaluation')); END IF; END $$;`. **The 6 values are the single source of truth shared with `web/lib/skill-validation.ts AGENT_TYPES` (Task 5)** — add a comment in BOTH files pointing at each other so they never drift. (c) `CREATE TABLE IF NOT EXISTS integrations` (id BIGSERIAL PK, name TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', endpoint TEXT, transport TEXT CHECK (transport IN ('sigv4','oauth_client_credentials','oauth_3lo','api_key')), credentials_ref TEXT, private_connection_ref TEXT, capability TEXT NOT NULL DEFAULT 'read' CHECK (capability IN ('read','read_write')), exposed_tools JSONB NOT NULL DEFAULT '[]'::jsonb, provided_context JSONB NOT NULL DEFAULT '{}'::jsonb, write_action_refs JSONB NOT NULL DEFAULT '[]'::jsonb, tier TEXT NOT NULL DEFAULT 'custom' CHECK (tier IN ('builtin','custom')), enabled BOOLEAN NOT NULL DEFAULT false, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()) — created but **unused by the runtime in P1**. (d) `UPDATE agents SET gateways = jsonb_build_array(gateway) WHERE gateways = '[]'::jsonb AND gateway IS NOT NULL`. (e) Seed `devops`/`security`/`finops` via `INSERT … (name,description,persona,routing_keywords,gateway,gateways,agent_type,tier,enabled) … ON CONFLICT (name) DO NOTHING` (devops→primary `ops`, gateways `["ops","monitoring","container","iac","network"]`; security→`security`; finops→`cost`). **Do NOT write `schema_migrations`** and **do NOT use `ON CONFLICT` on the ledger** (the runner stamps the ledger itself, in the same txn).
- [ ] `node scripts/v2/migrations-p1.itest.mjs` green; `DRY_RUN=1 OFFLINE=1 make migrate` lists the new file without error (the Makefile `migrate` target wraps `scripts/v2/migrate.mjs`). Commit `feat(agent-platform): P1 idempotent migration — drift fix + frontier seeds + integrations table`.

### Task 2: agent.py — enforce the resolved `toolAllowlist` (TDD)

**Files:**
- Modify: `agent/agent.py`
- Create: `agent/test_agent.py`

- [ ] Failing `unittest` (stdlib, no external deps — uses fake tool objects exposing a `.tool_name` **attribute**, matching the strands-agents tool interface, NOT a dict key): `_filter_tools(tools, allowlist)` returns only tools whose `tool_name ∈ allowlist`, preserving order; **`allowlist` is `None` OR `[]` ⇒ returns all tools unchanged** (the resolver omits the key when empty, so absent/None/[] all mean "no restriction"; `[]` is explicitly NOT deny-all — a deny-all sentinel is out of P1 scope); names in allowlist but absent from tools are ignored; duplicate-safe.
- [ ] Implement pure `_filter_tools(tools, allowlist)` in `agent.py`. In `handler()`, read `allowlist = payload.get('toolAllowlist')`; immediately after `tools = get_all_tools(mcp_client)`, set `tools = _filter_tools(tools, allowlist)` so the **same filtered `tools` variable** flows into BOTH the `## Available Tools (N)` prompt-section builder AND `Agent(model, tools=tools, …)` (verify the prompt builder iterates the post-filter `tools`, not a re-fetch). Empty/absent allowlist ⇒ current behavior (all tools). The **MCP-failure fallback path is unchanged** (it already runs tool-less); if a non-empty allowlist filters to zero tools, the agent simply runs tool-less — safe, and made explicit.
- [ ] `cd agent && python3 -m unittest test_agent` green (run from `agent/`, so no package `__init__.py` is required). Commit `fix(agent-platform): enforce resolved toolAllowlist in agent.py (close ADR-031 no-op)`.

### Task 3: web — fill `KNOWN_TOOL_CATALOG` for enumerable gateways (TDD)

**Files:**
- Modify: `web/lib/agent-space.ts`
- Test: `web/lib/agent-space.test.ts`
- Test: `web/lib/agent-resolver.test.ts`  <!-- scope correction (impl-time): populating KNOWN_TOOL_CATALOG.security now narrows the resolver's security fixture, which used a non-existent IAM tool name; update the fixture to real tools -->

- [ ] Failing tests: `KNOWN_TOOL_CATALOG.security` is a non-null array containing the IAM MCP tool names; `intersectToolAllowlist('security', [<declared incl. an unknown tool>])` (third arg omitted/`undefined` — the signature is `space?`, already null-safe) drops the unknown now the catalog is known; a still-`null` gateway (e.g. `iac`) is degrade-safe (no drop); a non-empty `space.toolAllowlist` still only REMOVES.
- [ ] **Scope: populate ONLY `security`** — the one slice whose tool set is confidently and statically enumerable from `agent/lambda/aws_iam_mcp.py` (the deployed IAM slice). Hardcode those tool names with a **prominent sync comment** (`// SOURCE OF TRUTH: agent/lambda/aws_iam_mcp.py — keep in sync; adding a tool there without updating here only OVER-restricts (safe)`). **Leave every other gateway `null`** (degrade-safe "inventory unknown here"; tightening only ever ADDS restriction). Full enumeration of the remaining gateways is **deferred to P2** (fragile static analysis; null is safe meanwhile, and Task 2's `agent.py` filter is the real enforcement — this catalog is only a secondary narrowing dimension).
- [ ] `cd web && npx vitest run lib/agent-space.test.ts` green. Commit `feat(agent-platform): fill KNOWN_TOOL_CATALOG for the security (iam) slice`.

### Task 4: web — fail-closed revocation (authoritative enabled re-check) (TDD)

**Files:**
- Modify: `web/lib/catalog.ts`
- Modify: `web/app/api/chat/route.ts`
- Test: `web/lib/catalog.test.ts`
- Test: `web/app/api/chat/route.test.ts`  <!-- scope correction (impl-time): modifying chat/route.ts requires its test to mock the new @/lib/catalog dependency + cover fail-closed fallback -->

- [ ] Failing test (match the existing `catalog.test.ts` getPool-mock pattern): `isCustomAgentEnabled(name)` issues a direct query `SELECT 1 FROM agents WHERE name=$1 AND tier='custom' AND enabled=true` (the partial `idx_agents_enabled` + the small row count make this cheap; no new index needed) and returns `true` only for an enabled custom row; `false` for disabled / missing / builtin / **on query error (fail-closed — a DB hiccup denies, never grants)**.
- [ ] Implement `isCustomAgentEnabled(name): Promise<boolean>` in `catalog.ts` (no cache — authoritative). Wire into `web/app/api/chat/route.ts`: the placement is **after `pickCustomAgent` has selected a custom `routeKey`** (which uses the 30 s-cached enabled-set) **and before `resolveAgent`/`invokeAgent`** — i.e. it does not touch the ADR-038 precedence (pin > custom > classifier) or the inactive-section guard, both of which run earlier/independently. **Why this is fail-closed across ALL Fargate tasks (rebuts the cache-race concern):** the per-request authoritative DB re-check runs on *whichever* task serves the request, for the *picked* agent, regardless of that task's cache contents. A stale cache can only cause `pickCustomAgent` to *propose* a just-disabled agent; the re-check then sees `enabled=false` in Aurora (the single source of truth) and falls through to the built-in gateway. So a disable is effective immediately on every instance; the 30 s cache window now only affects *enable* latency (a non-security change). No cache-bust plumbing is needed (and would be only a local-instance optimization anyway).
- [ ] `cd web && npx vitest run lib/catalog.test.ts` green. Commit `fix(agent-platform): fail-closed custom-agent revocation on chat path`.

### Task 5: web — catalog lib + validation + API for the new fields (TDD)

**Files:**
- Modify: `web/lib/skill-validation.ts`
- Test: `web/lib/skill-validation.test.ts`
- Modify: `web/lib/catalog.ts`
- Test: `web/lib/catalog.test.ts`
- Modify: `web/app/api/customization/route.ts`

- [ ] Failing validation tests: add `AGENT_TYPES = ['generic','on_demand','triage','rca','mitigation','evaluation']` **with a comment that this is the source of truth shared with the migration's `agents_agent_type_check` CHECK (Task 1) — keep both in sync**; `validateAgent` rejects an `agentType` not in the set (default `'generic'` accepted), rejects `gateways` not all in `KNOWN_GATEWAYS` (empty allowed), keeps existing rules; `validateSkill` accepts `agentTypes` (string[] ⊆ AGENT_TYPES, default `['generic']`) and `referenceKeys` (string[]).
- [ ] Failing catalog tests (getPool-mock pattern): `upsertAgent` persists `agent_type`, `gateways`, `response_language`; `upsertSkill` persists `agent_types`, `reference_keys`; **`listAgentsWithSkills` returns the new agent fields AND `listSkills` returns `agent_types`/`reference_keys`** (required so Task 6's UI renders them — assert this explicitly). Extend `AgentInput`/`SkillInput`/`AgentWithSkills`/`SkillRow` types accordingly (keep `gateway` for back-compat = `gateways[0]`).
- [ ] Implement validators + catalog SQL columns + extend `POST /api/customization` to read/forward the new fields. **All new fields are OPTIONAL with documented defaults** (`agent_type`→`'generic'`, `gateways`→`[]`, `agent_types`→`['generic']`, `reference_keys`→`[]`, `response_language`→null) so existing API callers and the existing 8 built-in rows keep working unchanged. Admin gate + audit unchanged.
- [ ] `cd web && npx vitest run lib/skill-validation.test.ts lib/catalog.test.ts` green. Commit `feat(agent-platform): catalog + validation + API for agent-type/gateways/response_language/skill agent_types`.

### Task 6: web — customization UI: skill-create form + agent-type + model picker + new agent fields

**Files:**
- Modify: `web/app/customization/page.tsx`

- [ ] Add a **New Skill** form (name / description / instructions / agent-types multi-select) that POSTs `kind:'skill'` (the endpoint already exists; the UI lacked the form). Extend the **New Agent** form with an `agent_type` select, a `gateways` multi-select (from `KNOWN_GATEWAYS`), a `model` text input, and `response_language`; surface `agent_type`/`gateways` in the agents list and `agent_types` in the skills list. Keep the admin-gated/`denied`/`noAurora` states unchanged.
- [ ] Verify: `cd web && npx tsc --noEmit` clean and `cd web && npx next build` compiles (the page is client JSX with no unit-testable pure logic; logic lives in the tested lib/API). Manual sanity: forms post and re-load the list.
- [ ] Commit `feat(agent-platform): customization UI — skill form + agent-type/model/gateways fields`.

## Test gate (run before each commit; full gate at the end)

- Task 1: `node scripts/v2/migrations-p1.itest.mjs` (PG17 container; skips cleanly w/o docker).
- Task 2: `cd agent && python3 -m unittest test_agent`.
- Tasks 3–5: `cd web && npx vitest run lib/agent-space.test.ts lib/catalog.test.ts lib/skill-validation.test.ts`.
- Task 6: `cd web && npx tsc --noEmit && npx next build`.
- Structure: `bash tests/run-all.sh` stays green (no v1 `src/` change).

## Acceptance criteria

- Migration is idempotent on a runner-only DB (twice → identical), creates the 5 catalog tables + new columns + `integrations`, seeds `devops`/`security`/`finops`, backfills `gateways` (Task 1 itest green).
- `agent.py` exposes ONLY the allowlisted tools to the model when `toolAllowlist` is non-empty, and ALL tools when empty/absent (Task 2 unittest green) — ADR-031's "enforce outside the model" is now real.
- Disabling a custom agent makes it unusable on the chat path immediately (Task 4) — not after 30 s.
- `KNOWN_TOOL_CATALOG` narrows declared tools for at least the deployed slices; unknown gateways remain degrade-safe (Task 3).
- New fields validated, persisted, API-accepted, and authorable in the UI (Tasks 5–6).
- No AWS security-mandate violation (no `0.0.0.0/0`, no `Principal:"*"`, no secrets in env, no `-auto-approve` on shared infra). No change outside the files-in-scope list.

## Out of scope (P2+)

- Integrations **runtime** (registration UX, auth wizards, read context injection, READ_WRITE write actions via the mutating gate, Notion/Confluence) — the `integrations` table is created but unused in P1.
- Multi-gateway agent **execution** in `agent.py` (P1 keeps single primary gateway; multi-domain synthesis via the ADR-032 federation phase, P4).
- Chat **user-facing agent picker** UI, AI-assist skill drafting, zip/asset upload, Learned Skills.
- Ops enablement (create `admins` Cognito group / populate SSM `admin_emails`) — required for live reachability but not a code change.
