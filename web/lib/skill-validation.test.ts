// web/lib/skill-validation.test.ts
import { describe, it, expect } from 'vitest';
import catalog from './gateway-tool-catalog.json';
import { validateSkill, validateAgent, KNOWN_GATEWAYS, AGENT_TYPES, toolPolicyErrors } from './skill-validation';

describe('skill-validation', () => {
  it('accepts a well-formed skill', () => {
    expect(validateSkill({ name: 'cis-pack', description: 'CIS checks', instructions: 'do CIS', toolAllowlist: [] }).ok).toBe(true);
  });
  it('rejects empty name and over-long instructions', () => {
    expect(validateSkill({ name: '', description: 'd', instructions: 'i', toolAllowlist: [] }).ok).toBe(false);
    expect(validateSkill({ name: 'n', description: 'd', instructions: 'x'.repeat(50_001), toolAllowlist: [] }).ok).toBe(false);
  });
  it('rejects a non-kebab name', () => {
    expect(validateSkill({ name: 'Bad Name', description: 'd', instructions: 'i', toolAllowlist: [] }).ok).toBe(false);
  });
  it('rejects a non-string-array toolAllowlist', () => {
    expect(validateSkill({ name: 'n', description: 'd', instructions: 'i', toolAllowlist: [1, 2] }).ok).toBe(false);
  });
  it('rejects an agent on an unknown gateway, accepts a known one', () => {
    expect(validateAgent({ name: 'a', description: 'd', persona: 'p', gateway: 'nope', routingKeywords: [] }).ok).toBe(false);
    expect(validateAgent({ name: 'compliance', description: 'd', persona: 'p', gateway: 'security', routingKeywords: ['cis'] }).ok).toBe(true);
    expect(KNOWN_GATEWAYS).toContain('security');
    // ADR-004: observability is now a routed section → custom agents may target it.
    expect(KNOWN_GATEWAYS).toContain('observability');
    expect(validateAgent({ name: 'obs', description: 'd', persona: 'p', gateway: 'observability', routingKeywords: ['promql'] }).ok).toBe(true);
  });

  it('AGENT_TYPES has the 6 lifecycle roles (source of truth shared with the migration CHECK)', () => {
    expect([...AGENT_TYPES]).toEqual(['generic', 'on_demand', 'triage', 'rca', 'mitigation', 'evaluation']);
  });

  it('validateAgent: agentType must be in AGENT_TYPES; gateways must each be a known gateway', () => {
    expect(validateAgent({ name: 'agt', description: 'd', gateway: 'ops', routingKeywords: [], agentType: 'bogus' }).ok).toBe(false);
    expect(validateAgent({ name: 'agt', description: 'd', gateway: 'ops', routingKeywords: [], agentType: 'triage' }).ok).toBe(true);
    expect(validateAgent({ name: 'agt', description: 'd', gateway: 'ops', routingKeywords: [], gateways: ['ops', 'nope'] }).ok).toBe(false);
    expect(validateAgent({ name: 'agt', description: 'd', gateway: 'ops', routingKeywords: [], gateways: ['ops', 'monitoring'] }).ok).toBe(true);
    // omitted (undefined) optional fields are accepted (defaults applied downstream)
    expect(validateAgent({ name: 'agt', description: 'd', gateway: 'ops', routingKeywords: [] }).ok).toBe(true);
  });

  it('validateSkill: agentTypes must each be in AGENT_TYPES; referenceKeys must be string[]', () => {
    expect(validateSkill({ name: 'sk', description: 'd', instructions: 'i', toolAllowlist: [], agentTypes: ['rca'] }).ok).toBe(true);
    expect(validateSkill({ name: 'sk', description: 'd', instructions: 'i', toolAllowlist: [], agentTypes: ['nope'] }).ok).toBe(false);
    expect(validateSkill({ name: 'sk', description: 'd', instructions: 'i', toolAllowlist: [], referenceKeys: [1] as unknown as string[] }).ok).toBe(false);
  });
});


it.each(['security', 'observability', 'code', 'auto'])('reserves the %s command identity', name => {
  expect(validateAgent({ name, description: 'd', persona: '', gateway: 'ops', routingKeywords: ['test'] }).ok).toBe(false);
});

describe('catalog tool declarations', () => {
  it.each(['not_a_real_tool', 'foreign___list_users', '!awsops-deny-all!'])('rejects unknown declaration %s before registration', tool => {
    expect(validateSkill({ name: 'scope', description: 'd', instructions: 'i', toolAllowlist: [tool] }).ok).toBe(false);
  });
  it('accepts instruction-only and known shared-gateway declarations', () => {
    for (const tools of [[], ['iam-mcp-target___list_users', 'prometheus-mcp-target___prometheus_query']])
      expect(validateSkill({ name: 'scope', description: 'd', instructions: 'i', toolAllowlist: tools }).ok).toBe(true);
  });
});

it('rejects ambiguous shorthand while preserving exact target declarations', () => {
  const fixture = catalog as Record<string, { gateway: string; tools: string[] }>;
  fixture['fixture-one'] = { gateway: 'security', tools: ['fixture_query'] };
  fixture['fixture-two'] = { gateway: 'security', tools: ['fixture_query'] };
  try {
    expect(toolPolicyErrors(['fixture_query'], 'security')).toContain('Ambiguous tool for gateway security');
    expect(toolPolicyErrors(['fixture-one___fixture_query'], 'security')).toEqual([]);
  } finally { delete fixture['fixture-one']; delete fixture['fixture-two']; }
});
