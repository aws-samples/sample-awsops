-- ADR-043 Step 2: class namespace on the materialized topology graph.
-- One physical graph, two logical graphs: class='flow' (traffic flow, the existing default) and
-- class='infra' (resource-relationship: resource <-> vpc/subnet/sg). `class` is part of BOTH the
-- node PK and the edge UNIQUE so a node shared by both graphs (same id) is stored as TWO
-- class-distinct rows — each materializer (rebuildGraph / rebuildInfraGraph) mark-sweeps only its
-- own class and can never wipe the other's rows. (P2 consensus-gate CRITICAL fix.)
-- Read-only posture unchanged: derived from inventory; never mutates AWS.

ALTER TABLE topology_nodes ADD COLUMN IF NOT EXISTS class text NOT NULL DEFAULT 'flow';
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS class text NOT NULL DEFAULT 'flow';

-- node PK: (account_id, id) -> (account_id, id, class)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'topology_nodes'::regclass AND contype = 'p' AND array_length(conkey, 1) = 3
  ) THEN
    ALTER TABLE topology_nodes DROP CONSTRAINT IF EXISTS topology_nodes_pkey;
    ALTER TABLE topology_nodes ADD PRIMARY KEY (account_id, id, class);
  END IF;
END $$;

-- edge UNIQUE: (account_id, source, target, rel) -> (..., class)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'topology_edges'::regclass AND contype = 'u'
      AND conname = 'topology_edges_account_id_source_target_rel_class_key'
  ) THEN
    ALTER TABLE topology_edges DROP CONSTRAINT IF EXISTS topology_edges_account_id_source_target_rel_key;
    ALTER TABLE topology_edges
      ADD CONSTRAINT topology_edges_account_id_source_target_rel_class_key
      UNIQUE (account_id, source, target, rel, class);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS topology_edges_class_source_idx ON topology_edges (account_id, class, source);
