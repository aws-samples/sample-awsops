"""Deterministic EoG controller: owns graph traversal + aggregation. The LLM (via `label`)
only labels individual nodes; it never drives control flow (ADR: EoG, ~7x ReAct, auditable)."""
from rca.graph import neighbors

def run_rca(failing_entity, edges, gather_evidence, label):
    order = [failing_entity] + neighbors(failing_entity, edges)
    nodes, root_causes = [], []
    for node_id in order:                       # 1-hop, each node exactly once (Stage 3)
        evidence = gather_evidence(node_id)
        verdict = label(node_id, evidence)
        nodes.append({"node": node_id, "label": verdict["label"], "rationale": verdict["rationale"]})
        if verdict["label"] == "cause":
            root_causes.append(node_id)
    return {"failing_entity": failing_entity, "nodes": nodes, "root_causes": root_causes}
