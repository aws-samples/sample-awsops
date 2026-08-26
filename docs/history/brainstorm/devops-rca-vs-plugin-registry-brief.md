# Decision: does the generic plugin-registry (current Phase 1) still make sense, given the owner's DevOps RCA agent vision?

## Background — AWSops today
Read-only AWS/K8s ops dashboard + AI diagnosis, regulated Korean FSI, AgentCore (Strands, ReAct-style chat loop) + 8 section gateways (~125 read-only MCP tools) + datasource connectors (Prometheus/Loki/Tempo/ClickHouse) + an existing "AI diagnosis" feature (a collector that gathers inventory/metrics → LLM writes a multi-section report) + ADR-035 k8sgpt read-only K8s diagnosis + ADR-043 Neptune graph substrate (option) + AgentCore in-VPC. Doctrine: AWS-resource mutation + autonomy permanently frozen; external data read/governed-write allowed under governance.

## Current Phase 1 plan (just spec'd, committed 93dd96c) — "internal plugin spine"
A read-model **capability registry** (Approach A): generate builtin manifests from agentcore catalog.py + merge sections.ts + integrations table into ONE registry; expose listCapabilities()/byDomain()/getDomainSummary(); wire the EXISTING AI diagnosis to enumerate capabilities hierarchically. Justified earlier (multi-AI panel) as "internal capability unification + AI visibility", with external MCP/A2A interop as deferred upside. Panel had warned of "platform trap — no customer asked".

## NEW input — the owner's DevOps RCA agent vision (Notion research doc, its OWN ADR-001..010, all "Proposed, pre-implementation"; NOT AWSops's ADR numbers)
An autonomous Root-Cause-Analysis agent on an OTel stack, woken by alerts, producing RCA reports. Core decisions:
- **ADR-001 Rules detect, LLM explains** (k8sgpt analyzers + anomaly/changepoint detect "problem exists"; LLM only explains/recommends). ReAct agents solved only 11-14% of SRE scenarios (IBM ITBench) → rejected.
- **ADR-002 PUSH trigger, never PULL** (AlertManager → lightweight router → agent wakes only on alert; ~100x cost difference).
- **ADR-003 Deterministic controller + LLM local reasoning (EoG pattern)** — a deterministic code controller OWNS graph traversal/state/belief-propagation; LLM does ONLY per-node evidence gathering + "cause vs symptom" labeling. ~7x accuracy vs ReAct, reproducible/auditable (FSI). NOTE: the doc explicitly CORRECTS an earlier design where "the LLM walked the decision tree itself".
- **ADR-004 Bounded-neighborhood tools** — tools return "failing entity + graph neighbors" (get_entity_neighbors, get_recent_deploys, get_exemplar_trace, get_error_logs_for_trace). NO get_all_* (context overload fails); but not too narrow either (over-constraint also fails). <4 entities explored → <20% success; >=8 → >60%.
- **ADR-005 Service dependency graph** is the foundation (spanmetrics service-graph / OBI). Without it, belief-propagation/neighbor-exploration impossible.
- **ADR-007 Bedrock AgentCore in-VPC** (matches AWSops). **ADR-010 identifier anonymization** before LLM (k8sgpt --anonymize).
- Staging: S1 connection substrate (OTel: exemplars/spanmetrics service-graph/trace_id-in-logs/k8sattributes — customer's collector config, NOT app code) → S2 deterministic detect + ~1KB incident digest → S3 narrow-tool PUSH agent (explain not detect, read-only) → S4 optional eBPF depth + approval-gated actions.

## Claude's re-examination thesis (UNDER REVIEW — pressure-test both sides)
The DevOps RCA agent's execution model (deterministic EoG controller over a service graph, bounded push-triggered tools, rules-detect) is **fundamentally different** from AWSops's current Strands ReAct chat AND from the current "collector → enumerate → LLM report" diagnosis. The generic plugin registry's primary consumer (the current diagnosis) would be **architecturally superseded** by the RCA agent — so registry-for-current-diagnosis risks being throwaway. This is product-first vs platform-first:
- PIVOT thesis: build/design the RCA agent FIRST (it is the concrete high-value product, fully read-only, aligned with the reversal doctrine), reusing AWSops's existing assets (datasource connectors = the OTel query tools; Neptune = service-graph substrate; k8sgpt = rules-detect; AgentCore in-VPC). Let the plugin/manifest abstraction be EXTRACTED later from two real consumers (RCA agent + 8 gateways), not designed speculatively now.
- KEEP thesis (steelman): the registry is light/low-risk, helps the current diagnosis regardless, and a tool registry helps any controller know which bounded tools exist; doing it doesn't preclude the RCA agent.

## Questions for the panel
1. Is the generic plugin registry (current Phase 1) on the critical path to the DevOps RCA agent, orthogonal to it, or an actual detour/throwaway? Be concrete.
2. Product-first (RCA agent) vs platform-first (registry): which is correct HERE, given (a) the panel's earlier platform-trap warning, (b) that the RCA agent is now a concrete named goal, (c) FSI/regulated reality?
3. The RCA agent is big (S1-S4). What is the SMALLEST high-value first slice that reuses AWSops's existing connectors/graph/k8sgpt and respects read-only? Is "Stage 2 deterministic detect + incident digest" or "Stage 3 bounded-tool read-only explain" the right entry?
4. Does EoG (deterministic controller + LLM local reasoning) require ABANDONING the current Strands/AgentCore ReAct chat for the RCA agent, or can they coexist (chat for Q&A, EoG controller for RCA)? Architectural implication for AWSops.
5. Biggest risk in the PIVOT, and biggest risk in NOT pivoting. What would make the registry worth doing first anyway?

Be concrete, cite the briefs. End with VERDICT: PIVOT-TO-RCA-AGENT / KEEP-REGISTRY-FIRST / HYBRID (+the single most important sequencing decision).
