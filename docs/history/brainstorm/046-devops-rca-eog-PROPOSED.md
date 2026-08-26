# ADR-046: DevOps RCA Incident Orchestrator — EoG execution model (RCA decision consolidation) / DevOps RCA 인시던트 오케스트레이터 — EoG 실행 모델 (RCA 결정 통합)

## Status / 상태

**Proposed (2026-06-20)** — owner-driven pivot, multi-AI panel (kimi·glm·antigravity) **unanimous PIVOT-TO-RCA-AGENT**. This ADR **consolidates the previously scattered RCA decision** into one record: the owner's Notion research ADRs (its own ADR-001~010, Proposed), the two brainstorm briefs (`docs/brainstorm/devops-rca-vs-plugin-registry-brief.md`, `plugin-platform-decision-brief.md`), the Stage-3 spec (`docs/superpowers/specs/2026-06-20-devops-rca-incident-orchestrator-stage3-design.md`), and the now-superseded plugin-registry spec. Acceptance is pending the Stage-3 plan + two open confirmations (orchestrator structure, first incident type).

오너 주도 피벗 + 멀티-AI 패널 만장일치. 흩어져 있던 RCA 결정(Notion 자체 ADR-001~10·브리프 2개·Stage-3 스펙·supersede된 레지스트리 스펙)을 **단일 ADR로 통합**한다. 확정은 Stage-3 플랜 + 두 열린 결정(오케스트레이터 구조·첫 인시던트 타입) 후.

### Relationship to existing ADRs / 기존 ADR 관계 (이 통합의 핵심)
- **Supersedes the *investigation mechanism* of ADR-032** — 032's multi-agent **Lead/Sub ReAct** orchestration is replaced by the **EoG pattern** (deterministic controller + LLM local reasoning). **RETAINED from 032**: the staged lifecycle state machine, Triage, the incident data model (`incidents`/`incident_stages`/`incident_findings`/`incident_links`), the read-only posture, `incident_lifecycle_enabled` flag-OFF, and the ADR-022 HMAC `/api/incidents/webhook` PUSH ingress. 032's abandoned autonomous-mitigation tier stays abandoned. / 032의 Lead/Sub ReAct 조사 메커니즘을 EoG로 승계; 라이프사이클·triage·데이터모델·read-only·flag·webhook은 유지.
- **Consolidates ADR-035** — K8sGPT read-only Result-CRD integration is the **rules-detect** layer (Notion ADR-001). Unchanged scope (GET-only, `k8sgpt_enabled` flag-OFF). / 035(k8sgpt read-only)를 rules-detect 레이어로 통합.
- **References ADR-034 as FROZEN / out-of-scope** — RCA write-back to OpsCenter/Incident Manager is NOT part of Stage 3. The RCA lands **locally** in `incidents.rca` only. 034 stays flag-OFF (still inherits the frozen 029/036 role; do-not-enable). / 034 writeback는 동결·비범위; RCA는 `incidents.rca`에 로컬 기록만.
- **References ADR-043** — Neptune is the **S2** service-graph substrate; **Stage 3 uses the existing `topology.ts` resource graph** for 1-hop neighbors (Neptune deferred). / 043 Neptune은 S2; Stage3는 기존 topology.
- **Supersedes the plugin-registry Phase-1 spec** — the panel found its primary consumer (current enumerate-style diagnosis) is architecturally superseded by the EoG controller; the plugin/manifest abstraction is **extracted later** from two real consumers (RCA + 8 gateways), not built speculatively now. / 레지스트리 스펙 supersede; 추상화는 나중에 추출.
- **Aligns with the 2026-06-11 reversal doctrine + ADR-041 keystone** — RCA is **read-only analysis** (resource-not-data read-only); S4 autonomous actions remain permanently frozen. / 번복 독트린·041 keystone 정합: read-only 분석, S4 동결.

## Context / 컨텍스트

The owner's north star is a **DevOps RCA agent** that wakes on alerts and produces read-only root-cause analysis — the **"1 incident orchestrator"** CLAUDE.md's design always reserved (8 section agents + 1 orchestrator). The decision basis is a research doc (its own ADR-001~010), grounded in: IBM ITBench (naive ReAct SRE agents solve only 11–14%), the EoG pattern (deterministic controller + LLM local reasoning, ~7× ReAct accuracy, reproducible/auditable — critical for FSI), RCACopilot (retrieval+in-context over fine-tuning), k8sgpt (rules-detect), and OTel signal-linking (exemplars/spanmetrics service-graph).

