# Plan: Integration Credential UI — credential-write UX (single secret)

> Spec: `docs/superpowers/specs/2026-06-15-integration-credential-ui-design.md`.
> An admin sets an integration's credential in the customization UI; the BFF stores it in ONE
> Secrets Manager secret (`ops/${project}/integrations/credentials`) as a JSON map keyed by slug;
> the connector Lambda reads that single secret and extracts its slug. Token never returned/logged.
> TF owns the secret's existence; the BFF owns its value (PutSecretValue only). MODIFIES the shipped
> Notion connector (per-notion secret → single secret + slug). Branch `fix/v2-upgrade-snapshot-id`.

## Grounding (verified)
- BFF AWS SDK pattern (`web/lib/admin.ts`): lazy singleton `new SSMClient({region})` + `.send(new Cmd)`;
  tests `vi.mock('@aws-sdk/client-ssm', …)`. Mirror for `@aws-sdk/client-secrets-manager` (NOT yet a dep).
- Integrations: `name` is the unique key (`ON CONFLICT(name)`); there is NO slug column → **slug = name**.
  Connector reads `creds[INTEGRATION_SLUG]` (Notion: `INTEGRATION_SLUG=notion`).
- Web task role currently has only `secretsmanager:GetSecretValue` (`workload.tf:39`); needs PutSecretValue.
- `/api/integrations` is `isAdmin`-gated (mirror for the new credential route).
- The Notion connector's per-notion secret (ai.tf) + `notion_mcp.py` fixed-name read are REPLACED here.

## Non-goals
- Per-integration secrets, secret rotation, CreateSecret-from-UI, concurrency locking
  (last-write-wins, documented). No mutation/autonomy (read-only stance holds).

## P2 consensus gate — round 1 findings & resolutions (panel: kiro opus-4.8 / kimi-k2.5 / glm-5; codex+agy timed out)
- **MAJOR (all 3, verified) — slug must be the integration `kind`, NOT `name`.** `web/app/customization/page.tsx:8,14,30,52`: a row has free-text `name` + a `kind` dropdown (`INTEG_KINDS_EGRESS` includes `notion`). Keying by `name` means an admin naming it "Team Notion" stores under the wrong key while the connector reads `INTEGRATION_SLUG="notion"`. **Resolution: slug = `row.kind`; the connector's `INTEGRATION_SLUG` = its kind (`notion`); the UI sends `row.kind`. (One connector per kind for now — a 2nd integration of the same kind shares the slug; documented.)**
- **MAJOR (all 3) — slug allowlist source undefined.** **Resolution: a `KNOWN_CONNECTOR_SLUGS` constant (kinds that have a connector Lambda; initially `['notion']`), reject anything else with NO SM call.** (Not Aurora-derived — connectors are fixed infra.)
- **MAJOR (glm) — payload size bound undefined.** **Resolution: `MAX_SECRET_PAYLOAD_BYTES = 65000` (Secrets Manager 64 KB/version limit); reject + test.**
- **MAJOR (all 3) — read-modify-write clobber on the shared single secret.** Secrets Manager `PutSecretValue` has **no** conditional-put / expected-version param (verified API limitation) — so VersionId-based optimistic locking is NOT possible. **Resolution: serialize the RMW with an Aurora `pg_advisory_xact_lock(<fixed key>)` (the BFF already has `getPool`) — concurrent admin writes to different slugs no longer clobber. Documented as the concurrency control.**
- **CRITICAL (kimi+glm) — destructive secret replacement / backward-compat / migration.** DROPPED as premise-false: **the prior Notion-connector increment was NEVER applied to live** (its per-notion secret has no value; the live-apply steps were not run). This is a clean pre-deployment replacement — **no migration, no backward-compat shim** (YAGNI). **Resolution: document this explicitly; rename the TF resource (old policy/secret cleanly removed); apply order = `terraform apply` (creates single secret) → `make agentcore` (Lambda new env).**
- **MAJOR (all 3, conditional) — KMS Decrypt.** **Resolution: the single secret uses the DEFAULT `aws/secretsmanager` key (no custom CMK) → no `kms:Decrypt` grant needed; state it in Tasks 5/6.** The existing `aws_kms_key.integrations` CMK serves the M2 egress path (unchanged) — not orphaned by this change.
- **MINOR (opus) — first-deploy no version.** **Resolution: `getConfiguredSlugs()` → `[]` and the connector → structured "credential not configured" on `ResourceNotFoundException`/empty.**
- **MINOR (kimi+glm) — test quality.** **Resolution: assert `PutSecretValue` receives the MERGED map (both old+new keys); assert the route response + `console`/logger never carry the secret value (spy).**

