---
sidebar_position: 1
title: Datasource Explore
description: Query connected observability datasources read-only in their native query language
---

import Screenshot from '@site/src/components/Screenshot';

# Datasource Explore

A page for querying connected observability datasources read-only, each in its own native query language.

<Screenshot src="/screenshots/observability/datasources.png" alt="Datasource Explore (empty state)" />

## Features

### Supported datasources and query languages
Query a connected datasource directly in the language native to its kind. Every query is **read-only**.

| Datasource | Query language | Example |
|-----------|----------------|---------|
| **Prometheus** | **PromQL** | `rate(node_cpu_seconds_total[5m])` |
| **Mimir** | **PromQL** | `up` |
| **Loki** | **LogQL** | `{job="varlogs"} \|= "error"` |
| **Tempo** | **TraceQL** | `{ duration > 500ms }` |
| **ClickHouse** | **SQL** (read-only) | `SHOW TABLES` |
| **Jaeger** | Service-anchored search | `service=frontend&limit=20` |
| **Dynatrace** | Metrics v2 metricSelector | `builtin:host.cpu.usage:avg` |
| **Datadog** | Metric query | `avg:system.cpu.user{*}` |

### Picking a datasource
- Choose the datasource from the dropdown. Each entry shows its **instance name** and **kind**.
- AI drafting uses separately collected schema caches. Datasources and per-kind defaults are shared; selecting an AWS account does not change their scope.
- Only administrators configure and test connections. Private endpoints require operator-managed networking and DNS; configured and query-verified are separate states.
- Timeout distinguishes server execution limits for Prometheus/Mimir/ClickHouse (default 10s) from HTTP response limits for other kinds (default 12s). Stored values are 1–60s; the form shows the effective maximum of 55s. Mimir's API prefix defaults to `/prometheus`; leave it empty for an API at the root.

### Time range toggle
- The window selector offers instant or up to 30 days for **Prometheus/Mimir**, and instant or up to seven days for **Loki**.
- **Tempo/Jaeger** default to one hour and support up to seven days; **Dynatrace/Datadog** default to one hour and support up to 30 days. The selected bounds are forwarded to the search request.
- **ClickHouse** time predicates belong to SQL. AI query drafting does not change the selected request window.

### Result display
- Time-series (matrix/range) results render as a **time-series area chart**.
- Instant, log, trace, and SQL results render as a sortable **table**.
- Actually truncated results show a **result truncated** warning. Search-limit saturation is marked **partial** because completeness is unproven; verified empty responses show an **empty result** notice.
- Unknown or partial responses cannot establish an empty dataset. Reaching Jaeger's search limit does not establish a complete trace inventory.

### Generate a query with AI
- Describe what you want in natural language and press **Generate with AI**; it turns your request into a query in the right language — using the cached schema — and fills it into the input box.
- The generated query **does not auto-run.** You review it and press **Run** yourself to execute.

## How to use
1. In the sidebar, click **Observability > Datasource Explore**
2. Select the **datasource** to query from the top dropdown
3. (Optional) Choose the query window from the selector when the datasource supports it
4. Type a query in the native language, or describe it in natural language and use **Generate with AI** to fill the query
5. Review the query, then press **Run** (or **Enter** in the input) to execute
6. Read the result as a chart or a table

:::info When no datasource is connected
If no datasource is connected, the dropdown is empty and the page shows **"No datasource configured — connect one in Connectors."** Connect datasources and register their credentials on the **Custom Agents (Connectors)** page.
:::

:::tip Quick run
Press **Enter** in the query input to run immediately. Press **Enter** in the natural-language box to trigger **Generate with AI**.
:::

:::tip If the result is truncated
If you see the **result truncated (cap reached)** warning, narrow the query's range or conditions and run again.
:::

## AI analysis tips
- "CPU utilization across all nodes over the last 5 minutes" → generates a PromQL query
- "recent logs containing error" → generates a LogQL query
- "traces that took over 500ms" → generates a TraceQL query
- "row count per table" → generates a read-only SQL query

## Diagnose with AI

On the Datasources management tab, each kind's **default** datasource row shows a **Diagnose with AI**
link (supported kinds: Prometheus, ClickHouse, Loki, Mimir, Tempo). Clicking it opens the AI assistant
with a section-pinned diagnostic prompt prefilled (Prometheus/ClickHouse → `/observability`,
Loki/Mimir/Tempo → `/monitoring`). It is **never sent automatically** — review and send it yourself,
and it starts a fresh conversation. The agent probes the datasource using that connector's
query/schema tools.

## Explore feature summary

- Curated **example-query and natural-language prompt chips** per kind (all 8 kinds)
- **7d/30d range presets** (Prometheus/Mimir up to 30d, Loki 7d — per-kind bounds)
- Result **metadata bar** (rows/series · round-trip ms · query language · shape)
- Dedicated **Loki log viewer** (newest-first, label badges) and Tempo/Jaeger **duration bars**
- An **"AI generated" banner** on drafted queries; management-tab **KPI tiles and refresh**

## Related pages
- [Custom Agents](../operations/custom-agents) - Configure agent personas, skill bindings and account tool caps
- [AI Assistant](../overview/assistant) - Conversational AI operations helper
