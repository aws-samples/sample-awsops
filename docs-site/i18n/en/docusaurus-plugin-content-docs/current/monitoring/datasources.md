---
sidebar_position: 7
title: Datasources
description: External datasource management (Prometheus, Mimir, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog)
---

import Screenshot from '@site/src/components/Screenshot';
import DatasourceFlow from '@site/src/components/diagrams/DatasourceFlow';
import DatasourceExploreFlow from '@site/src/components/diagrams/DatasourceExploreFlow';

# Datasources

A Grafana-style datasource management page for integrating external monitoring and observability systems with AWSops.

<Screenshot src="/screenshots/monitoring/datasources.png" alt="Datasources" />

## Overview

The AWSops Datasources feature provides centralized management of external observability platforms. Once a datasource is registered, you can execute queries from the dashboard or let the AI assistant use it for analysis.

<DatasourceFlow />

Key features:
- **8 datasource types** supported (Prometheus, Mimir, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog)
- **CRUD management**: Add, edit, delete datasources (admin only)
- **Connection test**: One-click connectivity verification with latency measurement
- **Query execution**: Native query language support for each datasource type
- **Security**: SSRF prevention, credential masking

## Supported Datasources

| Datasource | Query Language | Default Port | Key Features |
|-----------|---------------|-------------|-------------|
| **Prometheus** | PromQL | 9090 | Metrics collection, alerting, time-series data |
| **Mimir** | PromQL | 9009 | Long-term metrics storage, multi-tenant (X-Scope-OrgID) |
| **Loki** | LogQL | 3100 | Log aggregation, label-based search |
| **Tempo** | TraceQL | 3200 | Distributed tracing, span search |
| **ClickHouse** | SQL | 8123 | Columnar analytics, large-scale data processing |
| **Jaeger** | Trace ID | 16686 | Distributed tracing, service dependencies |
| **Dynatrace** | DQL | 443 | Full-stack monitoring, AI-powered analysis |
| **Datadog** | Query | 443 | Infrastructure monitoring, APM, logs |

## Adding Datasources

