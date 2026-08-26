import { describe, it, expect } from 'vitest';
import { diffReports } from './diff';

// A verdict is {id, kind, target, severity, passed, observed}. `summary.drift` holds the FAILED ones.
const v = (id: number, sev = 'critical') => ({
  id,
  kind: 'private_only',
  target: 'rds',
  severity: sev,
  passed: false,
  observed: `internet→rds edges: 1 (#${id})`,
});

describe('diffReports — report-vs-parent regression diff (pure)', () => {
  it('flags a drift that newly fails (in current.drift, not in parent.drift) as a regression', () => {
    const current = { drift: [v(1), v(2)] };
    const parent = { drift: [v(1)] };
    const d = diffReports(current, parent);
    expect(d.regressions.map((r) => r.id)).toEqual([2]);
    expect(d.improvements).toEqual([]);
  });

  it('flags a drift that no longer fails as an improvement', () => {
    const current = { drift: [v(1)] };
    const parent = { drift: [v(1), v(3)] };
    const d = diffReports(current, parent);
    expect(d.regressions).toEqual([]);
    expect(d.improvements).toEqual([3]);
  });

  it('flags a posture severity count that increased as a regression entry', () => {
    const current = { drift: [], posture: { critical: 3, warning: 1 } };
    const parent = { drift: [], posture: { critical: 1, warning: 1 } };
    const d = diffReports(current, parent);
    expect(d.regressions.some((r) => r.kind === 'posture' && r.severity === 'critical')).toBe(true);
  });

  it('a posture severity count that decreased is an improvement, not a regression', () => {
    const current = { drift: [], posture: { critical: 1 } };
    const parent = { drift: [], posture: { critical: 4 } };
    const d = diffReports(current, parent);
    expect(d.regressions).toEqual([]);
    expect(d.improvements).toContain('posture:critical');
  });

  it('returns empty regressions/improvements for identical inputs', () => {
    const same = { drift: [v(1), v(2)], posture: { critical: 2 } };
    const d = diffReports(same, { ...same });
    expect(d.regressions).toEqual([]);
    expect(d.improvements).toEqual([]);
    expect(d.unchanged).toBe(true);
  });

  it('treats a null/absent parent as no regression (first report)', () => {
    const current = { drift: [v(1)] };
    const d = diffReports(current, null);
    expect(d.regressions).toEqual([]);
    expect(d.improvements).toEqual([]);
    expect(d.unchanged).toBe(false); // nothing to compare against, but not "unchanged"
  });
});
