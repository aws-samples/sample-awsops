# Diagnosis discovery and observation evidence

The optional diagnosis evidence loop supplies a common, admitted evidence index to
six Well-Architected specialists and a bounded cross-pillar review. It uses at most
two analysis passes. Report facts and numbers are rendered from that index rather
than reconstructed from model prose. Remediation remains an operator-reviewed
proposal; collectors do not modify workloads or install instrumentation.

## Activation and scope

All settings are in `terraform/foundation/`. `diagnosis_evidence_loop_enabled`
defaults to `false`. The additional `diagnosis_network_evidence_enabled` flag also
defaults to `false` and requires the evidence loop. It enables reads of existing
Resolver query-log configuration, explicitly approved DNS log groups, existing
Network Flow Monitor monitors and RDS Proxy configuration. It creates no monitors,
log groups, instrumentation, Neptune or ElastiCache resources.

`diagnosis_dns_log_group_arns` defaults to an empty list and accepts at most eight
host-account CloudWatch Logs group ARNs. Each queried group must also have a
created Resolver configuration and an active association with the selected VPC.
Runtime account, region, group association and row provenance checks apply in
addition to IAM. Network evidence is currently host-only; member reports disclose
that source limitation.

Member metrics and Compute Optimizer reads require an enabled non-host account
registration, its registered role and external ID, and an exact role ARN in
`diagnosis_member_role_arns` (empty by default, at most 32 entries; each must name the
onboarding `AWSopsReadOnlyRole`, so a privileged role cannot be allowlisted). The assumed
principal and its STS account must match. Any failed authorization or verification
leaves an explicit gap and makes no substitute host read. Account registration
alone does not grant the worker permission to assume a role. Per ADR-011 the
registered ExternalId is sent when present and may be omitted for first-party
members, whose trust pins the host worker role ARN; third-party members must
register the same ExternalId as their trust policy. The target trust policy must
include the host worker role; see [member onboarding](../runbooks/onboard-target-account.md#prerequisites).

## Managed discovery providers

`diagnosis_managed_discovery_enabled` defaults to `false` and requires the evidence
loop. It adds Application Signals and, when configured, CloudWatch Omni to the
Fargate diagnosis worker. It installs no instrumentation and creates no domain,
space, access grant or graph database. These providers extend the existing
DNS/inventory, X-Ray and Network Flow Monitor evidence; they do not establish
complete CloudFront-to-database coverage.

Application Signals reads `ListServices` and `ListServiceDependencies` over three
completed hours in the selected account and regions. Existing instrumentation and
the corresponding read permissions are prerequisites. Host reads exclude linked
accounts. Member reads use only the verified, registered member session; that
role also needs both Application Signals read actions. A metric reference's optional
account ID must match when present; its absence uses the verified session and
explicitly account-filtered service catalog. This collector does not retrieve
latency or error-rate metrics.

Service dependencies retain a logical service source. A unique native identifier
in service attributes can add a configured `RUNS_ON` relationship to its compute
resource, but that membership does not prove which instance made a service call.
An exact, unique DB identifier can bind the dependency target to qualified
inventory. A matching inventory DB hostname adds a configured `endpoint_alias`,
separately from timestamped Resolver DNS answers. Display names, shared tags and
aggregate service edges never produce instance-to-DB call fan-out.

`diagnosis_omni_spaces` defaults to `{}`. Its keys are `<account-id>/<region>` and
its values are existing space UUIDs, with at most 32 entries. Accounts must be the
host or explicitly allowlisted diagnosis members. For example:

```hcl
diagnosis_managed_discovery_enabled = true
diagnosis_omni_spaces = {
  "123456789012/us-east-1" = "12345678-1234-1234-1234-123456789abc"
}
```

Omni requires an existing organization space in the selected account and region.
The host worker principal must already have organization-management or delegated
administrator access and the space access needed for
`GetSpaceCredentialsForOrganization`. Terraform adds only that exact credential
read action, conditioned on configured space regions, when the map is nonempty.
It grants no space administration or general host-session graph access. The
returned `SPACE_OPERATION` credentials are held only in memory, checked for
expiration and verified with STS against the selected account, then used for
`GetContextGraph`. The existing space role and access grant must permit that read;
review their effective permissions separately and use a read-only grant. This
collector does not implement interactive sign-in for standalone-account spaces.
Missing or denied access records a gap/degraded source without another graph
credential path. Member registration and role verification still precede any
member-space read; the organization credential API is an explicit control-plane
path, not a substitute for failed member authorization.

Omni enumerates account/region-filtered nodes at depth zero, reading bounded pages
before resolving edges whose targets appear on a later page. Native resource
binding requires a unique identifier in fresh, complete inventory. Merged
`SERVICE` attributes do not prove native instance ownership of a call. Only
`CALLS` edges with telemetry, traces and a confirmed recent observation timestamp
become fresh application-call evidence. Policy, configuration, `ACCESSES` and
`RUNS_ON` edges remain configuration. Stale or missing-time trace edges remain
unqualified observations.

Each provider has a per-region limit of 16 requests, 40 nodes and three pages per
operation; Omni includes credential retrieval and STS in its request count and
limits node fan-out to 50 edges. At most 20 new logical managed resources share
the existing overall bundle limits and analysis deadline. Late caps, malformed
pages and read failures disqualify earlier evidence from the affected batch.
Empty results and missing targets stay visible. Coverage always discloses
`managed_discovery_not_exhaustive`; it cannot prove absent traffic or justify
right-sizing on its own. Application Signals, Omni telemetry and X-Ray can project
the same application telemetry, so specialists and the cross-pillar review must
not count them as independent corroboration.

## Model requirement

The specialist and review stages use the shared provider wrapper and accept only
Claude Sonnet 5.5 or Opus 5.5 model IDs (`anthropic.claude-*` without a geographic
prefix, or a supported `global.`, `us.`, `eu.`,
`au.` or Opus-only `jp.` inference profile). The diagnosis model comes from
`DIAGNOSIS_MODEL_SONNET` (Opus for deep tier when selected), which
[`model_provider`](../runbooks/model-provider.md) sets. With `bedrock_claude` or
`mixed`, the loop runs. With `bedrock_openai` (`global.openai.*`) or `anthropic_api`
(bare `claude-*` IDs over the Anthropic API), provider validation refuses the loop
before client creation or model-attempt allocation: the report
still renders discovery evidence and intended-vs-actual results, every pillar is
`failed`, and the summary records the degraded marker `analysis:model_provider_unsupported`
and the incomplete marker `six_pillars`, so the report is `partial`. The disabled
(legacy) diagnosis path keeps using the configured provider. An unsupported model
ID under a supported provider remains a distinct `analysis:unsupported_model`.

## Identity and connection strength

Resources and graph nodes retain account and region identity. Inventory sampling
rotates across resource types with up to 140 inventory resources. X-Ray service
nodes have a separate share of 40, and 20 more slots are reserved for trace
identities and live proxies, within the total cap of 200. The graph reader
prioritizes selected-resource neighborhoods across graph classes, bounded to two
hops, 20 neighbors per expansion, 600 nodes and 400 edges. Caps and missing types
remain visible; the graph is not a claim of complete discovery.
Hitting either graph read cap disqualifies completeness and freshness for the
requested graph classes and their emitted rows, even when the stored writer
metadata was qualified.

| Evidence | Admission | Meaning and limit |
| --- | --- | --- |
| Configured dependency | Scoped inventory/graph identifiers; exact RDS Proxy target ARN and qualified cluster members | Configuration, not a successful request |
| DNS resolution | Fresh qualified compute IP/VPC, timestamped Resolver row, unique scoped DB endpoint | A name was resolved; no trustworthy TTL is assumed |
| Network observation | DNS/IP candidate plus compatible NFM contributor, VPC/region/native identity and port when known | Partial, undirected window correlation; no per-flow timestamp or successful SQL claim |
| Application call | Exact same-trace/span pairs or qualified managed call edges in the disclosed window | Request evidence, separate from configuration and traffic; aggregate service edges do not identify an instance caller |

Single-resource metrics observations require the resource's own fresh, complete,
representative metrics and an exact code-owned collection statement in the report
locale. The English statement is "Metrics were collected for this resource in
the disclosed window." Arbitrary backup, security, configuration or other
qualitative assertions are downgraded to hypotheses, even when they cite valid
CPU metrics. Metrics do not establish those properties.

X-Ray checks raw page and per-service edge counts before clipping. Exceeding
those bounds records `xray_node_cap` or `xray_edge_cap`; all emitted X-Ray rows
in that region disclose incomplete coverage and are not fresh. Missing pages,
targets and bounded discovery remain explicit limitations.
The 40-resource X-Ray share applies across regions. Each region is qualified
against the remaining share before evidence is emitted; overflow records
`xray_resource_cap` and disqualifies that region. Reusing its existing scoped
X-Ray identities does not consume the share again.

NFM uses up to eight regions, two monitors, six top-contributor queries and 50 rows
per query. The current query window is five minutes and incomplete categories and
sampling are disclosed. Collectors check deadlines before SDK calls and polling.
DNS plus aggregated NFM evidence supports a **hypothesis**, not a definitive
instance-to-DB application call. Conflicting IP-to-endpoint bindings, translated
addresses and ambiguous owners do not establish a connection.

Running ECS task addresses require the recorded ENI attachment and a unique
same-region subnet-to-VPC binding from fresh, complete inventory evidence. An EC2
node identity or shared ENI does not prove ownership by a Pod, Lambda function or
ECS task. These inventory address fields support IPv4; DNS answers can also carry
IPv6. Validated addresses remain internal for correlation and both forms are
scrubbed before model calls. Capped attachment projections cannot prove a unique
owner. Unsupported ownership remains unresolved. Proxy targets are read in
bounded batches, and Aurora cluster members must match exact scoped inventory
identifiers and VPCs; unresolved members remain gaps.
An individual denied target read or deleted cluster records `proxy_target_unresolved`
and continues to the next target or proxy. A region's initial provider failure
records `proxy_configuration_unavailable`; shared deadlines and query caps still
stop the stage. In-scope proxies that are not available record `proxy_not_available`;
malformed names or account/region ARNs record `proxy_identity_unresolved`. Later
qualified proxies are still collected; rows outside the selected VPCs are excluded.
DNS projection admits up to eight regions' bounded query rows and
records `dns_projection_cap` if that producer bound is exceeded.

Missing or mismatched host identity skips all native supporting sources and
records both the gap and degraded marker `supporting_host_unknown`, so this
failure cannot produce a successful report. Member scope still skips these
host-only sources without using host credentials.

These rules preserve evidence strength along CloudFront, load-balancer, compute
and database paths. A configured path may be available when end-to-end request
instrumentation is absent. The report must disclose that difference rather than
claim the entire path was observed.

## Measured memory and right sizing

EC2 memory reads use the default Linux/macOS CloudWatch agent metric
`CWAgent/mem_used_percent`, preserving the actual dimensions. They use the same
14-day interval as native metrics and normalize hourly `Maximum` samples to
`MemoryUtilization.Maximum` in percent. Collection accepts up to eight resources
per batch and three pages per operation.

Qualification requires a unique instance-scoped series, valid unique hourly
samples, complete provider status, at least 90% of the 336 expected hours, no
leading/trailing gap over two hours and no continuous gap over six hours.
Missing, ambiguous, foreign, capped or invalid data keeps the memory veto in
place. CPU and Compute Optimizer recommendations do not substitute for measured
memory. Custom namespaces and Windows memory instrumentation are not supported
by this collector. Provider recommendations still pass the existing sizing
guards; a complete memory series alone does not authorize resizing.
Compute Optimizer recommendation coverage is complete only when the provider
snapshot is fresh and includes memory, both I/O directions and at least 14 days
of observation. Missing pressure dimensions, an unknown or shorter window, or
stale recommendations remain incomplete; the existing sizing vetoes still apply.

## Cache bounds and infrastructure choice

The existing web DNS and NFM query consumers use a local cache with a four-minute
TTL, 128 retained values and 32 active loads. Same-key requests share a load;
expiry, least-recently-used eviction, errors and invalidation preserve those
bounds. Returned observations retain their original source timestamps and query
windows. Cache access never refreshes evidence age.

Run `node scripts/v2/benchmark-observation-cache.mjs` with the project's Node
version for an offline synthetic measurement. With 2,000 requests over 32 repeated
keys, the checked fixture reduces loader calls from 2,000 to 32; 2,000 concurrent
same-key requests share one load. It uses a fake loader and makes no AWS calls.
Those counts do not establish production latency or shared-cache savings.

Aurora remains the graph store. Evaluate Neptune only after measuring graph size,
query depth and database cost. Evaluate ElastiCache only after measuring repeated
queries across replicas, hit rate, retained bytes, latency and invalidation needs.
Neither service is required by this change or provisioned by its flags.

## Implementation and verification

- Collection and identity: `scripts/v2/workers/diagnosis/discovery.py`,
  `memory_metrics.py`, `observations.py`, `workload_identities.py`,
  `scoped_clients.py`.
- Admission and analysis: `evidence.py`, `pillar_agents.py`, `loop.py`, `report.py`.
- Local cache: `web/lib/bounded-cache.ts`, `dns-logs.ts`, `nfm.ts`.
- Worker policy: `terraform/foundation/workers.tf`; provider mocks:
  `terraform/foundation/tests/runtime_iam.tftest.hcl`.
- Regression tests include offline SDK input validation, ambiguous identities,
  scoped credentials, memory coverage and real PostgreSQL selection fixtures.
  The latter use `AWSOPS_DISCOVERY_PG_PORT` for a dedicated local test database
  and create temporary tables only.

Related contracts: [worker backbone](06-workers.md),
[end-to-end topology](observability-e2e.md),
[diagnosis evaluation](../guides/diagnosis-evaluation.md).
