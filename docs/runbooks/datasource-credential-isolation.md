# Datasource credential identity and rollout

This runbook covers native datasource isolation under ADR-007 external-data governance
and ADR-039 integration identity. It does not approve deployment or activate any gate.

## Symptoms

After the stricter connector rollout, an explicit-ID read for a migrated default whose
per-instance credential key was never written fails closed. A sibling without its own
credentials must fail.

## Diagnosis

Native datasource connectors store one credential blob per integration ID
(`map[<id>]`). Their plain kind key is the managed mirror of the current default
and serves only calls without an explicit ID. An explicit-ID read uses its own ID
key only; it never falls back to the kind mirror. Missing credentials fail closed.

## Action

Before deploying the stricter connector producer, operators must re-save every
migrated default through the existing authenticated administrator save flow:

1. Identify the current default datasource in the Integrations interface. Keep
   its endpoint and authentication type unchanged.
2. Save that datasource's connection settings (Integrations → datasource → save
   connection settings). Do not print credentials.
3. Confirm the save succeeded. For a default, the save reads the ID key and falls
   back to the kind mirror only when the mirror's endpoint origin matches the row;
   otherwise stored authentication material is dropped and must be resupplied
   through the same write-only form. It strips stale settings, writes the merged
   blob under the instance ID and re-mirrors it to the kind key.
4. Verify a credential-blind read for that exact instance ID before the connector
   rollout, and verify a same-kind instance without its own credentials fails
   closed. Stop deployment until all migrated defaults pass.

Default switching and deletion keep today's web behavior in this change. The
successor's credential is resolved by ID key with a fallback to the kind mirror —
which at that moment still holds the removed default's blob — so a successor
without its own ID key is re-mirrored with the previous default's credential (a
known residual); the mirror is cleared only when no instance of the kind remains.
The datasource web contract change replaces this with an ID-stamped mirror and a
409 guard. Secrets Manager and row writes are not one atomic cross-service
transaction; a failed save requires inspection and retry through the administrator
flow before rollout.

The implementation is `web/app/api/datasources/manage/route.ts` and
`agent/lambda/datasource_http.py`. Focused verification:

```bash
cd web && npx vitest run app/api/datasources/manage/route.test.ts
cd agent/lambda && python3 -m pytest test_external_connections.py -q
```

Run the two commands from the repository root independently. These local tests
mock Secrets Manager/provider reads and do not establish successful production
backfill, producer deployment, IAM readiness or live provider access.
