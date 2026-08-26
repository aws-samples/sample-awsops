// Guard integration (NO mocks): every SQL a collector will feed into runSteampipeQuery must pass
// the real aws-data SELECT-only guard — a collector shipping a blocked statement would silently
// lose that category at runtime (fail-open hides it), so we pin it here at build time.
import { describe, it, expect } from 'vitest';
import { isSelectOnly } from '../aws-data';
import { IDLE_CATEGORIES } from './idle-scan';
import { EKS_SQL } from './eks-optimize';
import { DB_SQL } from './db-optimize';
import { MSK_SQL } from './msk-optimize';
import { TRACE_SQL } from './trace-analyze';
import { INCIDENT_SQL } from './incident';

// Every named-SQL map a collector ships — a new collector adds its export here.
const SQL_MAPS: Record<string, Record<string, string>> = {
  'eks-optimize': EKS_SQL,
  'db-optimize': DB_SQL,
  'msk-optimize': MSK_SQL,
  'trace-analyze': TRACE_SQL,
  incident: INCIDENT_SQL,
};

describe('collector SQL × aws-data SELECT-only guard', () => {
  it('every idle-scan category SQL passes isSelectOnly', () => {
    for (const cat of IDLE_CATEGORIES) {
      expect(isSelectOnly(cat.sql), `idle-scan ${cat.key}`).toBe(true);
    }
  });
  it('every named collector SQL passes isSelectOnly', () => {
    for (const [collector, map] of Object.entries(SQL_MAPS)) {
      for (const [key, sql] of Object.entries(map)) {
        expect(isSelectOnly(sql), `${collector} ${key}`).toBe(true);
      }
    }
  });
  it('idle-scan SQLs carry account_id/region for multi-account visibility (v1 rule)', () => {
    for (const cat of IDLE_CATEGORIES) {
      expect(cat.sql, `idle-scan ${cat.key}`).toContain('account_id');
      expect(cat.sql, `idle-scan ${cat.key}`).toContain('region');
    }
  });
  it('AWS-table list SQLs carry account_id for multi-account visibility (v1 rule)', () => {
    // kubernetes_* tables have no account_id; every aws_* list query must include it.
    const awsListSql = [
      DB_SQL.rdsInstances, DB_SQL.ecClusters, DB_SQL.osDomains,
      MSK_SQL.clusters, TRACE_SQL.albs, INCIDENT_SQL.alarms,
    ];
    for (const sql of awsListSql) expect(sql).toContain('account_id');
  });
  it('every collector SQL is bounded by an explicit LIMIT (row-cap belt and suspenders)', () => {
    for (const cat of IDLE_CATEGORIES) expect(/limit \d+/i.test(cat.sql), `idle-scan ${cat.key}`).toBe(true);
    for (const [collector, map] of Object.entries(SQL_MAPS)) {
      for (const [key, sql] of Object.entries(map)) {
        expect(/limit \d+/i.test(sql), `${collector} ${key}`).toBe(true);
      }
    }
  });
});
