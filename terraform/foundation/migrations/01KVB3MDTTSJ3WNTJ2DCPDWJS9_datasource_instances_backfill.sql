-- since: 2.4.0
-- Datasource instances — Phase 0b: backfill `integrations` rows from existing cached datasources,
-- map the per-instance cache key, then swap the datasource_schemas PK to (account_id, integration_id).
-- Depends on 01KVB3MDTRVQW4MMC4GBVS6PPR_datasource_instances_additive.sql. Idempotent + re-runnable.
-- NOTE: datasources configured in Secrets Manager but never introspected (no cache row) are backfilled
-- separately by scripts/v2/backfill-datasource-instances.mjs (SQL cannot read Secrets Manager).
-- Do NOT write schema_migrations (the runner stamps it).

-- (a) Create one global integrations row per existing datasource-kind slug. enabled=true (so the chat/
--     diagnosis default-per-kind filter keeps them) and is_default=true (first instance of the kind).
--     FILTER to the 5 datasource kinds: an out-of-set slug would violate integrations_kind_check and
--     abort the whole backfill. ON CONFLICT (name) DO NOTHING ⇒ re-run safe.
INSERT INTO integrations (name, kind, direction, capability, description, enabled, is_default)
SELECT DISTINCT ds.slug, ds.slug, 'egress', 'read', ds.slug || ' (migrated datasource)', true, true
  FROM datasource_schemas ds
 WHERE ds.slug IN ('prometheus','mimir','loki','tempo','clickhouse')
ON CONFLICT (name) DO NOTHING;

-- (b) Map each cache row to its integration row (global; account-scoped cache rows for one slug all map
--     to the one integration row — first slug wins, endpoint/auth are user-editable post-migration).
UPDATE datasource_schemas ds
   SET integration_id = i.id
  FROM integrations i
 WHERE i.name = ds.slug
   AND ds.integration_id IS NULL;

-- (c) Drop any cache rows that could not be mapped (stale/unknown-kind cache — regenerable on next
--     introspect). This lets integration_id become NOT NULL for the new PK.
DELETE FROM datasource_schemas WHERE integration_id IS NULL;

-- (d) Swap the PK to (account_id, integration_id) so two instances of one kind no longer collide on a
--     single cache row. Guarded so a re-run (PK already swapped) is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'datasource_schemas' AND column_name = 'integration_id' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE datasource_schemas ALTER COLUMN integration_id SET NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'datasource_schemas_pkey'
       AND pg_get_constraintdef(oid) LIKE '%slug%'
  ) THEN
    ALTER TABLE datasource_schemas DROP CONSTRAINT datasource_schemas_pkey;
    ALTER TABLE datasource_schemas ADD PRIMARY KEY (account_id, integration_id);
  END IF;
END $$;
