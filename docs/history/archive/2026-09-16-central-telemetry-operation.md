# Central telemetry operation record — 2026-09-16

## Scope and authority

This is an anonymized, historical account of separately authorized operator work
on an eight-cluster lab. It is not a supported deployment recipe, a current
infrastructure source of truth, or evidence that AWSops product integration is
complete. No live account identifiers, addresses, domains, role references,
credentials, executable provisioning helpers, or deployment manifests are
published here. Full execution material remains in the operator's private
archive; local `.artifacts/` directories are excluded from this public sample.

**ADR-005 remains unchanged:** AWSops performs diagnosis and remediation proposals,
not AWS-resource mutation or autonomous mitigation. An external operator's approval
for this particular lab operation does not enable product mutation, create an
ADR-005 exception, or authorize future actions. No application, agent, feature
gate, Terraform root, deployment workflow, or datasource registration is changed
by this record. The existing connector governance under ADR-007 is also unchanged.

The [E2E observability reference](../../reference/observability-e2e.md) describes
application integration using existing read-only adapters. That product scope
does not provision the separately owned backends described below. This operation
did not establish that the product's adapters were registered against these
stores or that product-level E2E correlation worked.

## Approved operation

The operator requested additional central collection while retaining existing
CloudWatch and cluster-local Prometheus collection. Eight source clusters sent
telemetry to operator-owned storage in the central cluster. Each source/signal
pair had one central destination; existing local collection was outside that
deduplication boundary.

Three lab worker groups were separately approved to grow from four to five CPU
workers. Stateless nginx pods were relocated one at a time, with the configured
180 replicas preserved and availability checked after each relocation. Final
reported availability was 180 per group, with no remaining cordoned nodes and at
least two free pod slots per node. Relocation counts were 18, 17, and 16.
Databases and pre-existing collection workloads were not selected for relocation.

A proposal to combine the newly added node collector and tracer was cancelled
by the operator. Their separate deployments were retained. Targeted memory-limit
adjustments addressed observed failures in the new collectors/storage without
changing the pre-existing collection destinations.

## Recorded routing

Aliases A–H replace actual cluster identities; H denotes the central cluster.
These aliases describe the recorded experiment and are not configuration values.

| Source alias | Metrics | Container logs | Traces |
|---|---|---|---|
| A | Prometheus | ClickHouse | Tempo |
| B | Prometheus | Loki | Jaeger |
| C | Prometheus | Loki | Tempo |
| D | Mimir | Loki | Jaeger |
| E | Mimir | ClickHouse | ClickHouse |
| F | Mimir | ClickHouse | Tempo |
| G | Mimir | ClickHouse | Jaeger |
| H | Prometheus | Loki | ClickHouse |

The operator intentionally chose different trace stores by source cluster.
A distributed trace crossing those cluster boundaries can therefore be split
between stores. Neither this layout nor its test proves a complete cross-cluster
trace in any single backend.

## Reported observations and evidence limits

The [anonymized evidence projection](2026-09-16-central-telemetry-evidence.json)
records the supplied results; it is not a live probe or an independently
reproducible public acceptance test. At the recorded readiness observation,
cluster collectors were 8/8 Ready, node collectors 32/32, and tracers 32/32.
The six storage workloads and one central gateway were Ready.

Explicitly labelled test metrics, container logs, and traces exercised all
24 source/signal paths. Per-backend queries found the test markers only at their
assigned destinations. This establishes bounded delivery and the absence of
central fan-out for those markers at that time. It does not establish exactly-once
delivery, losslessness, failure recovery, retention durability, tenant isolation,
complete application instrumentation, or continuous health. Quiet sources were
validated with test data, not presented as observed business traffic.

The operator compared image names and replica counts for 50 pre-existing
CloudWatch/Prometheus workloads with the pre-operation inventory and reported
no differences. This is a limited preservation check, not a byte-for-byte audit
of every live configuration or an attestation about unrelated changes.

Source A had no active GPU exporter pods. CPU/node collection was available,
but no GPU hardware metrics were generated and the empty exporter target
continued to produce connection-refused warnings.

## Known limitations of the recorded experiment

This note deliberately does not publish the experimental manifests as approved
production assets. The following limitations require a separate operator review
before reuse or hardening; no live remediation is implied by this documentation.

- **Replay and persistence:** a queue PVC did not make every metrics export
  durable. Some remote-write buffering was not persistent, and a rescheduled
  cluster collector could strand its host-local queue on a previous node.
  Concurrent replay and backend ordering rules were not failure-tested.
- **Routing admission:** the allowlist covered exactly the eight source names.
  Unmatched or missing labels had no reviewed fallback path. Delivery checks for
  known labels did not test rename, unknown-source, or rejected-data observability.
- **Tracing:** source-based storage splits cross-cluster traces. eBPF collection
  covers supported protocol activity, not every application's internal business
  span; the single-replica forwarding path can also have restart gaps.
- **Security:** privileged host-level tracing, broad metadata-read permissions,
  mutable image tags, source-side OTLP admission, and the single operator-owned
  certificate trust domain were not validated as a hardened multi-tenant design.
  Full RBAC/IAM and credential-lifecycle evidence is private and is not established
  by this report. No credential-generation implementation is exported.
- **Self-observation:** startup status, log inspection, and point-in-time queries
  are not a continuously monitored end-to-end loss or queue-saturation SLO.
  Pipeline self-metrics, rejection visibility, and log-loop exclusions need review.
- **Lifecycle:** certificate/password rotation requires a reviewed restart/reload
  procedure. Single replicas and local storage remain availability constraints.
  Disruption budgets reduce voluntary movement but do not provide high availability
  and may require operator handling during maintenance.
- **Capacity and cost:** seven-day retention was configured, not observed for a
  full seven-day period. Storage growth, sustained workload capacity, added worker
  cost, and transport cost were not established by the smoke test. Reducing the
  worker groups can recreate the pod-slot shortage.

Any later improvement must preserve the owner's additive-only collection
constraint unless separately authorized. Historical approval of this operation
is not permission to replace existing collectors, alter product posture, or
publish the private execution archive.
