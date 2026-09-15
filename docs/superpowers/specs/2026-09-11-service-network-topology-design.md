# Service and network topology

## Purpose

Combine the existing front-door topology, saved service observations and Network Flow Monitor (NFM) traffic in an opt-in topology view. Correlate corroborated identities without claiming that independent observations represent one traced request.

## User flow

- `/topology?view=e2e` opts into Service + Network; the default configuration view remains available.
- Select one monitor, one metric, a 15/30/60-minute window and one/all seven destination categories. At most three category requests run concurrently, only after an explicit query.
- Load configuration and saved services independently. Missing, failed or partially failed NFM data must not erase other layers.
- Search, select nodes and filter evidence to focus the graph. Details expose local/remote endpoints, ports, metric/unit, observation windows, SNAT/DNAT, unordered traversed constructs and connection evidence.
- Link the integrated view from topology, service map and Network Flow.

## Data contract

Reuse the current topology inventory loader, `/api/graph?class=trace`, `/api/nfm` and `/api/nfm/query`. No new API, AWS resource, permission, schema migration or dependency. Preserve original cached query windows and source collection/read quality.

Namespace nodes by source. Separate configuration, service, network, identity and context edges. Preserve configuration/service direction; NFM local/remote observations do not establish request direction. Each connection node owns its aggregate metric, never a fabricated per-hop measurement.

Traversed constructs provide unordered context. NAT aliases are displayed, never identity keys. Shared NAT/TGW context must not make unrelated services reachable during focus traversal.

## Identity correlation

- Combine observations only for the host `self` scope. Member/all-account views show configuration and disclose unsupported observation scope.
- Always evaluate identity against the complete loaded account-scoped inventory. Default-view entry/cluster filters cannot remove competing or blocked candidates. E2E search/focus/evidence filters apply after correlation.
- Require exact target IP/instance ID and corroborated region/VPC. Missing/conflicting scope or multiple candidates leave identities unlinked.
- Never join application and Kubernetes services by name alone. Workload links require corroborated cluster/namespace/Pod tuples and compatible explicit service account/region claims.
- Monitor-derived cluster names are hints only, for both local and remote endpoints.
- Keep unproven DNS/IP, database and managed-service associations separate.

## Bounds and failures

NFM returns top contributors, not all traffic; service graphs are saved samples. Distinguish empty, unconfigured, failed, partial, stale, retained and capped sources. Missing evidence does not prove idle resources.

Apply search/focus/evidence eligibility before the 350-node/700-edge display bound. Reserve queried connection endpoints before optional identity context, drop dangling edges and disclose omissions. Source truncation is separate from display bounds.

Abort or ignore obsolete responses on scope changes and refreshes. Unapplied controls cannot relabel existing results. Retained/in-flight or incomplete inventory cannot promote identity. Preserve canvas preferences across queries.

## Verification

Pure tests cover source separation, conflicting/unknown scope, duplicate identities, monitor-name rejection, Pod corroboration, unordered/NAT context, stable IDs and bounded selection. Client tests cover independent sources, safe auth/error envelopes, three-lane requests, partial/cached windows, account/query races and preference retention.

Production browser fixtures cover front-door/workload/network correlation, metric/detail interactions, source failures, large graphs, account boundaries, history and desktop/mobile layout. Fixtures do not establish live AWS collection completeness.

Related decisions: ADR-005 read-only posture and ADR-007 governed external data; bodies remain in the private upstream repository.
