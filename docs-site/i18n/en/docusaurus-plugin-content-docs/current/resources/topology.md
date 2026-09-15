---
sidebar_position: 3
title: Topology
description: Explore the request-flow graph (Route53 → CloudFront → LB → Target Group → target)
---

import Screenshot from '@site/src/components/Screenshot';

# Topology

The default `/topology` view explores the configured request flow (**Route53 → CloudFront → Load Balancer → Target Group → target**) as an interactive graph. The optional **Service + Network** view is described below.

<Screenshot src="/screenshots/resources/topology.png" alt="Request-flow graph" />

These saved screenshots are illustrative examples; verify your selected account and current scope when using the page.

## Features
### Request-flow graph
- Visualizes the traffic path **Route53 → CloudFront → Load Balancer → Target Group → target** as nodes and edges.
- Nodes are distinguished by per-kind color and icon; target nodes change color by their health state (**healthy / unhealthy / draining**, etc.). The info line above the graph shows color legend chips for the kinds/health states present in the current graph.
- The graph shows the current **node count** and **edge count**; a separate collection-evidence area shows source capture/last-success times and read status.
- Use the **MiniMap** at the bottom-right and the **Controls** at the bottom-left to pan and zoom freely.

### Entry-point filter
- Pick a specific distribution from the top **CloudFront** selector to narrow the graph to just the paths starting from that entry point.
- The **LB** selector does the same for a specific Load Balancer.
- Leave both selectors at **All** to show the entire graph.

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
1. Click **Topology** in the sidebar.
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
- Inventory reads are bounded to keep the dashboard responsive. If a read fails, collection changes while loading, or a displayed limit is reached, ownership remains unverified. Check the collection and scope notices, retry after collection completes, and review the appropriate account inventory. A missing target does not prove the resource or its traffic is absent.
- Check the read/scope warnings and ambiguous-target icon before using cluster filters. Successful types remain visible after partial failures. If failed/incomplete reads produce an empty graph, the prior nonempty graph and its original evidence remain only within the same account, with a retained-data notice; complete empty reads replace it normally.
- Target collection time describes the target-group configuration, not when a task or pod owned the address. Member/materialized labels and host ECS snapshots are cached configuration. AI context may omit these qualifiers, so verify current ownership before relying on a flow label.

## Service + Network (opt-in)

Open `/topology?view=e2e`, or select **Service + Network →** on the configuration topology, service map (`/topology/services`) or network monitor (`/network-flow`). The default `/topology` configuration view remains available through **Back to configuration flow**.

Service and Network Flow Monitor (NFM) observations are supported only for the **host account (`self`)**. Member and all-account selections show configuration only; host observations are never overlaid on those accounts. NFM uses the host account's configured AWS region, not an account-wide or multi-region traffic census.

Configuration inventory keeps the existing **account-only** scope: region/global selectors do not filter these inventory reads. The inventory collection-evidence panel discloses that scope. EKS evidence covers only connected clusters in its configured region; it does not extend coverage to other regions.

Identity correlation uses the complete inventory for the selected account scope. Default-view entry and cluster filters do not apply to the integrated view; search, focus and evidence filters apply after correlation. Hiding a competing candidate must never turn an ambiguous observation into a confirmed identity.

### Query network observations

1. Check the separate configuration, saved service snapshot and NFM source panels. Loading a page reads source/status information; it does not start an NFM contributor query.
2. Select an active monitor, a metric (**Transferred**, **RTT**, **Retransmissions** or **Timeouts**), and a window: **15 min (900 seconds)**, **30 min (1800 seconds)** or **1 hour (3600 seconds)**.
3. Choose one destination category or **All categories**: `INTRA_AZ`, `INTER_AZ`, `INTER_VPC`, `INTER_REGION`, `AMAZON_S3`, `AMAZON_DYNAMODB`, `UNCLASSIFIED`. All categories queries the seven categories with at most **three concurrent requests**.
4. Click **Query network** explicitly. Progress and cancellation are available while it runs. Changing controls does not apply them until you query again; the applied-result heading and per-category windows continue to describe the result actually returned.
5. Check successful, failed and capped categories separately. A failed category does not erase successful observations. **Refresh** reloads the sources; use **Query network** again to load network observations.

