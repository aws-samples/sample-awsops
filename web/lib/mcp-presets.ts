// web/lib/mcp-presets.ts
// ADR-017 — curated official-vendor MCP presets, surfaced as cards on the Integrations hub's
// Connectors tab (web/app/integrations/connectors/ConnectorsTab.tsx). Registering here does NOT
// create a new integration `kind` — every slug below is already a member of
// INTEGRATION_KINDS_EGRESS (web/lib/integration-validation.ts) and of KNOWN_CONNECTOR_SLUGS
// (web/lib/integration-credentials.ts); this file only adds curated UI metadata + the ADR-017
// "official MCP" framing on top of the existing egress/credential machinery.
//
// Credential PAYLOAD shape written by ConnectorsTab is the SAME as the existing Notion flow —
// `PUT /api/integrations/credential { slug, secret: { token }, official: true }` — but the
// namespaced STORAGE KEY differs from Notion's: `official: true` routes to setMcpPresetCredential
// (web/lib/integration-credentials.ts), which stores under `mcp:<slug>`, not the plain slug.
// scripts/v2/agentcore/provision.py's ensure_mcp_server_targets reads `secret["mcp:" + preset_key].token`
// as the single bearer/API-key value for the AgentCore Identity credential provider (see
// catalog.py MCP_SERVER_TARGETS auth.credential_parameter_name — always one header slot).
//
// SOURCE OF TRUTH lockstep (mcp-presets.test.ts): every slug here must be a member of both
// INTEGRATION_KINDS_EGRESS and KNOWN_CONNECTOR_SLUGS.
import { KNOWN_CONNECTOR_SLUGS } from '@/lib/integration-credentials';

export interface McpPreset {
  slug: (typeof KNOWN_CONNECTOR_SLUGS)[number];
  label: string;
  /** true = a vendor-official MCP server exists for this kind (ADR-017). false = kept on the
   *  existing token-connector path because no official MCP exists (n/a here — Prometheus/Mimir
   *  stay off this catalog entirely) or the official MCP is OAuth-only / hosted-3LO (Notion). */
  official: boolean;
  /** Vendor's own server/API is in preview — surfaced as a badge, not a functional gate. */
  preview?: boolean;
  help: string;
  docsUrl: string;
  readOnlyNote: string;
}

// ADR-017 amendment 2026-08-05: cards exist ONLY for vendors where "paste one token" is a real
// vendor capability — Notion (direct token connector, works today) + the 3 vendor-HOSTED official
// MCPs (Datadog/Dynatrace/New Relic; gated behind official_mcp_enabled + per-preset ack, so the
// card stores the credential in advance and says so honestly). The self-hosted/in-binary kinds
// (clickhouse/tempo/jaeger/grafana/splunk) have NO card: ClickHouse's official MCP is
// stdio-embedded in the agent runtime off the existing Datasources registration
// (CLICKHOUSE_OFFICIAL_MCP), tempo/jaeger run on the in-house lambdas via Datasources,
// grafana/splunk are unsupported.
export const MCP_PRESETS: McpPreset[] = [
  {
    slug: 'notion',
    label: 'Notion',
    official: false,
    help: 'notion.so/my-integrations 에서 내부 통합을 만들고 토큰을 붙여넣으세요.',
    docsUrl: 'https://developers.notion.com/docs/get-started-with-mcp',
    readOnlyNote: '읽기 전용',
  },
  {
    slug: 'datadog',
    label: 'Datadog',
    official: true,
    help: 'Datadog 공식 hosted MCP. Personal/Service Access Token(bearer)을 붙여넣으세요.',
    docsUrl: 'https://docs.datadoghq.com/mcp_server/setup/',
    readOnlyNote: 'RBAC mcp_read + 런타임 allowlist',
  },
  {
    slug: 'dynatrace',
    label: 'Dynatrace',
    official: true,
    help: 'Dynatrace 공식 hosted MCP 게이트웨이. Platform Token을 붙여넣으세요.',
    docsUrl: 'https://docs.dynatrace.com/docs/dynatrace-intelligence/dynatrace-mcp',
    readOnlyNote: '스코프 기반 read + 런타임 allowlist',
  },
  {
    slug: 'newrelic',
    label: 'New Relic',
    official: true,
    preview: true,
    help: 'New Relic 공식 MCP(mcp.newrelic.com, Preview). 읽기 전용 User API Key를 붙여넣으세요.',
    docsUrl: 'https://docs.newrelic.com/docs/agentic-ai/mcp/overview/',
    readOnlyNote: '벤더 preview + 런타임 allowlist',
  },
];
