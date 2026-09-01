---
sidebar_position: 3
title: ECS
description: ECS cluster, service, and task monitoring
---

import Screenshot from '@site/src/components/Screenshot';

# ECS (Elastic Container Service)

A page for monitoring the status of ECS clusters, services, and tasks.

:::info How this is served in v2
v1 monitored clusters/services/tasks together on one page, but **v2 splits this into 3 separate inventory routes** — `/inventory/ecs_cluster`, `/inventory/ecs_service`, `/inventory/ecs_task`. The sidebar just groups the three under "Compute" — each is its own page with its own table, filters, and detail panel. The content below reflects this 3-route structure, not v1's unified page.
:::

<Screenshot src="/screenshots/compute/ecs.png" alt="ECS" />

## Key Features

### ECS Clusters (`/inventory/ecs_cluster`)
Highlight cards show a dedicated KPI band — ACTIVE cluster count, total running tasks, total active services, total container instances — plus a Top-N bar chart ranked by running task count.

Table columns:
| Column | Description |
|--------|-------------|
| Status | Status (ACTIVE, INACTIVE) |
| Running | Number of running tasks |
| Pending | Number of pending tasks |
| Services | Number of active services |
| Instances | Number of registered container instances |
| MTD Cost ($) | Month-to-date cost |

Detail panel: Identity (Name, Account, Region, ARN) / Tasks & Services / Config (Settings, Container Insights, etc.) / Tags sections.

### ECS Services (`/inventory/ecs_service`)
Highlight cards show Desired/Running/Pending totals and the distinct cluster count.

Table columns:
| Column | Description |
|--------|-------------|
| Service | Service name |
| Status | Status (ACTIVE, DRAINING) |
| Desired | Desired task count |
| Running | Running task count |
| Pending | Pending task count |
| Launch | Launch type (FARGATE, EC2) |
| Strategy | Scheduling strategy |
| Cluster | Owning cluster |
| Task def | Task definition |
| Created | Creation date |

### ECS Tasks (`/inventory/ecs_task`)
Highlight cards show the RUNNING count, Fargate task count, total daily cost (estimate), and distinct cluster count. Cost is a static estimate derived from the task definition's cpu/memory — see [ECS Container Cost](../compute/ecs-container-cost) for the calculation details.

Table columns: Task, Cluster, Group, Status, Launch, CPU, Memory, Cost/Day, Cost/Mo, AZ, Started.

## How to Use

1. Click **Compute > ECS Clusters / Services / Tasks** in the sidebar for the route you need
2. Review the overall status of that resource from the highlight cards at the top
3. On the Services page, compare Desired vs Running; on the Clusters page, check per-cluster status
4. Click a row to view detailed settings in the detail panel

## Fargate vs EC2 Launch Type

| Aspect | Fargate | EC2 |
|--------|---------|-----|
| Infrastructure Management | Serverless (AWS managed) | Self-managed |
| Cost | vCPU/Memory based | EC2 instance cost |
| Scaling | Automatic | Auto Scaling configuration required |
| Cost Analysis | Cost/Day, Cost/Mo columns on the ECS Tasks view (static estimate) | Not supported |

## Tips

:::tip Service Status Check
If Running is less than Desired in the Services table, there may be an issue with task deployment. Check the task failure cause.
:::

:::tip Pending Tasks Monitoring
If Pending Tasks persist for a long time, suspect resource shortage or scheduling issues.
:::

:::info AI Analysis
You can analyze with the AI Assistant using queries like "ECS cluster list", "Show Fargate services", "Analyze task deployment failure cause", etc.
:::

## Related Pages

- [ECR](../compute/ecr) - Container image registry
- [ECS Container Cost](../compute/ecs-container-cost) - ECS task cost analysis
- [VPC](../network/vpc) - ECS network configuration