## Tasks (TDD; per-task commit; vitest / `python3 -m unittest` / `terraform validate` green each task)

### Task 1: Secrets Manager credential helper (BFF)
**Files:**
- Modify: `web/package.json`
- Create: `web/lib/integration-credentials.ts`
- Test: `web/lib/integration-credentials.test.ts`
- [ ] Add `@aws-sdk/client-secrets-manager` to `web/package.json` deps; `npm install` in `web/`.
- [ ] Failing tests (vitest; `vi.mock('@aws-sdk/client-secrets-manager', …)` mirroring `admin.test.ts`;
  also mock `@/lib/db` `getPool` for the advisory lock):
  - `setIntegrationCredential('notion', {token:'x'})`: GetSecretValue then PutSecretValue; assert the
    `PutSecretValueCommand` input `SecretString` parses to a map containing BOTH a pre-existing
    `datadog` key AND the new `notion` key (merge, not overwrite).
  - First write: GetSecretValue throws `ResourceNotFoundException` (or no `SecretString`) → `{}` →
    PutSecretValue `{"notion":{...}}`.
  - `getConfiguredSlugs()` returns KEYS only (`['datadog','notion']`); ResourceNotFound → `[]`;
    assert NO secret values appear in the return.
  - slug allowlist: a slug NOT in `KNOWN_CONNECTOR_SLUGS` → throws, and **no SM call** is made.
  - payload size bound: a value pushing the map over `MAX_SECRET_PAYLOAD_BYTES` → rejected, no PUT.
  - advisory lock: assert `pg_advisory_xact_lock` (or the chosen lock call) runs before the GET→PUT.
- [ ] Implement `web/lib/integration-credentials.ts`: lazy `SecretsManagerClient` singleton (region
  from env, mirror `lib/admin.ts`); `SECRET_NAME = ops/${project}/integrations/credentials`
  (project from env, default `awsops-v2`); `KNOWN_CONNECTOR_SLUGS = ['notion']` (kinds with a
  connector Lambda — extend as connectors are added); `MAX_SECRET_PAYLOAD_BYTES = 65000`.
  `setIntegrationCredential(slug, obj)` wraps the GET→merge→PUT in a transaction holding
  `pg_advisory_xact_lock(<fixed key>)` via `getPool` (serializes concurrent admin writes — SM has no
  conditional-put). `getConfiguredSlugs()` returns keys only. Returns nothing sensitive; never logs values.
- [ ] `cd web && npx vitest run lib/integration-credentials.test.ts` → green.
- [ ] Commit: `feat(integrations): SM credential read-modify-write helper (single secret, slug-keyed)`.

### Task 2: admin credential route (BFF)
**Files:**
- Create: `web/app/api/integrations/credential/route.ts`
- Test: `web/app/api/integrations/credential/route.test.ts`
- [ ] Failing tests (mirror `web/app/api/integrations/route.test.ts`): non-admin → 403; `PUT
  {slug:'notion', secret:{token:'x'}}` → calls helper, returns `{ok:true}`; assert the response body
  (stringified) contains NEITHER the token value NOR a `secret` field; spy `console.log`/`console.error`
  and assert neither was called with the token; `GET` → `{configured:[...slugs]}` (no values);
  malformed body / unknown slug → 400.
- [ ] Implement `route.ts`: `PUT` + `GET`, `isAdmin`-gated (mirror `/api/integrations`); delegates to
  `lib/integration-credentials`; `// SECURITY: never log/echo the credential value`.
- [ ] `cd web && npx vitest run app/api/integrations/credential/route.test.ts` → green.
- [ ] Commit: `feat(integrations): admin credential route — PUT set / GET configured-slugs (no values)`.

