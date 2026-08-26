# ADR-031 Phase 2 (v2) — Per-Account Agent Spaces + Tool-Allowlist Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the **v2-native** plan — it targets `web/` + Aurora + SSM, NOT v1 `src/`/`data/config.json` (per ADR-031 Consensus Addendum #3). Do NOT touch v1 `src/`.

**Goal:** Extend the **LIVE** ADR-031 Phase-1 catalog (custom agents/skills + resolver + admin UI + registry-agnostic `agent.py`) with (a) a **per-account Agent Space** (`{account_id, enabled_agent_ids[], enabled_skill_ids[], tool_allowlist[], version}`, ADR-008) that scopes which globally-enabled custom agents/skills are active per account, and (b) **server-side tool-allowlist ENFORCEMENT** — the key Phase-2 deliverable. Phase 1 left `toolAllowlist` ADVISORY; Phase 2 makes the resolved spec's `toolAllowlist` an **enforced intersection** (a skill cannot grant a tool the Agent Space does not allow) computed **outside the model** (Consensus Addendum #5). This ships **safe-by-degradation**, not behind an off switch: with **NO `agent_spaces` row, behavior is byte-for-byte identical to the live Phase 1** (all globally-enabled custom agents available, no extra scoping).

**Architecture (v2):** This is a **non-mutating enhancement + security hardening that extends LIVE Phase-1 code** — it is **NOT a new flag-gated-OFF capability**. The degrade-safe rule is the load-bearing invariant:

- A new always-present `agent_spaces` table (migration **v8**, account-keyed) holds the optional per-account scope. **No row ⇒ Phase-1 global behavior.** It is never required to exist; absence is the safe default, not an error.
- `web/lib/agent-space.ts` (new) does get/upsert of the effective Agent Space, bumps `version` on change, and writes audit — reusing the live `customization_audit` table + `writeAudit`.
- `web/lib/catalog-source.ts` `getEnabledCustomAgents()` becomes **account-aware**: `getEnabledCustomAgents(accountId?)`. It still starts from the live "globally-enabled custom agents" set; **if a space row exists** it filters that set to `enabled_agent_ids`/`enabled_skill_ids`; **if no space row exists it returns the live Phase-1 set unchanged.** Cache key includes `accountId` + space `version`.
- `web/lib/agent-resolver.ts` `resolveAgent(routeKey, candidates, space?)` performs the **server-side tool-allowlist intersection** for **custom agents only**. The resolved `toolAllowlist` = `(union of the agent's enabled-skill tools) ∩ (known-tool catalog for the agent's gateway) ∩ (Agent Space tool_allowlist, when a space exists with a non-empty list)`. **Built-in agents (tier=builtin) pass through UNCHANGED** — they are never tool-scoped (the 8 gateways use `SKILL_BASE` + their full live gateway tool set). There are **0 custom agents live**, so enforcement is **inert** until customs exist; the built-in path must not regress.
- `web/app/api/chat/route.ts` resolves the **current account** (default = host account; see account-context mechanism below), loads the effective space, threads `accountId` into both `resolveAgent(...)` and the `invokeAgent(...)` payload. `agent.py` already reads `payload.get('accountId')`/`accountAlias` (~line 424) — we just supply it.
- `web/lib/trace.ts` records the Agent Space `version` alongside the existing `skillHashes`/`agentVersion`.

**Account-context mechanism (single-account-safe + multi-account-ready):** v2 has **no account selector UI** and one live account (`123456789012`). The web tier already uses the literal `'self'` as its single-account convention (`inventory.ts`, `inventory/summary`). We add `web/lib/account.ts` `currentAccountId()` that returns `process.env.HOST_ACCOUNT_ID` (wired in `workload.tf` from the existing `data.aws_caller_identity.current.account_id` in `ai.tf`) and falls back to the literal `'self'` when unset (test/local). The `agent_spaces` table is keyed by `account_id TEXT`, so seeding a row for `123456789012` (or `'self'`) scopes today's single account, and adding rows for other account ids is forward-ready with **zero schema change**. No STS call on the hot path (env is resolved once at task start). This is the *minimal* mechanism: it makes multi-account a data concern, not a code concern, while single-account works with no configuration at all (no row ⇒ Phase-1 behavior).

**Tech Stack:** Next.js 14 App Router (TS, `web/`, root path — no basePath), Aurora PostgreSQL 17.9 via node-pg (`web/lib/db.ts` `getPool()`), Strands `agent/agent.py` on AgentCore Runtime (arm64), vitest (`web/**/*.test.ts(x)`). Admin gate via `web/lib/admin.ts` `isAdmin(user)` (cognito:groups + SSM admin emails). Migration applied by in-VPC `psql` (no migration Lambda in v2).

**Key contracts (do not break) — these are LIVE Phase-1 files/functions you EXTEND:**

