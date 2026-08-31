import { describe, it, expect } from 'vitest';
import { MCP_PRESETS } from './mcp-presets';
import { INTEGRATION_KINDS_EGRESS } from './integration-validation';
import { KNOWN_CONNECTOR_SLUGS } from './integration-credentials';

describe('MCP_PRESETS lockstep', () => {
  it('every preset slug is a member of INTEGRATION_KINDS_EGRESS (no new kind introduced)', () => {
    for (const p of MCP_PRESETS) {
      expect((INTEGRATION_KINDS_EGRESS as readonly string[]).includes(p.slug)).toBe(true);
    }
  });

  it('every preset slug is a member of KNOWN_CONNECTOR_SLUGS (credential storage allowed)', () => {
    for (const p of MCP_PRESETS) {
      expect((KNOWN_CONNECTOR_SLUGS as readonly string[]).includes(p.slug)).toBe(true);
    }
  });

  it('has no duplicate slugs', () => {
    const slugs = MCP_PRESETS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('notion stays official=false (hosted MCP is OAuth-3LO-only, ADR-017 Context)', () => {
    expect(MCP_PRESETS.find((p) => p.slug === 'notion')?.official).toBe(false);
  });

  it('every ADR-017 official preset (all but notion) is marked official', () => {
    for (const p of MCP_PRESETS) {
      if (p.slug !== 'notion') expect(p.official).toBe(true);
    }
  });

  it('cards exist ONLY for vendor-hosted MCPs + notion (ADR-017 amendment 2026-08-05)', () => {
    // Self-hosted/in-binary kinds must never regain a token card: clickhouse is stdio-embedded in
    // the agent runtime, tempo/jaeger run via Datasources lambdas, grafana/splunk are unsupported.
    expect(MCP_PRESETS.map((p) => p.slug).sort()).toEqual(['datadog', 'dynatrace', 'newrelic', 'notion']);
  });
});
