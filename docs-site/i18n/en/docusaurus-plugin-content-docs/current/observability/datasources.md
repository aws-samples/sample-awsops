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
| **ClickHouse** | **SQL** (read-only) | `SELECT count() FROM system.tables` |

### Picking a datasource
- Choose the datasource to query from the dropdown. Each entry shows its **slug** and **kind**.
- A datasource whose schema has been collected is flagged **schema cached**. This cache helps the **Generate with AI** feature use real names.

### Time range toggle
- For range-capable kinds — **Prometheus**, **Mimir**, **Loki** — a **time range (range)** checkbox appears.
- Off runs an instant (single-point) query; on runs a time-series (range) query.

### Result display
- Time-series (matrix/range) results render as a **time-series area chart**.
- Instant, log, trace, and SQL results render as a sortable **table**.
- When a result hits its cap, a **result truncated** warning is shown; when there is no data, an **empty result** notice is shown clearly.

### Generate a query with AI
- Describe what you want in natural language and press **Generate with AI**; it turns your request into a query in the right language — using the cached schema — and fills it into the input box.
- The generated query **does not auto-run.** You review it and press **Run** yourself to execute.

## How to use
1. In the sidebar, click **Observability > Datasource Explore**
2. Select the **datasource** to query from the top dropdown
3. (Optional) For a range-capable datasource, turn on **time range (range)**
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

## Related pages
- [Custom Agents](../operations/custom-agents) - Connect datasources and register credentials
- [AI Assistant](../overview/assistant) - Conversational AI operations helper