- **`web/lib/catalog-source.ts`** — LIVE `getEnabledCustomAgents()`: `[]` when `!process.env.AURORA_ENDPOINT`; 30s in-process cache; filters `listAgentsWithSkills({enabledOnly:true})` to `tier==='custom'`; **never throws** (returns `[]` on DB error → resolver falls back to built-in). Phase 2 adds an **optional** `accountId?` arg. **Invariant: `getEnabledCustomAgents()` and `getEnabledCustomAgents(acct)` with NO space row MUST return the identical Phase-1 set.** Keep `_clearCacheForTests()`.
- **`web/lib/agent-resolver.ts`** — LIVE pure module. `SAFEGUARD_LINE` (immutable, exported, prepended to every custom prompt). `pickCustomAgent(prompt, candidates)` (keyword match; built-in untouched). `resolveAgent(routeKey, candidates)` returns `ResolvedAgentSpec { tier, gateway, skill?, systemPromptOverride?, toolAllowlist?, agentName, agentVersion?, skillHashes[] }`. **Built-in passthrough = `{tier:'builtin', gateway:routeKey, skill:routeKey, agentName:routeKey, skillHashes:[]}` (no `toolAllowlist`).** Phase 2 adds an **optional** `space?` 3rd arg and `spaceVersion?` to the spec; the custom branch's `toolAllowlist` becomes the enforced intersection. **The built-in branch MUST remain byte-identical** (no `toolAllowlist`, no `space` influence). Calling `resolveAgent(k, c)` with no `space` MUST equal Phase-1 output.
- **`web/lib/catalog.ts`** — LIVE `AgentWithSkills`/`SkillRef` types, `listAgentsWithSkills`, `upsertSkill/Agent`, `attachSkill`, `setEnabled` (custom-only at SQL level), `listSkills`, `writeAudit`, `computeSkillHash`. Phase 2 does NOT modify these signatures; agent-space CRUD lives in the new `web/lib/agent-space.ts` and reuses `writeAudit`.
- **`web/lib/agentcore.ts`** — LIVE `InvokeInput { gateway, messages, sessionId, systemPromptOverride?, toolAllowlist?, agentName?, agentVersion?, skillHashes? }` → builds payload conditionally, calls `InvokeAgentRuntimeCommand` (retry-once). Phase 2 adds **optional** `accountId?`/`accountAlias?` to `InvokeInput` and conditionally adds them to the payload. `getRuntimeArn()` unchanged.
- **`web/app/api/chat/route.ts`** — LIVE `POST`: `verifyUser` → (ADR-038 `classifyRoute`/`pickGateway`) → `getEnabledCustomAgents()` → `pickCustomAgent`/precedence → `resolveAgent(routeKey, customAgents)` → SSE with `meta` event → `invokeAgent({gateway, messages, sessionId, systemPromptOverride, toolAllowlist, agentName, agentVersion, skillHashes})` → typewriter `[DONE]`; fire-and-forget `recordCustomAgentTrace` for custom only. Phase 2 threads `accountId` through `getEnabledCustomAgents`, loads the space, passes `space` to `resolveAgent`, adds `accountId`/`accountAlias` to `invokeAgent`, and adds `spaceVersion` to `meta`+trace. **Keep the heartbeat-first / inactive-section / `[DONE]` framing and all existing tests passing.**
- **`web/lib/trace.ts`** — LIVE `recordCustomAgentTrace({gateway,userSub,agentName,agentVersion,tier,skillHashes})` → `agentcore_stats` insert; never throws; no-op when `!AURORA_ENDPOINT`. Phase 2 adds optional `spaceVersion?` into the JSONB payload only.
- **`web/app/api/customization/route.ts`** + **`web/app/customization/page.tsx`** — LIVE admin-gated CRUD/UI (`gate()` = `verifyUser` + `isAdmin` + `AURORA_ENDPOINT`). Phase 2 ADDS agent-space endpoints/UI; does not change existing agent/skill CRUD.
- **`terraform/foundation/data/schema.sql`** — single idempotent file; ADR-031 Phase-1 block ends with `schema_migrations` v2; latest migration is **v7** (ADR-035). Phase 2 appends a **post-COMMIT idempotent `CREATE TABLE IF NOT EXISTS agent_spaces` block + migration v8** in the v6/v7 style (own trigger via the existing `touch_updated_at()`).

**The two highest-value invariants (test them):**
1. **Backward-compat:** no `agent_spaces` row ⇒ identical to live Phase-1 (all globally-enabled customs available; no extra tool scoping).
2. **Built-in passthrough:** `resolveAgent` built-in branch is unaffected by tool-allowlist enforcement (no `toolAllowlist`, no `space` influence) — and the chat route's built-in path still produces a PONG-style answer.

---

## Out of scope (explicit)

- **BYO-MCP / `mcp_registrations` / `enabled_mcp_ids`** — Phase 3. We do **not** create `mcp_registrations`, do **not** add `enabled_mcp_ids` plumbing, do **not** register external endpoints. (The archived design lists `enabled_mcp_ids[]` on AgentSpace as **Phase 3**; we leave it out of the v8 table to avoid a dead column — Phase 3 adds it as an additive `ALTER TABLE` in its own migration.)
- **Mutating tools / ADR-029 routing for custom agents** — Phase 4. Custom agents remain read-only (the `SAFEGUARD_LINE` already enforces the recommendation-only boundary).
- **cosign / Sigstore signature verification + external uploads** — Phase 3.
- **A multi-account selector UI** beyond the default-host-account mechanism. We add the data model + resolution shim; we do **not** add an account-picker component. (Forward-ready: `agent_spaces` is account-keyed; adding rows needs no code change.)
- **Hard per-tool runtime enforcement inside `agent.py`** beyond what Phase 1 already does — see the honest boundary in Task 4. `agent.py` already receives `toolAllowlist` in the payload (Phase-1 plumbing); the *web-tier* enforcement is the new server-side intersection. Wiring `agent.py` to actually *filter* the live MCP tool list against the passed allowlist is an **optional stretch** documented in Task 4; the spec's "outside the model" control is satisfied by the resolver computing the enforced set and the prompt only advertising allowed tools.
- **EventBridge/pub-sub cache invalidation** — YAGNI per ADR-031; the resolver remains the single catalog reader with a short TTL keyed by `version`.

---

## How schema.sql is applied in v2 (recap)