오너의 북극성 = 알림으로 깨어나 read-only RCA를 내는 **DevOps RCA 에이전트** = CLAUDE.md가 비워둔 **"1 인시던트 오케스트레이터"**. 근거: ITBench(naive ReAct 11~14%)·EoG(~7× 정확도·재현성·FSI 감사성)·RCACopilot·k8sgpt·OTel 신호연결.

A prior in-session brainstorm had drifted toward a generic **plugin platform / capability registry**. The multi-AI panel reframed it (internal unification > external interop) and then, when the RCA agent emerged as the concrete named goal, **unanimously pivoted**: the registry's consumer is superseded by the EoG controller, so registry-first risks throwaway and hits the "platform trap" (external interop is blocked by the ADR-031 BYO-MCP reversal anyway). A key discovery: **ADR-032/034/035 already define the incident data model, PUSH trigger, and stage machine** (all shipped flag-OFF, read-only-retained) — so the RCA agent is **not greenfield**; it lights up the existing read-only `investigation → root_cause` path with an EoG orchestrator over reused assets.

직전 브레인스토밍이 범용 플러그인 플랫폼으로 흘렀으나, 패널이 재프레임 후 RCA 에이전트가 구체 목표로 떠오르자 **만장일치 피벗**. 결정적 발견: **032/034/035가 이미 데이터모델·트리거·스테이지 머신을 정의**(flag-OFF, read-only 보존) → RCA는 맨바닥이 아니라 기존 read-only investigation→root_cause를 EoG로 점등.

## Decision / 결정 (consolidated)

