# Design Spec: Runtime-Customizable Agents & Skills (Agent Spaces + BYO-MCP)

- **Status**: Draft (2026-05-31) — companion to ADR-031
- **ADR**: `docs/decisions/031-runtime-customizable-agents-skills.md`
- **Owner**: AWSops AI layer

## 한국어 요약 (TL;DR)

관리자가 대시보드에서 런타임에 **에이전트**(전문 페르소나)와 **스킬**(재사용 지시 패키지)을 항목별로 만들고, 계정별 **Agent Space**로 활성화/스코핑하며, **외부 MCP 서버(BYO-MCP)** 를 등록해 도구를 추가한다. 저장은 **Aurora(메타+instructions+매핑+감사+해시) + S3(업로드 아티팩트)** 하이브리드. 질의 시 **리졸버**가 유효 스펙을 합성해 `agent.py`에 넘기고, `agent.py`는 스펙을 실행만 하는 **registry-agnostic** 컴포넌트다. 보안은 **서버측 allowlist 강제 + ADR-029 변경 게이트 + 기본 읽기전용 + SHA-256(P1) + cosign(P3)** 다층 방어. AWS DevOps/Security Agent의 Agent Space·Managed/Custom·계정 수준 MCP 모델을 차용한다.

## 1. Goals / Non-goals

**Goals**
- Admins compose custom agents and skills at runtime, per account, with no Docker rebuild or Runtime redeploy.
- Skills are reusable across agents (many-to-many). Built-in (the current 8 gateways + `SKILL_BASE`) and custom tiers coexist.
- Custom agents/skills bind to the existing 125 MCP tools and (Phase 3) to admin-registered external MCP servers.
- Per-account Agent Spaces enable/scope what is active, mirroring AWS Agent Spaces.
- Strong governance: admin-only, read-only default, allowlist enforcement, integrity hashing, traceability.

**Non-goals (YAGNI)**
- Learned/auto-tuned skills; per-user agents; cross-org skill marketplace; EventBridge/pub-sub cache invalidation; replacing the 8 gateways.

## 2. Object model

Four catalog objects. Each skill/agent has a `tier` of `builtin` (read-only, system-seeded) or `custom` (admin-authored).

- **Skill** — `{ id, name, description, instructions (Markdown), tool_allowlist[], reference_keys[] (S3), tier, content_hash, version, enabled, created_by, created_at, updated_at }`. Instructions guide tool usage (AWS DevOps Agent skill model). `tool_allowlist` references tool ids from the known tool catalog (125 built-in + registered MCP tools).
- **Agent** — `{ id, name, description, persona (system prompt), routing_keywords[], model, tier, version, enabled, ... }`. Built-in agents = the 8 gateways. Skills attach via the mapping table (M:N).
- **AgentSkill** (mapping) — `{ agent_id, skill_id, order }`. Many-to-many; `order` controls instruction composition order.
- **McpRegistration** — `{ id, account_id, name, endpoint, transport (sigv4|oauth|apikey), credentials_ref (Secrets Manager ARN), exposed_tools[], allowlist_state, health_state, enabled, created_by, ... }`. Per account.
- **AgentSpace** — `{ account_id, enabled_agent_ids[], enabled_skill_ids[], enabled_mcp_ids[], tool_allowlist[], version }`. One per account (ADR-008). `version` increments on any change for traceability.
- **CustomizationAudit** — append-only `{ id, account_id, actor, action, object_type, object_id, before_hash, after_hash, at }`.

### Aurora schema sketch (Phase 1 tables)