Aurora has **no migration Lambda** in v2. `terraform/foundation/data/schema.sql` is applied by **`psql` from an in-VPC deploy host** (the controller's box inside `mgmt-vpc`); ingress gated by `var.allow_vpc_db_access`. The file is idempotent and tracked by `schema_migrations`. "Apply the migration" = the **controller** runs `psql` against the cluster endpoint with the RDS-managed master secret (see CONTROLLER task for the exact command).

---

## File map

**Create:**
- `web/lib/account.ts` — `currentAccountId(): string` (env `HOST_ACCOUNT_ID` → fallback `'self'`); `currentAccountAlias(): string|undefined`. Pure/sync.
- `web/lib/agent-space.ts` — Aurora CRUD for `agent_spaces`: `getAgentSpace(accountId)`, `upsertAgentSpace(...)` (version bump + audit), the `AgentSpace` type, and the **pure** `intersectToolAllowlist(...)` + `KNOWN_TOOL_CATALOG` constant used by the resolver.
- `web/lib/account.test.ts`, `web/lib/agent-space.test.ts` — vitest.
- Tests are also added to existing files (see Modify) for the two invariants.

**Modify:**
- `terraform/foundation/data/schema.sql` — append `agent_spaces` table + trigger + migration v8 (post-COMMIT idempotent block).
- `terraform/foundation/workload.tf` — add `{ name = "HOST_ACCOUNT_ID", value = data.aws_caller_identity.current.account_id }` to the web container `environment`.
- `web/lib/catalog-source.ts` — `getEnabledCustomAgents(accountId?)`: account-aware, **degrade to global Phase-1 set when no space row**; cache keyed by `accountId` + space `version`.
- `web/lib/agent-resolver.ts` — `resolveAgent(routeKey, candidates, space?)`; add `spaceVersion?` to `ResolvedAgentSpec`; enforced intersection for the custom branch; built-in branch byte-identical.
- `web/lib/agentcore.ts` — `InvokeInput` gains `accountId?`/`accountAlias?`; payload adds them conditionally.
- `web/app/api/chat/route.ts` — resolve account, load space, thread `accountId` + `space`, emit `spaceVersion`.
- `web/lib/trace.ts` — `CustomAgentTrace` gains `spaceVersion?`; recorded in the JSONB payload.
- `web/app/api/customization/route.ts` — add agent-space GET/PUT (admin-gated).
- `web/app/customization/page.tsx` — add the per-account Agent Space composition panel + tool_allowlist editor.
- `web/lib/agent-resolver.test.ts`, `web/lib/catalog-source.test.ts` — add backward-compat + enforcement tests.

---

## Tasks

### Task 1 — Migration v8: `agent_spaces` table (always-present; no row ⇒ Phase-1)

**Files:** `terraform/foundation/data/schema.sql`

- [ ] Append a **post-COMMIT** idempotent block after the ADR-035 (v7) block, in the v6/v7 style (own `DO $$` trigger guard reusing `touch_updated_at()`):

```sql
-- ============================================================================
-- ADR-031 Phase 2 (migration v8): per-account Agent Spaces.
-- ALWAYS PRESENT, but OPTIONAL per account: a missing row ⇒ Phase-1 global
-- behavior (all globally-enabled custom agents/skills available, no extra
-- tool scoping). One row per account (ADR-008). enabled_*_ids scope which
-- globally-enabled customs are active for that account; tool_allowlist is the
-- account-level cap that the resolver intersects (server-side enforcement,
-- ADR-031 Addendum #5). version bumps on every change (traceability).
-- Phase 3 will ADD enabled_mcp_ids via its own ALTER TABLE migration.
-- Idempotent.
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_spaces (
  account_id        TEXT PRIMARY KEY,
  enabled_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb,   -- agents.id[] enabled for this account
  enabled_skill_ids JSONB NOT NULL DEFAULT '[]'::jsonb,   -- skills.id[] enabled for this account
  tool_allowlist    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- account-level tool cap (server-side enforced)
  version           INT  NOT NULL DEFAULT 1,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_agent_spaces_touch') THEN
    CREATE TRIGGER trg_agent_spaces_touch BEFORE UPDATE ON agent_spaces
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;

INSERT INTO schema_migrations (version, description)
VALUES (8, 'ADR-031 Phase 2: agent_spaces (per-account enablement + tool_allowlist cap; no row => Phase-1 global behavior)')
ON CONFLICT (version) DO NOTHING;
```

- [ ] Do NOT add `enabled_mcp_ids` (Phase 3). Do NOT seed any row — **the absence of a row is the safe default** and seeding one would change live behavior.

### Task 2 — `web/lib/account.ts`: account-context shim (single-account-safe)

**Files:** `web/lib/account.ts`, `web/lib/account.test.ts`

- [ ] Create the pure shim:

```ts
// web/lib/account.ts
// ADR-031 Phase 2 — minimal account-context. v2 has one live account and no
// selector UI; the web tier already uses the literal 'self' as its single-account
// convention (inventory.ts). HOST_ACCOUNT_ID is wired from data.aws_caller_identity
// in workload.tf. Forward-ready: agent_spaces is account-keyed, so multi-account is a
// data concern (add a row), not a code change.

/** The account the dashboard is operating on today. Never throws; never empty. */
export function currentAccountId(): string {
  const id = process.env.HOST_ACCOUNT_ID?.trim();
  return id && id.length > 0 ? id : 'self';
}

/** Optional human alias for the system-prompt account directive (agent.py). */
export function currentAccountAlias(): string | undefined {
  const a = process.env.HOST_ACCOUNT_ALIAS?.trim();
  return a && a.length > 0 ? a : undefined;
}
```

- [ ] Test: returns `HOST_ACCOUNT_ID` when set; returns `'self'` when unset/blank; alias undefined when unset.

### Task 3 — `web/lib/agent-space.ts`: CRUD + pure intersection helper

**Files:** `web/lib/agent-space.ts`, `web/lib/agent-space.test.ts`

- [ ] Define the type + a **pure** intersection helper and a **known-tool catalog** constant. The catalog is keyed by gateway (the granularity the web tier has — see Task 4 boundary). `null`/`undefined` catalog entry for a gateway means "tool inventory unknown at the web tier" → that dimension is NOT used to *remove* tools (degrade-safe: we never over-restrict on missing data, we only restrict against the explicit Agent Space cap).

```ts
// web/lib/agent-space.ts
// ADR-031 Phase 2 — per-account Agent Space CRUD + server-side tool-allowlist intersection.
import { getPool } from '@/lib/db';
import { writeAudit } from '@/lib/catalog';

export interface AgentSpace {
  accountId: string;
  enabledAgentIds: number[];
  enabledSkillIds: number[];
  toolAllowlist: string[];
  version: number;
}

/**
 * Known-tool catalog, keyed by gateway. Pragmatic: the web tier does NOT hold the
 * full per-tool inventory of each gateway (that lives in the AgentCore gateway Lambdas
 * and is discovered live by agent.py). A `null` value = "inventory unknown here" → the
 * resolver does NOT use this dimension to drop tools (degrade-safe). Populate the entries
 * we DO know (mirror the gateway tool sets we can enumerate); leave the rest null.
 * Tightening this over time only ever ADDS restriction; it can never widen the space cap.
 */
export const KNOWN_TOOL_CATALOG: Record<string, string[] | null> = {
  network: null, container: null, iac: null, data: null,
  security: null, monitoring: null, cost: null, ops: null,
};

/**
 * Server-side tool-allowlist enforcement (ADR-031 Addendum #5), computed OUTSIDE the model.
 * A skill cannot grant a tool the Agent Space does not allow.
 *
 * result = skillTools
 *          ∩ (knownToolCatalog[gateway] when that gateway's inventory is known)
 *          ∩ (space.toolAllowlist when a space exists AND its list is non-empty)
 *
 * Degrade-safe: a missing space, or an empty space.toolAllowlist, is "no account cap"
 * (Phase-1 advisory behavior) — we return skillTools ∩ knownCatalog only. An unknown
 * gateway inventory (null) is not used to drop tools.
 */
export function intersectToolAllowlist(
  gateway: string,
  skillTools: string[],
  space?: Pick<AgentSpace, 'toolAllowlist'> | null,
): string[] {
  const uniqSkill = Array.from(new Set(skillTools.filter(Boolean)));
  const known = KNOWN_TOOL_CATALOG[gateway];
  let out = known ? uniqSkill.filter((t) => known.includes(t)) : uniqSkill;
  if (space && Array.isArray(space.toolAllowlist) && space.toolAllowlist.length > 0) {
    const cap = new Set(space.toolAllowlist);
    out = out.filter((t) => cap.has(t)); // the account cap can only REMOVE tools
  }
  return out;
}

export async function getAgentSpace(accountId: string): Promise<AgentSpace | null> {
  if (!process.env.AURORA_ENDPOINT) return null;
  try {
    const { rows } = await getPool().query(
      `SELECT account_id, enabled_agent_ids, enabled_skill_ids, tool_allowlist, version
       FROM agent_spaces WHERE account_id = $1`, [accountId]);
    if (rows.length === 0) return null; // NO ROW ⇒ Phase-1 global behavior
    const r = rows[0] as Record<string, unknown>;
    return {
      accountId: r.account_id as string,
      enabledAgentIds: (r.enabled_agent_ids as number[]) ?? [],
      enabledSkillIds: (r.enabled_skill_ids as number[]) ?? [],
      toolAllowlist: (r.tool_allowlist as string[]) ?? [],
      version: r.version as number,
    };
  } catch {
    return null; // degrade to Phase-1; never break chat
  }
}

export async function upsertAgentSpace(input: {
  accountId: string; enabledAgentIds: number[]; enabledSkillIds: number[]; toolAllowlist: string[];
  actor: string;
}): Promise<AgentSpace> {
  const { rows } = await getPool().query(
    `INSERT INTO agent_spaces (account_id, enabled_agent_ids, enabled_skill_ids, tool_allowlist, version)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, 1)
     ON CONFLICT (account_id) DO UPDATE
       SET enabled_agent_ids = EXCLUDED.enabled_agent_ids,
           enabled_skill_ids = EXCLUDED.enabled_skill_ids,
           tool_allowlist    = EXCLUDED.tool_allowlist,
           version           = agent_spaces.version + 1,
           updated_at        = NOW()
     RETURNING account_id, enabled_agent_ids, enabled_skill_ids, tool_allowlist, version`,
    [input.accountId, JSON.stringify(input.enabledAgentIds),
     JSON.stringify(input.enabledSkillIds), JSON.stringify(input.toolAllowlist)],
  );
  const r = rows[0] as Record<string, unknown>;
  await writeAudit({
    actor: input.actor, action: 'upsert', objectType: 'space', objectId: input.accountId,
  });
  return {
    accountId: r.account_id as string,
    enabledAgentIds: (r.enabled_agent_ids as number[]) ?? [],
    enabledSkillIds: (r.enabled_skill_ids as number[]) ?? [],
    toolAllowlist: (r.tool_allowlist as string[]) ?? [],
    version: r.version as number,
  };
}
```

