# Topology readability

The November 10 screenshots show unreadable whole-inventory canvases, repeated
workload context, a trace-only service map, and text bars in a time-series table.
This change uses the existing React Flow and chart components. It changes display
selection, not resource ownership, collection permissions, or evidence admission.

- Separate application calls from infrastructure configuration in the copy and
  links. Keep collection warnings and host/member limitations visible.
- Show a service overview with optional workload context, explicit service focus,
  search, and original metadata in a detail panel. Never merge like-named services
  from different telemetry scopes.
- Offer entry-point and VPC selection before expanding large inventory graphs.
  Follow upstream and downstream paths separately; a shared gateway or database
  must not expand every sibling path.
- Refit asynchronous/resized canvases without remounting them. Preserve full-map
  access and expose what the selected view leaves out.
- Bound selected service displays to 350 nodes and 700 edges, retaining connection
  endpoints before optional isolated nodes. Report omitted nodes/edges separately
  from collection completeness. Cards retain environment, broker and source scope;
  queue detail claims keep their unverified-identity disclosure.
- Search fleet network resources without losing parent containers or connection
  counterparts. Place regional Transit Gateway hubs above VPC cards and route
  attachment lines behind labels.
- Add charts only to completed, explicit time-series tables with numeric metrics.
  Keep original values/table, missing samples, units, and partial-row markers.
  Do not interpret arbitrary IDs or text bars as metric values.
  Reject status-code columns and ambiguous leading-zero comma groups; disclose
  eligible metric columns omitted by the four-chart limit in the source table.

Verification: targeted Vitest graph/page/markdown regressions, production web
build, and mocked browser fixtures at desktop and narrow widths. Local checks make no AWS calls and perform no account onboarding,
instrumentation, or feature activation. Integration uses the required PR checks
and the existing guarded dev web release workflow.

## Collection limitations

The trace graph represents service calls and metric-derived dependencies, not an
IGW-to-database network route. The existing request-flow page retrieves EKS Pod
ownership only for the host account. A member-account request map therefore
cannot establish Pod ownership from registration alone. These collection
limitations are exposed in the UI; this display change does not extend collectors
or create connections without evidence.

## Local verification

The final branch includes the latest dev whole-window trace aggregation change.
Local validation uses Node 24.22.1; Merge Verify validates the locked dependencies
under the project's Node 26 CI runtime before integration.

- After the shared-toolbar and service-identity fixes, the full web suite passed:
  375 suites, 5,747 tests; the existing four suites
  and 279 tests remained skipped.

- 17 targeted Vitest suites passed with 315 tests. After the regional hub layout
  change, the three network layout/topology/renderer suites passed with 35 tests
  (the renderer suite overlaps the first run).
- `npm run build` passed compilation, application type checking, and generation
  of all 38 static pages. This worktree reuses locked dependencies through a local
  symlink; 27 files outside the tracing root were omitted from its standalone
  output. This local artifact is not proof of a deployable container image.
- Browser fixtures intercept all `/api/**` requests. They exercise service focus,
  workload expansion, empty search, entry-point/VPC selection, sibling-path
  isolation, network filtering, metric charts and source-table switching at
  1440, 768 and 390 pixels, plus desktop/mobile resizing after asynchronous load.
  All 10 browser tests passed again after the shared-toolbar and service-identity
  fixes. The graph rebuild timer is
  disabled for the local server. The captured PNGs and browser JSON report are
  retained under `~/.tmp/topology-readability-20261110/`.
- Review was limited to the local diff and regression/browser checks. No
  independent subagent was started because this host exposes no `close_agent`
  operation and the user's lifecycle rule requires closing every new agent.
  Independent PR review remains required before integration.
- The first required PR review identified shared Kubernetes toolbar and scoped
  service-card regressions. Their fixes, graph limits, fleet-only filtering and
  numeric-table integrity checks passed seven targeted suites with 33 tests.
  The production build, full web suite and all browser fixtures also passed before
  committing those fixes.
- Subsequent review confirmed numeric `Account` values could match `count` inside
  the header. English metric words now require word boundaries. A focused parser
  regression rejects identifier substrings while preserving real count/rate
  columns. The parser, Markdown and translation suites passed 17 tests after
  this correction. Integration still requires checks and review on the final HEAD.
- To reproduce local screenshot capture, set `AWSOPS_TOPOLOGY_ARTIFACTS` to a
  writable artifact directory when running `topology-readability.spec.ts`.
  The fixtures assert every intercepted API request uses GET.
