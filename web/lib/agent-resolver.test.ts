// web/lib/agent-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { resolveAgent, pickCustomAgent, SAFEGUARD_LINE, MAX_PROVIDED_CONTEXT_CHARS } from './agent-resolver';
import type { AgentWithSkills } from './catalog';
import type { AgentSpace } from './agent-space';

const custom: AgentWithSkills = {
  id: 1, name: 'compliance', description: 'CIS expert', persona: 'You are a CIS auditor.',
  gateway: 'security', tier: 'custom', version: 3, enabled: true, routingKeywords: ['cis', 'benchmark'],
  skills: [
    { name: 'cis-pack', instructions: 'Always cite the control id.', contentHash: 'h1', ord: 0, toolAllowlist: ['simulate_principal_policy'] },
    { name: 'tone', instructions: 'Be concise.', contentHash: 'h2', ord: 1, toolAllowlist: [] },
  ],
};

describe('resolveAgent', () => {
  it('built-in passthrough when routeKey is not a custom agent (no override)', () => {
    const spec = resolveAgent('security', []);
    expect(spec.tier).toBe('builtin');
    expect(spec.gateway).toBe('security');
    expect(spec.skill).toBe('security');
    expect(spec.systemPromptOverride).toBeUndefined();
    expect(spec.skillHashes).toEqual([]);
  });

  it('composes safeguard + persona + ordered skills for a custom agent', () => {
    const spec = resolveAgent('compliance', [custom]);
    expect(spec.tier).toBe('custom');
    expect(spec.gateway).toBe('security');
    expect(spec.systemPromptOverride!.startsWith(SAFEGUARD_LINE)).toBe(true);
    expect(spec.systemPromptOverride).toContain('You are a CIS auditor.');
    const o = spec.systemPromptOverride!;
    expect(o.indexOf('Always cite')).toBeLessThan(o.indexOf('Be concise'));
    expect(spec.skillHashes).toEqual(['h1', 'h2']);
    expect(spec.toolAllowlist).toEqual(['simulate_principal_policy']);
    expect(spec.agentVersion).toBe(3);
    expect(spec.agentName).toBe('compliance');
  });

  it('falls back to built-in when the named agent is disabled/absent', () => {
    const spec = resolveAgent('compliance', [{ ...custom, enabled: false }]);
    expect(spec.tier).toBe('builtin');
    expect(spec.gateway).toBe('compliance'); // routeKey passes through as gateway
  });
});

describe('resolveAgent — Phase 2 server-side tool-allowlist enforcement', () => {
  // A custom agent declaring two tools at the security gateway. Both are REAL IAM tools present in
  // KNOWN_TOOL_CATALOG.security (ADR-039 Task 3 populated it from create_targets.py iam-mcp-target),
  // so the known-catalog intersection keeps both — the test still demonstrates the skill-declared union.
  const customTwoTools: AgentWithSkills = {
    ...custom,
    skills: [
      { name: 'cis-pack', instructions: 'Always cite the control id.', contentHash: 'h1', ord: 0,
        toolAllowlist: ['simulate_principal_policy', 'get_account_security_summary'] },
    ],
  };

  it('built-in branch is byte-identical to Phase 1 — a space has NO effect', () => {
    const space: AgentSpace = {
      accountId: 'a', toolAllowlist: ['x'], enabledAgentIds: [], enabledSkillIds: [], version: 5,
    };
    const spec = resolveAgent('security', [], space);
    expect(spec.tier).toBe('builtin');
    expect(spec.gateway).toBe('security');
    expect(spec.skill).toBe('security');
    expect(spec.agentName).toBe('security');
    expect(spec.skillHashes).toEqual([]);
    expect(spec.toolAllowlist).toBeUndefined();
    expect(spec.spaceVersion).toBeUndefined();
    // Must equal the no-space Phase-1 built-in output, key-for-key.
    expect(spec).toEqual(resolveAgent('security', []));
  });

  it('no space ⇒ skill-declared union ∩ known security catalog (both tools are valid IAM tools)', () => {
    const spec = resolveAgent('compliance', [customTwoTools]); // no 3rd arg
    expect(spec.toolAllowlist).toEqual(['simulate_principal_policy', 'get_account_security_summary']);
    expect(spec.spaceVersion).toBeUndefined();
  });

  it('enforcement removes a disallowed tool (account cap can only REMOVE)', () => {
    const space: AgentSpace = {
      accountId: 'a', toolAllowlist: ['simulate_principal_policy'],
      enabledAgentIds: [], enabledSkillIds: [], version: 2,
    };
    const spec = resolveAgent('compliance', [customTwoTools], space);
    expect(spec.toolAllowlist).toEqual(['simulate_principal_policy']);
  });

  it('empty space cap = no cap (advisory; equals Phase-1)', () => {
    const space: AgentSpace = {
      accountId: 'a', toolAllowlist: [], enabledAgentIds: [], enabledSkillIds: [], version: 7,
    };
    const spec = resolveAgent('compliance', [customTwoTools], space);
    expect(spec.toolAllowlist).toEqual(resolveAgent('compliance', [customTwoTools]).toolAllowlist);
  });

  it('carries spaceVersion on the custom spec when a space is passed, undefined otherwise', () => {
    const space: AgentSpace = {
      accountId: 'a', toolAllowlist: ['simulate_principal_policy'],
      enabledAgentIds: [], enabledSkillIds: [], version: 9,
    };
    expect(resolveAgent('compliance', [customTwoTools], space).spaceVersion).toBe(9);
    expect(resolveAgent('compliance', [customTwoTools]).spaceVersion).toBeUndefined();
  });
});