:::info Admin Only
Creating, editing, and deleting datasources requires an admin role. In v2, admins are determined by the Cognito admin group or the SSM email allowlist (v1's `data/config.json` `adminEmails` model is retired).
:::

### Configuration Fields

| Field | Required | Description |
|-------|----------|-------------|
| **Name** | Yes | Datasource display name |
| **Type** | Yes | Datasource type (select from 8 types) |
| **URL** | Yes | Endpoint URL (e.g., `http://prometheus:9090`) |
| **Authentication** | No | Auth method (None, Basic, Bearer Token, Custom Header) |
| **Timeout** | No | Upstream query execution bound (seconds, 1–60 · default 10) — forwarded as the API `timeout` param for Prometheus/Mimir and `max_execution_time` for ClickHouse; other kinds (Loki/Tempo/Jaeger/Dynatrace/Datadog) store the value but do not apply it today |
| **Database** | No | Default database name (ClickHouse only, identifier-only) |

:::note Difference from v1
v1's result-cache TTL setting does not exist in v2 — the v2 query path is deliberately uncached (thin-BFF; a result cache would need its own staleness disclosure). The Timeout unit also changed from v1's ms to seconds (1–60).
:::

### Steps

1. Click **Add Datasource** on the Datasources page
2. Select the datasource type
3. Enter name, URL, and authentication details
4. Click **Test Connection** to verify connectivity
5. Click **Save** to store the configuration

## Connection Test

Clicking **Test Connection** performs the following checks per datasource type:

| Datasource | Test Endpoint | Verification |
|-----------|--------------|-------------|
| Prometheus | `/-/healthy` | Server health, response time |
| Loki | `/ready` | Server readiness, response time |
| Tempo | `/ready` | Server readiness, response time |
| ClickHouse | `SELECT 1` | Query execution capability, response time |
| Jaeger | `/api/services` | Service list retrieval, response time |
| Dynatrace | `/api/v2/entities` | API accessibility, response time |
| Datadog | `/api/v1/validate` | API key validity, response time |

Test results display success/failure status and response latency in milliseconds.

## Query Execution

Execute queries directly using each datasource's native query language.

### PromQL (Prometheus)

```promql
rate(http_requests_total{job="api-server"}[5m])
```

Query time-series metric data such as CPU usage, request rates, and error rates.

### LogQL (Loki)

```logql
{namespace="production"} |= "error" | json | line_format "{{.message}}"
```

Label-based log search with pipeline filtering support.

### TraceQL (Tempo)

```
{span.http.status_code >= 500 && resource.service.name = "api"}
```

Condition-based distributed trace search.

### ClickHouse SQL

```sql
SELECT toStartOfHour(timestamp) AS hour, count() AS events
FROM logs
WHERE timestamp > now() - INTERVAL 24 HOUR
GROUP BY hour
ORDER BY hour
```

Fast analytical queries over large datasets.

### Jaeger

Search distributed traces by service name or Trace ID.

### Dynatrace (DQL)

```
fetch logs | filter contains(content, "error") | limit 100
```

### Datadog

Use metric queries or log search syntax.

## Authentication

Four authentication methods are supported for datasource connections:

| Auth Method | Description | Use Case |
|------------|-------------|----------|
| **None** | No authentication | Internal network Prometheus/Loki |
| **Basic** | Username/password | ClickHouse, auth-enabled Prometheus |
| **Bearer Token** | API token | Dynatrace, Datadog, Tempo |
| **Custom Header** | Custom HTTP header | Custom proxies, API gateways |

:::tip Credential Masking
Stored passwords and tokens are masked in the UI. New values can only be entered during editing.
:::

## Security

### SSRF Prevention

The following security checks are applied to datasource URLs:

- **Blocked targets**: only metadata (169.254.169.254), loopback, and link-local addresses — private (RFC1918) datasource endpoints are ALLOWED per ADR-007 (URLs containing a backslash are rejected to prevent parser-differential abuse)
- **Metadata endpoint blocking**: Blocks `169.254.169.254` (EC2 instance metadata) access
- **Link-local address blocking**: Blocks the `169.254.x.x` range
- **Protocol restriction**: Only `http://` and `https://` are allowed

:::caution SSRF Protection
External datasource URLs trigger server-side requests. To prevent SSRF (Server-Side Request Forgery) attacks, access to internal networks is blocked.
:::

### ClickHouse SQL Injection Prevention

Dangerous SQL statements (DROP, ALTER, INSERT, UPDATE, DELETE, TRUNCATE, etc.) are blocked when executing ClickHouse queries. Only read-only queries (SELECT) are permitted.

## AI Integration

The AI assistant can leverage registered datasources for analysis.

### Example Queries

- "Show the CPU usage trend from Prometheus over the last hour"
- "Search for error logs in the production namespace from Loki"
- "Aggregate today's events by hour from ClickHouse"

### How It Works

1. The AI assistant analyzes the question and selects the appropriate datasource
2. Automatically generates a query matching the datasource type
3. Provides analysis and insights based on query results

:::tip datasource Route Integration
Datasource-related questions are processed through the `datasource` route. The AI can analyze both Steampipe data and external datasources together.
:::

## Settings reference

### Common

| Setting | Default | Description |
|------|--------|------|
| **Timeout** | 10s | Upstream query execution bound (seconds, 1–60). ClickHouse applies it as the CEILING on every path (Explore, service graph, agent — callers can only tighten it) with the connector aligning its own HTTP timeout above it (effective maximum 55s — values 56–60 are shortened to 55s to stay under the Lambda's 60s wall); Prometheus/Mimir apply it as the Explore-path API `timeout` param, capped at 10s under the connector's 12s HTTP timeout |

### ClickHouse only

| Setting | Default | Description |
|------|--------|------|
| **Database** | (server default) | Default database name — identifier-only; `system`/`information_schema` are rejected (validated on both the web tier and the connector) |

Limits: ClickHouse queries must pass the read-only guard (table functions and SYSTEM blocked), and returned rows are capped at 1,000 (`max_result_rows`).

## Explore Page

The Explore page lets you execute queries directly against registered datasources and visualize results. It supports AI query generation and multi-series charts.

<DatasourceExploreFlow />

### Key Features

- **Datasource selection dropdown**: Choose which registered datasource to query.
- **Time range presets**: Select from 15m, 1h, 6h, 24h, 7d, or 30d to set the query time window.
- **Native query editor**: A syntax-highlighted editor tailored to each datasource type (PromQL, LogQL, SQL, etc.).
- **Example query chips**: One-click insertion of commonly used queries for each datasource type.
- **Result metadata**: After execution, row count, execution time (ms), and query language are displayed at the top.

### AI Query Generation

Enable the **AI Assist** toggle to write queries in natural language. Bedrock Sonnet automatically generates a query matching the datasource type and displays an explanation banner.

**Example prompts by datasource type:**

| Datasource | Example Prompt |
|-----------|---------------|
| Prometheus | "Top 5 Pods by CPU usage over the last hour" |
| Loki | "Search error-level logs in the production namespace" |
| ClickHouse | "Aggregate event count by hour for today" |
| Tempo | "Find traces with 500 errors" |

**How to use:**

1. Toggle AI Assist to ON
2. Describe the data you want in natural language
3. Press **Ctrl+Enter** or click the execute button
4. Bedrock Sonnet generates a PromQL/LogQL/SQL query
5. The generated query is displayed along with an explanation banner

:::tip AI Assist Shortcut
Use **Ctrl+Enter** to quickly generate and execute queries.
:::

### Multi-Series Charts

Prometheus datasources support visualizing up to **8 series** simultaneously.

- **Line/Bar chart toggle**: Select the chart type that best fits your data.
- **Custom color palette**: Each series is automatically assigned a unique color from an 8-color theme palette.
- **Series count indicator**: The number of currently rendered series is displayed below the chart.

:::info Series Limit
For performance, Prometheus multi-series charts are limited to a maximum of 8 series. If results exceed 8 series, only the top 8 are displayed.
:::

## Diagnose with AI

On the Datasources management tab, each kind's **default** datasource row shows a **Diagnose with AI**
link (supported kinds: Prometheus, ClickHouse, Loki, Mimir, Tempo). Clicking it opens the AI assistant
with a section-pinned diagnostic prompt prefilled (Prometheus/ClickHouse → `/observability`,
Loki/Mimir/Tempo → `/monitoring`). It is **never sent automatically** — review and send it yourself,
and it starts a fresh conversation. The agent probes the datasource using that connector's
query/schema tools.
## Allowed Networks

:::caution v1 documentation
This section describes v1's Allowed Networks feature, which does not exist in v2 — private (RFC1918) datasource endpoints are allowed by default per ADR-007; only metadata/loopback/link-local addresses are blocked.
:::

Admins can configure an allow list to exempt specific private network addresses from SSRF blocking.

:::info Admin Only
The Allowed Networks setting requires an admin role.
:::

### Supported Patterns

| Pattern Type | Example | Description |
|-------------|---------|-------------|
| **CIDR** | `10.0.0.0/16` | Allow a specific subnet range |
| **Single IP** | `10.0.1.50` | Allow a specific IP address |
| **Hostname** | `prometheus.internal` | Allow a specific internal hostname |

### Relationship with SSRF Prevention

By default, private IP ranges (`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`) are blocked to prevent SSRF attacks. Addresses registered in Allowed Networks are treated as exceptions to this blocking rule, enabling safe access to datasources located in internal networks.

:::caution Security Note
Adding overly broad CIDR ranges to Allowed Networks may weaken SSRF protection. Only register the minimum required ranges.
:::

## AI Agent Integration

Registered datasources are automatically available to the AI assistant (`/ai`). When your question contains datasource keywords, the AI generates and executes queries automatically.

### Single Datasource Query

```
"Show CPU usage from Prometheus"
→ datasource route → auto-generate PromQL → analyze results
```

### Multi-Datasource Correlation

Query multiple datasources simultaneously for correlation analysis:

```
"Correlate Prometheus metrics with Loki error logs"
→ Prometheus PromQL + Loki LogQL parallel execution → combined analysis
```

### Cross-Source Analysis with AWS

Combine datasource queries with AWS resources for root cause analysis:

```
"Compare Prometheus CPU spike with CloudWatch alarms"
→ datasource + monitoring multi-route → cross-source correlation
```

:::tip AI Keywords
Keywords recognized by the AI assistant: **prometheus**, **loki**, **tempo**, **clickhouse**, **jaeger**, **dynatrace**, **datadog** (Korean keywords also supported)
:::

## Related Pages

- [Monitoring Dashboard](./monitoring.md) - System monitoring overview
- [CloudWatch](./cloudwatch) - AWS CloudWatch metrics
- [AI Assistant](../overview/ai-assistant) - AI analysis features
