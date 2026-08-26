# Plan — Datasource · Connector · Skill Integrations Hub (v3, post plan-gate r2)

> ⚠️ **ARCHIVED — historical planning artifact, NOT a live spec.** Salvaged (PR #73) from a pruned worktree
> for reference only. The datasource-connector work this planned has since **shipped** (datasource connectors
> + Explore page, PR #57); the **shipped code — not this doc — is the source of truth.** Design decisions here
> may be superseded or contain known issues flagged in the PR #73 review: backfill `ALTER … SET NOT NULL`
> aborting on unmapped (non-5-kind) `datasource_schemas` rows; credential-lifecycle wording that must follow
> the unified-mirror model (kind key = managed default mirror, never blind-deleted on save); `name = slug`
> backfill mapping; and the Task-13 `.internal`-suffix SSRF block (should block resolved metadata/loopback/
> link-local IPs, not the suffix). **Do not implement from this doc without reconciling against the shipped code.**

**Spec:** `docs/superpowers/specs/2026-06-18-datasource-connector-skill-design.md`
**Base:** current HEAD of `feat/v2-architecture-design`.
**Method:** TDD + Tidy. Each task = failing test → minimal code → refactor → ONE commit (explicit paths).
**Test runners:** web = `cd web && npx vitest run <file>` (vitest IS configured — 600+ existing tests); agent = `cd agent && python -m unittest`; full = `bash tests/run-all.sh`.
**Concurrent-edit note:** `web/lib/integration-credentials.ts`, `web/app/api/chat/route.ts`, `web/app/api/integrations/credential/route.ts` may carry concurrent-session edits — build on top, never revert them.

## VERIFIED schema facts (round-2 gate, confirmed against real DDL)
- `integrations.id` = **BIGSERIAL** (bigint, auto-assigned) — NOT ULID. So `datasource_schemas.integration_id` is **BIGINT**; never `gen_random_uuid()`.
- `integrations` is **global — NO `account_id` column** (only `datasource_schemas` has account_id). Default uniqueness = partial unique index on `(kind) WHERE is_default`.
- `integrations_kind_check` egress set lacks `clickhouse,mimir,loki,tempo` → must DROP+re-add the constraint AND update `web/lib/integration-validation.ts INTEGRATION_KINDS_EGRESS` (declared SOURCE-OF-TRUTH pair).
- `auth_mode` column is reserved for ingress → add dedicated `ds_auth_type TEXT` for datasource auth method.
- Migration filenames MUST be real 26-char ULIDs (`scripts/v2/migrate-core.mjs` ULID_RE). Use `01KVB3MDTRVQW4MMC4GBVS6PPR` (additive) and `01KVB3MDTTSJ3WNTJ2DCPDWJS9` (backfill).

## Gate-driven design (rounds 1+2+3)
- **Credential storage model — UNIFIED (resolves the round-3 kind-key collision):**
  - The **id key** (`<bigint id>`) holds each instance's connConfig secret blob `{endpoint, authType, creds…, org_id?}`.
  - The **kind key** (`<kind>`) is the **managed default mirror** — ALWAYS equals the current default instance's connConfig for that kind. It is the legacy/agent-gateway no-inline fallback. It is NOT orphan garbage and is **never blind-deleted on save**.
  - Reads: `getCredentialById(id, kind)` = id entry, else kind mirror (fallback). The connector Lambda no-inline path loads the kind key = the default.
  - Writes are mirror-aware: **create/update/setDefault** of the instance that IS (or becomes) the default also (re)writes the kind mirror; saving a NON-default instance leaves the kind key untouched. **delete** of the default re-picks a new default and re-mirrors (or clears the kind key if none remain). No big-bang re-key migration; zero data-loss on LIVE.
- **Connector Lambda keeps slug/kind/env fallback** (inline takes precedence) so the AgentCore/`agent.py` gateway path resolves the default instance via the kind mirror.
- **Migration additive→backfill→swap, guarded**; backfill is **filtered to the 5 datasource kinds** (skip out-of-set slugs like jaeger/dynatrace so one bad slug can't abort the txn); backfilled + created rows set **`enabled=true`** (else Task-21 chat filter drops them); `is_default=true` for first-of-kind.
- **kind CHECK re-add reproduces BOTH conditional branches** (egress set + 4 new kinds) OR (ingress set unchanged) — never just the egress branch.
- **Three constant lists kept in lockstep** with a test: SQL `integrations_kind_check` egress set, TS `INTEGRATION_KINDS_EGRESS`, and `DATASOURCE_KINDS`/`KNOWN_CONNECTOR_SLUGS`.
- **Unqueried datasources** (in the secret map but with no `datasource_schemas` cache row) can't be seen by SQL → a Node backfill step ensures their integrations row + id-keyed cred.
- Extract shared components BEFORE redirecting legacy pages. Split bundled tasks. Add create/update + set-default routes. Chat default-per-kind + secrets/freeze tests are first-class.
- Owner decision kept: auth OPTIONAL (None / empty-password Basic allowed).

## Phase 0 — Data model foundation (schema-accurate, no data loss)

### Task 1: Category derivation helper
**Files:**
- Create: `web/lib/integrations-category.ts`
- Test: `web/lib/integrations-category.test.ts`

- [ ] Failing test: `integrationCategory({kind,direction,capability})` → `'datasource'` for egress+read+{prometheus,mimir,loki,tempo,clickhouse}, else `'connector'`; `isDatasourceKind`, `DATASOURCE_KINDS`. Cover ingress + read_write.
- [ ] Implement minimally.
- [ ] Refactor; vitest; commit.

### Task 2: Auth-header model + custom-header safety
**Files:**
- Create: `web/lib/datasource-auth.ts`
- Test: `web/lib/datasource-auth.test.ts`

- [ ] Failing test: `AuthType='none'|'basic'|'bearer'|'custom_header'`; `buildAuthHeaders(authType,creds)`: none→`{}`; basic→`Basic base64(user:pass)` (empty password allowed — owner requirement); bearer→`Bearer <token>`; custom_header→`{[name]:value}`; add `X-Scope-OrgID` when `creds.org_id`. **Reject CRLF/control chars and forbidden names (Host, Content-Length, Authorization)** → throw. authType persists on the row (`ds_auth_type`); creds/org_id live in the secret blob. Mirror `agent/lambda/datasource_http.py:85-92`.
- [ ] Implement minimally.
- [ ] Refactor; vitest; commit.

### Task 3: Migration — additive columns + kind-CHECK expansion
**Files:**
- Create: `terraform/foundation/migrations/01KVB3MDTRVQW4MMC4GBVS6PPR_datasource_instances_additive.sql`
- Modify: `web/lib/integration-validation.ts`
- Test: `web/lib/integration-validation.test.ts`

- [ ] Failing **lockstep test**: assert `INTEGRATION_KINDS_EGRESS` (TS) includes clickhouse, mimir, loki, tempo AND equals the egress set that the migration's CHECK will use AND that `DATASOURCE_KINDS` ⊆ egress set and matches `KNOWN_CONNECTOR_SLUGS`'s datasource members — one canonical list, no drift across the three constants.
- [ ] Write additive, idempotent SQL: add `integration_id BIGINT` (nullable) to `datasource_schemas`; add `is_default BOOLEAN NOT NULL DEFAULT false` and `ds_auth_type TEXT` to `integrations`; `DROP CONSTRAINT IF EXISTS integrations_kind_check` then re-add the FULL two-branch CHECK — `(direction='egress' AND kind IN (…existing 13… , 'clickhouse','mimir','loki','tempo')) OR (direction='ingress' AND kind IN (…ingress set unchanged…))`; add partial unique index `(kind) WHERE is_default` (NO account_id — integrations is global). Update `web/lib/integration-validation.ts INTEGRATION_KINDS_EGRESS` in the SAME commit.
- [ ] Apply twice on a PG17 container to prove idempotency (or document the verify command).
- [ ] vitest (lockstep) + commit.

### Task 4: Migration — backfill rows + map + defaults + PK swap + secret-key backfill
**Files:**
- Create: `terraform/foundation/migrations/01KVB3MDTTSJ3WNTJ2DCPDWJS9_datasource_instances_backfill.sql`
- Create: `scripts/v2/backfill-datasource-instances.mjs`

- [ ] Guarded SQL: for each distinct `slug` in `datasource_schemas` **WHERE slug IN ('prometheus','mimir','loki','tempo','clickhouse')** (filter — out-of-set slugs like jaeger/dynatrace must NOT be inserted or they violate the kind CHECK and abort the whole txn), `INSERT INTO integrations (name, kind, direction, capability, enabled, is_default) VALUES (slug, slug, 'egress', 'read', true, true)` (id auto-assigned by BIGSERIAL — NO gen_random_uuid; **enabled=true** else Task-21 drops them) `ON CONFLICT (name) DO NOTHING`; `UPDATE datasource_schemas ds SET integration_id = (SELECT id FROM integrations WHERE name = ds.slug)` for those slugs (integrations is global; account-scoped cache rows for the same slug map to the one global row — first slug wins; endpoint/auth are user-editable post-migration). Then in a transaction: assert no NULL `integration_id` among mapped rows, `ALTER COLUMN integration_id SET NOT NULL`, drop old PK, add PK `(account_id, integration_id)`, keep `slug` nullable transitional.
- [ ] Node backfill `scripts/v2/backfill-datasource-instances.mjs` (idempotent, re-runnable): read the Secrets Manager slug-keyed map; for each datasource-kind slug present in the secret but NOT yet an `integrations` row (i.e. configured-but-unqueried, no cache row), create the integrations row (enabled=true; is_default if first) and write its id-keyed credential, leaving the kind-mirror intact. Covers the "SQL can't read Secrets Manager" gap.
- [ ] Prove a re-run is a no-op (PG17 container or documented verify).
- [ ] commit.

### Task 5: id-keyed credentials with slug fallback + write-back delete
**Files:**
- Modify: `web/lib/integration-credentials.ts`
- Test: `web/lib/integration-credentials.id.test.ts`

- [ ] Failing test: `setIntegrationCredentialById(id, secret)` writes the id-keyed entry (full connConfig blob incl. `endpoint`) without overwriting other ids; `getCredentialById(id, fallbackKind?)` returns the id entry, else falls back to the kind-mirror entry (does NOT delete on read); `mirrorDefaultCredential(kind, secret)` writes the kind-mirror key (= managed default mirror); `getConfiguredIds()`. Two same-kind instances by distinct ids coexist. **The kind key is NEVER blind-deleted on save** (mirror lifecycle is owned by create/update/setDefault/delete in `datasources.ts`). Preserve the concurrent best-effort try/catch.
- [ ] Implement minimally; keep slug/kind helpers as thin shims for the fallback.
- [ ] Refactor; vitest; commit.

### Task 6: Datasource CRUD data layer (+ getDefaultDatasource)
**Files:**
- Create: `web/lib/datasources.ts`
- Test: `web/lib/datasources.test.ts`

- [ ] Failing test: `createDatasource` (insert integrations row category=datasource, **`enabled=true`**; `is_default=true` when FIRST of its kind, and then writes the kind-mirror credential; duplicate name → error), `listDatasources`, `getDatasource`, `updateDatasource` (if the updated row IS the current default, re-writes the kind-mirror credential too — no stale mirror), `getDefaultDatasource(kind)` (returns the is_default row, or null). Two same-kind instances coexist. Composes `web/lib/integrations.ts` + `integration-credentials.ts` mirror helper.
- [ ] Implement minimally.
- [ ] Refactor; vitest; commit.

### Task 7: setDefaultDatasource (transactional + kind-key credential mirror)
**Files:**
- Modify: `web/lib/datasources.ts`
- Test: `web/lib/datasources.default.test.ts`

- [ ] Failing test: `setDefaultDatasource(id)` sets this row default + unsets other same-kind defaults in one transaction; AND mirrors the new default's credential under the plain `kind` key (so the agent gateway/no-inline path resolves to it). Idempotent.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 8: deleteDatasource (ordered cascade, no orphan, re-default)
**Files:**
- Modify: `web/lib/datasources.ts`
- Test: `web/lib/datasources.delete.test.ts`

- [ ] Failing test: delete order = schema-cache rows → credential id entry → integrations row; a Secrets Manager delete failure is logged, not blocking. If the deleted row was the default: pick a new default for the kind and **re-mirror its credential into the kind key**; if NO instances of that kind remain, delete the kind-mirror key. If the deleted row was NOT default, the kind mirror is left untouched.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 9: Fix GET /api/integrations/credential 500 (narrow downgrade)
**Files:**
- Modify: `web/app/api/integrations/credential/route.ts`
- Test: `web/app/api/integrations/credential/route.test.ts`

- [ ] Diagnose the real failing path first. Failing test: GET returns id-keyed configured status; downgrades to 200 empty ONLY for Secrets Manager AccessDenied/NotFound; other errors (PG, malformed JSON) stay 500 + logged (no secret contents). Align with concurrent try/catch.
- [ ] Implement minimally.
- [ ] vitest; commit.

## Phase 1 — Connector contract (backward-compatible) + endpoints

### Task 10: Inline conn-config invoke (BFF) with shim
**Files:**
- Create: `web/lib/mcp-lambda-invoke.ts`
- Modify: `web/lib/connector-invoke.ts`
- Test: `web/lib/mcp-lambda-invoke.test.ts`

- [ ] Failing test: `invokeMcpLambdaTool({kind, connConfig:{endpoint,authType,creds,org_id}, tool, args})` passes conn config inline to `${PROJECT}-agent-${kind}-mcp`; `KNOWN_MCP_LAMBDA_KINDS`; unknown kind rejected; `connector-invoke.ts` re-exports as a shim so existing importers keep working.
- [ ] Implement minimally.
- [ ] Refactor; vitest; commit.

### Task 11: Connector Lambda — inline conn-config WITH slug/kind fallback
**Files:**
- Modify: `agent/lambda/datasource_http.py`
- Test: `agent/tests/test_datasource_http.py`

- [ ] Failing unittest: handler uses inline conn-config when present, ELSE falls back to the existing slug/kind/env-map load (so the live AgentCore gateway path works and resolves to the default instance via the mirrored kind key). no-auth → `{}` headers; custom-header injected; Lambda SSRF guard retained. Test BOTH inline and no-inline (kind) paths.
- [ ] Implement minimally.
- [ ] unittest; commit.

### Task 12: Per-kind `*_health` tools
**Files:**
- Modify: `agent/lambda/prometheus_mcp.py`
- Modify: `agent/lambda/clickhouse_mcp.py`
- Modify: `agent/lambda/loki_mcp.py`
- Modify: `agent/lambda/tempo_mcp.py`
- Modify: `agent/lambda/mimir_mcp.py`
- Modify: `agent/lambda/datasource_http.py`
- Test: `agent/tests/test_health_tools.py`

- [ ] Failing unittest: a `*_health` op per kind — prometheus `/-/healthy` (prometheus_mcp), clickhouse `/ping` (clickhouse_mcp), loki `/ready` + tempo + mimir ready path (generic via datasource_http) — returns `{ok,latency,error?}`; uses inline conn-config; SSRF-guarded.
- [ ] Implement minimally.
- [ ] unittest; commit.

### Task 13: SSRF guard test matrix
**Files:**
- Modify: `web/lib/ssrf-guard.ts`
- Test: `web/lib/ssrf-guard.test.ts`

- [ ] Failing test: `assertDatasourceEndpointAllowed` blocks 169.254.169.254, IPv6 IMDS (`[fd00:ec2::254]`/`::1`), loopback `127.0.0.0/8`/`localhost`, **`0.0.0.0/8` and IPv6 unspecified `::`** (Linux routes 0.0.0.0 to localhost — bypass guard), link-local, `.internal`, non-http(s) schemes; allows RFC1918. (Locate the existing guard used by `credential/route.ts:47-51`; centralize if needed.)
- [ ] Implement/centralize minimally.
- [ ] vitest; commit.

### Task 14: POST /api/datasources/test (unsaved, pre-save)
**Files:**
- Create: `web/app/api/datasources/test/route.ts`
- Test: `web/app/api/datasources/test/route.test.ts`

- [ ] Failing test: body `{kind,endpoint,authType,creds}` (unsaved) → SSRF guard → `*_health` via `invokeMcpLambdaTool` → `{ok,latency,error?}`; admin-gated; SSRF block + non-admin 403 + success-shape; assert no secret value appears in the response/error.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 15: Create/Update datasource route (Add/Edit save)
**Files:**
- Create: `web/app/api/datasources/manage/route.ts`
- Test: `web/app/api/datasources/manage/route.test.ts`

- [ ] Failing test: `POST` create / `PATCH` update persist name/kind/endpoint/ds_auth_type/org_id (via `datasources.ts`) + id-keyed credential (via `setIntegrationCredentialById`); when updating the CURRENT default instance, the kind-mirror is refreshed (handled inside `updateDatasource`, no stale mirror); admin-gated; SSRF on endpoint; duplicate name → 409; secret never echoed back.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 16: Set-default route (admin, transactional)
**Files:**
- Create: `web/app/api/datasources/[id]/default/route.ts`
- Test: `web/app/api/datasources/[id]/default/route.test.ts`

- [ ] Failing test: `POST` sets the instance default (calls `setDefaultDatasource`, which mirrors the kind key); admin-only; unset-others verified.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 17: Re-scope QUERY route to instance id (+ slug fallback)
**Files:**
- Modify: `web/app/api/datasources/query/route.ts`
- Test: `web/app/api/datasources/query/route.test.ts`

- [ ] Failing test: accepts instance `id` (preferred) or `slug` (deprecated, resolved via datasources lookup), resolves connConfig, SSRF on resolved endpoint, invokes via `invokeMcpLambdaTool`.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 18: Re-scope GENERATE route to instance id (+ slug fallback)
**Files:**
- Modify: `web/app/api/datasources/generate/route.ts`
- Test: `web/app/api/datasources/generate/route.test.ts`

- [ ] Failing test: accepts instance `id` (or slug), resolves kind/schema for NL→query; never auto-runs.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 19: Re-scope SCHEMA introspect route + cache by integration_id
**Files:**
- Modify: `web/app/api/integrations/schema/route.ts`
- Modify: `web/lib/datasource-schema.ts`
- Test: `web/app/api/integrations/schema/route.test.ts`

- [ ] Failing test: introspect resolves an instance id → connConfig; cache writes/reads keyed by `integration_id` (BIGINT); two same-kind instances do not share a cache row.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 20: GET list instances + DELETE [id]
**Files:**
- Modify: `web/app/api/datasources/route.ts`
- Create: `web/app/api/datasources/[id]/route.ts`
- Test: `web/app/api/datasources/route.test.ts`

- [ ] Failing test: GET lists instances `{id,name,kind,ds_auth_type,status,isDefault}` (read = any authenticated user); DELETE `[id]` calls `deleteDatasource` (admin only).
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 21: Chat + diagnosis default-per-kind routing
**Files:**
- Modify: `web/app/api/chat/route.ts`
- Test: `web/app/api/chat/route.test.ts`

- [ ] Failing test: enabled egress-read datasource integrations are filtered to the `is_default` instance per kind before tool/context injection (no duplicate same-kind instances); schema/`provided_context` injection keyed by integration_id; a kind with no default is skipped cleanly. The agent gateway path resolves the default via the mirrored kind credential (Task 7/11) — assert no duplicate-kind injection.
- [ ] Implement minimally (build on the concurrent edits to this file).
- [ ] vitest; commit.

### Task 22: Secrets-never-logged + AWS-freeze regression tests
**Files:**
- Create: `web/lib/__tests__/secrets-and-freeze.test.ts`
- Create: `agent/tests/test_no_write_tools.py`

- [ ] Failing test (web): representative error/log paths for test/query/credential never contain token/password/custom-header values. (agent): `notion_mcp.py` exposes NO `*_write*`/mutation tools; `terraform.tfvars` keeps `integrations_write_enabled` (and remediation kill-switch) false (grep).
- [ ] Implement/adjust minimally.
- [ ] run both; commit.

## Phase 2 — Component extraction, hub shell, nav (ordering fixed)

### Task 23: Extract Explore into a shared component
**Files:**
- Create: `web/components/datasources/ExplorePanel.tsx`
- Modify: `web/app/datasources/page.tsx`
- Test: `web/components/datasources/ExplorePanel.test.tsx`

- [ ] Failing test: `ExplorePanel` renders query console + AI-generate and accepts an instance `id`/`kind` prop; `/datasources` renders it (no behavior change yet). Extraction BEFORE any redirect.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 24: Extract Agents/Skills/Agent-Space + isolate Connectors section
**Files:**
- Create: `web/components/customization/AgentsSkillsSections.tsx`
- Modify: `web/app/customization/page.tsx`
- Test: `web/components/customization/AgentsSkillsSections.test.tsx`

- [ ] Failing test: Agents/Skills/Agent-Space render from the extracted component; the Connectors 6-card section is a separate export so it can be dropped from the hub. No behavior change to `/customization` yet.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 25: i18n keys
**Files:**
- Modify: `web/lib/i18n.ts`
- Test: `web/lib/i18n.test.ts`

- [ ] Failing test: `nav.integrations` exists ko+en; `nav.datasources`/`nav.customAgents` retained for tab labels.
- [ ] Implement; vitest; commit.

### Task 26: Hub shell + tabs
**Files:**
- Create: `web/app/integrations/page.tsx`
- Create: `web/app/integrations/IntegrationsTabs.tsx`
- Test: `web/app/integrations/IntegrationsTabs.test.tsx`

- [ ] Failing test: tabs `Datasources | Connectors | Agents & Skills` via `?tab=` (default datasources); renders the right panel (placeholders ok).
- [ ] Implement minimally.
- [ ] Refactor; vitest; commit.

### Task 27: Explore instance route
**Files:**
- Create: `web/app/integrations/datasources/[id]/page.tsx`
- Test: `web/app/integrations/datasources/[id]/page.test.tsx`

- [ ] Failing test: renders `ExplorePanel` scoped to the instance `id`; query/generate calls carry the id.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 28: Nav fold-in (3 surfaces)
**Files:**
- Modify: `web/components/shell/Sidebar.tsx`
- Modify: `web/components/shell/CommandPalette.tsx`
- Modify: `web/lib/mobile-tabs.ts`
- Test: `web/components/shell/Sidebar.test.tsx`

- [ ] Failing test: an Integrations entry is present and standalone `/datasources` + `/customization` are removed across Sidebar, CommandPalette, and mobile tabs (assert all three).
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 29: Back-compat redirects (preserve query)
**Files:**
- Modify: `web/app/datasources/page.tsx`
- Modify: `web/app/customization/page.tsx`
- Test: `web/app/integrations/redirect.test.tsx`

- [ ] Failing test: `/datasources` → `/integrations?tab=datasources` (preserving `?instance=`); `/customization` → `/integrations?tab=agents-skills`. (Components already extracted in 23/24.)
- [ ] Implement minimally (Next redirect with query passthrough).
- [ ] vitest; commit.

## Phase 3 — Tab UIs + authorization

### Task 30: Datasources tab list
**Files:**
- Create: `web/app/integrations/datasources/DatasourcesTab.tsx`
- Test: `web/app/integrations/datasources/DatasourcesTab.test.tsx`

- [ ] Failing test: instance table (name/type/auth/status/★default/actions Explore·Test·Edit·Delete) + `+ Add datasource`; list visible to all authenticated users; mutation actions only for admin.
- [ ] Implement minimally.
- [ ] Refactor; vitest; commit.

### Task 31: Add/Edit drawer (auth selector + pre-save Test)
**Files:**
- Create: `web/app/integrations/datasources/DatasourceForm.tsx`
- Test: `web/app/integrations/datasources/DatasourceForm.test.tsx`

- [ ] Failing test: fields Type→Name→Endpoint→Auth method (None/Basic/Bearer/Custom-header)→conditional creds→org_id (loki/tempo/mimir); 🧪 Test posts the unsaved form to `/api/datasources/test` with a green/red banner; Save (via create/update route) allowed with auth None; name required. Test is advisory — Save not blocked on an untested form (documented).
- [ ] Implement minimally.
- [ ] Refactor; vitest; commit.

### Task 32: Connectors tab
**Files:**
- Create: `web/app/integrations/connectors/ConnectorsTab.tsx`
- Test: `web/app/integrations/connectors/ConnectorsTab.test.tsx`

- [ ] Failing test: lists connector-category integrations (Notion) with admin-only paste-token connect; write capability shown as propose-only/disabled; NO datasource kinds appear here.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 33: Agents & Skills tab + strip Connectors from source
**Files:**
- Create: `web/app/integrations/agents-skills/AgentsSkillsTab.tsx`
- Modify: `web/app/customization/page.tsx`
- Test: `web/app/integrations/agents-skills/AgentsSkillsTab.test.tsx`

- [ ] Failing test: the tab renders Agents/Skills/Agent-Space (from the extracted component) and contains NO Connectors section; the `CONNECTORS` array + Connectors `<section>` are gone from the legacy source.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 34: Authorization split
**Files:**
- Modify: `web/app/api/datasources/route.ts`
- Test: `web/app/api/datasources/authz.test.ts`

- [ ] Failing test: list + Explore reachable by any authenticated user; create/update/delete/credential/test/set-default require `isAdmin` (`web/lib/admin.ts`); non-admin mutate → 403.
- [ ] Implement minimally.
- [ ] vitest; commit.

### Task 35: Full-suite green + tidy
**Files:**
- Modify: `docs/superpowers/plans/2026-06-18-datasource-connector-skill-plan.md`

- [ ] Run `bash tests/run-all.sh`; fix in-scope regressions.
- [ ] Tidy: drop dead slug-only shims once no importers remain; confirm freeze checks pass; confirm no stale `connector-invoke` references.
- [ ] Commit final tidy + check off the plan.
