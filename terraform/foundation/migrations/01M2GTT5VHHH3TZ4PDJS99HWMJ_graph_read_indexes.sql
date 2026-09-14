-- since: 0.9.0
-- Support bounded class-wide / __all__ reads without sorting raw metadata.
CREATE INDEX IF NOT EXISTS topology_nodes_class_read_idx
  ON topology_nodes (class, id, captured_at DESC);
CREATE INDEX IF NOT EXISTS topology_edges_class_read_idx
  ON topology_edges (class, source, target, rel, captured_at DESC);
