---
sidebar_position: 7
title: EKS Pods
description: Kubernetes Pod list, status, container information
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Pods

A page for viewing the detailed list and status of Kubernetes Pods.

<Screenshot src="/screenshots/compute/eks-pods.png" alt="EKS Pods" />

:::info Selected scope and observed results
The top account/region filter applies to this page. Totals count resources actually queried in the selected registered-cluster scope, not every AWS resource. Same-named cluster options include account and region. Partial failures or query-limit notices mean results may be incomplete; narrow the scope and retry.
:::


## Key Features

### Stats Cards
- **Total Pods**: Observed Pod count in the selected scope (cyan)
- **Running**: Running Pod count (green)
- **Pending**: Pending Pod count (orange)
- **Failed**: Failed Pod count (red)

### Pod Status Distribution Chart
Visualize Pod status distribution with a pie chart:
- **Running**: Running normally
- **Pending**: Waiting for scheduling or pulling image
- **Failed**: Execution failed
- **Succeeded**: Completed (Jobs, etc.)

### Pod List Table
| Column | Description |
|--------|-------------|
| Name | Pod name |
| Namespace | Namespace |
| Status | Status (StatusBadge) |
| Node | Node where running |
| Created | Creation time |

### Status Colors
- **Running**: Green
- **Pending**: Orange
- **Failed**: Red
- **Succeeded**: Cyan
- **Unknown**: Gray

## How to Use

1. Click **Compute > K8s > Pods** in the sidebar
2. Review the statistics cards for resources observed in the selected scope.
3. If there are Pending or Failed Pods, investigate the cause
4. Check node placement for specific Pods in the table

## Understanding Pod Status

| Status | Description | Action |
|--------|-------------|--------|
| Pending | Waiting for scheduling, image pulling, resource shortage | Check node resources, image access permissions |
| Running | Running normally | - |
| Succeeded | Completed (Job, CronJob) | Normal termination |
| Failed | Container terminated abnormally | Check logs, review resource limits |
| Unknown | Node communication issue | Check node status |

## Tips

:::tip Pending Pod Diagnosis
If Pending status persists, check the following:
- Node resource shortage (CPU/Memory)
- Image pull failure (imagePullBackOff)
- PVC binding pending
- nodeSelector/affinity conditions not met
:::

:::tip Failed Pod Analysis
For Failed Pods, check container logs and events:
- OOMKilled: Memory limit exceeded
- CrashLoopBackOff: Repeated crashes
- Error: Application error
:::

:::info AI Analysis
You can analyze with the AI Assistant using queries like "Pending Pod list", "Failed Pod cause analysis", "Pod status in specific namespace", etc.
:::

## Related Pages

- [EKS Overview](../compute/eks) - Cluster view in the selected scope
- [EKS Nodes](../compute/eks-nodes) - Check node resources
- [EKS Explorer](../compute/eks-explorer) - Detailed resource exploration
- [EKS Container Cost](../compute/eks-container-cost) - Pod cost analysis
