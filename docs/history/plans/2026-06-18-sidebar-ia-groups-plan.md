# Plan — Sidebar IA: collapsible inventory groups + group overview pages (Phase 1)

Branch `feat/sidebar-ia-groups` (worktree). WEB-ONLY, read-only. Consensus-gated (5/5 panel,
PASS after hardening). Right-sizing + recent-events AI summary = Phase 2 (placeholder slots only).

## Decisions (locked)
- Group ONLY `/inventory/*` types; the 10 FIXED feature links stay pinned/untouched.
- Group label click = navigate `/inventory/g/<slug>` overview AND expand; chevron = toggle only.
- Subgroups (ECS · Load Balancing · API Gateway) = collapsible (chevron toggle only, NO nav, NO route).
- Singleton groups (Monitoring) render flat: no chevron, no overview page.
- 43→~15 collapsed rows.

## Consensus fixes folded in
- navTree items are OBJECTS (carry EKS feature link: href `/eks`, no count) — not bare slugs.
- GROUPS = single bridge: slug ↔ display-group ↔ labelKey ↔ order/subgroupOrder ↔ singleton ↔ splitKeys.
- No type ever dropped: navTree derives a group's types from `inventoryGroups()`, orders by GROUPS, appends unknowns.
- `groupForPath()` resolver (covers `/inventory/<type>`, `/eks`, `/inventory/g/<slug>`) drives 2-level auto-expand.
- localStorage SSR-safe: deterministic initial state from `usePathname` (active group expanded on server) → hydrate localStorage in `useEffect` (try/catch). Active group re-seeds on path change; manual toggle persists.
- Collapsed subtrees are UNMOUNTED (leave tab order). chevron = real `<button type=button aria-expanded aria-controls>`; label = sibling `<Link>` (no nesting); `aria-current` on active.
- chevron toggle never calls `onNavigate` (mobile drawer stays open); only nav links do.
- split→group mapping pinned: Compute←ec2Running/Stopped · Storage&DB←ebsUnencrypted · Network←sgOpenIngress · Security←iamUserNoMfa · Monitoring←none. (`security_group` ∈ Network — verified.)
- `/inventory/g/[group]` = server wrapper → `notFound()` for unknown/singleton slug → client child fetches `/api/inventory/summary`.
- TYPE_ICON adds route53, target_group, s3_public_access (were Server fallback).
- `inventoryGroups()` UNCHANGED (returns all types incl. subgroup ones) → CommandPalette + mobile-tabs intact.
- Cmd-K gains 4 group-overview destinations; existing `/integrations` nav-contract test stays green.

## Tasks (TDD, per-task commit)
- [ ] T1 `web/lib/inventory-types.ts`: add `GROUPS`, `navTree()`, `groupForPath()`, `groupBySlug()`, `overviewGroups()`. Keep `inventoryGroups()` + `INVENTORY_TYPES` (31) unchanged. Tests in `inventory-types.test.ts`: navTree invariants (every type placed once; ECS/LB/APIGW subgroups; EKS injected feature; singleton Monitoring; slug↔group bridge; no reserved-slug collision; path resolver incl. /eks + /inventory/g).
- [ ] T2 `web/components/shell/Sidebar.tsx`: collapsible 2-level `<NavGroup>`/`<NavSubgroup>` from navTree; SSR-safe expand state + localStorage; auto-expand chain; unmount collapsed; a11y; TYPE_ICON + GROUP_ICON. FIXED untouched. Update `Sidebar.test.tsx` (keep nav-contract; add accordion source assertions).
- [ ] T3 `web/app/inventory/g/[group]/page.tsx` (server, notFound guard) + `GroupOverviewClient.tsx` (status band from summary splits + per-type tiles + Phase-2 placeholders). Test: valid renders tiles (mocked summary); unknown/singleton → notFound.
- [ ] T4 `web/components/shell/CommandPalette.tsx` (+4 overview cmds) + `web/lib/i18n.ts` (ko/en group/subgroup/overview/split keys).
- [ ] T5 `cd web && npm test` + `bash tests/run-all.sh` GREEN; `npx next build` type-check (app).
