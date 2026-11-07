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
alone does not grant the worker permission to assume a role. Missing or empty
ExternalId values are rejected before STS, including for same-org members. The
target trust policy must include the host worker role and the same ExternalId;
see [member onboarding](../runbooks/onboard-target-account.md#prerequisites).

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
rotates across resource types, with up to 180 initial resources and a total cap of
200, reserving space for trace identities and live proxies. The graph reader
prioritizes selected-resource neighborhoods across graph classes, bounded to two
hops, 20 neighbors per expansion, 600 nodes and 400 edges. Caps and missing types
remain visible; the graph is not a claim of complete discovery.

| Evidence | Admission | Meaning and limit |
| --- | --- | --- |
| Configured dependency | Scoped inventory/graph identifiers; exact RDS Proxy target ARN and qualified cluster members | Configuration, not a successful request |
| DNS resolution | Fresh qualified compute IP/VPC, timestamped Resolver row, unique scoped DB endpoint | A name was resolved; no trustworthy TTL is assumed |
| Network observation | DNS/IP candidate plus compatible NFM contributor, VPC/region/native identity and port when known | Partial, undirected window correlation; no per-flow timestamp or successful SQL claim |
| Application call | Existing same-trace/span identifier admission | Stronger request evidence, kept separate from configuration and traffic |

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
