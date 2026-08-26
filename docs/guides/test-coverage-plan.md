# AWSops Test Coverage Plan

## Current State

- **Source files**: 165 files (~36,000 LOC)
- **Test files**: 0
- **Test framework**: None configured
- **Coverage**: 0%

## Recommended Framework

**Vitest** + `@testing-library/react` + `@testing-library/jest-dom`

### Why Vitest
- Native ESM support (critical for Next.js App Router)
- Faster than Jest for TypeScript projects
- Built-in coverage via c8/istanbul
- Compatible expect/mock API

### Installation
```bash
npm install -D vitest @vitejs/plugin-react @testing-library/react @testing-library/jest-dom jsdom
```

---

## Priority Tiers

### Tier 1 — Critical Business Logic (Week 1)

| File | LOC | What to Test |
|------|-----|-------------|
| `src/lib/steampipe.ts` | 307 | `buildSearchPath()` returns correct paths per account; `batchQuery()` handles errors/timeouts; cache key generation with account prefix; `runCostQueriesPerAccount()` merges results correctly |
| `src/lib/app-config.ts` | 163 | Config parsing with missing/malformed fields; account lookup; feature flag resolution; default values |
| `src/lib/auth-utils.ts` | 42 | JWT extraction with valid/invalid/expired tokens; missing claims handling |
| `src/contexts/AccountContext.tsx` | 109 | `useAccount()` hook returns correct state; account switching; default account selection |

**Estimated effort**: ~2 days
**Impact**: Covers the foundation all other code depends on

### Tier 2 — API Routes (Week 1-2)

| Route | LOC | What to Test |
|-------|-----|-------------|
| `api/ai/route.ts` | 1,660 | Route classification for all 10 categories; SSE stream format; error handling; multi-route detection |
| `api/steampipe/route.ts` | 561 | POST query execution; GET cost availability probe; PUT inventory; error responses |
| `api/report/route.ts` | 561 | Report generation flow; error handling for missing data |
| `api/benchmark/route.ts` | 116 | CIS compliance result formatting |

**Estimated effort**: ~3 days
**Impact**: Validates all data flows between frontend and backend

### Tier 3 — SQL Query Validation (Week 1, quick win)

Single test file covering all 25 query modules (`src/lib/queries/*.ts`):

```typescript
// src/lib/queries/__tests__/query-validation.test.ts
// For each query function in each module:
// 1. Query includes account_id column (project rule)
// 2. No $ characters in SQL (project rule)
// 3. No SCP-blocked columns: mfa_enabled, attached_policy_arns, Lambda tags
// 4. Query is non-empty string
// 5. Snapshot test to catch unintended changes
```

**Estimated effort**: ~0.5 day
**Impact**: Covers ~2,500 LOC of query logic; catches rule violations automatically

### Tier 4 — Collector/Analysis Modules (Week 2-3)

| Module | LOC | What to Test |
|--------|-----|-------------|
| `collectors/incident.ts` | 333 | Incident detection thresholds; false positive/negative scenarios |
| `collectors/idle-scan.ts` | 281 | Idle resource identification rules; edge cases |
| `collectors/db-optimize.ts` | 262 | Optimization recommendation logic |
| `collectors/msk-optimize.ts` | 362 | MSK-specific optimization rules |
| `collectors/eks-optimize.ts` | 238 | EKS rightsizing logic |

**Estimated effort**: ~3 days
**Impact**: Ensures optimization recommendations are correct

### Tier 5 — UI Components (Week 3)

| Component | LOC | What to Test |
|-----------|-----|-------------|
| `DataTable.tsx` | 165 | Rendering with data; auto Account column when `isMultiAccount && data[0].account_id`; empty state; sorting |
| `Sidebar.tsx` | 346 | All 36 navigation items render; active state; collapsed state |
| `AccountSelector.tsx` | 94 | Account list rendering; selection callback; multi-account badge |
| Chart components | 220 | Render without crashing; handle empty data |
| `StatsCard.tsx` | 57 | Color prop mapping (name not hex); value formatting |

**Estimated effort**: ~2 days
**Impact**: Prevents UI regressions

### Tier 6 — CDK Infrastructure (Week 3)

| Stack | LOC | What to Test |
|-------|-----|-------------|
| `awsops-stack.ts` | 609 | Snapshot test; verify VPC, ALB, EC2 resource creation |
| `cognito-stack.ts` | 262 | Snapshot test; verify User Pool config, Lambda@Edge |
| `agentcore-stack.ts` | 97 | Snapshot test |

**Estimated effort**: ~1 day
**Impact**: Catches unintended infrastructure drift

---

## Suggested File Structure

```
src/
├── lib/
│   ├── __tests__/
│   │   ├── steampipe.test.ts
│   │   ├── app-config.test.ts
│   │   ├── auth-utils.test.ts
│   │   ├── cache-warmer.test.ts
│   │   ├── resource-inventory.test.ts
│   │   └── cost-snapshot.test.ts
│   ├── queries/__tests__/
│   │   └── query-validation.test.ts
│   └── collectors/__tests__/
│       ├── incident.test.ts
│       ├── idle-scan.test.ts
│       ├── db-optimize.test.ts
│       └── msk-optimize.test.ts
├── app/api/
│   ├── ai/__tests__/
│   │   └── route.test.ts
│   ├── steampipe/__tests__/
│   │   └── route.test.ts
│   └── benchmark/__tests__/
│       └── route.test.ts
├── components/__tests__/
│   ├── DataTable.test.tsx
│   ├── AccountSelector.test.tsx
│   ├── StatsCard.test.tsx
│   └── Sidebar.test.tsx
└── contexts/__tests__/
    └── AccountContext.test.tsx
infra-cdk/
└── test/
    └── stacks.test.ts
```

## Coverage Targets

| Phase | Timeline | Target Coverage |
|-------|----------|----------------|
| Phase 1 | Week 1 | Tier 1 + 3 → ~15% line coverage |
| Phase 2 | Week 2 | + Tier 2 + 4 → ~40% line coverage |
| Phase 3 | Week 3 | + Tier 5 + 6 → ~55% line coverage |
| Ongoing | — | Target 70%+ for src/lib/, 50%+ for API routes |

## Highest-ROI Quick Wins

1. **Query validation test** (Tier 3) — 1 file tests 25 modules for project rule compliance
2. **`buildSearchPath` + `batchQuery` unit tests** — pure logic, no mocking needed for path builder
3. **`auth-utils.ts` tests** — small file, security-critical, easy to test
4. **AI route classifier tests** — extract classifier logic into pure function, test all 10 routes
5. **CDK snapshot tests** — trivial setup, catches infrastructure drift automatically
