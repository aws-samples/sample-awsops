// Task 22 — AWS-freeze regression: the datasource/connector work must NOT enable any mutating /
// autonomous / external-write capability. These flags are permanently frozen (2026-06-11 reversal,
// ADR-005). A default-value assertion fails CI if someone flips a default to true.
//
// Reads terraform/foundation/variables.tf (committed, always present in CI) — NOT
// terraform.tfvars (gitignored, per-environment, never present on a CI runner; the original
// version of this test read tfvars directly and had never actually run in CI before the
// merge-verify gate existed, silently checking flag names — remediation_execute_enabled,
// autonomous_enabled, autonomous_mitigation_enabled, mutating_tools_enabled, byo_mcp_enabled —
// that were renamed away and no longer exist, so 5 of 7 assertions were vacuously true).
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { variableDefault } from '../tf-frozen-flags';

const VARIABLES_TF = new URL('../../../terraform/foundation/variables.tf', import.meta.url);

describe('AWS-resource-mutation / external-write freeze (ADR-005)', () => {
  const tf = readFileSync(VARIABLES_TF, 'utf8');

  it('external integration WRITE stays disabled by default (propose-only / flag-OFF)', () => {
    expect(variableDefault(tf, 'integrations_write_enabled')).toBe('false');
  });

  it('the remediation/autonomous mutating substrate stays disabled by default', () => {
    expect(variableDefault(tf, 'remediation_enabled')).toBe('false');
  });
});
