---
sidebar_position: 3
title: Topology
description: Explore the request-flow graph (Route53 → CloudFront → LB → Target Group → target)
---

import Screenshot from '@site/src/components/Screenshot';

# Topology

A page for exploring the request flow (**Route53 → CloudFront → Load Balancer → Target Group → target**) as an interactive graph.

<Screenshot src="/screenshots/resources/topology.png" alt="Request-flow graph" />

## Features
### Request-flow graph
- Visualizes the traffic path **Route53 → CloudFront → Load Balancer → Target Group → target** as nodes and edges.
- Nodes are distinguished by per-kind color and icon; target nodes change color by their health state (**healthy / unhealthy / draining**, etc.).
- The header above the graph shows the current **node count** and **edge count**, plus the inventory sync time.
- Use the **MiniMap** at the bottom-right and the **Controls** at the bottom-left to pan and zoom freely.

### Entry-point filter
- Pick a specific distribution from the top **CloudFront** selector to narrow the graph to just the paths starting from that entry point.
- The **LB** selector does the same for a specific Load Balancer.
- Leave either selector at **All** to show the entire graph.

### Resource search
- Type part of a resource name in the top search box to see an autocomplete list.
- Selecting an item focuses that node directly. **Enter** selects the first match.

### Focus mode + detail panel
- Clicking a node enters **focus mode**, which keeps only the connected upstream/downstream path and re-centers it on screen.
- At the same time, the right **detail panel** opens and shows the resource's fields. **VPC / subnet / security group IDs** are shown alongside human-readable names.
- In the panel, use the **Copy ARN** button to copy the resource identifier, and the **Ask AI** button to send the resource straight to the AI assistant.
- Suggested **question chips** tailored to the resource kind are provided, and resources with a network placement also show a **relationship graph** link.
- Click empty space to clear the selection and return to the full graph.

<Screenshot src="/screenshots/resources/topology-detail.png" alt="Node focus mode + detail panel" />

## How to use
1. Click **Resources > Topology** in the sidebar.
2. Once the graph renders, use the **MiniMap** and **Controls** to zoom into the area you want to inspect.
3. To view a single entry point, pick a target in the top **CloudFront** or **LB** selector.
4. To find a specific resource, type part of its name in the search box and choose from the autocomplete list.
5. Click a node to enter **focus mode**, then review its fields in the right **detail panel**.
6. Use **Copy ARN**, the suggested question chips, **Ask AI**, and the **relationship graph** link as needed.
7. Click empty space to clear the selection and return to the full graph.

## Tips
:::tip Follow from the entry point
To see a service's full path, pick an entry point with the **CloudFront** or **LB** selector, then follow the flow down to the terminal targets. The target node colors let you read health state at a glance.
:::

:::info Displayed times
The inventory sync time in the graph header and the times in the detail panel are all in Korea Standard Time (KST, Asia/Seoul).
:::

## AI analysis tips
Using the detail panel's question chips or the **Ask AI** button opens the AI assistant pre-seeded with the selected resource's context. Example questions:
- Does this CloudFront distribution talk to its origin over TLS?
- Why is this Load Balancer's listener/target health in this state?
- Diagnose the cause of unhealthy targets in this Target Group.
- Find the instance/ENI this IP belongs to and check its security group.

## Related pages
- [Resource Inventory](./inventory) - browse resources by type
- [AI Assistant](../overview/assistant) - continue the conversation with the context handed over from the graph
