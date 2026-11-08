# Managed Service Discovery Implementation Plan

**Goal:** Add bounded Application Signals discovery to the existing read-only
six-pillar diagnosis; retain the Omni adapter inactive until credential scope is
verified.

**Architecture:** Extend the worker evidence bundle through verified host/member
sessions and existing inventory, DNS, trace and network-flow qualification.
No web-path collection, instrumentation, service activation, grants, graph database
or deployment is included. Python and the locked boto3 SDK use existing dependencies.

## Omni activation decision (2026-11-08)

Review confirmed that a space UUID map and region-conditioned wildcard IAM do not
constrain credential vending to reviewed read-only spaces. STS account verification
and prose grant preflight cannot prove effective read-only privileges. Therefore:

- Public `collect(bundle, budget, regions, *, client_factory)` calls Signals only.
- `diagnosis_omni_spaces` must remain empty; Terraform rejects host and member maps.
- No Omni environment wiring or credential-vending IAM permission is shipped.
- `_omni` remains private, exercised directly by simulated and locked-SDK tests.
- A separately reviewed release must prove enforceable read-only per-space scope
  and explicit member authorization before adding an activation path. No new IAM
  condition, operator override or private ADR number is invented here.

## Constraints

- `diagnosis_managed_discovery_enabled` defaults off and requires the evidence loop.
- Existing registered member roles, ExternalId and identity checks remain mandatory.
- Three pages per operation, 16 requests and 40 nodes per provider/region; Omni
  adapter fan-out is at most 50 edges. Every page request checks that the remaining
  analysis budget exceeds the client connect-plus-read timeout. Deadline stops
  disqualify prior batch rows and do not masquerade as empty results.
- Overall caps remain 200 resources, 400 relationships, 1,200 evidence rows and
  192 KiB. When managed discovery is enabled, its 20 logical slots are separate
  from the 20 native proxy/trace reserve and 40 X-Ray slots; inventory has 120 slots.
  Default-off inventory retains 140 slots. Managed evidence is evicted first.
- Batch failures disqualify prior rows; isolated invalid identities/edges are
  skipped with gaps. Empty/partial results cannot prove absence or justify sizing.
- Service membership and hostname aliases are configuration, not native calls.
  Typed explicit identifiers must agree; shared telemetry is not corroboration.

## Implementation and verification

- [x] Add bounded Signals and private Omni adapters, typed native joins, provider
  coverage projection and shared-telemetry prompt rules.
- [x] Keep optional collector errors from discarding native evidence; remove
  relationships through their disqualified evidence IDs.
- [x] Keep valid rows on isolated partials; preserve batch-wide cap/error handling.
- [x] Reserve managed resource capacity separately and retain native eviction priority.
- [x] Enforce the Omni activation hold in production code, Terraform and docs.
- [x] Verify the final delta: diagnosis/runtime policy/Terraform read tests
  passed (1,434 tests, 194 subtests; 36 pre-existing skips), including 82 managed
  adapter tests. Terraform validation and all 52 mocked runtime IAM tests passed.
- [ ] Require both configured AI reviewers and required checks on the latest PR
  HEAD before reporting review completion. Review feedback is applied through the
  guarded fix pipeline; publication is regular PR, not draft. No merge/deploy is
  authorized by the autofix invocation.
