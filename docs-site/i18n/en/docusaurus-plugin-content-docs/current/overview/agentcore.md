---
sidebar_position: 3
title: AgentCore
description: Amazon Bedrock AgentCore architecture and MCP tool details (v2)
---

import Screenshot from '@site/src/components/Screenshot';
import AgentCoreFlow from '@site/src/components/diagrams/AgentCoreFlow';

# AgentCore

AgentCore handles tool execution for the [AI Assistant](../overview/assistant), powered by Amazon Bedrock AgentCore Runtime and Gateway. Unlike v1's single-EC2 embedded approach, v2 splits everything out serverless: **Runtime + 9 section Gateways + Memory + Code Interpreter**.

<Screenshot src="/screenshots/overview/agentcore-routing.png" alt="AI Assistant routing badges" />

:::tip Customer-session point
**8 AWS-domain Gateways + external-obs (external observability) = 9 routed sections** · **144 MCP tools** across the full catalog · **23 Lambda slices** (17 gated on `agentcore_enabled`, 6 on `integrations_enabled`, both off by default) run serverless. The classifier routes each question to 1-3 routes and **calls them in parallel, then synthesizes**. → [Why AWSops](./why-awsops)
:::

## Architecture

![AgentCore Architecture](/diagrams/agentcore-architecture.png)

### AI Routing Flow

<AgentCoreFlow />

### Deployment Requirements

| Item | Requirement |
|------|-------------|
| **Docker** | arm64 required (`docker buildx --platform linux/arm64 --load`; `make agentcore` builds and pushes) |
| **agent.py** | Gateway URLs are injected via the `GATEWAYS_JSON` env (no per-account hardcoding) |
| **Code Interpreter / Memory** | No hyphens in name, underscores only |
| **Memory Store** | Max 365-day retention (`eventExpiryDuration`) |
| **Config source of truth** | **SSM** `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}` — written by `provision.py`, read by the web BFF at runtime (never exposed in the UI) |
| **Runtime updates** | Re-running the idempotent provisioner (`scripts/v2/agentcore/provision.py`) applies changes — a just-created Gateway not yet READY can make the first target creation fail; re-run resolves it |

## AgentCore Runtime

### Configuration

| Item | Description |
|------|-------------|
| **Engine** | Strands Agent Framework |
| **Container** | Docker arm64 (stored in ECR, via `make agentcore`) |
| **Execution Environment** | AgentCore managed service (Bedrock AgentCore Runtime) |
| **Model** | Claude Haiku 4.5 (ADR-038 routing classifier) / **the Runtime itself only ever runs Sonnet 4.6** (hardcoded in `agent/agent.py`). Opus 4.8 isn't used by the Runtime — it's an optional Deep-tier choice in the separate **AI Diagnosis (async worker)** feature |

### Status

- **READY**: Operating normally
- **CREATING**: Being created
- **UPDATING**: Being updated
- **FAILED**: Error state

## Gateway Details

v2 has 8 AWS-domain Gateways (`awsops-v2-{network,container,data,security,cost,monitoring,iac,ops}-gateway`) plus **external-obs** — a routed section hosting external-observability/integration connectors, chat-aliased to the `observability` routing key. Tool counts below are from the full catalog (`scripts/v2/agentcore/catalog.py`); actual activation is staged behind the `agentcore_enabled`/`integrations_enabled` flags (P3 — currently only a subset is deployed read-only).

### Network Gateway (16 tools)

Provides VPC, ENI, Reachability, Flow Logs, TGW, VPN, and Network Firewall tools.

| Category | Tools |
|----------|-------|
| **flow-monitor** | `query_flow_logs` |
| **network-mcp** | `get_path_trace_methodology`, `find_ip_address`, `get_eni_details`, `list_vpcs`, `get_vpc_network_details`, `get_vpc_flow_logs`, `describe_network`, `list_transit_gateways`, `get_tgw_details`, `get_tgw_routes`, `get_all_tgw_routes`, `list_tgw_peerings`, `list_vpn_connections`, `list_network_firewalls`, `get_firewall_rules` |

### Container Gateway (12 tools)

Provides EKS and ECS tools.

| Category | Tools |
|----------|-------|
| **eks-mcp** | `list_eks_clusters`, `get_eks_vpc_config`, `get_eks_insights`, `get_cloudwatch_logs`, `get_cloudwatch_metrics`, `get_eks_metrics_guidance`, `get_policies_for_role`, `search_eks_troubleshoot_guide`, `generate_app_manifest` |
| **ecs-mcp** | `ecs_resource_management`, `ecs_troubleshooting_tool`, `wait_for_service_ready` |

### IaC Gateway (12 tools)

Provides Infrastructure as Code tools.

| Category | Tools |
|----------|-------|
| **iac-mcp** | `validate_cloudformation_template`, `check_cloudformation_template_compliance`, `troubleshoot_cloudformation_deployment`, `search_cdk_documentation`, `search_cloudformation_documentation`, `cdk_best_practices`, `read_iac_documentation_page` |
| **terraform-mcp** | `SearchAwsProviderDocs`, `SearchAwsccProviderDocs`, `SearchSpecificAwsIaModules`, `SearchUserProvidedModule`, `terraform_best_practices` |

