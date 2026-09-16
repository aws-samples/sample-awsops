---
sidebar_position: 5
title: EKS Overview
description: EKS cluster status, node resources, Pod status summary
---

import Screenshot from '@site/src/components/Screenshot';

# EKS Overview

A page for viewing the overall status of EKS clusters, node resources, and Pod status at a glance.

<Screenshot src="/screenshots/compute/eks.png" alt="EKS Overview" />

## Key Features

### Cluster Filter
- Filter by EKS cluster
- Filter by VPC
- Multi-select support

### EKS Cluster Cards
Display key information for each cluster in card format:
- Cluster Name, Status (ACTIVE)
- Kubernetes Version, Account, Region, VPC ID, Platform Version
- **Access Entry badge**: K8s Connected (green) / No Access (red)
- **Cluster registration button (admin)**: use existing-Access-Entry query registration, a ServiceAccount token, or an explicit AssumeRole identity. AWSops stores registration settings; it does not create AWS roles, Access Entries, or policies (ADR-005).
- **Click to filter**: Click a cluster card to filter all data to that cluster (cyan border)

:::tip Cluster Access
When registered clusters cannot supply live data, the page shows the failure reason and a link to this guide. Default query registration needs the web task-role Access Entry on the target; explicit SA/AssumeRole authentication needs Kubernetes authorization for that identity. The selected cluster owner executes any commands returned with a 409, then an admin retries query registration.
:::

### Connect a cross-account cluster

1. Register and enable the target account in **Accounts**, and configure the regions to query. Metadata discovery uses the registered target read-only role, normally `AWSopsReadOnlyRole`.
2. Select the target account and region in the top filter. Changing the filter refreshes lists and aggregates without registering another cluster. **Account** and **Region** on each card distinguish clusters with the same name.
3. For default **Access Entry query registration**, the cluster owner must create a `STANDARD` entry for the **host account's web task role** on the target cluster and associate the required read policy. The role used for metadata discovery and the default Kubernetes bearer identity are separate.
4. Choose **Register for query**. Registration directly checks that cluster in the selected account and region; it does not verify membership in the host account's cluster list. Registration and detail requests retain the same account/region identity.

A **ServiceAccount token** authenticates Kubernetes reads as the read-only SA authorized inside the cluster. It does not require an IAM Access Entry, but target-account metadata discovery must still be configured. **AssumeRole authentication** uses a role that the web task can assume and that is authorized for the target Kubernetes API. The default deployment's AssumeRole grant targets `AWSopsReadOnlyRole`; an operator must separately authorize another role. Both methods still require network access to the cluster API.

`make configure` → `eks.tf` is the **host-account Terraform onboarding path**. For member/nondefault-region clusters, the owner executes the displayed commands and then an admin registers query access manually. Do not assume the host EventBridge observer will register them automatically.

:::info Scope and failure states
All-region discovery currently covers configured regions and regions of already registered clusters; it does not prove exhaustive AWS-region coverage. Narrow the scope when partial-collection or limit notices appear. `404` means the selected target cluster was not found; `409` means an Access Entry is missing or could not be verified. A `503` or another query failure is not evidence that no cluster exists.
:::

### Stats Cards (Click to Navigate)
Click each card to navigate to the detail page:
- **Nodes** → Node Details (`/eks/nodes`)
- **Pods** → Pod Details (`/eks/pods`)
- **Deployments** → Deployment Details (`/eks/deployments`)
- **Services** → Service Details (`/eks/services`)

### Node Card Grid
Visually display resource usage for each node:
- Node name, Pod count, status (Ready/NotReady)
- **CPU usage bar**: Pod requests / total capacity (percent)
- **Memory usage bar**: Pod requests / total capacity (percent)
- 80% or higher: red, 50% or higher: orange, otherwise: cyan/purple

### Node Detail View
Click a node card to navigate to the detail page:
- **CPU/Memory/Pod Info cards**: Capacity, Allocatable, Requested, Available
- **ENI list**: IP allocation per network interface + instance network traffic tiles (In/Out bytes·packets — cumulative and average rate over the completed previous hour bucket; CloudWatch has no per-ENI dimension, so values are instance-level)
- **Pods table**: List of Pods running on that node

### Visualization Charts

- **Pod Status Distribution**: Running, Pending, Failed, Succeeded distribution (pie chart)
- **Pods per Namespace**: Pod count by namespace (bar chart)

### Warning Events Table
Display Kubernetes Warning events in real-time:
- Kind, Object, Reason, Message, Count, Last Seen

## How to Use

1. Click **Compute > EKS** in the sidebar
2. Click a cluster card to filter to a specific cluster
3. Click stats cards to navigate to Pods/Nodes/Deployments/Services detail pages
4. Identify nodes with high resource usage from the node cards
5. Click a node to view detailed resources and Pod list
6. Monitor problem events in Warning Events

## Tips

:::tip Node Resource Monitoring
If a node card's CPU/Memory bar is red (80% or higher), there's a risk of resource shortage. Consider adding nodes or rebalancing Pods.
:::

:::tip ENI IP Usage
In the node detail view, if ENI IP Slots Used is close to 15/15, new Pod scheduling may fail.
:::

:::info AI Analysis
You can analyze with the AI Assistant using queries like "EKS cluster status", "CPU usage by node", "Analyze Warning events", etc.
:::

## Related Pages

- [EKS Authentication Setup](./eks-auth) - Access Entry / aws-auth authentication guide
- [EKS Explorer](./eks-explorer) - K9s-style terminal UI
- [EKS Pods](./eks-pods) - Pod detailed list
- [EKS Nodes](./eks-nodes) - Node detailed list
- [EKS Deployments](./eks-deployments) - Deployment list
- [EKS Services](./eks-services) - Service list
- [EKS Container Cost](./eks-container-cost) - Pod cost analysis (OpenCost)
