---
sidebar_position: 11
title: ECS Container Cost
description: ECS Fargate task cost analysis, CloudWatch Container Insights metrics
---

import Screenshot from '@site/src/components/Screenshot';

# ECS Container Cost

:::caution v1 archive doc — no equivalent page exists in v2
This document describes v1's dedicated **ECS Container Cost** page (stats cards, charts, and the "Cost Calculation Basis" toggle). **v2 has no such dedicated page/UI** — there is no `showBasis` toggle or matching StatsCard/chart anywhere in `web/`. v2's only equivalent is the **Cost/Day** and **Cost/Mo** columns on the **`/inventory/ecs_task`** inventory view, and those values are a **static estimate derived from the task definition's allocated cpu/memory** — not from CloudWatch Container Insights utilization metrics (`web/lib/inventory-derived.ts`'s `ecs_task` deriver, around lines 106-124). The **pricing constants and formula** below (`$0.04656`/`$0.00511`, `(CPU units/1024)×rate×24 + (MB/1024)×rate×24`) match that static-estimate logic and are accurate — don't change those. But the stats cards, charts, "Cost Calculation Basis" toggle, and the "calculated from CloudWatch Container Insights metrics" claim in this document are v1-only and don't exist in v2.
:::

A page for analyzing the cost of ECS Fargate tasks. Costs are calculated based on Fargate pricing and CloudWatch Container Insights metrics.

<Screenshot src="/screenshots/compute/ecs-container-cost.png" alt="ECS Container Cost" />

## Key Features

### Stats Cards
- **Daily Cost (ECS)**: Total daily cost (cyan)
- **Monthly Estimate**: Estimated monthly cost (green)
- **Running Tasks**: Number of running tasks - Fargate/EC2 breakdown (purple)
- **Top Cost Service**: Highest cost service (orange)

### Service Cost Distribution Chart
Pie chart showing daily cost distribution by service

### Cost by Service (CPU vs Memory) Chart
Stacked bar chart comparing CPU cost vs Memory cost per service

### ECS Tasks Table
| Column | Description |
|--------|-------------|
| Cluster | Cluster name |
| Service | Service name |
| Task ID | Task ID (first 12 characters) |
| Type | Launch type (FARGATE/EC2) |
| CPU (units) | CPU units and vCPU equivalent |
| Memory (MB) | Memory and GB equivalent |
| Daily Cost | Daily cost (Fargate only) |
| AZ | Availability Zone |

## Cost Calculation Method

### Fargate Pricing (v2 actual values — ap-northeast-2 (Seoul) rates, `web/lib/inventory-derived.ts`)
| Resource | Rate | Billing Unit |
|----------|------|--------------|
| vCPU | $0.04656 | per vCPU-hour |
| Memory | $0.00511 | per GB-hour |
| Ephemeral Storage (>20GB) | $0.000111 | per GB-hour |

> These are fixed, static estimate constants applied regardless of the task's actual AWS region — the deriver does not look up a per-task region column.

### Calculation Formula
```
CPU Cost = (CPU Units / 1024) x $0.04656/hr x 24hr
Memory Cost = (Memory MB / 1024) x $0.00511/hr x 24hr
Daily Cost = CPU Cost + Memory Cost
Monthly Estimate = Daily Cost x 30
```

### Calculation Example
Fargate Task: 512 CPU units (0.5 vCPU) + 1024 MB (1 GB)
- CPU: 0.5 vCPU x $0.04656/hr x 24hr = **$0.5587/day**
- Memory: 1 GB x $0.00511/hr x 24hr = **$0.1226/day**
- Total: **$0.681/day ($20.44/month)**

## How to Use

1. Click **Compute > Container Cost** in the sidebar
2. Review overall cost status from the stats cards
3. Identify high-cost services from the charts
4. Check detailed cost per task in the table
5. Expand the "Cost Calculation Basis" section to verify calculation basis

## Support Scope

| Item | Support |
|------|---------|
| Fargate Launch Type | O (cost calculation supported) |
| EC2 Launch Type | X (requires node cost distribution, not supported) |
| Spot Fargate | - (based on On-Demand pricing) |

## Tips

:::tip EC2 Launch Type
EC2 type tasks are displayed as "N/A (EC2)". EC2 costs require node cost distribution and are currently not supported.
:::

:::tip Cost Optimization
If one side is significantly higher in the CPU vs Memory chart, consider adjusting the task definition. Fargate has limited CPU and Memory combinations.
:::

:::tip Changing Price Settings (v1-only)
The `fargatePricing` field of `data/config.json` was v1's override mechanism — it does not exist in v2.
:::

:::info AI Analysis
You can analyze with the AI Assistant using queries like "ECS cost analysis", "Highest cost service", "Fargate cost optimization recommendations", etc.
:::

## Related Pages

- [ECS](../compute/ecs) - ECS cluster and service status
- [EKS Container Cost](../compute/eks-container-cost) - EKS Pod cost analysis
- [Cost](../monitoring/cost) - Overall AWS cost analysis
