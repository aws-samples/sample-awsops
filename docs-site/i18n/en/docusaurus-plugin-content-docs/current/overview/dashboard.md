---
sidebar_position: 1
title: Dashboard
description: The main dashboard for AWS and Kubernetes operations at a glance
---

import Screenshot from '@site/src/components/Screenshot';

# Dashboard

A page for viewing your AWS and Kubernetes operations at a glance and moving straight into the AI assistant.

<Screenshot src="/screenshots/overview/dashboard.png" alt="Dashboard" />

## Features

### AI Operations

The **AI Operations** row at the top of the page gives you direct entry points into the AI features.

- **AI Assistant card**: Shows a badge with the active agent count; click **Start chat** to open the chat drawer.
- **Recent AI conversations**: Lists your past conversations — click an item to reopen it.
- **AI analysis** status card: Summarizes the current analysis environment, including the **EKS diagnosis**/**K8sGPT** gate, incident auto-analysis, and hybrid routing accuracy.

### KPI tiles

Key resource metrics are organized into three groups.

| Group | Metrics |
|-------|---------|
| **COMPUTE & CONTAINERS** | EC2 (running/stopped hint), Lambda, ECS, ECR, EKS |
| **STORAGE & NETWORK** | S3, EBS (unencrypted volume count), RDS, DynamoDB, VPC |
| **SECURITY · OPS · COST** | IAM roles, Security Groups (open-ingress count), job success/fail, CloudWatch alarms, this-month cost (USD) |

- Tiles are highlighted in **warning/danger** colors when there are unencrypted volumes, 0.0.0.0/0 open ingress, or failed jobs.
- This-month cost is shown as a USD amount.

### Charts

| Chart | Content |
|-------|---------|
| **Resource distribution** | Counts of the top resource types (bar) |
| **Resources by category** | Share per category with total (donut) |
| **Job status** | Share of succeeded, failed, running, and queued jobs (donut) |
| **Daily cost trend** | Cost trend by date (area) |

## How to use

1. The dashboard opens automatically after you sign in; you can also reach it via **Overview > Dashboard** in the sidebar.
2. In the **AI Operations** row, click **Start chat** to begin a conversation, or reopen a previous one from **Recent AI conversations**.
3. Check any tiles highlighted in warning/danger colors in the KPI section.
4. Review the charts for resource composition, job status, and cost trend.
5. Use the **Refresh** button in the header to reload all data. The last-updated time is shown alongside it.

:::tip Keeping data fresh
The **Refresh** button shows the time data was last loaded (KST) and adds an **(outdated)** marker after 30 minutes. If highlighted tiles appear or the timestamp looks stale, refresh once.
:::

:::info When data looks empty
KPI tiles show **—** until the summaries arrive. When there is no job or cost data, the chart areas display **No job data** or **No cost data** instead.
:::

## AI analysis tips

You can ask the AI assistant about anything you notice on the dashboard.

- "List the Security Groups that have open ingress."
- "Show the unencrypted EBS volumes and which instances they're attached to."
- "Analyze the main driver behind this month's cost increase."
- "Diagnose what the recent failed jobs were and why they failed."

## Related pages

- [AI Assistant](./assistant) - Analyze dashboard data with the AI assistant
- [Resource Inventory](../resources/inventory) - See detailed resource lists by type
- [Cost Explorer](../cost/cost-explorer) - Analyze cost trends and breakdowns
