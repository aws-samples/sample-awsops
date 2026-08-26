# Datasource · Connector · Skill — Integrations Hub Design

> ⚠️ **ARCHIVED — historical design artifact, NOT a live spec.** Salvaged (PR #73) from a pruned worktree for
> reference only. This feature has since **shipped** (datasource connectors + Explore page, PR #57); the
> **shipped code — not this doc — is the source of truth.** Known issues flagged in the PR #73 review:
> §4/§6 credential-lifecycle ("delete the legacy kind entry" on save) is **stale/superseded** — the unified
> model keeps the kind key as a managed default mirror (never blind-deleted), since the AgentCore/`agent.py`
> no-inline gateway path resolves credentials by kind; and §4's "default per kind, scoped per account" wording
> contradicts the global `(kind) WHERE is_default` index (resolution is global). **Do not implement from this
> doc without reconciling against the shipped code.**

**Date:** 2026-06-18
**Branch:** `feat/v2-architecture-design`
**Status:** Approved (brainstorm) → consensus plan/implement
**Owner decisions locked:** C (single hub + tabs) · Explore = row-entry · reuse `integrations` table · auth = None/Basic/Bearer/Custom-header · 3rd tab = Agents & Skills

## 1. Problem / Motivation

The v2 datasource feature regressed vs v1. v1 (`src/`) let an admin:
1. create **multiple** datasources of the same type (e.g. two Prometheus),
2. give each a **name**,
3. connect **without** id/password (optional auth),
4. **Test** the connection before connecting/saving,
5. pick an **auth method** (none / basic / bearer / custom-header).

v2 today (PR #57) cannot do 1, 2, 4, 5; #3 already works at the backend. Root cause: the
connector registry is keyed solely by **type** (`slug == kind`) and credentials live in **one
Secrets Manager secret as a JSON map keyed by slug** (`web/lib/integration-credentials.ts:3-5,54-69`),
so a second Prometheus overwrites the first. There is no `name` column, no instance id, no
test-before-save endpoint, and no explicit auth-method selector (auth is inferred from which
fields are filled).

Separately, the IA conflates three distinct concepts. The `/customization` page
("Custom Agents") hosts a hardcoded `CONNECTORS` array of six cards
(`web/app/customization/page.tsx:21-34`) that mixes **observability datasources**
(prometheus/clickhouse/loki/tempo/mimir) with an **external connector** (notion). The word
"connector" is overloaded between (a) observability connector Lambdas and (b) external
integrations. The owner wants three clean categories:

- **Datasource** — observability backends you query read-only (prometheus, mimir, loki, tempo, clickhouse).
- **Connector** — external SaaS integrations (Notion now; Slack/Jira later). Read + governed write. **≠ skill.**
- **Skill** — agent capability (reusable instructions + tool allowlist, ADR-031). Already its own concept.

## 2. Goals / Non-goals

**Goals**
- v1 parity for datasources: multi-instance, naming, optional auth, test-before-save, auth-method selector.
- A single **Integrations hub** with three tabs that cleanly separates Datasource / Connector / Agents & Skills.
- Reuse the existing `integrations` table as the single substrate (ADR-039 unification intent).
- Fix the known `GET /api/integrations/credential` 500 (QA `docs/reviews/2026-06-17-app-qa-walkthrough.md:30`).

**Non-goals (frozen — do not enable)**
- External **write** activation (Notion/Slack/Jira writes stay propose-only, flag-OFF per ADR-040/041).
- New connector Lambdas for slack/jira/etc (Notion + the 5 observability kinds only).
- Any AWS-resource mutation / autonomy (permanently frozen per 2026-06-11 reversal).

## 3. Information architecture (decision: C + A)

- New top-level sidebar item **"연동 / Integrations"** → `/integrations` hub page with tabs:
  **Datasources · Connectors · Agents & Skills**.
- Remove the standalone top-level **Datasources** and **Custom Agents** (`/customization`) nav entries;
  fold them into the hub. Update `web/components/shell/Sidebar.tsx` (FIXED array :25-35),
  `web/components/shell/CommandPalette.tsx` (:16-24), `web/lib/mobile-tabs.ts`, `web/lib/i18n.ts`
  (add `nav.integrations`; keep/repurpose `nav.datasources`, `nav.customAgents`).
- **Explore (query)** is reached from a Datasources **row → "Explore →"**, scoped to an instance id:
  route `/integrations/datasources/[id]`. Reuse the existing Explore component
  (`web/app/datasources/page.tsx`) made instance-scoped. Explore keeps both the direct query console
  (PromQL/LogQL/TraceQL/SQL via `POST /api/datasources/query`) and the AI "generate" assist
  (NL→query via `POST /api/datasources/generate`, fills box, never auto-runs).
- Backward-compat redirects: `/datasources` → `/integrations?tab=datasources`, `/customization` →
  `/integrations?tab=agents-skills` (preserve existing links/bookmarks).

## 4. Data model (reuse `integrations`)

Datasource and Connector are both rows in the existing `integrations` table (created
`migrations/01KTY39P4SV1SQES36KCS8BESY_custom_agent_platform_p1.sql:96-114`, extended
`migrations/01KV0JKFF7Q28CMKQ2JGM2D1NK_integrations_p2.sql:7-32`). Columns already present:
`id, name (UNIQUE), kind, direction, capability, endpoint, transport, credentials_ref,
exposed_tools, provided_context, auth_mode, ..., tier, enabled`.

**Category derivation** (no enum migration needed — a `web/lib/integrations.ts` helper):
- `category = 'datasource'` when `direction='egress' AND capability='read' AND kind ∈
  {prometheus, mimir, loki, tempo, clickhouse}` (the query-language kinds).
- `category = 'connector'` for the remaining egress kinds (notion, slack, jira, …) + ingress.

**Instance identity (VERIFIED schema):** `integrations.id` is **`BIGSERIAL`** (bigint, auto-assigned)
— NOT a ULID. `name` is the user label (UNIQUE). Same `kind` may appear in many rows → multi-instance.
The integrations table is **global (single-account) — it has NO `account_id` column** (only
`datasource_schemas` is account-scoped).

**Kind CHECK must be expanded.** The `integrations_kind_check` egress set
(`migrations/01KV0JKFF7Q28CMKQ2JGM2D1NK_integrations_p2.sql`) is
`grafana,datadog,splunk,prometheus,newrelic,notion,confluence,jira,servicenow,slack,github,gitlab,custom_mcp`
— it includes `prometheus` but **NOT `clickhouse`/`mimir`/`loki`/`tempo`**. The migration must
`DROP CONSTRAINT IF EXISTS integrations_kind_check` and re-add it with those 4 kinds, and the
paired SOURCE-OF-TRUTH list `web/lib/integration-validation.ts INTEGRATION_KINDS_EGRESS` must be
updated in lockstep.

**Credentials (id-first + slug/kind fallback + lazy write-back — NO big-bang re-key):** keep the
single Secrets Manager secret JSON map. New instances store under the bigint **id** key. Existing
single instances keep their **slug/kind** key; `getCredentialById(id, kind)` reads the id entry, else
falls back to the legacy kind key. On the next save, write the id entry **and delete the legacy kind
entry** (no orphan). Because SQL cannot mutate Secrets Manager, there is intentionally **no migration
re-key** — the fallback guarantees zero credential loss on a LIVE system. Secret value shape:
`{ endpoint?, authType, username?, password?, token?, headerName?, headerValue?, org_id? }`.

**Default-per-kind also mirrors the agent path.** The AgentCore/`agent.py` gateway path invokes the
connector Lambdas WITHOUT inline config (it resolves by kind). To make "chat uses the default
instance" true there too, **`setDefaultDatasource` mirrors the default instance's credential under the
plain `kind` key** — so the connector Lambda's kind fallback always resolves to the current default.

**Auth metadata on the row:** add a dedicated additive column **`ds_auth_type TEXT`**
(`none|basic|bearer|custom_header`) so the list/UI shows the auth method without reading the secret.
(`auth_mode` is reserved for ingress webhook auth — do not overload it.) `endpoint` stays on the row;
`org_id`/creds live in the secret blob.

**Schema cache migration (2-phase, guarded):** `datasource_schemas` PK `(account_id, slug)`
(`migrations/01KV9GHENRHPGTX4KFMEH0ZFYT_datasource_schemas.sql:3-10`) → `(account_id, integration_id)`
where `integration_id` is **BIGINT** referencing `integrations.id`. Phase 1 (additive): add nullable
`integration_id BIGINT`, `ds_auth_type`, `is_default BOOLEAN`, partial unique index `(kind) WHERE
is_default`. Phase 2 (backfill+swap): create one `integrations` row per existing distinct slug (id
auto-assigned by BIGSERIAL — no `gen_random_uuid`), `ON CONFLICT (name) DO NOTHING`, map
`integration_id` by `kind=slug`, set `is_default=true`, then validate no-NULL → `SET NOT NULL` → swap
PK in a transaction. Migration filenames are real 26-char ULIDs (the `migrate-core.mjs` runner rejects
hand-numbered ids).

**Default-per-kind:** add `is_default BOOLEAN` semantics (one default per kind, scoped per account).
On set-default, unset other defaults of the same kind (mirror v1 `route.ts:376-381`). Chat/diagnosis
use the default instance per kind.

## 5. Datasources tab — v1 parity

- **List**: instance rows (name · type · auth · status · ★default · actions Explore/Test/Edit/Delete).
  Read-visible to all authenticated users; mutations admin-only.
- **Add/Edit drawer** (admin): `Type → Name → Endpoint URL → Auth method (None/Basic/Bearer/
  Custom-header) → conditional credential fields → org_id (loki/tempo/mimir only, X-Scope-OrgID)`.
  - Conditional fields: None → none; Basic → username/password (password optional); Bearer → token;
    Custom-header → header name + value.
  - Name required & unique; type required; endpoint required. Auth fully optional (None saves fine).
- **Test connection (before save)**: 🧪 button posts the **unsaved** form to `POST /api/datasources/test`;
  renders a green/red banner with latency or error (mirror v1 `page.tsx:929-957`).
- **Delete**: new instance-delete path (today there is no DELETE on the credential route).

## 6. Connector Lambda contract + test endpoint

The connector Lambdas currently load credentials by slug from the shared secret map
(`agent/lambda/datasource_http.py:119-123`). Change the contract so the **BFF resolves the instance
(row + secret) and passes the connection config inline** to the Lambda invocation
(`{ endpoint, authType, auth..., org_id? }` + the tool args). This enables both multi-instance
(resolve by id) and **pre-save test** (pass a candidate secret that isn't stored yet).

- **SSRF guard at the BFF** on the resolved endpoint (`assertDatasourceEndpointAllowed`, as in
  `web/app/api/integrations/credential/route.ts:47-51`) **plus** the Lambda's own guard
  (defense-in-depth). Blocks metadata/loopback/IPv6-IMDS; allows RFC1918.
- **New route `POST /api/datasources/test`**: body `{ kind, endpoint, authType, auth... }` (unsaved) →
  SSRF → connector `*_health` tool (per-kind health probe: prometheus `/-/healthy`, loki `/ready`,
  clickhouse `/ping`, tempo/mimir equivalent) → `{ ok, latency, version?, error? }`. Admin-gated.
- **Existing routes re-scoped to instance id:** `POST /api/datasources/query`,
  `POST /api/datasources/generate`, `POST /api/integrations/schema` (introspect→cache) take an
  instance **id** (resolve row → conn config) instead of slug. `GET /api/datasources` lists instances
  (id, name, kind, status, isDefault) for the tab + Explore picker. `GET /api/integrations/credential`
  500 fixed (return configured-instance status keyed by id; suspected missing table/migration).
- Connector invoke wiring `web/lib/connector-invoke.ts` still resolves the **per-kind** Lambda
  (`${PROJECT}-agent-${kind}-mcp`) — one prometheus Lambda serves all prometheus instances; only the
  credential source changes (inline conn config, not slug-map lookup).
- **De-overload naming** (low-risk rename): the transport mechanism = "MCP connector Lambda"
  (`KNOWN_CONNECTOR_SLUGS` → `KNOWN_MCP_LAMBDA_KINDS`, `connector-invoke.ts` → `mcp-lambda-invoke.ts`);
  user-facing "Connector" = the external-service category. Keep lexically distinct.

## 7. Connectors tab (Notion)

- Shows `integrations` rows of `category='connector'`. Notion: paste token → connect; read stays LIVE
  (`agent/lambda/notion_mcp.py`, external-obs gateway target, `terraform.tfvars:16
  integrations_enabled=true`) — **unchanged**.
- Notion/Slack write = **out of scope**, remains propose-only & flag-OFF (`integrations_write_enabled`
  default false). Future slack/jira appear as registerable kinds without a Lambda (no live connect).

## 8. Agents & Skills tab

- Move the current `/customization` content (New Agent, New Skill, Agents list, Skills list, Agent
  Space) verbatim into this tab. **Remove only the "Connectors" section** (the 6-card array) — its
  members split to the Datasources tab (5 observability kinds) and Connectors tab (Notion).
- `skills`/`agents`/`agent_skills` tables and `web/lib/agent-resolver.ts` unchanged.

## 9. Authorization

- **Mutations** (register/edit/delete/credential/test/set-default) = **admin** (`isAdmin`,
  `web/lib/admin.ts`).
- **Read + Explore (query)** = any authenticated user. Split the currently all-admin `/customization`
  gating so the hub's list + Explore are non-admin-visible; only management is admin-gated.

## 10. Chat / diagnosis routing

- With multi-instance, chat injection (`web/app/api/chat/route.ts:117-130`), `generate`, and AI
  diagnosis use the **default instance per kind**. Explore uses the explicit instance the user opened.
- `provided_context`/schema injection keyed by instance id.

## 11. Phasing

- **P0** — data model: ULID migration (schema-cache PK → integration_id; default-per-kind; authType),
  id-keyed secret map (`integration-credentials.ts`), `GET /api/integrations/credential` 500 fix.
- **P1** — connector inline-conn contract (`datasource_http.py` + `connector-invoke.ts`),
  `POST /api/datasources/test`, re-scope query/generate/schema to instance id, instance DELETE.
- **P2** — hub shell (`/integrations`, 3 tabs) + nav/palette/mobile + fold `/datasources`+
  `/customization` (redirects) + Explore row-entry `/integrations/datasources/[id]`.
- **P3** — Datasources tab UI (list/Add/Edit/Test/Delete drawer, auth selector), Connectors tab,
  Agents & Skills tab (minus Connectors section), authz split.

## 12. Out of scope

External write activation; new connector Lambdas (slack/jira/…); AWS-resource mutation/autonomy
(all frozen). Neptune graph (ADR-043). Ingress webhook handlers (designed-only).

## 13. Testing strategy

- Unit (vitest, `web/`): category derivation; id-keyed credential get/set + multi-instance no-overwrite;
  auth-header building per authType incl. custom-header & empty-password basic; SSRF guard on test/query;
  default-per-kind unset-others; route authz (admin vs read); 500-fix regression.
- Connector (python unittest, `agent/`): inline conn-config path; `*_health` tool per kind; no-auth path
  returns `{}` headers; custom-header injection.
- Migration: schema-cache PK move + data migration idempotency (PG17 container as in backfill tooling).
- Keep existing suites green (`web` vitest ~600+, `agent` unittests).

## 14. Key files

`web/components/shell/{Sidebar,CommandPalette,MobileNav,BottomTabBar}.tsx`, `web/lib/{mobile-tabs,i18n,
integrations,integration-credentials,connector-invoke,datasource-schema,admin}.ts`,
`web/app/integrations/**` (new hub + tabs + `datasources/[id]` explore), `web/app/api/datasources/**`
(+ `test/route.ts`), `web/app/api/integrations/{credential,schema}/route.ts`,
`web/app/customization/page.tsx` (strip Connectors), `agent/lambda/datasource_http.py` (+ per-kind
`*_mcp.py` health/inline-conn), `terraform/foundation/migrations/<new ULID>_*.sql`.
v1 parity reference: `src/lib/{app-config,datasource-client,datasource-registry}.ts`,
`src/app/api/datasources/route.ts`, `src/app/datasources/page.tsx`.
