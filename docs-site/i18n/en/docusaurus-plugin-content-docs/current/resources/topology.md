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
- Nodes are distinguished by per-kind color and icon; target nodes change color by their health state (**healthy / unhealthy / draining**, etc.). The info line above the graph shows color legend chips for the kinds/health states present in the current graph.
- The graph shows the current **node count** and **edge count**; a separate collection-evidence area shows source capture/last-success times and read status.
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
Configuration topology shows the source capture range, with eligible host last-success time as a fallback when captures are missing. The Refresh chip uses the newest of those source times for its update/stale indication; rereading old inventory does not make it fresh. Displayed times use the browser timezone and do not prove live traffic. Aggregate account-sweep status, inventory read failures and unknown per-account health are separate. Inventory reads apply account selection only. EKS checks cover listed connected clusters in the configured region. Unconnected clusters use `cluster_not_connected`, distinct from `cluster_unreadable` failures, but their unassessed network scopes still block ownership. Other regions remain unassessed. Genuine row caps stay visible even on empty graphs; incomplete early stops are not labeled as the full cap.
:::

## Ownership evidence and incomplete reads

- EKS IP evidence is queried only for the exact host scope (`self`). Member, mixed and all-account scopes show an unqueried-EKS notice; IP target details include `ownership_reason=eks_not_enumerated`. Host pod addresses are never reused globally. Cached ECS configuration can remain visible without claiming exclusive ownership.
- EKS candidates require an independently listed unique `Pending`/`Running` pod with an assigned IP and valid endpoint read. `Succeeded`/`Failed` pods and `STOPPED`/`DELETED` ECS tasks cannot claim former IPs; other or missing states remain unverified. If two clusters in one region/VPC enumerate the same IP, that scoped IP is withheld even when workload names match. Other addresses are independent; a shared VPC alone does not invalidate every target.
- Target-group, ECS-task and subnet reads use at most 20 pages of 500 rows under a 30-second browser deadline shared with EKS. Each page's stored rows and global sweep ledger/count are read in one read-only Repeatable Read database snapshot. Critical reads require the `consistency: "repeatable-read"` marker and stable succeeded versions across pages. Legacy/missing markers, failures, changed metadata or remaining caps withhold ownership; browser clocks are not compared with database clocks. Separate pages/types are not one snapshot or proof of fresh, complete AWS coverage. Inventory and enrichment requests share at most two lanes per page load, with sequential critical paging inside each lane.
- Check the read/scope warnings and ambiguous-target icon before using cluster filters. Successful types remain visible after partial failures. If failed/incomplete reads produce an empty graph, the prior nonempty graph and its original evidence remain only within the same account, with a retained-data notice; complete empty reads replace it normally.
- Target `targetCapturedAt` is the target-group row's capture time, not task/subnet/pod ownership time. All member/materialized target labels and host ECS snapshot labels are cached configuration. The agent SQL view can expose bare region/cluster/ECS/task fields while omitting provenance and target time; those projected labels are not live ownership proof.

## AI analysis tips
Using the detail panel's question chips or the **Ask AI** button opens the AI assistant pre-seeded with the selected resource's context. Example questions:
- Does this CloudFront distribution talk to its origin over TLS?
- Why is this Load Balancer's listener/target health in this state?
- Diagnose the cause of unhealthy targets in this Target Group.
- Find the instance/ENI this IP belongs to and check its security group.

## Related pages
- [Resource Inventory](./inventory) - browse resources by type
- [AI Assistant](../overview/assistant) - continue the conversation with the context handed over from the graph
