// web/lib/skill-validation.test.ts
import { describe, it, expect } from 'vitest';
import { validateSkill, validateAgent, KNOWN_GATEWAYS, AGENT_TYPES } from './skill-validation';

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