- [ ] Tests for `intersectToolAllowlist` (pure, no DB):
  - no space → `skillTools` unchanged when gateway inventory unknown (`null`).
  - empty `space.toolAllowlist` → treated as no cap (Phase-1 advisory).
  - non-empty `space.toolAllowlist` → result ⊆ cap (the account cap REMOVES tools the skill declared but the space disallows).
  - known catalog (when a gateway entry is non-null) drops tools not in the catalog.
  - the cap can never ADD a tool the skill did not declare.

### Task 4 — `web/lib/agent-resolver.ts`: server-side enforcement (custom only; built-in passthrough unchanged)

**Files:** `web/lib/agent-resolver.ts`, `web/lib/agent-resolver.test.ts`

> **Honest boundary (document in code + plan):** the web tier does NOT hold the full per-tool inventory of each gateway (it lives in the AgentCore gateway Lambdas; `agent.py` discovers it live). So the resolver's enforced intersection is, at minimum, `skillTools ∩ space.toolAllowlist` (plus `∩ KNOWN_TOOL_CATALOG[gateway]` for any gateway whose inventory we *do* enumerate). This is consistent with Phase-1's note that **hard per-tool runtime enforcement was deferred**. What Phase 2 guarantees: a skill **cannot widen** the tool set beyond the Agent Space `tool_allowlist` (the account cap), and the resolved spec — which is what the system prompt advertises to the model — only lists allowed tools. The optional stretch (Task 4d) wires `agent.py` to additionally filter the live MCP tool list against `payload.toolAllowlist`, closing the loop at the runtime; without it, enforcement is web-tier + prompt-level, which is the spec's "outside the model" requirement (the model never decides the allowlist).

