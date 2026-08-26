# Integration Credential UI — DevOps-Agent-style credential-write UX (single secret)

**Date:** 2026-06-15
**Branch:** `fix/v2-upgrade-snapshot-id` (worktree `gap-impl-wave1`)
**Status:** Design — approved by user direction (`/co-agent:consensus`), entering plan→build.
**Follows:** `2026-06-14-notion-read-connector-design.md` (the M1 Notion connector this credential
path feeds).

## Problem / Context

The Notion read connector (shipped, flag-gated) reads its token from Secrets Manager, but the
**credential-write UX was explicitly deferred in inc2** — the token must be injected by an admin via
CLI (`put-secret-value`) and there is no UI. The user wants the AWS-DevOps-Agent experience: an
admin adds an integration and enters its credential **in a UI screen**, and the system stores it in
Secrets Manager.

Current state (verified):
- `/api/integrations` (admin, `isAdmin`-gated) registers integration rows and accepts a
  `credentialsRef` *string* (an ARN the admin pastes) — it does NOT create/write the secret.
- The web BFF has **no** Secrets Manager SDK usage; `@aws-sdk/client-secrets-manager` is not a
  dependency. The web task role has only `secretsmanager:GetSecretValue` (no write).
- The customization page already renders an Integrations section (create / enable-toggle).

## Goal

An admin can set an integration's credential from the customization UI; the BFF stores it in **one
Secrets Manager secret** holding a JSON map keyed by integration **slug**
(`{ "notion": {"token": "..."}, ... }`); the connector Lambda reads that single secret and extracts
its own slug's entry. The token is never returned to the client or logged.

## Key decisions (from brainstorming)

- **Single secret, multiple integrations** (user's choice): one secret
  `ops/${project}/integrations/credentials` holds a JSON object keyed by slug. The BFF does a
  read-modify-write: `GetSecretValue` → set `map[slug]` → `PutSecretValue` the whole map.
- **TF owns the secret's existence; the BFF owns its value.** TF creates the (value-less) secret
  + grants; the BFF writes the value (`PutSecretValue` only — no `CreateSecret`).
- **Isolation note:** all connector Lambdas already share one `agent_lambda` role, so a single
  secret is no worse for isolation than per-integration secrets (the shared role reads all either
  way). A future per-connector-role split could re-split the secret. Documented, not blocking.
- **Slug = the integration row `name`** (already unique via `ON CONFLICT(name)`); there is no
  separate slug column. The connector Lambda reads `creds[INTEGRATION_SLUG]`; for Notion the
  integration must be named `notion` (the connector's `INTEGRATION_SLUG=notion`).
- **This MODIFIES the shipped Notion connector:** `notion_mcp.py` switches from the per-notion
  secret to the single secret + slug extraction; the per-notion TF secret is replaced by the single
  `integrations/credentials` secret.

## Architecture (data flow)

```
[Admin UI] customization → Integrations → per-row "Set credential" form (token, masked input)
   → PUT /api/integrations/credential {slug, secret:{token}}   (isAdmin)
      → BFF lib/integration-credentials.ts: GetSecretValue(single) → map[slug]=secret → PutSecretValue(map)
      → returns {ok, configured:true}   (NEVER the value)
[Connector Lambda] notion_mcp → GetSecretValue(single) → map["notion"]["token"]
```

## Components (single-responsibility units)

### (a) `terraform/foundation/ai.tf` — single secret + lambda read grant
- Replace `aws_secretsmanager_secret.notion` with `aws_secretsmanager_secret.integrations`
  (`count = integ_count`, name `ops/${var.project}/integrations/credentials`, default key, value
  NOT managed by TF). Update `agent_lambda_notion_secret` → `agent_lambda_integrations_secret`:
  `GetSecretValue` on the single secret ARN.
- Update the notion Lambda env: `INTEGRATIONS_SECRET_NAME = <single secret name>` +
  `INTEGRATION_SLUG = "notion"`.

### (b) `terraform/foundation/workload.tf` — web task write grant
- Grant the web task role `secretsmanager:GetSecretValue` + `secretsmanager:PutSecretValue` on the
  single secret ARN only (`count` aligned with the secret's existence). No `CreateSecret`, no
  `Principal:"*"`, no wildcard beyond the one ARN.

### (c) `web/lib/integration-credentials.ts` — SM read-modify-write helper
- `setIntegrationCredential(slug, secretObj)`: lazy `SecretsManagerClient` (mirror `lib/admin.ts`
  SSM singleton); `GetSecretValue` (treat `ResourceNotFoundException` / empty as `{}`); merge
  `map[slug]=secretObj`; `PutSecretValue` the serialized map. Returns nothing sensitive.
- `getConfiguredSlugs()`: returns the set of slugs present (keys only — **never values**), for the
  UI "configured" status.
- Validates `slug` against an allowlist of known integration names (no arbitrary keys);
  size-bounds the secret payload.

### (d) `web/app/api/integrations/credential/route.ts` — admin credential route
- `PUT` (isAdmin): body `{slug, secret}` → `setIntegrationCredential`; returns `{ok:true}`. Never
  echoes the secret; never logs it.
- `GET` (isAdmin): returns `{configured: ["notion", ...]}` (slugs only).

### (e) `web/app/customization/page.tsx` — credential form in Integrations section
- Per integration row: a masked token input + "Save credential" button → `PUT
  /api/integrations/credential`; show `configured: ✓/✗` (from the GET). Never display the token.

### (f) `agent/lambda/notion_mcp.py` — read single secret by slug
- `_get_token()` reads `INTEGRATIONS_SECRET_NAME` (single secret), parses JSON, extracts
  `map[INTEGRATION_SLUG]` (default slug `notion`) → `{"token": ...}`. Update tests accordingly.

### (g) `web/package.json` — add `@aws-sdk/client-secrets-manager`

## Error handling
- Missing/empty secret version (first write) → treat as `{}` and create the first value.
- Read-modify-write is last-write-wins (admin-only, low frequency); documented. Optional: capture
  `VersionId` and warn on a detected concurrent change (stretch, not required).
- Non-admin → 403 (mirror existing `/api/integrations`).
- Connector: slug missing from the map → structured "credential not configured" tool error.

## Security
- `isAdmin`-gated write; token never returned/logged; write-only from the UI's perspective.
- Web task role scoped to the single secret ARN (Get+Put only). No CreateSecret.
- Slug allowlist (no arbitrary secret keys); payload size bound.
- Read-only stance unaffected (this manages *credentials for read connectors*, not AWS mutation).

## Testing
- `web/lib/integration-credentials.test.ts`: RMW merge (existing keys preserved), first-write
  (ResourceNotFound→{}), values never in return, slug allowlist rejects unknown.
- `web/app/api/integrations/credential/route.test.ts`: admin-gate 403, PUT writes, GET returns
  slugs-only (no values), bad body → 400.
- `agent/lambda/test_notion_mcp.py`: updated for single-secret + slug extraction (missing slug →
  error; present slug → token).
- TF `fmt` + `validate`. UI: minimal render/interaction test if the page has a test harness.

## Scope / YAGNI
- One secret, slug-keyed; admin UI write + status. No per-integration secrets, no rotation, no
  CreateSecret-from-UI, no concurrency locking (last-write-wins documented).
- Connector generalization (Prometheus/etc.) reuses the same secret + slug convention later.

## ADR note
Credential-write UX for read-tier external integrations. No mutation/autonomy/BYO-MCP → consistent
with the high-risk reversal. An optional ADR addendum could record the single-secret credential
convention; out of scope for this spec (ADR numbering per `docs/decisions/CLAUDE.md`).
