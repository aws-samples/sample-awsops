---
sidebar_position: 2
title: Custom Agents
description: Admin page to configure the assistant’s agents, skills, integrations, and tools
---

import Screenshot from '@site/src/components/Screenshot';

# Custom Agents

A page for configuring how the AI assistant behaves through agents, skills, integrations, and tools.

<Screenshot src="/screenshots/operations/custom-agents.png" alt="Custom Agents & Skills" />

:::info Admin only
This page is available to **admins** only (the Cognito admins group or the SSM admin allowlist). Non-admin users see an access-denied screen.
:::

## Features

### New Agent
Create a new agent that defines how the assistant responds.

- **name**: agent name (kebab-case)
- **description**: agent description
- **persona**: system prompt (the agent's voice and perspective)
- **gateway**: area of focus — **network**, **container**, **iac**, **data**, **security**, **monitoring**, **cost**, **ops**
- **routing keywords**: keywords that route questions to this agent (comma-separated)
- **agent type**: lifecycle role — **generic**, **on_demand**, **triage**, **rca**, **mitigation**, **evaluation**

### New Skill
Create a reusable skill shared across agents.

- **name** / **description**: skill name and description
- **instructions**: how the skill should be performed
- **agent types (targeting)**: which agent types the skill applies to (multi-select checkboxes)

### Agents / Skills lists
- New agents and skills start **Disabled** and are toggled on in the lists below.
- Built-in items show a **built-in** label and are not toggleable.

### Data-source connectors
Connect read-only observability connectors (**Prometheus**, **Loki**, **Tempo**, **Mimir**, **ClickHouse**).

- Enter the **endpoint** and credentials to connect. Credentials are stored server-side and are never shown back.
- Use **Refresh schema** to cache the schema so the assistant can query that data source.

### Advanced
The **Advanced — register custom integration** section registers custom egress/ingress integrations.

### Agent Space
Choose which agents, skills, and integrations are active for the account, plus a **tool allowlist**, then save. The version increments on each save.

## How to use
1. Click **AI Operations > Custom Agents** in the sidebar
2. In **New Agent**, enter name, description, and persona, pick a **gateway** and **agent type**, add routing keywords, and create
3. Optionally create a skill in **New Skill** and select the **agent types** it applies to
4. Toggle the new items on in the **Agents** / **Skills** lists below
5. In **Data-source connectors**, enter an endpoint and credentials to connect, then **Refresh schema** to cache it
6. In **Agent Space**, choose the active items and tool allowlist, then click **Save Agent Space**

:::tip They start disabled
New agents and skills are not enabled automatically. You must toggle them on in the lists and include them in the **Agent Space**, then save, for them to take effect in the assistant.
:::

:::info Credentials are not shown back
Connector credentials are not displayed after saving. To change them, re-enter the values and click **Update**.
:::

## Related pages
- [Datasource Explorer](../observability/datasources) - Explore the observability data sources you connected
- [AI Assistant](../overview/assistant) - Chat with the agents you configured

## Policy compatibility and rollout

Built-in/collector routing keys (for example `security` and `aws-data`) are reserved: new custom names are rejected with 400, and existing conflicting rows remain stored but no longer route. Review saved names and skill bindings. Gateway grants use `target___tool`; a bare alias must uniquely match within that gateway. A saved cap that no longer intersects can produce deny-all. Caps only remove declared tools; integration-only agents receive no implicit gateway grant.

Once configured, a tool restriction survives emptying, disabling or detaching its skill. The migration backfills current bindings, including disabled skills; the API has no reset to unrestricted mode. Restrictions removed before migration cannot be reconstructed, so review existing configurations. Legacy unrestricted mode requires no retained tool restriction and no current cap or integration tool grant.

Apply `01M2K0BTQ4P4QHHFHR44ZK1YW6_agent_tool_policy_history.sql` through the reviewed standalone migration flow before the Web rollout. Automatic Web migration rejects its ALTER/trigger statements. Initial custom-policy failure returns `/api/chat` 503 except for explicit built-in pins in hybrid mode (default hybrid=false has no exemption; product help also 503s on initial failure). After a successful initial read, final enablement failure leaves a custom pin unavailable without invocation; automatic routing uses a built-in with a persisted notice. Product help bypasses that final read. A failed `/api/customization` GET policy read also returns 503.