- [ ] Add `spaceVersion?: number` to `ResolvedAgentSpec`.
- [ ] Import the pure helper: `import { intersectToolAllowlist, type AgentSpace } from '@/lib/agent-space';`
- [ ] Change the signature to `resolveAgent(routeKey, candidates, space?: AgentSpace | null)`. **The custom branch** computes the enforced allowlist; **the built-in branch is byte-identical** to Phase-1 (no `toolAllowlist`, no `space` influence, no `spaceVersion`):

```ts
export function resolveAgent(
  routeKey: string,
  candidates: AgentWithSkills[],
  space?: AgentSpace | null,
): ResolvedAgentSpec {
  const custom = candidates.find((a) => a.name === routeKey && a.enabled && a.tier === 'custom');
  if (custom) {
    const ordered = [...custom.skills].sort((a, b) => a.ord - b.ord);
    const skillBlock = ordered.map((s) => s.instructions).filter(Boolean).join('\n\n');
    const systemPromptOverride = [SAFEGUARD_LINE, custom.persona.trim(), skillBlock].filter(Boolean).join('\n\n');
    // Phase 2: server-side enforcement (ADR-031 Addendum #5) — OUTSIDE the model.
    // skill-declared tools ∩ known catalog ∩ Agent Space cap. A skill cannot grant
    // a tool the space does not allow. No space ⇒ Phase-1 advisory (skill ∩ catalog).
    const declared = ordered.flatMap((s) => s.toolAllowlist);
    const enforced = intersectToolAllowlist(custom.gateway, declared, space);
    return {
      tier: 'custom',
      gateway: custom.gateway,
      systemPromptOverride,
      toolAllowlist: enforced.length ? enforced : undefined,
      agentName: custom.name,
      agentVersion: custom.version,
      skillHashes: ordered.map((s) => s.contentHash),
      spaceVersion: space?.version, // traceability; undefined when no space
    };
  }
  // Built-in passthrough — UNCHANGED from Phase 1. Never tool-scoped; space has no effect.
  return { tier: 'builtin', gateway: routeKey, skill: routeKey, agentName: routeKey, skillHashes: [] };
}
```

- [ ] Tests (the highest-value enforcement + built-in tests):
  - **Built-in unaffected:** `resolveAgent('security', [], { accountId:'a', toolAllowlist:['x'], enabledAgentIds:[], enabledSkillIds:[], version:5 })` → identical to Phase-1 built-in spec (`tier:'builtin'`, no `toolAllowlist`, no `spaceVersion`, `skill:'security'`).
  - **No space ⇒ Phase-1:** `resolveAgent('compliance', [custom])` (no 3rd arg) equals the live Phase-1 `toolAllowlist` (skill-declared union, since `KNOWN_TOOL_CATALOG.security` is `null`).
  - **Enforcement removes a disallowed tool:** custom skill declares `['simulate_principal_policy','get_account_authorization_details']`; space `tool_allowlist=['simulate_principal_policy']` → resolved `toolAllowlist === ['simulate_principal_policy']`.
  - **Empty space cap = no cap:** space with `toolAllowlist:[]` → resolved equals Phase-1 (advisory).
  - **`spaceVersion`** is carried on the custom spec when a space is passed, undefined otherwise.
- [ ] (Optional stretch, Task 4d — out of the critical path) In `agent/agent.py`, when `payload.get('toolAllowlist')` is present, filter the discovered `tools` to that set before constructing the `Agent(...)` (custom path only; never filter the built-in `SKILL_BASE` path). Document as a follow-up if not done; the web-tier + prompt-level control already satisfies the spec.

### Task 5 — `web/lib/catalog-source.ts`: account-aware, degrade-safe

**Files:** `web/lib/catalog-source.ts`, `web/lib/catalog-source.test.ts`

- [ ] Make the source account-aware while preserving the **exact Phase-1 contract** when there's no space row. Cache keyed by `accountId` + space `version`:

```ts
// web/lib/catalog-source.ts
// ADR-031 Phase 1+2 — single catalog reader for the chat hot path. Aurora + 30s cache.
// Phase 2: account-aware. NO agent_spaces row ⇒ Phase-1 global behavior (all
// globally-enabled customs). A row scopes the set to its enabled_agent_ids and
// filters each agent's skills to enabled_skill_ids.
import { listAgentsWithSkills, type AgentWithSkills } from '@/lib/catalog';
import { getAgentSpace } from '@/lib/agent-space';

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; ver: number; data: AgentWithSkills[] }>();

export function _clearCacheForTests() { cache.clear(); }

export async function getEnabledCustomAgents(accountId?: string): Promise<AgentWithSkills[]> {
  if (!process.env.AURORA_ENDPOINT) return [];
  const acct = accountId ?? 'self';
  try {
    const space = await getAgentSpace(acct);       // null ⇒ Phase-1 global behavior
    const ver = space?.version ?? 0;               // 0 = "no space"; busts cache on version bump
    const now = Date.now();
    const hit = cache.get(acct);
    if (hit && hit.ver === ver && now - hit.at < TTL_MS) return hit.data;

    const all = await listAgentsWithSkills({ enabledOnly: true });
    let data = all.filter((a) => a.tier === 'custom');   // Phase-1 set

    if (space) {
      const agentSet = new Set(space.enabledAgentIds);
      const skillSet = new Set(space.enabledSkillIds);
      data = data
        .filter((a) => agentSet.has(a.id))
        // scope each agent's skills to the space's enabled skills
        .map((a) => ({ ...a, skills: a.skills.filter((_s, _i) => true) })); // see note below
      // NOTE: skills carry no id in SkillRef; if per-skill scoping by id is required,
      // extend listAgentsWithSkills to project s.id into SkillRef and filter here by skillSet.
      // For Phase 2 minimal scope, enabled_skill_ids gates which skills an admin may attach
      // in the space composition UI; agent-level scoping (enabledAgentIds) is the load-bearing
      // filter on the hot path. Document this boundary.
      void skillSet;
    }
    cache.set(acct, { at: now, ver, data });
    return data;
  } catch {
    return []; // resolver falls back to built-in; assistant never breaks
  }
}
```

