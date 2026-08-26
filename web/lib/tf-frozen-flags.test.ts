import { describe, it, expect } from 'vitest';
import { variableDefault } from './tf-frozen-flags';

describe('variableDefault', () => {
  it('extracts the default of a named terraform variable block', () => {
    const tf = `
variable "remediation_enabled" {
  type        = bool
  description = "ADR-005 FROZEN. DO NOT ENABLE."
  default     = false
}
`;
    expect(variableDefault(tf, 'remediation_enabled')).toBe('false');
  });

  it('is not confused by a validation block nested before default', () => {
    const tf = `
variable "eks_auto_register_enabled" {
  type = bool
  validation {
    condition     = !var.eks_auto_register_enabled || var.workers_enabled
    error_message = "requires workers_enabled"
  }
  default = false
}
`;
    expect(variableDefault(tf, 'eks_auto_register_enabled')).toBe('false');
  });

  it('returns null for a variable name that is not declared', () => {
    const tf = `variable "remediation_enabled" { default = false }`;
    expect(variableDefault(tf, 'byo_mcp_enabled')).toBeNull();
  });
});
