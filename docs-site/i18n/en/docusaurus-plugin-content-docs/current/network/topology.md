---
sidebar_position: 4
title: Topology
description: React Flow-based AWS infrastructure and Kubernetes cluster visualization
---

import Screenshot from '@site/src/components/Screenshot';

# Topology

A page to visually explore relationships between AWS infrastructure and Kubernetes clusters.

<Screenshot src="/screenshots/network/topology.png" alt="Topology" />

## Key Features

### View Toggle

Choose among four tabs:

| View | Target | Purpose |
|------|--------|---------|
| **VPC connections** | VPC connection configuration | Inspect TGW and peering connections |
| **Placement graph (default)** | Saved AWS resources | Filter and page by VPC/subnet |
| **Infrastructure map** | Saved AWS resources | Inspect the resource hierarchy |
| **K8s map** | EKS workloads | Namespace-grouped Service graph (DNS → Gateway → Service → datastore) |

### Infrastructure View

Two display modes are available:

**Map View**
- 5-column layout showing resource hierarchy
- External (IGW/TGW) → VPCs → Subnets → Compute → NAT
- Click/search to highlight related resources

**Graph View**
- **Placement graph** is the default tab and starts with the VPC containing the most saved resources.
- Filter by VPC, subnet and resource type. Search spans all VPCs while the VPC is selected automatically; an explicitly selected scope stays selected. Invalid subnet/type filters clear when the scope changes.
- Each page shows up to four resources, or one on narrow screens. Pages use fewer resources and a taller canvas when there are many connected targets. Use previous/next to inspect the remaining resources.
- Security-group connections are hidden by default and can be enabled with the checkbox. Each page retains its resources' original placement edges.
- The resource-count denominator is the number matching the current filters. Saved node/edge totals and collection warnings appear separately. Placement edges do not prove traffic paths.

### Collection Evidence and Read Status

The infrastructure relationship graph and an individual resource's relationship graph show collection evidence separately from the displayed nodes.

- Source capture, last successful collection, and saved-graph clocks describe different events. Retained results, incomplete coverage and truncation remain visible; they do not establish the current live AWS state.
- No collection state recorded is neutral information. An empty drawing alone does not prove that resources are absent; check the collection status.
- **Refresh** reads the saved graph again. It does not start collection or rebuild the graph.
- Graph read unavailable describes a lookup failure, separately from the collection outcome. Retry with Refresh when available. If the session expires, follow **Sign in**. Access denial and request rejection are shown separately.
- Response or traversal limits disclose truncation even when no nodes are shown. They cannot establish that resources or connections outside the displayed scope are absent.


### Kubernetes View

Displays the selected cluster as a namespace-grouped Service graph (DNS → Gateway → Service → datastore):

| Node | Resource | Description |
|------|----------|-------------|
| **DNS** | Route 53 record | Alias or CNAME record that targets a gateway's load-balancer hostname exactly |
| **Gateway** | K8s Ingress, LoadBalancer Service | External traffic entry point |
| **Service** | K8s Service | Shown inside its namespace box |
| **Datastore** | RDS, ElastiCache, OpenSearch, MSK | Managed host found in Pod env, ConfigMaps or traces |

Solid lines are calls observed in traces, dashed lines are datastore links inferred from configuration, and thin lines are DNS, Ingress and LoadBalancer routing. Trace calls are shown for clusters of every registered account; a member-account cluster joins only when its name is unique across a completely read fleet-wide cluster listing. Pods and Nodes are not drawn in the graph; they appear in the detail panel that opens when you click a Service. System namespaces are hidden by default.

### Interactive Features

**Search**
- Infrastructure: Search EC2, Subnet, VPC by name/ID/CIDR
- Kubernetes: Search Service, Ingress, Namespace, datastore
- Automatically highlights matched and related resources

**Click Selection**
- Click a resource to select it
- All connected resources are highlighted
- Click again to deselect

**Graph View Only**
- Mouse wheel: Zoom in/out
- Drag: Pan canvas
- Node drag: Adjust node position
- Controls: Zoom reset, fit to screen

## How to Use

### Understand Infrastructure Structure

1. Select **Infrastructure** view
2. Review hierarchical structure in **Map View**
3. Follow the VPC → Subnet → EC2 flow
4. Check external connectivity via IGW/TGW

### Track Specific Resources

1. Enter resource name/ID in the search bar
2. View highlighted matching resources
3. Related VPC and Subnets are also highlighted
4. Click "Clear search" button to reset

### Analyze K8s Traffic Flow

1. Select the **K8s map** tab
2. Follow the DNS → Gateway → Service → datastore flow
3. Click a Service to see its Pods and Nodes in the detail panel
4. Search to track a specific Service or namespace

### Use Graph View

1. Select **Placement graph** and choose the VPC, subnet and resource type. Choose **All VPCs** to include resources with no confirmed VPC.
2. Enter a search query and use **Previous resources**/**Next resources** to navigate pages.
3. Enable **Show security group connections** when needed. Page size and canvas height adjust for many connected targets.
4. Use zoom/pan and page scrolling to inspect the edges alongside the selected scope and collection status.

## Tips

:::tip Network Path Tracing
To trace the path from a specific EC2 to the external internet:
1. Enter EC2 name in the search bar
2. Check the highlighted Subnet
3. Verify if Subnet is connected to NAT Gateway or IGW
4. Private Subnet uses NAT, Public Subnet uses IGW path
:::

:::tip K8s Service Debugging
Troubleshooting "No Pods connected to Service":
1. Click the Service in the K8s map
2. Check the Pod list in the detail panel (an empty list indicates a problem)
3. Verify Pod labels match Service selector
4. If Pods exist, check resource status in the detail panel's Node details
:::

:::info Color Legend
| Color | Infrastructure | Kubernetes |
|-------|---------------|------------|
| Cyan | VPC, IGW | - |
| Green | Subnet | - |
| Purple | EC2 | DNS, Gateway |
| Blue | - | Service |
| Pink | ELB | - |
| Orange | RDS, NAT | Datastore |
| Red | TGW | - |

The legend chips in the info line above the map show only the kinds present in the current graph. The status dot next to a card name is also shown in the legend — **ok** (green) / **warn** (amber) / **bad** (red) / **neutral** (gray).
:::

## Related Pages

- [VPC](../network/vpc) - VPC details and resource map
- [EKS Overview](../compute/eks) - EKS cluster details
- [EC2](../compute/ec2) - EC2 instance details