### Data Gateway (28 tools)

Provides AWS database and streaming service tools.

| Category | Tools |
|----------|-------|
| **rds-mcp** | `list_db_instances`, `list_db_clusters`, `describe_db_instance`, `describe_db_cluster`, `execute_sql`, `list_snapshots` |
| **dynamodb-mcp** | `list_tables`, `describe_table`, `query_table`, `get_item`, `dynamodb_data_modeling`, `compute_performances_and_costs` |
| **msk-mcp** | `list_clusters`, `get_cluster_info`, `get_configuration_info`, `get_bootstrap_brokers`, `list_nodes`, `msk_best_practices` |
| **valkey-mcp** | `list_cache_clusters`, `describe_cache_cluster`, `list_replication_groups`, `describe_replication_group`, `list_serverless_caches`, `elasticache_best_practices` |
| **clickhouse-mcp** (`integrations_enabled`) | 4 ClickHouse query tools |

### Security Gateway (14 tools)

Provides IAM and security analysis tools. (Deployed in P1f.)

| Tool | Description |
|------|-------------|
| `list_users` / `get_user` | List/detail IAM users |
| `list_roles` / `get_role_details` | List/detail IAM roles |
| `list_groups` / `get_group` | List/detail IAM groups |
| `list_policies` | List policies |
| `list_user_policies` / `list_role_policies` | List user/role policies |
| `get_user_policy` / `get_role_policy` | User/role inline policy |
| `list_access_keys` | List Access Keys |
| `simulate_principal_policy` | Policy simulation |
| `get_account_security_summary` | Account security summary |

### Monitoring Gateway (40 tools)

Provides CloudWatch and CloudTrail (AWS-native), plus OpenSearch and the Prometheus/Loki/Tempo/Mimir observability stack.

| Category | Tools |
|----------|-------|
| **cloudwatch-mcp** (11) | Metrics/alarms/log-insights queries |
| **cloudtrail-mcp** (5) | `lookup_events`, `list_event_data_stores`, `lake_query`, `get_query_status`, `get_query_results` |
| **opensearch-mcp** (4) | OpenSearch domain/index queries |
| **prometheus-mcp / loki-mcp / tempo-mcp / mimir-mcp** (5 each, `integrations_enabled`) | PromQL/LogQL/TraceQL queries — Loki/Tempo/Mimir stay on this Gateway (ADR-004) |

### Cost Gateway (14 tools)

Provides cost analysis, forecasting, and FinOps tools.

| Category | Tools |
|----------|-------|
| **cost-mcp** (9) | `get_today_date`, `get_cost_and_usage`, `get_cost_and_usage_comparisons`, `get_cost_comparison_drivers`, `get_cost_forecast`, `get_dimension_values`, `get_tag_values`, `get_pricing`, `list_budgets` |
| **finops-mcp** (5) | Compute Optimizer rightsizing, RI/SP recommendations, Cost Optimization Hub, Trusted Advisor |

### Ops Gateway (5 tools)

Provides AWS documentation / general operations tools (`aws-knowledge`).

### External-Obs (3 tools, routing key: `observability`)

The 9th routed section, hosting external-observability/integration connectors (ADR-004, amended 2026-06-24). The catalog defines `notion-mcp` (3 tools) here, gated on `integrations_enabled` (off by default). Prometheus/ClickHouse live on the Monitoring/Data Gateways instead (see Gateway Details above), not on this section.

## Code Interpreter

Provides a sandbox environment for Python code execution.

### Features

- **Isolated environment**: Secure Python execution
- **Data analysis**: Library support for pandas, numpy, etc.
- **Visualization**: Chart generation with matplotlib, plotly, etc.
- **File processing**: Data parsing for JSON, CSV, etc.

### Usage Examples

```
"Visualize AWS cost data as a monthly trend chart"
"Parse this JSON data and calculate statistics"
```

## Routing Display (AI Assistant)

Instead of v1's separate "AgentCore" dashboard page (call statistics, config lookup), v2 shows routing information inline **inside the [AI Assistant](../overview/assistant) chat screen**.

- Each answer shows a **badge** for which section (Gateway) handled it.
- Answers synthesized from multiple domains in parallel show **"via" chips**, one per contributing Gateway (e.g. `multi:network+data`).
- Up to two **alternate-route chips** let you re-ask via a different route.
- The chat rail lists recent conversation threads (no full-text search yet).

The AgentCore Runtime ARN, Memory ID, and similar config values live **only in SSM** and are never exposed in the UI (operators check via `terraform output` / SSM).

## Known Limitations

| Item | Limitation |
|------|------------|
| **Docker architecture** | arm64 required |
| **Code Interpreter / Memory name** | No hyphens, underscores only |
| **Conversation history retention** | Maximum 365 days |
| **AgentCore response** | Returns final text only (tool inference streamed with a typing effect) |
| **Fleet not fully deployed** | Only a subset of the catalog's 23 slices is deployed read-only in P1f (full activation is P3) |

## Next Steps

- [AI Assistant](../overview/assistant) - Using AI features
- [Dashboard](../overview/dashboard) - Return to dashboard
