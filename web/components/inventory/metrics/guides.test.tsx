import { describe, it, expect } from 'vitest';
import type { GuideSpec } from './DiagnosisGuide';
import {
  MSK_GUIDE, RDS_GUIDE, DDB_GUIDE, EC_GUIDE, OS_GUIDE, ALB_GUIDE,
  NLB_GUIDE, S3_GUIDE, EBS_GUIDE, EC2_GUIDE, LAMBDA_GUIDE, EKS_GUIDE, ANFW_GUIDE,
} from './guides';
import { GUIDES_EN } from './guides.en';
import { GUIDES_ZH } from './guides.zh';
import { GUIDES_JA } from './guides.ja';

// Lockstep guard: guides.tsx (ko source) and its en/zh/ja variants must stay structurally
// identical — same service keys, same section/item/priority-row shape. A translation that
// drops or reorders content fails here instead of silently rendering a shorter guide.

const KO: Record<string, GuideSpec> = Object.fromEntries(
  [MSK_GUIDE, RDS_GUIDE, DDB_GUIDE, EC_GUIDE, OS_GUIDE, ALB_GUIDE,
   NLB_GUIDE, S3_GUIDE, EBS_GUIDE, EC2_GUIDE, LAMBDA_GUIDE, EKS_GUIDE, ANFW_GUIDE].map((g) => [g.service, g]),
);
const VARIANTS: [string, Record<string, GuideSpec>][] = [['en', GUIDES_EN], ['zh', GUIDES_ZH], ['ja', GUIDES_JA]];

describe('diagnosis guide translations (lockstep)', () => {
  it('every variant defines exactly the ko service keys', () => {
    const koKeys = Object.keys(KO).sort();
    for (const [name, rec] of VARIANTS) {
      expect(Object.keys(rec).sort(), `GUIDES_${name.toUpperCase()} keyset`).toEqual(koKeys);
    }
  });

  it('every variant matches the ko structure per service', () => {
    for (const [name, rec] of VARIANTS) {
      for (const key of Object.keys(KO)) {
        const ko = KO[key];
        const v = rec[key];
        const at = `${name}:${key}`;
        expect(v.service, `${at} service`).toBe(ko.service);
        expect(v.sections.length, `${at} section count`).toBe(ko.sections.length);
        v.sections.forEach((s, i) => {
          expect(s.items.length, `${at} section[${i}] items`).toBe(ko.sections[i].items.length);
          expect(s.title.length, `${at} section[${i}] title`).toBeGreaterThan(0);
        });
        expect(v.priorityHeader.length, `${at} priorityHeader`).toBe(3);
        expect(v.priority.length, `${at} priority rows`).toBe(ko.priority.length);
      }
    }
  });

  it('ja rows keep metric names untranslated (spot check)', () => {
    const row = GUIDES_JA.MSK.priority[0];
    expect(row[0]).toBe('ActiveControllerCount');
    expect(GUIDES_JA.EKS.service).toBe('EKS');
  });
});
