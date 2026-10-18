# Datasource credential identity and rollout

This runbook covers native datasource isolation under ADR-007 external-data governance
and ADR-039 integration identity. It does not approve deployment or activate any gate.

## Symptoms

After a stricter connector rollout, a migrated default with only an unstamped kind
credential fails an explicit-ID read. A sibling without its own credentials must fail.

## Diagnosis

Native datasource connectors store one credential blob per integration ID.
Their plain kind key is a managed mirror for the current default. The mirror
includes `instanceId`; an explicit-ID producer read accepts only its own ID key
or a mirror bearing that exact ID. Missing credentials fail closed. Calls without
an explicit ID retain the existing kind-default lookup.

An old unstamped mirror cannot prove which instance owns its credentials.
## Action

Before deploying the stricter connector producer, operators must backfill every
migrated default through the existing authenticated administrator save flow:

1. Identify the current default datasource in the Integrations interface. Keep
   its endpoint and authentication type unchanged.
2. Save that datasource's connection settings. The server re-reads the row under
   its manage lock; only a current default may recover an unstamped kind mirror,
   and its stored endpoint must exactly match that row. Do not print credentials.
3. Confirm the save succeeded. It writes the instance ID credential and stamps
   the kind mirror. A settings-only save preserves the matched authentication
   material. A mismatched stamp or endpoint is rejected as a credential source;
   resupply the intended instance's credentials through the same write-only form.
4. Verify a credential-blind read for that exact instance ID before the connector
   rollout, and verify a same-kind instance without its own credentials fails
   closed. Stop deployment until all migrated defaults pass.

Changing or deleting a default does not establish ownership of its old mirror.
Only an ID-bound credential may be mirrored to the replacement; absent credentials
clear the kind mirror instead of lending the previous default's authentication.
Resave migrated defaults before switching them. Secrets Manager and row writes are
not one atomic cross-service transaction; a failed save requires inspection and
retry through the administrator flow before rollout.

The implementation is `web/lib/integration-credentials.ts`,
`web/app/api/datasources/manage/route.ts`, `web/lib/datasources.ts` and
`agent/lambda/datasource_http.py`. Focused verification:

```bash
cd web && npx vitest run lib/integration-credentials.id.test.ts lib/datasources.test.ts lib/datasources.default.test.ts lib/datasources.delete.test.ts app/api/datasources/manage/route.test.ts
cd agent/lambda && python3 -m pytest test_external_connections.py -q
```

Run the two commands from the repository root independently. These local tests
mock Secrets Manager/provider reads and do not establish successful production
backfill, producer deployment, IAM readiness or live provider access.