**D1. EoG ⊂ AgentCore, orchestrating over the 8 section gateways (the "+1"; not a bare worker, not a gateway bypass).** The orchestrator is the **"1 incident orchestrator" over the 8 section gateways** (CLAUDE.md "8 section agents + 1 orchestrator"), hosted as a **new AgentCore entrypoint** (separate from the chat `agent.py`). It reuses the **existing gateway MCP + SigV4 fabric** (`agent.py`'s `create_gateway_transport` + `MCPClient`): bounded tools are a **curated bounded subset of the already-gateway-federated MCP tools** (`prometheus`/`tempo`/`loki` on monitoring, k8sgpt on container, reachability on network, topology/inventory on ops — all already `*-mcp-target`s), **NOT new direct-connector wrappers** that bypass the gateways. Unlike chat (one gateway, ReAct loop per invocation), the **deterministic controller traverses the graph and routes each node's bounded tool calls ACROSS the relevant section gateways, then aggregates** — this cross-gateway aggregation + the long-running incident session are exactly why **AgentCore Memory** is needed; dropping AgentCore slides the design to on-prem and breaks the AWS-native line (Notion ADR-007, in-VPC). AgentCore runs *our* code, and that code is a **deterministic controller**, not a ReAct loop. The controller logic stays unit-testable Python (gateway MCP calls mocked, as in `agent.py`). / 오케스트레이터 = 8 섹션 게이트웨이 위의 "+1". 기존 MCP+SigV4 fabric 재사용, bounded 툴 = 게이트웨이 페더레이션된 기존 MCP 툴의 큐레이션 서브셋(게이트웨이 우회 아님). 결정론 컨트롤러가 그래프 노드별로 여러 게이트웨이를 가로질러 호출·취합 → cross-gateway 취합·세션=AgentCore Memory.

**D2. Two execution paths, shared substrate.** Chat Router (Strands/AgentCore, interactive Q&A, 8 gateways — unchanged) + Incident Orchestrator (EoG, alert-driven RCA — new). RCA is **never** forced into a chat loop. / 두 실행 경로, substrate 공유.

**Consolidated principles (from Notion ADR-001~010, retained where reversal-compatible):**
1. **Rules detect, LLM explains** — k8sgpt analyzers + deterministic invariants detect "problem exists"; LLM only explains/labels (ADR-035). 
2. **PUSH trigger, never PULL** — an alert from a **registered alert-source integration** (AlertManager / Slack / Datadog / Grafana / generic) → ADR-022 HMAC webhook (`/api/incidents/webhook`) → `normalizeAlert` (multi-source, already exists) → Triage → enqueue (no polling). The alert's labeled entity (service/resource) seeds the EoG failing-entity. k8sgpt (ADR-035) is **one** rules-detect source, not the primary entry — the primary entry is the external alert integration. / 1차 진입 = 등록된 알림-소스 integration(AlertManager/Slack/Datadog 등)의 webhook 알림; k8sgpt는 rules-detect 소스 중 하나.
3. **EoG** — deterministic controller owns graph traversal/state/aggregation; LLM does **per-node "cause vs symptom" labeling only** (supersedes 032 Lead/Sub).
4. **Bounded-neighborhood tools** — failing entity + 1-hop neighbors; **no `get_all_*`** (context overload), but not over-narrow. Wrap existing connectors.
5. **Service/resource graph foundation** — Stage 3 = existing `topology.ts` 1-hop neighbors; **Neptune (ADR-043) deferred to S2** multi-hop belief-propagation.
6. **AgentCore in-VPC** host + Memory (D1).
7. **Identifier anonymization before every LLM call** — reuse `egress-dlp` (k8sgpt --anonymize pattern), **fail-closed** (no LLM call if anonymization fails) — FSI.
8. **read-only throughout** — S4 autonomous actions and ADR-034 RCA write-back stay frozen.

**Staging gates:** S1 OTel substrate = **customer-owned (out of scope)** · S2 deterministic detect = **gated on S3** proving tool boundaries · **S3 bounded-tool read-only "explain" = FIRST SLICE** · S4 autonomous action = **frozen (do-not-enable)**.

## Options Considered / 검토한 대안

- **Option 1 (chosen): consolidate into this ADR-046, EoG supersedes 032's mechanism, Stage-3-first read-only.** Single source of truth; reuses 032/034/035 scaffolding + connectors/topology/k8sgpt; reversal-compatible. 
- **Option 2 (rejected): generic plugin registry first.** Panel-unanimous reject — consumer superseded by EoG, platform-trap, registry-first risks throwaway.
- **Option 3 (rejected): keep 032's Lead/Sub ReAct orchestration.** Rejected — ITBench shows ReAct fails (11–14%); EoG is ~7× and auditable (FSI).
- **Option 4 (rejected): bare worker + direct Bedrock (drop AgentCore).** Rejected by owner — loses Memory/state + AWS-native line → on-prem drift.

## Consequences / 결과 · 리스크

- **Reuse map** (de-risks Stage 3): `topology.ts:buildTopology`→1-hop neighbors · connectors `loki_query_range`/`tempo_get_trace`/`prometheus_query_range`→bounded tools · `k8sgpt.ts:DiagnosisResult`→rules-detect · `incidents.rca`/`incident_findings`→persistence · `egress-dlp`→anonymization · `/api/incidents/webhook`→PUSH.
- **Critical gate (panel/kimi):** Stage 3 validates the existing topology graph gives adequate 1-hop neighbors; if not, escalate to a Neptune (ADR-043) spike — which would force reconsidering EoG's graph-dependent design (principles 4/5).
- **Two agent architectures** (chat ReAct + incident EoG) → maintenance/tool-shape divergence; mitigated by sharp D2 boundary + shared connectors.
- **Resolved (2026-06-20, owner):** (1) **orchestrator structure** = the AgentCore "+1" orchestrating over the existing 8 section gateways via the reused MCP+SigV4 fabric (D1) — deterministic controller logic in testable Python, gateway tool calls mocked in tests; NOT a gateway bypass. (2) **first incident entry** = an alert from a **registered alert-source integration** (AlertManager/Slack/Datadog/generic) via the existing `/api/incidents/webhook` + `normalizeAlert`; the first slice proves end-to-end with one concrete source (AlertManager — `normalizeAlertmanager` exists) and the registration generalizes to the others.
- **Implementation process (owner-set):** plan = Claude · P2 plan-review gate = Claude chair + panel · **code = Codex** (isolated worktree, per task) · P4 final review = Claude + panel.
- Built **flag-OFF**; read-only; no AWS-resource mutation on any path.
