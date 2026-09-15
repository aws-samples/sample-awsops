# Complete Service and Network Topology

> **For agentic workers:** Use superpowers:subagent-driven-development task by task, with failing regressions before fixes and scoped review before integration.

**Goal:** Complete draft samples PR #44, including its service/network correlation view, truthful evidence states, browser QA, complete latest-HEAD AI review and merge to dev.

**Architecture:** Reuse the current configuration loader, authenticated graph/NFM APIs and pure namespaced correlation engine. Separate engine/view selection from source acquisition and React rendering. Preserve current dev's account, inventory and graph-read protections.

**Tech Stack:** Existing Next.js 14, React 18, TypeScript, React Flow/Dagre, Vitest and Playwright; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-service-network-topology-design.md`, with the completion rulings below.

## Global Constraints

- `/topology?view=e2e` opts in; the current default topology remains available.
- No new AWS resource, permission, API route or schema migration. NFM queries run only on an explicit user action, using existing endpoints and at most three concurrent categories.
- Host observations never overlay member/all-account views. Service names, NAT aliases and a monitor-name prefix do not prove resource identity.
- Require corroborated region/VPC/endpoint and workload identity. Conflicts remain unlinked and disclosed; cross-source links are correlations, not a traced request.
- Display at most 350 nodes/700 edges. Query/focus/filter eligibility precedes bounds; observation connections and their endpoints must not be starved by configuration insertion order.
- Preserve cached query windows and source capture/collection/read-quality state. Failures are not empty success. Unknown/partial coverage stays visible.
- Keep all required CI and latest-HEAD complete AI review. Split independently reviewable engine and UI work to stay below the repository's 3,000-line review bound.
- Existing user instructions authorize implementation, commits, pushes and conditional merge. Browser fixtures do not prove live AWS collection.

## Completion Rulings

- The existing design is approved by the user's request to complete #44. Finish that scope rather than designing a new topology product.
- Monitor-derived cluster names are hints only. Workload correlation requires configured endpoint evidence corroborating cluster/namespace/pod; losing an unproven link is preferable to a false attribution.
- Reuse current dev's common files. Do not restore old inventory/page/graph-read implementations from the draft over merged fixes.
- #100 is merged. Evaluate #69 against current dev as the inventory-consistency prerequisite; retry its confirmed base-image false finding with exact-HEAD evidence, without waiving required review. #97's unpublished writer is not needed to read existing trace snapshots.
- Stable network IDs reflect the observation/endpoint identity rather than only list position. Source refresh must not silently retarget a selected node.
- Use Playwright because the Browser plugin/browser skill is not available. Keep screenshots and run logs in the task cache outside tracked source.

## Task 1: Complete the independent correlation engine

**Files:** `web/lib/e2e-topology-types.ts`, `e2e-topology.ts`, `e2e-topology.test.ts` in the core worktree.
**Consumes:** existing `FlowGraph`, NFM types, `E2eInput`/`E2eSelection` from the preserved draft.
**Produces:** `buildE2eGraph`, `selectE2eGraph` and a shared pure eligibility/search helper for the canvas. Keep source modules browser-safe through type-only NFM imports.

- [ ] Preserve the draft implementation and run its 48 baseline tests on current dev.
- [ ] Add and observe failing regressions: 1,000 configuration nodes cannot hide a queried connection under a 350-node cap; explicit focus/query hits win the cap; every visible edge has visible endpoints; disabling a selected layer cannot blank unrelated enabled evidence.
- [ ] Add rejection tests for monitor-name-only workload matches and contradictory pod identities, including grouped target members. Keep exact scoped target matches, NAT non-identity and non-transitive shared construct tests.
- [ ] Give observation groups and selected/query nodes stable priority without dropping loaded data. Reuse one filter/search rule across view selection and UI search, with harmless cyclic metadata.
- [ ] Verify stable flow identity across row reordering and distinct identities across changed endpoints/windows; keep metadata/source arrays unmutated.
- [ ] Run `cd web && npx vitest run lib/e2e-topology.test.ts`, review the immutable patch, and integrate the engine through a small prerequisite PR.

## Task 2: Integrate current inventory and source contracts

**Files:** current `web/app/topology/page.tsx` and tests; `web/components/topology/ServiceNetworkTopology.tsx` and tests; existing `topology-observations`/`nfm` only if current contracts require a fix.
**Consumes:** the completed engine and current dev's account/configuration loader and graph-read envelope.
**Produces:** source-isolated `E2eInput`, truthful source panels and explicit-query state.

- [ ] Merge current dev into the preserved draft; retain current common-file implementations and port only the opt-in view/entry points. Preserve account restoration and response-generation protections.
- [ ] Test strict `class=trace` and `account=self`, safe auth/failure envelopes, empty/partial/stale/retained snapshots and propagation of the current collection panel contract.
- [ ] Keep NFM status and trace reads independent. Mixed category failures preserve successful observations, three-lane bounds and original applied windows.
- [ ] Guard account/monitor/query races; changing an unapplied control must not relabel an old result. Refresh should preserve evidence/overview preferences.
- [ ] Use fixed user-facing errors and existing auth affordances; do not render raw SDK/server error bodies.

## Task 3: Complete the interactive canvas and user documentation

**Files:** `E2eGraphCanvas.tsx` and tests; opt-in links in network-flow/services pages; i18n terms; four topology user-guide locales; relevant module contexts and the existing changelog feature entry.
**Consumes:** the pure eligibility/search/view rules, `E2eGraph` and current source state.
**Produces:** bounded, navigable evidence with consistent search, filters and details.

- [ ] Add failing UI cases for hidden selection, filtered search, new result identity, cyclic metadata, malformed traversed fields and non-finite/negative metric values.
- [ ] Clear invalid selection, respect active evidence in details and search, preserve preferences across queries, and avoid fitting a detached React Flow instance.
- [ ] Display observed versus inferred confidence, local/remote versus request direction, query/capture windows and unordered traversed context. Clamp invalid metrics to unavailable rather than NaN/Infinity.
- [ ] Use existing dynamic imports and component styles; document opt-in navigation, source limits, explicit queries, empty/failure/partial states and account boundaries in ko/en/ja/zh.
- [ ] Keep screenshots outside source unless needed for user docs, and redact real account/ARN data before any committed screenshots.

## Task 4: Final verification and PR completion

**Files:** `web/e2e/service-network-topology.spec.ts`, current tests and review artifacts in the task cache.

- [ ] Run affected unit tests, full `npx vitest run` and `npm run build` in `web/`.
- [ ] Run the production standalone browser fixtures on desktop and mobile: route -> explicit query -> observed connection -> detail -> metric change -> repeat; filters/search/overview; failed categories; empty source; account and late-response races; navigation/back history; large configuration graph.
- [ ] Inspect screenshots/DOM for meaningful rendering, clipping/overflow and framework overlays; inspect console/page errors. Report fixtures separately from live AWS data.
- [ ] Perform an independent whole-change review. Fix verified Critical/Major findings, push and require fresh full AI review/CI for the latest HEAD.
- [ ] Mark #44 ready only when its remaining diff is complete/reviewable. Confirm prerequisites, target branch and reviewed HEAD before merging. Observe the normal dev deployment and its required checks.
