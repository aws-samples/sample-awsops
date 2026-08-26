---
sidebar_position: 10
title: Event Pre-Scaling
description: ADR-010 Phase 1+2 — traffic event registration, historical metric analysis, AI-driven warm-up scripts
---

import Screenshot from '@site/src/components/Screenshot';

# Event Pre-Scaling

The `/event-scaling` page generates **AI-driven warm-up plans** for upcoming traffic events (Black Friday, ticket drops, live streams, etc.). This is the ADR-010 Phase 1+2 implementation: it **plans and exports scripts only**; operators run the scripts manually after review.

<Screenshot src="/screenshots/overview/event-scaling.png" alt="Event Pre-Scaling page" />

## Overview

| Item | Value |
|------|-------|
| **Model** | Bedrock Claude Sonnet 4.6 (`global.anthropic.claude-sonnet-4-6-v1`) |
| **Access** | admin-only — `data/config.json` `adminEmails` |
| **State machine** | planned → analyzing → plan-ready → approved / cancelled |
| **Execution** | **None** — scripts exported as bash; humans run them |
| **Storage** | `data/event-scaling/<eventId>.json` |
| **Supported resources** | KEDA, HPA, Aurora replica/ACU, MSK broker/partition, ASG, EC2, EBS IOPS, ALB |

:::caution Phase 2 boundary
Generated scripts are for **human review**. AWSops does not perform infrastructure mutations (KEDA deploys, AWS API calls). Auto-execute + IAM expansion + KEDA integration are gated separately under ADR-029 Phase 3 (Proposed).
:::

## Workflow

```
[New Event] → [Save] → [Analyze] → [Review Plan] → [Approve | Cancel]
              POST     POST         UI expand        POST approve / DELETE
              create   analyze
                       ├ fetch metrics
                       └ Bedrock plan
```

### 1. Register Event (`planned`)
**+ New Event** opens a form with:

| Field | Description |
|-------|-------------|
| Event Name | Identifier label (e.g. "Black Friday 2026") |
| Description | Free-text notes |
| Event Start / End | KST timestamps (ISO 8601) — the peak window |
| Pattern Type | `flash-sale`, `sustained-peak`, `gradual-ramp`, `ticket-drop` |
| Expected Peak Multiplier | e.g. `10` = 10× normal traffic |
| Duration Minutes | Peak window length |
| Ramp-Up Minutes | Warm-up window before peak |
| Custom Metrics | Comma-separated CloudWatch metric names (optional) |
| Reference Event | Name + timestamp of a past similar event (for metric retrieval) |
| Target Account | Restrict in multi-account mode |

### 2. Metric Fetch + Analysis (`analyzing` → `plan-ready`)
**Analyze** runs:

1. CloudWatch metric retrieval around the reference event's ±60-minute window → `MetricsSnapshot`
2. Steampipe snapshot of current resources
3. Both datasets are sent to Bedrock Sonnet 4.6 to generate a multi-phase plan
4. The `PLAN_JSON: { ... }` marker at the end of the response is parsed into a structured `ScalingPlan`

Typical duration: 30–90 seconds.

### 3. Review + Approve (`plan-ready` → `approved`)
The right panel expands with:

- **Phases** — grouped by offset (e.g. T-4h, T-30m)
- **Targets (ScalingTarget)** — resource type, current → target value, unit, rationale
- **Scripts** — bash / kubectl code (download per phase or full ZIP)
- **Estimated additional cost** — USD (model's estimate)
- **Model metadata** — modelId, input/output tokens
- **Raw analysis** — original Bedrock markdown (for audit)

**Approve** does NOT execute — it just records `approvedBy` + `approvedAt` to mark "review complete".

### 4. Cancel / Delete
- **Cancel** — status flips to `cancelled` (record kept)
- **Cancel (hard)** — `?hard=true` deletes the JSON file

## Supported Resource Types

| Type | Script generator (`event-scaling-scripts.ts`) | Description |
|------|-------|-------------|
| `keda` | `kubectl scale` + ScaledObject patch | EKS workload pre-scaling |
| `hpa` | `kubectl patch hpa` | minReplicas/maxReplicas tuning |
| `aurora-replica` | AWS CLI `modify-db-cluster` | add reader nodes |
| `aurora-acu` | AWS CLI `modify-db-cluster` | Serverless v2 ACU ceiling |
| `msk-broker` | AWS CLI `update-broker-count` | add MSK brokers |
| `msk-partition` | `kafka-topics.sh --alter` | increase topic partitions |
| `asg` | AWS CLI `update-auto-scaling-group` | adjust Desired/Max |
| `ec2` | AWS CLI `run-instances` | pre-warm extra instances |
| `ebs-iops` | AWS CLI `modify-volume` | raise gp3 IOPS / throughput |
| `alb-capacity` | (note only) | ALB warmup advisory |

Every script is **manual review then run** — `set -euo pipefail` + `--dry-run` comments included.

## API

```bash
# List
curl '/awsops/api/event-scaling?action=list&accountId=111111111111'

# Detail
curl '/awsops/api/event-scaling?action=detail&id=<eventId>'

# Register
curl -X POST '/awsops/api/event-scaling?action=create' \
  -H 'Content-Type: application/json' \
  -d '{"name":"BF2026","eventStart":"2026-11-27T13:00:00+09:00","eventEnd":"2026-11-27T18:00:00+09:00","pattern":{"type":"flash-sale","expectedPeakMultiplier":10,"durationMinutes":120,"rampUpMinutes":60}}'

# Metrics + analysis
curl -X POST '/awsops/api/event-scaling?action=analyze&id=<eventId>'

# Mark approved
curl -X POST '/awsops/api/event-scaling?action=approve&id=<eventId>'

# Download script (text/x-shellscript)
curl '/awsops/api/event-scaling?action=script&id=<eventId>' -o warmup.sh

# Cancel
curl -X DELETE '/awsops/api/event-scaling?id=<eventId>'
```

## Pattern Guide

| Pattern | Use case | Recommended ramp-up |
|---------|----------|---------------------|
| `flash-sale` | Black Friday, mall sales | 30–60 min |
| `sustained-peak` | Live streaming, conferences | 60–120 min |
| `gradual-ramp` | Marketing campaigns, newsletters | 120–240 min |
| `ticket-drop` | Concert tickets, limited drops | 15–30 min |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Reference event metrics empty | No resources at that time, or IAM short | Ensure EC2 profile has `cloudwatch:GetMetricStatistics` |
| `PLAN_JSON` parse fails | Bedrock response truncated (max tokens) | Increase `eventScalingMaxTokens`, reduce phases |
| Nothing runs after Approve | Phase 2 by design | Download script, run manually (changing in Phase 3) |
| Multi-account leakage | `accountId` not set | Specify Target Account at registration |

## Related Pages

- [Resource Inventory](./inventory) — current resource snapshot
- [Monitoring](./monitoring.md) — baseline metrics
- [Cost Explorer](./cost) — verify cost impact of pre-scaling
- [AI Comprehensive Diagnosis](./ai-diagnosis) — post-event retrospective

## References

- **ADR-010 Phase 1+2** — event registration + AI plan generation (current)
- **ADR-029** — Phase 3 mutating-action gate (Proposed)
- `src/lib/event-scaling.ts` — data model + JSON persistence
- `src/lib/event-scaling-prompts.ts` — Bedrock prompts + `PLAN_JSON` parsing
- `src/lib/event-scaling-scripts.ts` — safe bash script generators
