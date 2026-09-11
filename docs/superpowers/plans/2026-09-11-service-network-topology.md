# Service and Network Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 토폴로지에 서비스 관측과 NFM 트래픽을 연결한 근거 기반 보기를 제공한다. / Deliver an evidence-aware service/network topology.

**Architecture:** Reuse existing configuration, materialized service, and NFM APIs. Compose a pure graph; keep data acquisition, identity matching, and React rendering separate.

**Tech Stack:** Existing Next.js 14, React 18, TypeScript, React Flow, Dagre, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-11-service-network-topology-design.md`

## Global Constraints

- No new dependencies, API routes, AWS permissions/resources, or database migrations.
- Observation integration is opt-in at `/topology?view=e2e`; no NFM query until the user requests it.
- Host account observations only; never overlay them on another account.
- NFM windows: 900 / 1800 / 3600 seconds; at most 3 concurrent category queries.
- Display limits: 350 nodes / 700 edges; search and focus operate before bounding.
- User-facing strings use Korean literals through `tt`; components export default.
- Browser fixtures must be reported as fixture validation, not live telemetry verification.
- 구현 권한은 사용자의 통합 토폴로지 요청에서 이어진다. 배포·병합은 이 계획에 포함하지 않는다. / Implement the requested view; deployment and merge are separate actions.

### Task 1: Evidence graph and identity matching

**Files:** Create `web/lib/e2e-topology-types.ts`, `web/lib/e2e-topology.ts`, `web/lib/e2e-topology.test.ts`.

**Interfaces:** Types are defined in `e2e-topology-types.ts`. Export
`buildE2eGraph(input: E2eInput): E2eGraph` and
`selectE2eGraph(graph: E2eGraph, selection: E2eSelection): E2eView`.

- [ ] Write tests first. A representative rejection case:

```ts
const graph = buildE2eGraph({
  account: 'self', configured, services,
  network: [observationWithRemotePodInAnotherCluster],
});
expect(graph.edges.filter(e => e.evidence === 'identity'
  && e.meta?.match === 'monitor-cluster')).toHaveLength(0);
```

- [ ] Verify RED; implement namespaced nodes, configuration/service edges, nondirectional network connection nodes and unordered construct context.
- [ ] Correlate only unique, scoped identities. Config IP/instance matches require region and VPC context from the target's TG; workload matching requires exact cluster/namespace/pod. No NAT alias or service-name-only joins. Preserve unmatched and ambiguous counts.
- [ ] Implement search/focus before display bounding. Context edges never create transit reachability through a shared hop. Keep all loaded data in the base graph; cap only the returned view, with counts.
- [ ] Run `cd web && npx vitest run lib/e2e-topology.test.ts`.
- [ ] Review the task's spec compliance and correctness.

### Task 2: Observation fetching and freshness

**Files:** Create `web/lib/topology-observations.ts`, `web/lib/topology-observations.test.ts`; modify `web/lib/nfm.ts`, `web/lib/nfm.test.ts`.

**Interfaces:** `loadNetworkObservations(filters, monitor, options)` returns successful `NetworkObservation[]`, failed/capped categories, and applied filters. It accepts injected `fetch`, `AbortSignal`, and an optional progress callback. Client code imports NFM types only.

- [ ] Add failing NFM tests asserting `startTime`, `endTime`, `queriedAt`, `capped` exist and cache hits preserve the same timestamps.
- [ ] Add only these result fields to `NfmQueryResult`; preserve the original query, timeout, pagination, TTL, and credential behavior.
- [ ] Add fetch tests with real Response fixtures:

```ts
const result = await loadNetworkObservations(filters, monitor, { fetch: fakeFetch });
expect(maxConcurrent).toBeLessThanOrEqual(3);
expect(result.failedCategories).toEqual(['INTER_VPC']);
expect(result.observations).toHaveLength(6);
```

- [ ] Implement a three-worker queue over one/all category values. Check HTTP status and response shape; aborts stop scheduling additional requests. Never turn a failed category into a successful zero.
- [ ] Run `cd web && npx vitest run lib/nfm.test.ts lib/topology-observations.test.ts`.

### Task 3: Topology UI and entry points

**Files:** Create `web/components/topology/E2eGraphCanvas.tsx`, `web/components/topology/E2eGraphCanvas.test.tsx`, `web/components/topology/ServiceNetworkTopology.tsx`; modify `web/app/topology/page.tsx`, `web/app/topology/services/page.tsx`, `web/app/network-flow/page.tsx`, `web/lib/flow-layout.ts`.

**Interfaces:** The canvas consumes `E2eGraph`; the container receives the existing `FlowGraph`, account and configuration-source status. The container owns monitor/filter/source fetch state.

- [ ] Test empty, evidence filtering, search/focus and selected-node detail behavior.
- [ ] Dynamically load the new view only on opt-in. Reuse the existing topology inventory data; guard its account/request generations before passing it into correlation.
- [ ] Fetch NFM status and service snapshot independently for `self`. Provide explicit query controls and applied-result captions. Show unavailable/error/partial states independently.
- [ ] Render network flow values on connection nodes; show traversed constructs as contextual relations. Use glyphs and legends, not color alone. Support light/dark and responsive layout.
- [ ] Provide existing-page links to `/topology?view=e2e`, preserving monitor/metric/range when linking from Network Flow.
- [ ] Generalize Dagre's input type to node IDs and edge endpoints only if required; preserve layout behavior and tests.
- [ ] Run targeted React/Vitest tests and review spec compliance.

### Task 4: Browser and branch verification

**Files:** Add `web/e2e/service-network-topology.spec.ts`; amend the existing topology feature bullet in `CHANGELOG.md`, or add one per language if none covers this feature.

- [ ] Use fixtures for `/api/inventory/*`, `/api/eks`, `/api/graph`, `/api/nfm`, and `/api/nfm/query`; keep application authentication unchanged.
- [ ] Exercise `/topology?view=e2e` → query → select network connection → inspect metrics/NAT/constructs → change metric → query. Verify failed category and host-account boundaries.
- [ ] Capture desktop/mobile screenshots outside the repository, inspect them, check no page overflow/framework overlay/relevant console errors.
- [ ] Run full `npx vitest run` and `npm run build` in `web/`; record actual counts and source freshness limitations.
- [ ] Perform a broad branch review and correct actionable findings.
- [ ] Commit the isolated feature branch and make the code plus preview evidence reviewable.