```sql
CREATE TABLE skills (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  instructions  TEXT NOT NULL,
  tool_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
  reference_keys JSONB NOT NULL DEFAULT '[]'::jsonb,   -- S3 object keys
  tier          TEXT NOT NULL CHECK (tier IN ('builtin','custom')),
  content_hash  TEXT NOT NULL,                          -- SHA-256 of canonical form
  version       INT  NOT NULL DEFAULT 1,
  enabled       BOOLEAN NOT NULL DEFAULT false,         -- disabled-by-default
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name, version)
);

CREATE TABLE agents (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  persona         TEXT NOT NULL,
  routing_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  model           TEXT,
  tier            TEXT NOT NULL CHECK (tier IN ('builtin','custom')),
  version         INT NOT NULL DEFAULT 1,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name, version)
);

CREATE TABLE agent_skills (
  agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id BIGINT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  ord      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, skill_id)
);

-- Phase 2
CREATE TABLE agent_spaces (
  account_id        TEXT PRIMARY KEY,
  enabled_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled_skill_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled_mcp_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_allowlist    JSONB NOT NULL DEFAULT '[]'::jsonb,
  version           INT NOT NULL DEFAULT 1,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 3
CREATE TABLE mcp_registrations (
  id             BIGSERIAL PRIMARY KEY,
  account_id     TEXT NOT NULL,
  name           TEXT NOT NULL,
  endpoint       TEXT NOT NULL,
  transport      TEXT NOT NULL CHECK (transport IN ('sigv4','oauth','apikey')),
  credentials_ref TEXT,                                 -- Secrets Manager ARN
  exposed_tools  JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowlist_state TEXT NOT NULL DEFAULT 'pending',
  health_state   TEXT NOT NULL DEFAULT 'unknown',
  enabled        BOOLEAN NOT NULL DEFAULT false,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, name)
);

CREATE TABLE customization_audit (
  id          BIGSERIAL PRIMARY KEY,
  account_id  TEXT,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,        -- create|update|enable|disable|delete
  object_type TEXT NOT NULL,        -- skill|agent|mcp|space
  object_id   TEXT NOT NULL,
  before_hash TEXT,
  after_hash  TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## 3. Components

- **Admin UI** (`src/app/agents/` or `src/app/customization/`) — admin-gated (ADR-023). Catalog CRUD for skills/agents, M:N attach, MCP registration (Phase 3), and per-account Agent Space composition (Phase 2). Disabled-by-default; explicit enable toggle. Surfaces the "read-only tools + read-only credentials" guidance for MCP.
- **Resolver** (`src/lib/agent-resolver.ts`) — single reader of the catalog. Input `(accountId, query)`. Loads the effective Agent Space (built-in + enabled custom), exposes the candidate agent set + routing keywords to the classifier, and on selection composes the **resolved spec**: `{ persona, composedInstructions, toolAllowlist, mcpEndpoints[], spaceVersion, skillHashes[] }`. Caches catalog reads with a short TTL (reuse the node-cache pattern), keyed by `accountId` + space `version`.
- **Classifier extension** (`src/app/api/ai/route.ts`) — today's 11 fixed routes become the built-in agent set; the classifier additionally considers enabled custom agents by `routing_keywords`/description. Multi-route synthesis (ADR-025) unchanged.
- **`agent.py` (registry-agnostic)** — receives the resolved spec in the payload. Builds the system prompt from `persona + composedInstructions`. Connects to allowlisted built-in gateways (existing auto-discovery) plus `mcpEndpoints[]` via `streamable_http_sigv4.py` (OAuth/API-key transports added in Phase 3). Never reads the catalog directly.
- **Validation pipeline** (`src/lib/skill-validation.ts`) — on author/upload: schema validation → tool_allowlist validated against the known tool catalog → size/lint/forbidden-pattern checks → SHA-256 content hash → (Phase 3, external uploads) cosign signature verify → (MCP) health check + endpoint allowlist (ADR-011) → store disabled → require explicit enable.
- **BYO-MCP manager** (Phase 3, `src/lib/mcp-registry.ts`) — registers per-account MCP servers, stores credentials in Secrets Manager, probes health, lists exposed tools for allowlisting.

## 4. Data flow

**Authoring (admin):** UI form/upload → validation pipeline → artifacts to S3 (hash-named), metadata + hash to Aurora (disabled) → admin enables → audit row.

**Query-time:** user query → resolver loads effective Agent Space for current account → classifier selects built-in/custom agent(s) → resolver composes resolved spec → payload to AgentCore → `agent.py` connects to allowlisted gateways + BYO-MCP, runs with composed system prompt → SSE stream (ADR-021) → response logged with `spaceVersion + agentId + skillHashes`.

## 5. Security & governance (multi-layer)

1. **Admin-only authoring** (ADR-023); **disabled-by-default**.
2. **Server-side allowlist enforcement** — at resolve/execute time the tool set is intersected with the known tool catalog and the Agent Space `tool_allowlist`; a skill cannot grant a tool it is not allowed, regardless of its declared `tool_allowlist`.
3. **ADR-029 gate** — any mutating tool requires the mutating-action approval flow; custom agents are read-only by default.
4. **Integrity** — SHA-256 content hash stored at author time, verified on load (Phase 1). cosign/Sigstore signature verification for externally-sourced uploads (Phase 3); depends on cosign key custody (shared with ADR-030).
5. **BYO-MCP egress control** — endpoint allowlist + SSRF protections (extend ADR-011); transport auth required; credentials in Secrets Manager; surface AWS "read-only tools + read-only credentials" guidance.
6. **Audit** — every authoring action and every custom-agent invocation recorded.

## 6. Traceability

Every AI response and AgentCore stat record carries `{ agentSpaceVersion, agentId, skillHashes[] }`. This makes "account A returns a wrong answer" reproducible (which skills/versions were live) and doubles as the integrity anchor (hashes tie back to stored content).

## 7. Dev mode

`SKILLS_SOURCE=local` reads the catalog from a local Postgres + `agent/skills/` directory with hot-reload, bypassing S3/Aurora-cloud. Keeps the edit→test loop fast; no LocalStack pipeline required for basic skill authoring.

## 8. Phasing & acceptance criteria

- **Phase 1 — Catalog + resolver + admin CRUD (125 tools only).**
  - AC: built-in agents/`SKILL_BASE` migrated as read-only catalog entries; admin can create/enable a custom skill and attach it to an agent; resolver composes the spec; `agent.py` runs from the spec; SHA-256 verified on load; response logs `agentSpaceVersion + skillHashes`; `SKILLS_SOURCE=local` hot-reload works. No rebuild needed to add a skill.
- **Phase 2 — Per-account Agent Spaces.**
  - AC: enabling a skill/agent for account A does not affect account B; resolver honors per-account `tool_allowlist`; space `version` increments and appears in logs.
- **Phase 3 — BYO-MCP + signing.**
  - AC: admin registers a SigV4 MCP server (then OAuth/API-key); health check + endpoint allowlist enforced; exposed tools allowlistable; uploaded artifacts cosign-verified; credentials in Secrets Manager.
- **Phase 4 (gated) — mutating tools.**
  - AC: a custom agent invoking a mutating tool routes through the ADR-029 approval flow; blocked otherwise.

## 9. Error handling

- Resolver failure → fall back to built-in agents (assistant never breaks).
- BYO-MCP connection/health failure → skip that MCP, log, surface "degraded" in the response.
- Invalid/unsigned/hash-mismatch artifact → rejected at author time (Phase 1 hash; Phase 3 signature); never loaded.
- Disabled-by-default prevents half-configured agents going live.

## 10. Testing strategy (TDD per repo norm)

- Resolver: spec composition (built-in + custom), instruction ordering, allowlist intersection, fallback on failure.
- Classifier: selection of custom agents by routing keywords alongside built-ins; multi-route synthesis intact.
- Validation pipeline: schema rejects, tool-allowlist-against-catalog, hash compute/verify, (Phase 3) signature verify.
- Governance: admin-only enforcement, read-only-default, ADR-029 routing for mutating tools, audit row written.
- BYO-MCP (Phase 3): registration validation, endpoint allowlist, health-check gating, Secrets Manager credential resolution.
- Traceability: response/log carries correct space version + skill hashes.

## 11. Open questions

- Catalog scope of built-in migration: migrate all 8 gateways' `SKILL_BASE` verbatim in Phase 1, or curate while migrating?
- Resolver placement: pure `src/lib` module invoked by `route.ts`, vs a thin `/api` resolve endpoint `agent.py` could also call. (Lean: `src/lib`, payload-passed.)
- cosign key custody resolution timeline (shared with ADR-030).