- [ ] **Decision point for the implementer (resolve, don't leave ambiguous):** `SkillRef` currently has no `id`. To make `enabled_skill_ids` filter on the hot path, extend `catalog.ts` `SkillRef` with `id: number` and project `s.id` in the `json_build_object(...)` of `listAgentsWithSkills`, then filter `a.skills` by `skillSet` here. This is a **small additive** change (a new optional field; existing tests that don't reference `id` keep passing). If the implementer chooses agent-level-only scoping for the minimal Phase 2, the `enabled_skill_ids` column still gates the **composition UI** (which skills are offered per account) — document whichever boundary is shipped. **Recommended:** do the additive `SkillRef.id` projection so per-skill scoping is real and the column is not vestigial.
- [ ] Tests:
  - `getEnabledCustomAgents()` / `getEnabledCustomAgents('self')` with `getAgentSpace`→`null` returns the **identical** Phase-1 set (all globally-enabled customs). (Mock `@/lib/agent-space` `getAgentSpace` to return null.)
  - With a space mock returning `enabledAgentIds:[1]`, only agent id 1 survives.
  - Cache is keyed by account + version: bumping the mocked `version` re-queries.
  - DB error → `[]` (never throws).

### Task 6 — `web/lib/agentcore.ts`: thread accountId/alias into the payload

**Files:** `web/lib/agentcore.ts`

- [ ] Extend `InvokeInput` (additive, optional):

```ts
export interface InvokeInput {
  gateway: string;
  messages: ChatMsg[];
  sessionId: string;
  systemPromptOverride?: string;
  toolAllowlist?: string[];      // ADR-031 Phase 2: now the server-side-enforced set
  agentName?: string;
  agentVersion?: number;
  skillHashes?: string[];
  accountId?: string;            // ADR-031 Phase 2: agent.py reads payload.accountId
  accountAlias?: string;
}
```

- [ ] In `invokeAgent`, after the existing conditional payload fields:

```ts
  if (input.accountId) body.accountId = input.accountId;
  if (input.accountAlias) body.accountAlias = input.accountAlias;
```

- [ ] No other change. `agent.py` already consumes `payload.get('accountId')`/`accountAlias` (~line 424) for the account directive — no Python change required for this task.

### Task 7 — `web/app/api/chat/route.ts`: resolve account, load space, thread through

**Files:** `web/app/api/chat/route.ts`

- [ ] Import the new shims:

```ts
import { currentAccountId, currentAccountAlias } from '@/lib/account';
import { getAgentSpace } from '@/lib/agent-space';
```

- [ ] Resolve the account once, load the effective space, and pass both through. Replace the LIVE custom-agent block:

```ts
  // ADR-031 Phase 2: per-account Agent Space. No row ⇒ Phase-1 global behavior.
  const accountId = currentAccountId();
  const accountAlias = currentAccountAlias();
  const customAgents = await getEnabledCustomAgents(accountId);   // [] when Aurora off / no customs
  const space = await getAgentSpace(accountId);                   // null ⇒ Phase-1
  const pinIsValid = !!(body.section && sectionByKey(body.section));
  const routeKey = (hybridOn && pinIsValid)
    ? gateway
    : (pickCustomAgent(prompt, customAgents) ?? gateway);
  const spec = resolveAgent(routeKey, customAgents, space);       // server-side enforcement
```

- [ ] Add `spaceVersion` to the `meta` event (only when custom, alongside the existing `customAgent`):

```ts
        ...(spec.tier === 'custom' ? { customAgent: spec.agentName, spaceVersion: spec.spaceVersion } : {}),
```

- [ ] Pass account context into `invokeAgent`:

```ts
        text = await invokeAgent({
          gateway: spec.gateway, messages, sessionId,
          systemPromptOverride: spec.systemPromptOverride,
          toolAllowlist: spec.toolAllowlist,
          agentName: spec.agentName, agentVersion: spec.agentVersion, skillHashes: spec.skillHashes,
          accountId, accountAlias,
        });
```

- [ ] Add `spaceVersion` to the fire-and-forget trace (custom only):

```ts
        void recordCustomAgentTrace({ gateway: spec.gateway, userSub: user.sub, agentName: spec.agentName, agentVersion: spec.agentVersion, tier: spec.tier, skillHashes: spec.skillHashes, spaceVersion: spec.spaceVersion });
```

- [ ] **Do not touch** the heartbeat-first open, the inactive-section branch, the typewriter loop, or `[DONE]`. Built-in path is unchanged (no space influence; `getAgentSpace` returning null is the common case).

### Task 8 — `web/lib/trace.ts`: carry spaceVersion

**Files:** `web/lib/trace.ts`

- [ ] Add `spaceVersion?: number` to `CustomAgentTrace` and include it in the JSONB payload:

```ts
export interface CustomAgentTrace {
  gateway: string; userSub: string; agentName: string; agentVersion?: number;
  tier: 'builtin' | 'custom'; skillHashes: string[];
  spaceVersion?: number; // ADR-031 Phase 2 traceability
}
```
```ts
      ['custom_agent_invoke', t.gateway, t.userSub, JSON.stringify({
        agentName: t.agentName, agentVersion: t.agentVersion, tier: t.tier,
        skillHashes: t.skillHashes, spaceVersion: t.spaceVersion,
      })],
```

- [ ] Still `no-op` when `!AURORA_ENDPOINT`; still never throws.

### Task 9 — Admin CRUD: agent-space GET/PUT (admin-gated)

**Files:** `web/app/api/customization/route.ts`, `web/app/api/customization/route.test.ts` (extend)

- [ ] Import the agent-space lib + account shim:

```ts
import { getAgentSpace, upsertAgentSpace } from '@/lib/agent-space';
import { currentAccountId } from '@/lib/account';
```

- [ ] Extend `GET` to also return the effective space for the current account (so the UI can render it). Keep the existing `agents`/`skills` keys:

```ts
export async function GET(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  const accountId = currentAccountId();
  return json({
    aurora: true,
    accountId,
    agents: await listAgentsWithSkills(),
    skills: await listSkills(),
    space: await getAgentSpace(accountId), // null ⇒ Phase-1 (UI shows "global" mode)
  }, 200);
}
```

