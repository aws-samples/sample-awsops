# Discovery observations and graph coverage

## Intent and authorization

The owner approved implementing the discovery, graph and cache improvement
checklist on 2026-11-05. The existing six-pillar evidence-loop design remains
binding: `2026-11-04-diagnosis-discovery-pillars-design.md`.

Improve the evidence connecting configured CloudFront/LB/target/compute paths to
database dependencies. DNS resolution, observed network traffic and application
calls are separate facts. None alone proves an end-to-end successful request.

## Constraints

- Read-only AWS access; no infrastructure apply, deployment, source publication,
  instrumentation installation or autonomous remediation.
- Keep the evidence loop default off. New billed DNS/NFM reads need a separate
  default-off worker gate dependent on the evidence-loop gate.
- Keep Aurora as the authoritative materialized graph. Do not provision Neptune
  or ElastiCache before production query measurements justify them.
- Resolve account, region, VPC and resource identity from registered inventory.
  Names, monitor prefixes, IPs without scope and external trace claims do not
  establish ownership. Failed member access cannot fall back to host credentials.
- Preserve observation windows, source timestamps, collection status, ambiguity
  and cap omissions. Cached retrieval must not advance the evidence clock.
- Preserve existing bounded worker time, bytes, resource and SDK request limits.
- Public documentation is English. Product translations retain locale parity.

## Deliverables

1. A reusable, capacity-bounded TTL cache with expired-entry pruning and
   concurrent-request deduplication for DNS/NFM reads. Failed loads are not
   cached. A dependency-free benchmark distinguishes local repeated-read benefit
   from production latency or shared-cache economics.
2. EC2 memory evidence from an existing, uniquely scoped CWAgent memory metric.
   Read maximum utilization over the same representative fourteen-day period
   as native metrics. Preserve actual dimensions, completeness, unit and sample
   coverage; missing or ambiguous instrumentation keeps sizing withheld.
3. Bounded DNS and NFM collectors feeding the same admitted evidence bundle as
   the six pillar specialists. Resolver association and inventory scope must
   qualify logs. NFM top contributors remain partial traffic coverage and never
   imply successful SQL or causal request direction.
4. Inventory and graph selection that reserves useful resource types and reads
   neighborhoods of selected resources instead of taking alphabetical prefixes.
   Exact identity matching expands to configured ECS/Lambda/Pod and database
   endpoint/proxy identities where inventory and trace support them. Unknown
   proxy-to-backend or workload identity remains an explicit gap.
5. Registered member live metric/recommendation reads through the existing
   role registry, with external ID and actual assumed identity verified. Missing
   registration, denied assumptions and unsupported trace/network sources remain
   explicit member gaps.
6. Deterministic tests for identity conflicts, stale DNS/IP reuse, missing metric
   dimensions, query deadlines, caps, cache eviction and cross-account refusal.

## Storage and source design

New observation adapters project only allowed fields; raw log bodies, SQL,
credentials and environment variables never reach model context. DNS edges
express resolution. Network edges express observed communication. Application
call edges require the same observation or trace pair. A configured proxy route
may connect a known proxy to its configured target while retaining its configured
evidence class.

Cache keys preserve source/query scope. A future distributed cache must also key
graph publication generation and collection state, recheck authentication and
authorization on every hit, and fall back through the existing bounded database
admission. The present change only bounds the existing local caches and supplies
measurement tooling.

## Acceptance

Existing scoped diagnosis evidence and graph tests continue to pass. New tests
admit uniquely scoped observed facts, reject conflicting or stale pairs and
preserve partial coverage. No SDK call executes when its gate is off. Terraform
provider-mock plans keep the default configuration unchanged. Actual production
latency, deployed runtime readiness and shared-cache savings are not claimed by
offline tests.