### Task 3: credential form in the customization Integrations section
**Files:**
- Modify: `web/app/customization/page.tsx`
- [ ] Add a per-integration masked token input + "Save credential" button → `PUT
  /api/integrations/credential {slug: row.kind, secret:{token}}` (key by **kind**, matching the
  connector's `INTEGRATION_SLUG`); show `configured ✓/✗` by kind from `GET
  /api/integrations/credential`. Helper text noting the credential is keyed by integration kind.
  NEVER render the token value. Clear the input after save.
- [ ] `cd web && npm run build` (or `npx tsc --noEmit`) → no type/build error. (Light render test only
  if the page already has a test harness; otherwise build is the gate.)
- [ ] Commit: `feat(integrations): customization UI — per-integration credential form + configured status`.

### Task 4: connector reads the single secret by slug
**Files:**
- Modify: `agent/lambda/notion_mcp.py`
- Test: `agent/lambda/test_notion_mcp.py`
- [ ] Update/extend tests: `_get_token()` reads `INTEGRATIONS_SECRET_NAME` (single secret), parses the
  JSON map, extracts `map[INTEGRATION_SLUG]` (default `notion`) → `{"token":...}`; token cached
  per warm container; a missing slug key OR `ResourceNotFoundException`/empty secret → structured
  "credential not configured" error (NOT an opaque stack trace). No backward-compat with the old
  per-notion secret — that connector was never deployed live, so there is nothing to migrate.
- [ ] Implement: `_get_token()` reads the single secret + slug extraction (env `INTEGRATION_SLUG`,
  default `notion`; `INTEGRATIONS_SECRET_NAME` default `ops/awsops-v2/integrations/credentials`).
- [ ] `cd agent/lambda && python3 -m unittest test_notion_mcp` → green.
- [ ] Commit: `feat(agent-platform): notion_mcp reads single integrations secret by slug`.

### Task 5: single secret + lambda env/IAM (TF)
**Files:**
- Modify: `terraform/foundation/ai.tf`
- [ ] Replace `aws_secretsmanager_secret.notion` with `aws_secretsmanager_secret.integrations`
  (`count = integ_count`, `name = ops/${var.project}/integrations/credentials`, **DEFAULT
  aws/secretsmanager key — no `kms_key_id`**, NO `aws_secretsmanager_secret_version`, NO
  `lifecycle{ignore_changes}` — the BFF owns the value). Rename `agent_lambda_notion_secret` →
  `agent_lambda_integrations_secret` (`GetSecretValue` on the single secret ARN) — the rename
  cleanly removes the old policy (TF destroy+create). Clean replacement: the per-notion secret was
  never applied live (no value) → nothing to migrate.
- [ ] notion Lambda env: `INTEGRATIONS_SECRET_NAME = aws_secretsmanager_secret.integrations[0].name`
  + `INTEGRATION_SLUG = "notion"` (replace the old `NOTION_SECRET_NAME`).
- [ ] `terraform -chdir=terraform/foundation fmt` (revert any out-of-scope file fmt drift) +
  `validate` → green. (Apply order at deploy: `terraform apply` creates the single secret BEFORE
  `make agentcore` ships the Lambda's new env.)
- [ ] Commit: `feat(agent-platform): single integrations secret + notion slug env (replaces per-notion secret)`.

### Task 6: web task role secret write grant (TF)
**Files:**
- Modify: `terraform/foundation/workload.tf`
- [ ] Add a NEW `aws_iam_role_policy.task_integrations_secret` (`count = local.integ_count`, on the web
  task role) granting `secretsmanager:GetSecretValue` + `secretsmanager:PutSecretValue` on
  `aws_secretsmanager_secret.integrations[0].arn` ONLY. No `CreateSecret`, no `Principal:"*"`, no
  wildcard beyond the ARN. Default-key secret → no `kms:Decrypt` needed. (Verify `local.integ_count`
  is available in workload.tf or reference the var condition equivalently.)
- [ ] `terraform -chdir=terraform/foundation fmt` + `validate` → green.
- [ ] Commit: `feat(integrations): web task role PutSecretValue on single integrations secret (scoped)`.

## Manual / live steps (NOT autonomous)
1. `terraform -target` apply for the single secret + IAM (ai.tf, workload.tf) — controller/user.
2. `make deploy` (web image with the new route/UI + SDK dep) and `make agentcore` (notion Lambda env).
3. Live: admin opens customization → Integrations → set the Notion token → connector reads it.
   (Admin gate must be open — see the connector plan's manual steps.)
4. Persist `integrations_enabled=true` in the live source-of-truth (already present — verify).