- [ ] Add a `PUT` op `space` (alongside the existing `enable`/`disable`/`attach` ops). The body carries the composition for the current account:

```ts
  if (body.op === 'space') {
    const accountId = currentAccountId();
    const toIds = (v: unknown) => Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : [];
    const toStrs = (v: unknown) => Array.isArray(v) ? v.map(String) : [];
    const space = await upsertAgentSpace({
      accountId,
      enabledAgentIds: toIds(body.enabledAgentIds),
      enabledSkillIds: toIds(body.enabledSkillIds),
      toolAllowlist: toStrs(body.toolAllowlist),
      actor,
    });
    // writeAudit already done inside upsertAgentSpace; return the new version
    return json({ ok: true, version: space.version }, 200);
  }
```

- [ ] The `gate()` (admin + Aurora) already protects this. Test: non-admin → 403; admin `op:'space'` calls `upsertAgentSpace` (mock the lib) and returns the version.

### Task 10 — Admin UI: per-account Agent Space composition + tool_allowlist editor

**Files:** `web/app/customization/page.tsx`

- [ ] Add state + an "Agent Space (account: <id>)" panel below the existing Agents/Skills sections. It loads `d.space`/`d.accountId` from the LIVE `GET`, lets the admin (a) check which custom agents/skills are enabled for this account, (b) edit a comma-separated `tool_allowlist`, and (c) `Save` (PUT `op:'space'`). When `d.space` is `null`, show a clear "Global (Phase-1) mode — all globally-enabled custom agents are available; create an Agent Space to scope this account" banner so the degrade-safe default is visible.

```tsx
// add to interfaces
interface SpaceState { enabledAgentIds: number[]; enabledSkillIds: number[]; toolAllowlist: string[]; version?: number }
```
```tsx
  const [accountId, setAccountId] = useState('self');
  const [space, setSpace] = useState<SpaceState | null>(null);
  const [allowlistText, setAllowlistText] = useState('');
```
```tsx
  // in load(): after setAgents/setSkills
    setAccountId(d.accountId || 'self');
    setSpace(d.space ? {
      enabledAgentIds: d.space.enabledAgentIds || [], enabledSkillIds: d.space.enabledSkillIds || [],
      toolAllowlist: d.space.toolAllowlist || [], version: d.space.version,
    } : null);
    setAllowlistText((d.space?.toolAllowlist || []).join(', '));
```
```tsx
  async function saveSpace() {
    const enabledAgentIds = space?.enabledAgentIds ?? [];
    const enabledSkillIds = space?.enabledSkillIds ?? [];
    const toolAllowlist = allowlistText.split(',').map((s) => s.trim()).filter(Boolean);
    const res = await fetch('/api/customization', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'space', enabledAgentIds, enabledSkillIds, toolAllowlist }),
    });
    const data = await res.json();
    setMsg(res.ok ? `Agent Space saved (v${data.version}) for ${accountId}` : `Error: ${JSON.stringify(data.error)}`);
    if (res.ok) load();
  }
  function toggleSpaceAgent(id: number) {
    const cur = space ?? { enabledAgentIds: [], enabledSkillIds: [], toolAllowlist: [] };
    const set = new Set(cur.enabledAgentIds);
    set.has(id) ? set.delete(id) : set.add(id);
    setSpace({ ...cur, enabledAgentIds: [...set] });
  }
```
```tsx
      <section className="space-y-2 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <h2 className="text-[13px] font-semibold">Agent Space — account {accountId}</h2>
        {!space && (
          <div className="text-[12px] text-ink-500">
            Global (Phase-1) mode — all globally-enabled custom agents are available for this account.
            Saving below creates an Agent Space and scopes this account.
          </div>
        )}
        <div className="text-[12px]">
          <div className="mb-1 font-medium">Enabled custom agents (account-scoped)</div>
          {agents.filter((a) => a.tier === 'custom').map((a) => (
            <label key={a.id} className="mr-3 inline-flex items-center gap-1">
              <input type="checkbox" checked={!!space?.enabledAgentIds.includes(a.id)} onChange={() => toggleSpaceAgent(a.id)} />
              {a.name}
            </label>
          ))}
          {agents.filter((a) => a.tier === 'custom').length === 0 && <span className="text-ink-400">no custom agents yet</span>}
        </div>
        <div className="text-[12px]">
          <div className="mb-1 font-medium">Tool allowlist (account cap, comma-separated)</div>
          <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]"
                 placeholder="e.g. simulate_principal_policy, get_account_authorization_details"
                 value={allowlistText} onChange={(e) => setAllowlistText(e.target.value)} />
          <div className="mt-1 text-ink-400">Empty = no account cap (Phase-1 advisory). A non-empty list can only REMOVE tools a skill declared — it never grants new tools.</div>
        </div>
        <button onClick={saveSpace} className="rounded bg-claude-500 px-3 py-1 text-[12px] font-medium text-white">Save Agent Space</button>
      </section>
```

- [ ] Keep the existing `denied`/`noAurora` guards and the Agents/Skills sections intact. (Per-skill scoping checkboxes are optional UI polish; agent-level scoping + the allowlist editor are the load-bearing controls.)

### Task 11 — Wire `HOST_ACCOUNT_ID` into the web container

**Files:** `terraform/foundation/workload.tf`

- [ ] In the web container `environment` block, add (the `data.aws_caller_identity.current` data source already exists in `ai.tf`):

```hcl
        { name = "HOST_ACCOUNT_ID", value = data.aws_caller_identity.current.account_id },
```

- [ ] Optional: `{ name = "HOST_ACCOUNT_ALIAS", value = "" }` (left empty; alias is cosmetic for the prompt directive). Do not add otherwise.

### Task 12 — Full test sweep + typecheck

**Files:** `web/**`