describe('pickCustomAgent', () => {
  it('matches an enabled custom agent by routing keyword (case-insensitive)', () => {
    expect(pickCustomAgent('run a CIS benchmark please', [custom])).toBe('compliance');
  });
  it('returns null when nothing matches', () => {
    expect(pickCustomAgent('what is my bill', [custom])).toBeNull();
  });
  it('ignores disabled candidates', () => {
    expect(pickCustomAgent('cis', [{ ...custom, enabled: false }])).toBeNull();
  });
});

describe('resolveAgent — ADR-039 egress-READ integration injection', () => {
  // custom is on the 'security' gateway whose KNOWN_TOOL_CATALOG has 14 IAM tools.
  it('integration tools BYPASS the gateway catalog (a non-IAM tool survives) and union with skill tools', () => {
    const spec = resolveAgent('compliance', [custom], null, [
      { name: 'dd', exposedTools: ['datadog_query'], providedContext: { dashboards: 5 } },
    ]);
    // skill tool (in the security catalog) AND the external integration tool (catalog-bypassed) both present
    expect(spec.toolAllowlist).toContain('simulate_principal_policy');
    expect(spec.toolAllowlist).toContain('datadog_query');
  });

  it('appends an "## Integration context" block to the system prompt (after SAFEGUARD/persona/skills)', () => {
    const spec = resolveAgent('compliance', [custom], null, [
      { name: 'dd', exposedTools: [], providedContext: { topology: 'svc-graph' } },
    ]);
    expect(spec.systemPromptOverride).toMatch(/## Integration context/);
    expect(spec.systemPromptOverride!.indexOf(SAFEGUARD_LINE)).toBe(0); // SAFEGUARD stays first
    expect(spec.systemPromptOverride).toMatch(/svc-graph/);
  });

  it('caps the combined integration context at MAX_PROVIDED_CONTEXT_CHARS', () => {
    const big = { name: 'big', exposedTools: [], providedContext: { blob: 'x'.repeat(5000) } };
    const spec = resolveAgent('compliance', [custom], null, [big]);
    // the integration block is bounded; total override is persona+skills + the capped block (+joins)
    const block = spec.systemPromptOverride!.split('## Integration context')[1] ?? '';
    expect(block.length).toBeLessThanOrEqual(MAX_PROVIDED_CONTEXT_CHARS + 2);
    expect(spec.systemPromptOverride).toMatch(/…\[truncated\]/);
  });

  it('integration tools are still subject to a non-empty Agent Space cap', () => {
    const space: AgentSpace = { accountId: 'a', toolAllowlist: ['datadog_query'], enabledAgentIds: [], enabledSkillIds: [], version: 1 };
    const spec = resolveAgent('compliance', [custom], space, [
      { name: 'dd', exposedTools: ['datadog_query', 'datadog_write'], providedContext: {} },
    ]);
    expect(spec.toolAllowlist).toContain('datadog_query');
    expect(spec.toolAllowlist).not.toContain('datadog_write'); // space cap removed it
  });

  it('no integrations passed ⇒ behavior is unchanged (Phase-2 baseline)', () => {
    const a = resolveAgent('compliance', [custom], null);
    const b = resolveAgent('compliance', [custom], null, []);
    expect(a.toolAllowlist).toEqual(b.toolAllowlist);
    expect(a.systemPromptOverride).toEqual(b.systemPromptOverride);
  });
});

describe('resolveAgent — ADR-039 P2-infra inc2 connection details (spec.integrations)', () => {
  const conn = {
    name: 'dd', exposedTools: ['datadog_query'], providedContext: { d: 1 },
    endpoint: 'https://mcp.datadoghq.com/mcp', transport: 'api_key',
    credentialsRef: 'arn:aws:secretsmanager:ap-northeast-2:1:secret:ops/awsops-v2/integrations/dd-xx',
    allowPrivate: false,
  };

  it('custom path surfaces connectable integrations with their connection details', () => {
    const spec = resolveAgent('compliance', [custom], null, [conn]);
    expect(spec.integrations).toEqual([{
      name: 'dd', endpoint: conn.endpoint, transport: 'api_key',
      credentialsRef: conn.credentialsRef, exposedTools: ['datadog_query'], allowPrivate: false,
    }]);
  });

  it('threads sigv4Service/sigv4Region + allowPrivate when present', () => {
    const sig = {
      name: 'apigw', exposedTools: ['q'], endpoint: 'https://x.execute-api.ap-northeast-2.amazonaws.com/mcp',
      transport: 'sigv4', sigv4Service: 'execute-api', sigv4Region: 'ap-northeast-2', allowPrivate: true,
    };
    const spec = resolveAgent('compliance', [custom], null, [sig]);
    expect(spec.integrations).toEqual([{
      name: 'apigw', endpoint: sig.endpoint, transport: 'sigv4', credentialsRef: undefined,
      exposedTools: ['q'], allowPrivate: true, sigv4Service: 'execute-api', sigv4Region: 'ap-northeast-2',
    }]);
  });

  it('an egress-READ integration WITHOUT endpoint/transport still injects tools+context but is NOT in the connect list', () => {
    const noConn = { name: 'ctx-only', exposedTools: ['t'], providedContext: { topology: 'g' } };
    const spec = resolveAgent('compliance', [custom], null, [noConn]);
    expect(spec.toolAllowlist).toContain('t');                      // tools still injected
    expect(spec.systemPromptOverride).toMatch(/topology/);          // context still injected
    expect(spec.integrations).toBeUndefined();                      // but nothing connectable
  });

  it('built-in path never carries integrations', () => {
    const spec = resolveAgent('security', [], null, [conn]);
    expect(spec.tier).toBe('builtin');
    expect(spec.integrations).toBeUndefined();
  });

  it('no integrations ⇒ spec.integrations undefined', () => {
    expect(resolveAgent('compliance', [custom], null).integrations).toBeUndefined();
    expect(resolveAgent('compliance', [custom], null, []).integrations).toBeUndefined();
  });
});

describe('resolveAgent — ADR-040/041 propose-only READ_WRITE', () => {
  it('surfaces write actions as a propose-only prompt block, NEVER as a live tool', () => {
    const spec = resolveAgent('compliance', [custom], null, [], [{ name: 'slack', writeActionRefs: ['slack.post_message'] }]);
    expect(spec.systemPromptOverride).toMatch(/## Proposable write actions/);
    expect(spec.systemPromptOverride).toMatch(/PROPOSE only, never execute/);
    expect(spec.systemPromptOverride).toMatch(/slack\.post_message/);
    expect(spec.toolAllowlist ?? []).not.toContain('slack.post_message'); // never a live tool
  });

  it('no proposable writes ⇒ prompt unchanged (Phase-2 baseline)', () => {
    const a = resolveAgent('compliance', [custom], null, []);
    const b = resolveAgent('compliance', [custom], null, [], []);
    expect(a.systemPromptOverride).toEqual(b.systemPromptOverride);
  });

  it('built-in path: proposable writes have no effect (no override)', () => {
    const spec = resolveAgent('security', [], null, [], [{ name: 'slack', writeActionRefs: ['slack.post_message'] }]);
    expect(spec.tier).toBe('builtin');
    expect(spec.systemPromptOverride).toBeUndefined();
  });
});
