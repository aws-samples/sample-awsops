# Topology redesign — request-flow graph (Spec 1: front-door)

**Date:** 2026-06-14
**Status:** Approved (brainstorm) — ready for implementation plan
**Branch:** `feat/v2-architecture-design`

## Problem

The current `/topology` page draws a **containment hierarchy** from synced inventory
(`buildTopology()`: VPC → Subnet → {EC2, RDS, ALB}). Operators find it low-value — it
shows "subnet then straight to EC2", clutters with every instance, and answers "what
contains what" rather than the question that matters in ops: **how does a request flow,
and what does each entry point depend on?**

## Desired end state (full vision)

A **request-flow graph**:

```
CloudFront → ALB/NLB → TargetGroup → {EKS pod | ECS task | EC2 | Lambda} → RDS
```

with per-CloudFront and per-LB filtering. The `→RDS` edge is **inferred** from the
workload's environment (EKS container env / ECS task-def env endpoint values matched
against `rds.endpoint_address`). OTEL/tracing is the ideal source for the true request
path but is **excluded this iteration** (drop if unavailable).

## Decision: incremental, 2 specs (Approach A)

Chosen via multi-AI consensus gate (2026-06-14) — **unanimous A** across Codex (gpt-5.5),
Gemini (3.1-pro), Kiro (opus-4.8), and Claude (chair). Rationale: fastest time-to-first-value
(one new sync turns the page into a real flow graph), smallest blast radius (syncs added
incrementally and validated against the proven synced-inventory pattern), consistency with
the existing Aurora-backed inventory architecture (vs Approach C's live per-page AgentCore
queries), and it quarantines the weakest, lowest-confidence piece (env→RDS inference) into
Spec 2 so the honest, high-confidence graph ships first.

- **Spec 1 (this doc):** front-door flow graph — `CF → ALB/NLB → TargetGroup → raw targets`
  (instance / IP / lambda) + CF/LB filtering + theme-aware render. Ships immediately.
- **Spec 2 (separate, later):** backend resolution + DB inference — match TG target IPs to
  EKS pod IPs / ECS task ENIs, group into workloads (Deployment/Service, ECS Service); parse
  EKS + ECS env to infer `→RDS` edges.

### Panel-surfaced guardrails (folded into this design)

1. **Inferred edges ≠ observed edges.** Establish an edge-style convention now: **solid =
   observed/resolved**, **dashed = inferred/best-effort**. Spec 1 emits only solid edges; the
   convention exists so Spec 2's `→RDS` inference renders as visibly low-confidence and is
   never given the same authority as resolved edges.
2. **Batch-sync staleness.** Dynamic targets (pod / ENI IPs) drift between sync runs. The page
   must surface the inventory **sync timestamp** and tolerate **orphaned targets** (a TG target
   whose endpoint no longer resolves to a known node) without breaking the graph.

## Scope (Spec 1)

**In:** target_group inventory sync; new flow-graph builder; CF/ALB/NLB/TG/raw-target nodes
and edges; entry-point (CF / LB) filtering; theme-aware React Flow render with target health
coloring; tests.

**Out (Spec 2+):** EKS/ECS workload grouping, TG-target-IP↔pod/ENI matching, env→RDS DB
inference, OTEL service map, listener-level routing rules, EKS-internal topology depth.

## Design

### 1. Data layer — add `target_group` inventory type

Follow the existing inventory registry pattern; no schema migration (inventory rows are
generic `{ resource_id, region, ...payload }`).

- **`scripts/v2/steampipe/sync_lambda.py`** — add a `target_group` query against
  `aws_ec2_target_group`, selecting: `target_group_arn` (→ resource_id), `target_group_name`,
  `region`, `account_id`, `target_type` (instance|ip|lambda|alb), `vpc_id`, `protocol`, `port`,
  `load_balancer_arns` (jsonb — TG→LB link), `target_health_descriptions` (jsonb — each entry's
  target id/IP/port + health state).
- **`web/lib/inventory-types.ts`** — register `target_group` (label, group, icon) so it appears
  in inventory nav and `/api/inventory/target_group` resolves. Update
  `inventory-types.test.ts` count/expectations accordingly.
- No new Terraform beyond the sync code (steampipe sync is `steampipe_enabled`-gated already).

### 2. Graph builder — `web/lib/flow-topology.ts` (new; leaves `topology.ts` untouched)

Pure, React-Flow-independent, mirrors `buildTopology`'s style (node dedup, no dangling edges).