- [ ] `npm --prefix web run lint && npm --prefix web run typecheck` (or the repo equivalent) — verify no type drift on `ResolvedAgentSpec`, `InvokeInput`, `CustomAgentTrace`, `AgentSpace`, `SkillRef` (if the `id` projection was done).
- [ ] `npx --prefix web vitest run` — ALL existing Phase-1 tests (`agent-resolver.test.ts`, `catalog-source.test.ts`, `catalog.test.ts`, `skill-validation.test.ts`, `admin.test.ts`, `customization/route.test.ts`) MUST still pass, plus the new `account.test.ts`, `agent-space.test.ts`, and the added backward-compat/enforcement cases.
- [ ] Grep for placeholders: `grep -rn "TODO\|FIXME\|placeholder\|XXX" web/lib/agent-space.ts web/lib/account.ts web/lib/agent-resolver.ts web/lib/catalog-source.ts` — must be clean.

### Task 13 (CONTROLLER) — Apply migration v8 + deploy + verify (LIVE feature; real deploy)

> **This task is run by the CONTROLLER, not a subagent** (in-VPC `psql` + a real `make deploy` against a LIVE feature). Phase 1 is deployed, so this changes a running system — verify the live chat still works.

- [ ] Confirm branch: `git branch --show-current` = `feat/v2-architecture-design`. Commit all Task 1–12 changes in small units first.
- [ ] **Apply migration v8** (idempotent; in-VPC deploy host, RDS-managed master secret):

```bash
PGPASSWORD="$(aws secretsmanager get-secret-value \
  --secret-id "$(terraform -chdir=terraform/foundation output -raw aurora_secret_arn)" \
  --query SecretString --output text | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')" \
psql -v ON_ERROR_STOP=1 \
  "host=$(terraform -chdir=terraform/foundation output -raw aurora_endpoint) port=5432 dbname=awsops user=awsops_admin sslmode=require" \
  -f terraform/foundation/data/schema.sql
# verify: SELECT version FROM schema_migrations ORDER BY version;  -> includes 8
# verify table: \d agent_spaces
```

- [ ] **Apply Terraform** for the new `HOST_ACCOUNT_ID` env (saved plan; no `-auto-approve` on shared infra):

```bash
terraform -chdir=terraform/foundation plan -out tfplan   # expect: in-place update of the web task def only
# CONTROLLER: terraform -chdir=terraform/foundation apply tfplan
```

- [ ] **`make deploy`** (web: arm64 build → ECR push → ECS rolling → wait stable → smoke `/api/health`). This rebuilds the LIVE web image with the new resolver/route/source.
- [ ] **Verify backward-compat (no space ⇒ Phase-1):** with NO `agent_spaces` row, send a built-in chat (e.g. a network/security prompt) and confirm a normal answer + `meta` with `tier:'builtin'` and **no `spaceVersion`**. The built-in PONG path must be unaffected.

```bash
# in-cluster / via the authenticated dashboard; confirm SSE meta has tier=builtin, no spaceVersion
```

- [ ] **Verify a configured Agent Space scopes a custom agent's tools:** (a) create + enable a custom agent with a skill declaring 2 tools (admin UI), (b) save an Agent Space with `tool_allowlist` containing only 1 of them, (c) chat to that custom agent and confirm the SSE `meta` shows `tier:'custom'`, `customAgent`, `spaceVersion>=1`, and the resolved spec advertises only the allowed tool (inspect via the trace row `agentcore_stats` payload). Then (d) remove the agent from the space's `enabledAgentIds` and confirm the custom agent is no longer selected for that account (degrades to built-in), while remaining available to an account with no space row.
- [ ] **Verify no-space-degrades:** for any account id with no `agent_spaces` row, `getEnabledCustomAgents` returns the full globally-enabled custom set (Phase-1) — confirm a second account context (or `'self'` with the row deleted) behaves identically to Phase 1.
- [ ] Roll back posture: deleting the `agent_spaces` row (or never creating one) fully reverts to Phase-1 behavior with no redeploy. Document this in the PR.

---

## Self-Review (run before claiming done)

- [ ] **Backward-compat coverage:** Is there a test proving `getEnabledCustomAgents()` / `getEnabledCustomAgents(acct)` with `getAgentSpace`→null returns the **identical** Phase-1 set? Is there a test proving `resolveAgent(k, c)` (no `space`) equals the live Phase-1 output? Is the "no row ⇒ Phase-1" path exercised end-to-end in Task 13?
- [ ] **Tool-allowlist enforcement:** Is there a test where a custom skill declares a tool the Agent Space `tool_allowlist` excludes, and the resolved `toolAllowlist` provably drops it (`result ⊆ space.toolAllowlist`)? Is the "cap can only remove, never add" property tested? Is the honest boundary (web tier lacks full per-tool inventory; intersection is at least `skill ∩ space.toolAllowlist`) documented in code + plan?
- [ ] **Built-in unaffected:** Is there a test passing a non-null `space` to `resolveAgent('security', [])` and asserting the built-in spec is byte-identical (no `toolAllowlist`, no `spaceVersion`)? Did Task 13 confirm the live built-in chat (PONG) still works post-deploy?
- [ ] **Placeholder scan:** `grep -rn "TODO\|FIXME\|placeholder\|\.\.\." web/lib/agent-space.ts web/lib/account.ts` — none. Every SQL/TS snippet in this plan is real (no stubs). The `SkillRef.id` decision (Task 5) is resolved one way or the other, not left dangling.
- [ ] **Type consistency:** `ResolvedAgentSpec.spaceVersion?`, `InvokeInput.accountId?/accountAlias?`, `CustomAgentTrace.spaceVersion?`, `AgentSpace` shape, and (if chosen) `SkillRef.id` all line up; `npm typecheck` clean; no `any`.
- [ ] **Degrade-safe everywhere:** `getAgentSpace` returns `null` on no-row AND on DB error (never throws); `getEnabledCustomAgents` returns `[]` on error; `currentAccountId()` never empty; `intersectToolAllowlist` treats missing/empty space and unknown catalog as "no extra restriction" (never over-restricts on missing data). Confirm none of these can regress the built-in path or block chat.
- [ ] **No scope creep:** no `mcp_registrations`, no `enabled_mcp_ids`, no ADR-029 mutating wiring, no cosign, no account-selector UI. Migration is exactly v8.