### Read source state before drawing conclusions

| State | Meaning |
| --- | --- |
| Empty | The read succeeded but returned no matching observations in its scope/window. This does not prove there is no traffic. |
| Partial | Some categories, source reads or collection steps were incomplete. Successful evidence remains useful, but failed portions cannot establish traffic presence or absence. |
| Stale | The source capture is old. Reloading cached data does not make the evidence fresh. |
| Retained | A previous graph and its original evidence remain after a failed or incomplete refresh. Read the retained-data notice; it does not describe current traffic. |
| Capped | A contributor, inventory, processing or graph-read limit was reached. Coverage is incomplete; distinguish this from the canvas display limit below. |
| Unavailable or unknown | No active/configured monitor, unsupported account scope, an inaccessible source, failed read or missing collection metadata is not an empty successful observation. The panel identifies the applicable condition. |

Compare configuration capture/last-success times, service snapshot/collection windows and **Observation windows by category**. Cached NFM results retain their original windows, which may differ between categories; a service snapshot can fall outside them. Missing times or collection state remain unknown. Configuration relationships describe setup, service snapshots are saved samples, and NFM returns top contributors rather than every flow. A source failure does not invalidate independent sources or prove them complete.

### Search, filter and inspect

- Search loaded evidence by service, Pod, IP or resource, then select a result or node to focus its neighborhood. Search respects the active relationship filters: **Configuration relationships**, **Service observations**, **Network observations**, **Identity correlations** and **Context**.
- Use **Focus main flow**, **View all**, the MiniMap and zoom controls to move between focused and overview views. Details show available endpoint identifiers, local/remote IPs, ports, metric/unit, monitor/category, observation window, SNAT/DNAT and connection evidence.
- The canvas displays at most **350 nodes and 700 edges**, with omitted counts. Search, focus and relationship filters apply before that bound, so search can find loaded evidence outside the initial display. They cannot recover observations omitted by a source limit.
- Service relationships marked **Inferred relationship** remain estimates; observed service relationships are still limited to their source samples. Identity correlations are a separate kind of evidence.

### What a connection proves

Configuration and service-call arrows retain their direction. NFM **Local** and **Remote** identify observation sides, not the request initiator and recipient. The metric is aggregated between those endpoints, not measured per hop. **Traversed components** are unordered context, not a packet itinerary; sharing a NAT gateway or TGW does not prove an end-to-end path. SNAT/DNAT aliases are displayed for context and are never identity keys.

Resource matching requires an exact IP or instance ID with corroborating **region and VPC** scope. A workload link additionally needs configured endpoint evidence confirming the exact **cluster + namespace + Pod** tuple on the relevant side. A cluster name inferred from a monitor prefix is only a hint. Matching service names alone, a NAT address, or an unsupported DNS/IP or managed-service association cannot establish identity. Missing scope, duplicate candidates and conflicting identities remain unlinked or ambiguous. Cross-source correlations never prove one traced request, causality or an E2E traffic total.

Unmatched and withheld counts measure row-side observations, not unique endpoints; the same Pod can appear in several rows. Details explain withheld identity and cached configuration context. Evidence lists show the first 20 entries and the remaining count independently of canvas limits. Main-flow ranking compares values only within one metric/unit group.

Context includes traversed constructs and cached configuration records. The view names categories with omitted observations; high-value observations within the preferred metric/unit group are prioritized before display limits.

Grouped targets show member-specific IP, namespace and Pod evidence with omission counts; the first Pod is not presented as the whole group. Check ownership restrictions, ambiguity and target-group capture time together. Capture time is not a time of ownership verification.

## AI analysis tips
Using the detail panel's question chips or the **Ask AI** button opens the AI assistant pre-seeded with the selected resource's context. Example questions:
- Does this CloudFront distribution talk to its origin over TLS?
- Why is this Load Balancer's listener/target health in this state?
- Diagnose the cause of unhealthy targets in this Target Group.
- Find the instance/ENI this IP belongs to and check its security group.

## Related pages
- [Resource Inventory](./inventory) - browse resources by type
- [AI Assistant](../overview/assistant) - continue the conversation with the context handed over from the graph