- **Types:** `FlowKind = 'cloudfront' | 'alb' | 'nlb' | 'tg' | 'target' | 'waf'`;
  `FlowNode { id, kind, label, meta? }`; `FlowEdge { id, source, target, confidence: 'observed' }`
  (confidence field present now for the guardrail-1 convention; Spec 2 adds `'inferred'`);
  `FlowGraph { nodes, edges }`.
- **Input:** `{ cloudfront?, alb?, nlb?, tg?, waf? }` row arrays (flattened inventory rows).
- **Edges:**
  - `CF → ALB/NLB`: for each cloudfront origin domain, match against `alb.dns_name` /
    `nlb.dns_name` (case-insensitive, suffix-tolerant). Origins live in `cloudfront.origins`
    (jsonb array of `{ domain_name, ... }`).
  - `CF → WAF`: `cloudfront.web_acl_id` → waf node.
  - `ALB/NLB → TG`: `tg.load_balancer_arns` contains the LB arn.
  - `TG → target`: one target node per entry in `tg.target_health_descriptions`
    (`target.id` is an instance-id, IP, or lambda arn depending on `tg.target_type`); node
    carries health state in `meta`.
- **Noise control:** no VPC/subnet/per-instance containment. Targets are raw this iteration
  (kind `'target'` + `target_type` + health), not yet grouped into workloads.
- **Orphan tolerance (guardrail 2):** a TG with zero resolvable targets still renders (shows
  "no healthy targets"); a target with an unparseable id renders as a generic target node
  rather than being dropped silently.

### 3. Filtering UI

- **Entry-point selector** in the `PageHeader` right slot: two dropdowns — *CloudFront
  distribution* and *Load balancer*. Selecting one filters the graph to that entry point's
  reachable subtree (BFS from the selected node over outgoing edges). None selected = full graph.
- Selection is client-side over the already-fetched graph (no refetch).

### 4. Rendering

- Reuse the theme-aware React Flow wiring shipped earlier (`colorMode` bound to `useTheme()`,
  dark-tuned node styles). Node fill keyed by `FlowKind`; **target nodes colored by health**
  (healthy / unhealthy / draining / unused) using the existing semantic tokens.
- **Edge-style convention:** solid stroke = observed (all Spec 1 edges). The renderer reads
  `edge.confidence` so Spec 2 can switch inferred edges to dashed + low-confidence styling with
  no renderer rewrite.
- Show the inventory **sync timestamp** near the header (guardrail 2) so operators know freshness.

### 5. Testing

`web/lib/flow-topology.test.ts` (pure, no React):
- CF origin domain ↔ ALB `dns_name` matching (exact + case-insensitive); non-matching origin
  produces no edge.
- `ALB → TG` via `load_balancer_arns`; `TG → target` fan-out from `target_health_descriptions`.
- No dangling edges (both endpoints must be real nodes); node dedup.
- Entry-point filter returns only the reachable subtree.
- Orphan tolerance: TG with empty/garbage targets still yields a node, never throws.

Update `web/lib/inventory-types.test.ts` for the new `target_group` type.

## Components & boundaries

| Unit | Purpose | Depends on |
|---|---|---|
| `sync_lambda.py` (+target_group) | sync TG rows into Aurora inventory | Steampipe, `aws_ec2_target_group` |
| `inventory-types.ts` (+target_group) | register type for nav + `/api/inventory` | — |
| `lib/flow-topology.ts` | pure CF→LB→TG→target graph builder | inventory row shapes only |
| `app/topology/page.tsx` | fetch types, build graph, filter UI, render | `flow-topology`, `useTheme`, React Flow |

`buildTopology()` / `lib/topology.ts` stays in place (not deleted) until the flow graph fully
replaces it in the page; the page swaps to `buildFlowGraph()` and drops the old fetch set.

## Risks

- **CF origin ↔ ALB matching** can miss when CloudFront fronts an ALB via a custom domain /
  Route53 alias rather than the raw `*.elb.amazonaws.com` `dns_name`. Mitigation: match on both
  raw `dns_name` and any known aliases; unmatched origins render as standalone origin nodes
  (honest "external/unresolved origin") rather than being hidden.
- **Sync staleness** for IP/instance targets (guardrail 2) — surfaced via timestamp + orphan
  tolerance, fully resolved only in Spec 2 where dynamic IPs are matched live-ish.
- **target_health_descriptions volume** on large TGs — cap rendered targets per TG (e.g. top N
  by health-state) with an explicit "+N more" node; never silently truncate (log/label the cap).
