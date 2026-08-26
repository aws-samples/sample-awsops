# Design Spec: Custom Agent Platform — Frontier Agents + Integrations Axis (extends ADR-031)

- **Status**: Active (2026-06-13) — companion spec to **ADR-039** (`docs/decisions/039-multi-agent-platform-frontier-agents-integrations.md`, Accepted 2026-06-13 via multi-AI co-agent consensus); extends ADR-031. P1 implemented; P2+ backlog.
- **Supersedes**: `docs/superpowers/archive/2026-05-31-custom-agents-skills-design.md` (the original ADR-031 spec — its catalog/resolver/Agent-Space model is carried forward and extended here).
- **Owner**: AWSops AI layer.
- **Decision inputs**: AWS DevOps Agent + Security Agent customization model (the explicit reference); FinOps Foundation framework (forthcoming FinOps agent); multi-AI co-agent decision on the Integrations axis (Option 4, codex+gemini unanimous, kiro concurring on the single-substrate principle).

---

## 한국어 요약 (TL;DR)

AWSops를 **여러 프런티어 AI 에이전트(DevOps · Security · FinOps, 그리고 N개로 확장 가능)를 호스팅·커스터마이즈하는 플랫폼**으로 만든다. AWS DevOps Agent의 커스터마이징 모델(Agent Space + Skills + MCP + Capability Providers, dual-console UX)을 차용하되, 두 가지를 **확장**한다: (R1) 에이전트들이 **함께 오케스트레이션**되어 협업(ADR-032 Lead/Sub 재사용), (R2) **read/write 외부 통합**(Notion·Confluence 등) — AWS의 read-only 권고를 넘어, 쓰기는 기존 mutating gate(ADR-029/036)로 거버넌스.

**4개 기둥(축):**
1. **Frontier Agents** — DevOps/Security/FinOps를 1급 카탈로그 객체로(현재 `agents`를 확장: 멀티-게이트웨이 스코프 + agent-type + 응답언어 + 연결된 integrations). built-in 시드 + custom.
2. **Skills** — 재사용 지시 패키지(SKILL.md frontmatter + Markdown + references/assets). UI 폼 / zip 업로드. agent-type 타게팅. (`skills`/`agent_skills` 확장.)
3. **Integrations** (신규 축, **Option 4**) — 외부 커넥터를 1급 **타입드 카탈로그**로 노출하되 **실행 substrate는 단일 MCP 하나**. `READ` vs `READ_WRITE` 능력 플래그 → 쓰기는 자동으로 mutating gate(action_catalog → P2 워커)로. 공유 capability provider(모든 에이전트가 재사용).
4. **Agent Spaces** — 계정별 활성화·스코핑·도구 cap(기존 `agent_spaces` 확장: enabled integrations 추가).

**실행 substrate는 바꾸지 않는다** — 공유 AgentCore Runtime + Aurora 카탈로그 + registry-agnostic `agent.py` + resolver. 커스터마이즈는 **데이터**이지 재빌드가 아니다.

**핵심 보안 마감(현존 갭):** (a) `agent.py`가 `toolAllowlist`를 실제 강제하도록(현재 무시 — no-op), (b) revocation fail-closed, (c) write 통합은 mutating gate 경유만, (d) 마이그레이션 드리프트(카탈로그 테이블이 ULID 마이그레이션에 부재) 해소.

**권한 분리:** Agent Space·Integration/MCP 등록(egress/자격증명/SSRF 표면) = admin. **폼 기반** Skill·Agent 작성·조합 = 일반 사용자 — 단 **per-account 플래그 `nonAdminAuthoring` default-OFF(=admin-only)** 뒤(켜기 전까진 admin 전용; read-only 범위·disabled-by-default·admin-only enable). **zip 업로드는 플래그 무관 cosign 전까지 admin 전용**(ADR-031 Addendum #6 공급망 표면). ADR-031 admin-only authoring 대비 의도적 완화(co-agent Q3) — §16 기록.

---

## 1. Goals / Non-goals

### Goals
- Host **multiple frontier agents** (DevOps, Security, FinOps) as first-class, **extensible to N** — adding FinOps is a seed row + capability wiring, not a code fork.
- Mirror the **AWS DevOps Agent customization model** (Agent Space, Skills, account-level capability registration, tool allowlisting, agent-type targeting, Active/Inactive) and its **dual-console UX**.
- Add a first-class **Integrations axis** (Capability Providers) — ONE catalog/UI spanning both directions: **egress** observability (Grafana/Datadog/Splunk/New Relic/Prometheus, READ) and read/write knowledge/work/comms systems (Notion/Confluence/Jira/ServiceNow/Slack, READ_WRITE, writes via the mutating gate), **and ingress** webhook alarm sources (CloudWatch SNS / Alertmanager / Grafana / PagerDuty / Datadog / generic) that trigger the incident lifecycle via the existing ADR-022 webhook + ADR-032 triage.
- **Federate** agents (R1): DevOps/Security/FinOps work in concert via the existing ADR-032 Lead/Sub orchestration over a shared Agent Space.
- **direct-compose first**, with **optional lightweight AI-assist** (draft a SKILL.md from a description; suggest a tool/integration allowlist).
- Customization is **data on a shared runtime** — no per-agent infra, no Docker rebuild (preserve ADR-031's core property).
- Close the **known runtime/security gaps** (tool-cap enforcement, fail-closed revocation, migration drift, admin reachability).

### Non-goals (YAGNI)
- A generative "agentcore creator" that provisions a dedicated AgentCore Runtime per agent (rejected: contradicts the no-rebuild substrate; the user de-scoped this — "스펙이 너무 넓다").
- Per-user agents; cross-org/cross-account agent federation beyond ADR-008; a public skill/integration marketplace.
- Learned Skills (auto-generated topology / tool-use best practices) — noted as a **later phase**, not in the first build.
- Replacing the section gateways or ADR-038 hybrid routing.
- A second execution/egress substrate for integrations (the co-agent decision explicitly forbids this).

---

## 2. Reference model (what we mirror) and our extension

AWS frontier agents (DevOps Agent, Security Agent; FinOps Agent forthcoming) are all **built on Amazon Bedrock AgentCore** and split customization into **three axes** inside a per-account **Agent Space** (a logical container defining what the agent can access):

| Axis | AWS concept | What it is |
|---|---|---|
| **Skills** | DevOps Agent Skills | Non-executable knowledge: `SKILL.md` (frontmatter `name`+`description`, Markdown instructions) + `references/` + `assets/`. UI form or ≤6 MB zip. Agent-type targeting. Active/Inactive. |
| **MCP Servers** | account-level MCP registration | Tools via Streamable HTTP; OAuth2 / API-key / **SigV4**; per-Agent-Space tool allowlist; read-only guidance. |
| **Capability Providers / Integrations** | GitHub, GitLab, Grafana, Datadog, Splunk, ServiceNow, PagerDuty, Slack | Typed first-party connectors with their own connection + auth lifecycle; feed **tools AND context** (topology, dashboards, deployment data). |

**Agent types** (fixed lifecycle roles, not user-created): Generic / On-demand / Incident Triage / Incident RCA / Incident Mitigation / Evaluation. Skills target one or more.

**Our two extensions beyond AWS:**
- **R1 — Federation**: AWS DevOps Agent is one agent with sub-types; we host *multiple* frontier agents that must be orchestrated together. We reuse our ADR-032 Lead/Sub incident lifecycle as the orchestration spine.
- **R2 — read/write Integrations**: AWS guidance is read-only. We need governed writes (Notion/Confluence create/update, ticketing, comms). Each integration carries a `READ` vs `READ_WRITE` capability; writes are bound to the ADR-029/036 mutating gate.

---

## 3. Current state (grounded) — what exists, what's missing

> Verified by reading the live code/ADRs (not assumed). Exact contracts in §6/§9.

**Substrate (reuse as-is):**
- Shared AgentCore Runtime; `agent.py` is **registry-agnostic** — it executes a resolved spec via payload `{messages, gateway, skill, systemPromptOverride, accountId, accountAlias}`. `SKILL_BASE` has 9 persona keys (`network, container, ops, data, security, monitoring, cost, diagnostics, iac`; `DEFAULT_GATEWAY='ops'`). Gateways discovered via `bedrock-agentcore-control list-gateways` or `GATEWAYS_JSON`.
- Chat routing (ADR-038): **explicit section pin > custom-agent keyword match > Haiku/regex classifier**, with an inactive-section guard.
- Resolver (`web/lib/agent-resolver.ts`): `resolveAgent()` builds `systemPromptOverride = SAFEGUARD_LINE + persona + ordered skill instructions` and an (advisory) `toolAllowlist`.
- Catalog (`web/lib/catalog.ts` + Aurora): `skills`, `agents` (single `gateway`), `agent_skills` (M:N + `ord`), `agent_spaces` (per-account), `customization_audit`. Custom rows default `enabled=false`; 8 built-in gateway agents seeded `enabled=true`.
- Mutating gate (ADR-029/036): governed write path **already exists** — `POST /api/actions` (plan; ADR-029 idempotency token, paired rollback, dry-run) → `POST /api/actions/[id]` (execute: flag + kill-switch + 4-eyes-or-`singleOperatorApproved` + not-expired gates) → `worker_jobs(type='action')` → SQS → dispatcher → **the shared P2 worker Step Functions** (the ADR-036 single spine; `$.runtime` Choice routes to the per-action executor — **not** a separate "remediation" state machine) → per-action executor. `action_catalog` is the single facade (executor_type ∈ {ssm, lambda, fargate}); durable idempotency is ultimately enforced by ADR-036's `job_id == SFN execution-name`. **All flag-off** today.
- Federation (ADR-032): Lead/Sub over a Step Functions Map; composition unit = **Agent Space**; `agent_bridge.invoke` mirrors `resolveAgent`. **Flag-off** today.
- Admin/auth: `isAdmin` = Cognito group OR SSM email allowlist (fail-closed); `verifyUser` = RS256 JWKS; `currentAccountId()='self'`.

**Confirmed gaps this spec must close:**
1. **Tool cap is a runtime no-op** — `agent.py` never reads `payload.toolAllowlist`; it loads ALL gateway tools. ADR-031's "enforce outside the model" is not actually enforced.
2. **`KNOWN_TOOL_CATALOG` is all-null** — the skill∩catalog intersection dimension is dead.
3. **Revocation not fail-closed** — 30 s cache TTL on the chat hot path; a disabled agent can still be selected for ≤30 s.
4. **No first-class frontier-agent object** — DevOps/Security/FinOps are personas/gateways, not selectable agents; `agents` is single-`gateway`.
5. **No Integrations axis, no BYO-MCP** — gateways are the fixed AgentCore set; no external connector registration; no read/write classification.
6. **No user-facing agent picker** — chat only pins built-in sections; custom agents reachable only via routingKeywords.
7. **UX gaps vs AWS** — no skill-create form, no agent-type, no zip/assets, no model picker, no AI-assist.
8. **Migration drift** — catalog tables live only in frozen `schema.sql` (integer ledger), not in ULID migrations; runner-only DBs may lack them.
9. **Admin unreachable in live** — zero Cognito admin-group members + blank SSM `admin_emails` → everyone 403 (ops fix, not code).
10. **Mutating gate not wired to chat** — chat mutation-safety is prompt directive + read-only IAM only.

---

## 4. Architecture — four pillars on the shared resolver substrate

```
                        ┌──────────────────────────────────────────────┐
                        │            AWSops Agent Platform              │
                        │                                              │
  ADMIN console ──────► │  Frontier Agents   Skills   Integrations     │ ◄── Operator / author
  (Agent Space,         │  (DevOps/Security/ (SKILL.md  (typed catalog  │     (compose, chat,
   Integration/MCP      │   FinOps + custom)  + assets)  over 1 MCP)    │      AI-assist)
   registration)        │         │             │            │         │
                        │         └──────┬──────┴─────┬──────┘         │
                        │            Agent Space (per account)          │
                        │         enabled agents/skills/integrations    │
                        │            + tool allowlist cap + version      │
                        └───────────────────┬──────────────────────────┘
                                             │  resolver (web/lib + python)
                                             ▼
            ┌──────────────────────────────────────────────────────────────┐
            │  Effective spec: persona + ordered skills + ENFORCED tool      │
            │  allowlist + integration context + agent-type                  │
            └───────────────┬──────────────────────────────┬───────────────┘
                            │ chat (resolveAgent)           │ federation (ADR-032 Lead/Sub)
                            ▼                                ▼
                  registry-agnostic agent.py  ◄── single shared AgentCore Runtime
                            │
          ┌─────────────────┼───────────────────────────────┐
          ▼                 ▼                                 ▼
   section gateways   MCP tools (READ)              WRITE actions (READ_WRITE)
   (~120 read tools)  (incl. Notion/Confluence read)  → action_catalog → P2 worker
                                                        (ADR-029/036 mutating gate)
```

**Invariants:**
- Customization is data; the runtime executes a resolved spec. No per-agent infra, no rebuild.
- One execution substrate. Integrations are typed catalog/UX/governance metadata over **MCP registrations** — never a second runtime (the co-agent guardrail).
- Reads flow through the allowlisted tool set; **every write transits the mutating gate** (`action_catalog` → P2). The model never writes directly.
- The server-side tool allowlist is enforced **outside the model** (in `agent.py`), not merely advised.

---

## 5. Pillar 1 — Frontier Agents (first-class entity, Approach A)

Promote `agents` from a single-`gateway` persona to a **frontier-agent entity** that DevOps/Security/FinOps and custom agents all share.

**Model (extends the existing `agents` row):**
- `kind` / `agent_type`: the AWS lifecycle role set — `generic | on_demand | triage | rca | mitigation | evaluation`. Default `generic`. (Skills target these; see §6.)
- **Capability scope spanning multiple gateways/tools**: replace the single `gateway` with a `gateways JSONB` (ordered list of section keys) **plus** a `tool_allowlist`/integration binding. The single `gateway` column is kept (back-compat) and treated as `gateways[0]` during migration.
- `response_language` (per AWS Agent Space; Korean supported) — feeds the agent directive.
- `tier` (`builtin | custom`) — unchanged. Built-in seeds: `devops`, `security`, `finops` (each composing the relevant section gateways + a curated skill/integration set).
- `enabled` — unchanged (custom default false).

**Mapping the frontier agents to existing capabilities (no new gateways required for P1):**
| Frontier agent | Composes (section gateways) | First integrations |
|---|---|---|
| **DevOps** | ops, monitoring, container, iac, network | Grafana/Datadog (READ), Slack/Jira (READ_WRITE) |
| **Security** | security (+ iam tools) | (later) security feeds |
| **FinOps** | cost (existing `aws_finops_mcp.py` / 5 recommendation tools per **ADR-015**) | Notion/Confluence (READ_WRITE for cost reports), CUR/FOCUS feeds |

> The FinOps frontier agent **composes the existing ADR-015 FinOps MCP tools** (rightsizing / SP-RI / Cost Optimization Hub / Trusted Advisor) — it does NOT introduce a new cost-recommendation surface. FinOps Foundation domain structure (Inform/Optimize/Operate; 4 domains; FOCUS) informs only the FinOps agent's **skills** (e.g. `rate-optimization`, `anomaly-management`, `unit-economics`), not new schema or tools.

**Runtime impact:** a multi-gateway agent requires `agent.py` to either (a) be invoked per gateway and synthesized (the ADR-032 Lead/Sub pattern), or (b) gain a multi-gateway tool-union mode. **P1 keeps single-gateway execution** (frontier agents seed one primary gateway), and multi-gateway/federation is delivered via the ADR-032 spine in a later phase — avoiding a deep `agent.py` rewrite up front.

---

## 6. Pillar 2 — Skills (authoring parity with AWS)

Extend `skills` + authoring to match AWS DevOps Agent Skills:
- **Frontmatter** (`name` kebab ≤64, `description` ≥100 chars recommended) — already validated; add a parser for zip-uploaded `SKILL.md`.
- **Agent-type targeting**: `agent_types JSONB` (default `["generic"]`) — a skill is evaluated only for matching agent types (context economy).
- **references/ + assets/**: optional artifacts stored in **S3** (content-hash keyed), `reference_keys JSONB` on the skill (the field existed in the original ADR-031 spec; wire it). ≤6 MB zip, **no `scripts/`** (non-executable only). **Zip upload is admin-only until cosign/Sigstore verification (ADR-031 Phase 3 / Addendum #6) — see §11**; form-based authoring (no upload) is open to any user.
- **Active/Inactive** — maps to existing `enabled`.
- **AI-assist (optional)**: a "draft from description" action calls the existing classifier/Bedrock to generate a `SKILL.md` body + suggest a tool allowlist; the human edits and saves. The generated content is **untrusted** and passes the same validation/allowlist enforcement.

`agent_skills` (M:N, `ord`) is unchanged; composition order drives instruction concatenation.

---

## 7. Pillar 3 — Integrations axis (Option 4: typed catalog over one MCP substrate)

**Decision (co-agent, Option 4):** Integrations are a **first-class typed catalog + UX + governance concept**, but **mechanically every integration is an MCP registration** — one auth/egress/allowlist/mutating-gate code path. No second runtime.

**Relationship to existing ADRs (the Integrations axis SUBSUMES three existing concepts — it must reuse, not duplicate, them):**
- **ADR-011 (external datasource integration) — egress READ observability is the v2 re-derivation of this.** ADR-011 already owns external-observability READ (Prometheus/Loki/Tempo/Jaeger/ClickHouse/Dynatrace/Datadog) via `web` `datasource-registry.ts`/`datasource-client.ts`/`datasource-prompts.ts` + `/api/datasources` + NL→DSL. ADR-039's egress-READ integrations are that capability **re-based onto the MCP substrate**; the per-type registry (health-check, query-language id, supported auth) and NL→DSL prompts map onto `integrations.provided_context`/`exposed_tools`. v1 `datasources` stays frozen (v1→v2 carry-over). **ADR-011's SSRF defense is inherited verbatim — see §11.**
- **ADR-012 (SNS/Slack notification) — Slack split by ownership.** ADR-012's `slack-notification.ts` Block Kit sender owns **system notifications** (severity→channel, incident threads via `slack_thread_ts`). The Integrations `slack` connector owns **agent-proposed governed writes** (READ_WRITE → mutating gate). The integration **reuses ADR-012's Slack client/credential**, not a second sender.
- **ADR-031 `mcp_registrations` → `integrations`.** The `integrations` table with `kind=custom_mcp` **supersedes** the archived ADR-031 `mcp_registrations` object; its `health_state`/`allowlist_state` lifecycle maps onto integration health-check + `exposed_tools` allowlisting. ADR-031 registered BYO-MCP **per account**; here registration is a **global catalog row + per-account enablement** (`agent_spaces.enabled_integration_ids`) — per-account **isolation** is preserved via per-account credential scoping + enablement (ADR-031 Addendum #4), not row ownership. (This is a deliberate change to ADR-031's per-account registration model, recorded in §16.)

**Object model — `integrations` (new table):** ONE catalog + ONE admin UI for every external connector — both **egress** (the agent reaches out: observability READ, Slack/Notion/Confluence/Jira READ_WRITE) **and ingress** (an external system reaches in: webhook alarm sources that trigger the incident lifecycle). Operators register "connect Datadog", "connect Slack", and "receive PagerDuty alerts" on the same screen.
- `id`, `name`, `kind` — egress: `grafana | datadog | splunk | prometheus | newrelic | notion | confluence | jira | servicenow | slack | github | gitlab | custom_mcp`; **ingress (webhook source): `cloudwatch_sns | alertmanager | grafana_alert | pagerduty | datadog_monitor | generic_webhook`** — and `description`.
- **`direction`: `egress | ingress`** — the new load-bearing dimension. (A vendor like Datadog/Grafana can appear as TWO rows: an `egress` READ connector AND an `ingress` alarm source — distinct connection/auth/lifecycle.)
- `connection` (**egress**): endpoint URL; `transport` (`sigv4 | oauth_client_credentials | oauth_3lo | api_key`); `credentials_ref` (Secrets Manager ARN — never plaintext); optional `private_connection_ref` (VPC path).
- `capability` (egress): **`READ | READ_WRITE`** — the load-bearing governance attribute for egress writes.
- **`ingress` fields**: `receive_path`/generated receive URL; `auth_mode` + `inbound_auth_ref`; `source_allowlist` (sender IP/identity); `trigger_target` (`incident` → ADR-032 triage). Ingress carries NO outbound `credentials_ref`/`exposed_tools`. **Inbound auth is per-source, NOT uniform HMAC** (ADR-022 Post-acceptance correction): HMAC-SHA256 shared-secret (Secrets Manager, with ADR-022's active/standby rotation pair) applies **only to push emitters that can sign — `alertmanager`, `grafana_alert`, `generic_webhook`**; **`cloudwatch_sns` uses SNS subscription-confirmation + the ADR-012 SNS→SQS→IAM path (NO customer HMAC)**; `pagerduty`/`datadog_monitor` use their **vendor signature scheme** verified by a per-source adapter. (v1 stored these in `data/config.json`; v2 stores in Secrets Manager per §11 credential custody.)
- `exposed_tools JSONB` (egress, allowlistable tool ids), `provided_context JSONB` (typed context schema: topology/dashboards/wiki — injected into the effective spec).
- `write_action_refs JSONB`: for `READ_WRITE`, the `action_catalog` entries each write maps to (e.g. `notion.create_page` → catalog row `executor_type='lambda'`).
- `tier` (`builtin | custom`), `enabled` (default false), `created_by`, audit fields.

> P1 created the `integrations` table with the egress columns + free-text `kind` (unused at runtime). The `direction` column + the ingress columns above are an **additive P2 migration** (the P1 migration is committed/idempotent — not edited); a `kind` CHECK is added in P2 once the set stabilizes.

**Auth (SigV4 first, then OAuth/API-key):** mirror AWS exactly — SigV4 reuses IAM trust (confused-deputy `aws:SourceAccount`/`aws:SourceArn` conditions); OAuth Client Credentials / 3LO / API-key store secrets in Secrets Manager with rotation. Private VPC connections for self-hosted tools (analogous to AWS's VPC Lattice resource gateway; for us, our MCP Lambdas already run in-VPC).

**READ path:** allowlisted integration tools are added to the agent's effective tool set exactly like section-gateway tools, and enforced in `agent.py` (§9).

**WRITE path (R2 — the critical governance binding):** **🧊 FROZEN (2026-06-11 reversal) — do-not-enable.** The mutating gate (ADR-029/036) this path rides is REVERSED/frozen; the design below is recorded but **not implementable** until the substrate is un-reversed by a future decision. a `READ_WRITE` integration **does not expose raw write tools to the model**. Each write is an `action_catalog` row (`executor_type='lambda'`, `dry_run_contract`, paired `rollback_ref`, `approval_mode`, `enabled=false`). The model only *proposes inputs*; execution requires:
`POST /api/actions {action, inputs}` (admin, plan) → `POST /api/actions/[id] {op:'execute'}` (flag + kill-switch + **4-eyes [approver≠creator, default ON] OR ADR-029 §4 `singleOperatorApproved`/`dual-control:false` escape hatch, logged** + not-expired) → `worker_jobs(type='action')` → dispatcher → **the shared P2 worker Step Functions** (`$.runtime` → `lambda` executor; ADR-036 single spine, not a separate machine) → the per-action `lambda` executor performs the Notion/Confluence API call in-VPC, re-validating the catalog gate. (ADR-036 rule 3: external/app-state writes route to the P2 `lambda` executor, NOT SSM, which is AWS-resource-only.)

> Example: `notion.create_page` ships as a disabled catalog row with a paired rollback `notion.archive_page`; first dry-run renders the page body with no side effect.

**INGRESS path (webhook alarm sources — same UI, opposite direction):** an `ingress` integration is the **registration/config surface** for an external alarm source; it does NOT introduce a new ingestion engine (one-substrate principle). It is the config layer over the **already-existing v2 route `web/app/api/incidents/webhook/route.ts`** (ported from v1 `src/app/api/alert-webhook`; it already has the SNS subscription-confirmation branch + HMAC verify) + **ADR-032 triage**. Flow: external alarm → `POST` to the receive URL → **per-source inbound auth** (see ingress fields above: HMAC for push emitters; SNS-confirm + ADR-012 SNS→SQS→IAM for `cloudwatch_sns`; vendor-signature adapter for SaaS) + source allowlist → **ADR-032 triage (New/Linked/Skipped — this is the ADR-032 look-back component, i.e. the ADR-009 correlation engine carried forward; ADR-009 is Superseded by ADR-032, NOT the legacy single-pass path)** → Lead/Sub investigation. Loop breaker = the ADR-034 **self-marker filter (drop `CreatedBy=AWSops-AIOps` events) PLUS a max-concurrent-RCA cap** (both halves). **Edge reachability — DECIDED (2026-06-13):** **SaaS ingress IS allowed via webhook** — build the **Lambda@Edge viewer-request carve-out for the webhook path only** (the ADR-022 single Cognito-everywhere exception extended to the v2 edge), with the ADR-022 1-hop-vs-2-hop XFF branch; the per-source inbound auth (HMAC / SNS-confirm / vendor signature) + source allowlist is the security boundary for that public path. **Egress to SaaS is allowed** because the AgentCore agent + MCP Lambdas run **VPC-internal** (mgmt-vpc, behind NAT) — they reach public SaaS endpoints (Datadog/Notion/etc.) outbound; the §11 SSRF blocklist still blocks **private**/metadata targets (public SaaS is permitted, the legitimate case). The Integrations UI surfaces ingress rows with an "alarm source" badge + copyable receive URL + secret rotation; the trigger/lifecycle stays in ADR-032 (R1 / P4).

**Shared across agents (R1):** integrations are **capability providers reused across DevOps/Security/FinOps** via the Agent Space (`enabled_integration_ids`), not bound to one agent.

---

## 8. Pillar 4 — Agent Spaces + Federation (R1)

**Agent Spaces (extend `agent_spaces`):** add `enabled_integration_ids JSONB` and `response_language`. Semantics unchanged: missing row ⇒ Phase-1 global behavior; tool allowlist cap can only REMOVE. The composition unit for both chat and federation.

**Federation (reuse ADR-032 Lead/Sub):** DevOps + Security + FinOps "work together" = a **Lead (Incident Commander) composes them as read-only Sub-agents** rostered from the Agent Space and fanned out over the Step Functions Map; RootCause synthesizes. This is **orchestration, not peer-to-peer** — and it already exists (flag-off). Two items:
- **Per-account Agent Space roster scoping (gap-closure, NOT new):** ADR-032 already *decided* the roster is "scoped by the per-account Agent Space" (Decision relationship table, consumes ADR-031). The current `lead.py` reads all enabled agents globally — this phase **closes that implementation gap** by calling `getAgentSpace(account)`/`enabled_agent_ids` (matching the chat path).
- **Frontier-agent rostering**: the Lead rosters by frontier agent (devops/security/finops) + their gateways, not only raw section gateways — a compatible extension of ADR-032's "roster resolved via ADR-031 Agent Space" (the frontier agent is just what the resolver now returns).
- Mutation in any stage stays recommendation-only → ADR-029/036 gate. The Lead remains least-privilege (delegate-only).
- **Memory isolation (ADR-018):** every Sub-agent invocation in the fan-out MUST carry the originating operator's `userId` + the Agent Space `accountId`, so ADR-018's per-user + per-account memory isolation holds across the Lead/Sub fan-out (no shared-pool memory bleed across operators/accounts).

> Federation rides the existing P2 backbone (`worker_jobs type='incident_stage'` → the incident SM, a sibling of the P2 worker SFN). No second spine.

---

## 9. Resolver & runtime changes (close the gaps)

1. **Enforce `toolAllowlist` in `agent.py` (gap #1, security-critical):** read `payload['toolAllowlist']`; when present and non-empty, filter `get_all_tools(mcp_client)` by tool name **before** `Agent(tools=...)` and before building the "## Available Tools" section. Empty/absent ⇒ current behavior (all tools). This makes ADR-031's "enforce outside the model" real.
2. **Fill `KNOWN_TOOL_CATALOG` (gap #2):** populate per-gateway tool inventories we can enumerate (mirror the gateway Lambda tool sets) so the skill∩catalog dimension actually narrows; keep `null` = degrade-safe for unknown gateways. Tightening only ever ADDS restriction.
3. **Fail-closed revocation (gap #3):** on disable/revoke, bust the `catalog-source` cache immediately for that account (version bump already busts; add an explicit invalidation on the disable path) so a disabled agent/skill/integration is unusable at once — not after 30 s. The 30 s window stays only for *enable* (non-security) changes.
4. **Integration context injection:** the resolver adds typed `provided_context` from enabled integrations into the effective spec (bounded size; counts toward token budget).
5. **agent-type & multi-gateway:** the resolver passes `agent_type`; multi-gateway union is deferred (P1 = single primary gateway). **Two distinct multi-domain paths must not be conflated:** interactive **chat** multi-domain synthesis is owned by **ADR-025** (parallel 1–3 route fan-out + a Bedrock `synthesizeResponsesStreaming()` merge over SSE) — confirm whether v2 chat reuses ADR-025 fan-out or defers it; incident-time multi-agent collaboration is **ADR-032** Lead/Sub (P4). The frontier-agent `gateways[]` scope feeds whichever path applies, not a new synthesis engine.
6. **DRY the resolver:** `web/lib/agent-resolver.ts` (chat) and `scripts/v2/incident/agent_bridge.py` (federation) must stay byte-identical on `SAFEGUARD_LINE` and resolution semantics; add a cross-language parity test.

---

## 10. UX — dual-console, AWS DevOps Agent-style

**Navigation / IA (co-agent decided 2026-06-13, unanimous Q1=C — hybrid):** a **Settings hub** holds the low-frequency admin surfaces — **Accounts** (the v2 multi-account registry), **Admin** (SSM admin_emails / Cognito group), and **OpenCost install** (a governed ADR-029 mutating action, isolated from routine config) — while **Integrations** and **Agent Spaces** stay **first-class top-level pages** (high-frequency, AWS-Capability-Providers parity, scale to N connectors/accounts). OpenCost-install lives in Settings but executes through the mutating gate, not as a plain toggle.

**Admin console** (gated by `isAdmin`):
- **Agent Spaces** (first-class page): create/scope per account; name, description, response language, enabled agents/skills/integrations, tool allowlist cap.
- **Integrations / Capability Providers** — ONE screen for both directions, filterable by a **direction** toggle (egress / ingress):
  - **egress** (kind picker → connection → auth wizard SigV4 / OAuth / API-key → review): per-vendor presets (Notion/Confluence/Grafana/Datadog/Slack), tool allowlisting per Agent Space, READ vs READ_WRITE, health check. Credentials → Secrets Manager.
  - **ingress** (webhook alarm source: cloudwatch_sns / alertmanager / grafana_alert / pagerduty / datadog_monitor / generic_webhook): the wizard **generates a receive URL + HMAC secret** (ADR-022), captures a source allowlist, and wires the source to the ADR-032 incident trigger. Listed with an "alarm source" badge; secret-rotation + copy-URL actions.
- **MCP servers** (custom_mcp kind): generic BYO-MCP registration (an egress integration).

**Operator / author** (general users, read-only scope; write registration stays admin):
- **Agents**: list built-in (devops/security/finops) + custom; compose (attach skills, set agent-type, pick gateways/integrations, model, routing keywords); enable/disable; **AI-assist** draft.
- **Skills**: create-in-UI form (name/description/instructions/agent-type) for any user; **≤6 MB zip upload (references/assets) is admin-only until cosign/Sigstore verification lands** (§11, ADR-031 Addendum #6); Active/Inactive; AI-assist draft.
- **User-facing agent picker (gap #6):** the chat UI gains an explicit agent selector (built-in + enabled custom). **A picker selection IS an explicit pin = highest precedence in the ADR-038 ladder (pin > custom > classifier)** — it is wired through the `body.section`/pin path (NOT the routingKeywords/custom tier), so a picked agent suppresses both keyword-match and the classifier for that turn and is not overridden by a transition-chip re-send.

**Permission split (co-agent decided 2026-06-13, Q3 — a deliberate revision of ADR-031 Addendum #6, recorded in §16):** Agent Space + Integration/MCP registration (egress endpoints + credentials, the SSRF/egress surface) = **admin** (ADR-023 gate); **form-based** Skill + Agent authoring/composition within read-only tool scope = **any authenticated user** — **but gated behind a per-account feature flag `nonAdminAuthoring`, default OFF (= admin-only, preserving ADR-031's fail-closed posture)** until an org opts in (codex's conservative dissent folded in). The relaxation is safe because authored objects are disabled-by-default, server-side-allowlisted, SAFEGUARD_LINE-bounded, and **admin-only to ENABLE**. **Externally-sourced zip uploads stay admin-only regardless of the flag** (the supply-chain surface ADR-031 Addendum #6 scoped to admins) until cosign verification (§11). Enabling a `READ_WRITE` integration or wiring a write action = **admin + the mutating-gate 4-eyes** (or the logged ADR-029 single-operator escape hatch).

---

## 11. Security & governance

- **Server-side allowlist outside the model** (§9.1) — the model cannot exceed the resolved tool set even if a skill/MCP description tries to widen it.
- **Untrusted content**: custom Markdown, MCP tool descriptions, and tool results are untrusted → immutable non-overridable `SAFEGUARD_LINE` (kept), server-side allowlist enforcement, output validation, prompt-injection posture (mirrors AWS guidance).
- **Writes → mutating gate only** (ADR-029 six controls + ADR-036): Action Catalog facade, two-step plan→execute with idempotency token, mandatory dry-run, **4-eyes (approver≠creator) default-ON with the logged `singleOperatorApproved`/`dual-control:false` escape hatch (ADR-029 §4)** — required for solo-admin deployments, paired rollback, audit (Aurora + S3 Object-Lock; CloudTrail is defense-in-depth, not a synchronous gate), kill-switch (fail-closed), flag-gated.
- **Egress SSRF defense (inherited from ADR-011, NOT re-invented) — load-bearing because v2 runs in-VPC near 169.254.169.254 / the internal ALB:** every egress integration's HTTP path MUST **resolve the target hostname before the request and block private CIDRs** (IPv4 10/8, 172.16/12, 192.168/16, 169.254/16; IPv6 ::1, fc00::/7, fe80::/10), set `redirect:'manual'`, and open private CIDRs only via the per-account `allowPrivateDatasource` opt-in (the legitimate case for `private_connection_ref` self-hosted MCP). The egress MCP Lambda inherits ADR-011's blocklist.
- **Credential custody**: Secrets Manager with rotation (ADR-022 active/standby pair for inbound HMAC secrets); SigV4 confused-deputy conditions; per-account isolation for BYO-MCP/integration credentials; no plaintext in Aurora/env.
- **Untrusted uploads (ADR-031 Addendum #6)**: SHA-256 guards storage integrity/TOCTOU only — NOT supply-chain. Externally-sourced zip uploads (references/assets) require **cosign/Sigstore signature verification (ADR-031 Phase 3)**, pending cosign key custody (shared follow-up with ADR-030); until then zip upload is **admin-only** (§10).
- **Fail-closed revocation** (§9.3) for security-relevant disables; note the ADR-023 SSM-admin 5-min cache is the registration-auth path, NOT the agent-disable hot path, so it does not undermine immediate revocation.
- **Memory isolation (ADR-018)**: all read/write memory paths (chat threads, federation stages, integration context) filter by the originating `userId` + `accountId` — no cross-user/cross-account bleed across the Lead/Sub fan-out.
- **Integrity & traceability**: every response/log records Agent Space version + agent id/version + skill hashes, carried on the **ADR-021 `done` / ADR-038 `meta` SSE event** (extend those frames — do not invent a new one) and/or `chat_messages.meta`.
- **Cost (ADR-033)**: the token budget stays partitioned **per account + per `userSub`** (ADR-033's `(accountId, userSub, route, normalizedQuestion, sourceDataFingerprint)` key; aligns with ADR-008/018 tenant isolation). Agent-Space-level prompt-size/tool-count **caps are an additional ceiling layered on top, not a replacement** for the per-user budget; integration context injection counts toward it.

---

## 12. Phased delivery

> The full platform is large; deliver in bounded, independently-shippable, flag-safe phases. **Phase 1 is the first consensus-implemented slice** (code-only, no new infra apply required; closes real security gaps).

- **P1 — Foundation + gap-closure (consensus target):**
  1. ULID migration re-asserting the ADR-031 catalog tables **idempotently** (resolves drift) + additive columns: `agents.agent_type`, `agents.gateways JSONB`, `agents.response_language`; `skills.agent_types`, `skills.reference_keys`; `agent_spaces.enabled_integration_ids`, `agent_spaces.response_language`; new `integrations` table (created, flag-gated, unused at runtime in P1).
  2. **Enforce `toolAllowlist` in `agent.py`** + tests (gap #1).
  3. **Fill `KNOWN_TOOL_CATALOG`** for enumerable gateways (gap #2).
  4. **Fail-closed revocation** on disable (gap #3).
  5. Seed `devops`/`security`/`finops` built-in frontier agents (single primary gateway each) + `agent_type`.
  6. Catalog/lib + `/api/customization` + validation extended for the new fields; **skill-create form** + **model picker** + **agent-type** in the UI; **user-facing agent picker** in chat.
- **P2 — Integrations axis (READ + ingress):** additive migration adding `direction` + ingress columns (+ `kind` CHECK). The unified Integrations UI (egress/ingress toggle). Egress READ: `integrations` registration UX (SigV4-first) + per-space tool allowlisting + read context injection; first observability integrations (Grafana/Datadog) as read MCP. Ingress: webhook alarm-source registration (generate receive URL + HMAC secret + source allowlist) wired to the existing ADR-022 route + ADR-032 trigger.
  - **P2-infra inc1 (DONE, applied):** Lambda@Edge ingress carve-out for `/api/incidents/webhook` (the single Cognito-everywhere exception extended to the v2 edge).
  - **P2-infra inc2 (DONE, code; apply via `-target` + `make agentcore`):** `agent.py` **live-connects** registered egress-READ integration MCP endpoints — credentials fetched at runtime from Secrets Manager by `credentials_ref` ARN (Q3=B; never plaintext in the payload). Connection-time SSRF defense (https-required + DNS resolve-and-recheck; metadata/link-local/loopback always blocked, RFC1918/ULA only via the per-account `allowPrivateDatasource` opt-in; `redirect:manual` on both transports), `api_key`/`oauth_client_credentials`(bearer)/`sigv4` transports (sigv4 service explicit-or-dropped; cross-account sts-assume = Q3-sigv4=C, deferred), per-integration failure isolation (a bad integration drops only its own tools; the gateway is unaffected). New `integrations_enabled`-gated `aws_kms_key.integrations` + scoped `secretsmanager:GetSecretValue`/`kms:Decrypt` on the runtime role.
- **P3 — Integrations axis (READ_WRITE) + AI-assist:** re-scoped by **ADR-040/041** — external **knowledge/comms** DATA-writes (Slack/Notion/Jira records) are governed-open (NOT FROZEN: data-write ≠ AWS-resource mutation per ADR-041); **AWS-resource mutation + autonomy stay ⛔ frozen** (ADR-029/036/031-P4). **Slack vertical slice implemented flag-OFF (2026-06-14)** — `slack.post_message` via the action_catalog facade on a fully-decoupled control plane (own `integrations_write_enabled` flag + kill-switch + no-AWS-mutation IAM; DLP/redaction + channel allowlist + 4-eyes; propose-only chat). Notion/Jira slices + AI-assist follow the same pattern. (orig) write actions as `action_catalog` `lambda` executors behind the mutating gate (dry-run + paired rollback); OAuth/API-key auth.
- **P4 — Federation:** per-account Agent Space scoping of the ADR-032 Lead roster + frontier-agent rostering; enable DevOps+Security+FinOps to collaborate on an incident.
- **P5 — Learned Skills (optional):** topology/tool-use auto-skills from inventory + investigation history.

**Ops (not code, prerequisite for live):** create the `admins` Cognito group / populate SSM `admin_emails` so `/customization` is reachable (gap #9).

---

## 13. Acceptance criteria (P1)

- A ULID migration creates/asserts all ADR-031 catalog tables + new columns idempotently on a runner-only DB; re-running is a no-op; existing rows preserved (`gateway` → `gateways[0]`).
- `agent.py` invoked with a non-empty `toolAllowlist` exposes **only** those tools to the model and lists only them in the prompt; with empty/absent allowlist, behavior is unchanged. Unit + integration tested.
- Disabling a custom agent/skill makes it unusable on the chat path **immediately** (no 30 s window) — tested.
- `devops`/`security`/`finops` appear as selectable built-in agents in the UI and chat picker; selecting one routes to its primary gateway with its persona.
- Skill create-in-UI form persists a valid `SKILL.md`-equivalent row with `agent_types`; admin gate + audit unchanged.
- All new code TDD'd; `tests/run-all.sh` green; no AWS security-mandate violation (no `0.0.0.0/0`, no `Principal:"*"`, no secrets in env); no `-auto-approve` on shared infra.

---

## 14. Open questions / risks

- **`external-obs` / gateway count — DECIDED (2026-06-13):** external observability is the **Integrations axis** (egress READ; ADR-011 re-derivation), and **internal CloudWatch stays the `monitoring` section gateway**. `external-obs` is therefore NOT a section gateway: drop/repurpose the `catalog.py` `external-obs` key (its tools become Integrations connectors), keep `agent.py` `SKILL_BASE` at its section personas, and keep **ADR-004's canonical count at 8 role-based gateways** (update ADR-004's note to record external-obs → Integrations, not a 9th gateway). The `agent.py` `diagnostics` persona vs `monitoring` gateway naming is tidied separately (low-risk).
- **v2 multi-account — IN SCOPE (decided 2026-06-13):** v2 WILL add multi-account (Agent Space keyed on a real account, not just `'self'`). This needs a **v2 successor to ADR-008's `AccountConfig`** (the v1 Steampipe-aggregator model is frozen) — a v2 account registry + cross-account AssumeRole that `currentAccountId()` and `getAgentSpace(account)` resolve against. Tracked as its own workstream (likely its own ADR); the Integrations/Agent-Space/OpenCost surfaces all assume it. Until it lands, `'self'` is the single live account.
- **ADR-035 (K8sGPT in-cluster diagnosis) — DECIDED (2026-06-13, co-agent Q2):** modeled as a **container-section capability bound to the `container` agent**, enabled **per-onboarded-EKS-cluster by extending the existing EKS onboarding (`eks_registrations`)** — NOT a new Integrations row (avoids duplicate per-cluster registration; matches ADR-035's "MCP target consumed by the container/orchestrator"). It inherits health-check + tool-allowlist governance via that path. (If an external K8sGPT-as-a-service ever appears, it can become an Integrations egress READ connector then.) P3.
- **Multi-gateway execution**: P1 keeps single-primary-gateway; chat multi-domain synthesis is ADR-025's (not a new engine); incident multi-agent is ADR-032 (P4).
- **Migration ledger (ADR-037 baseline):** integer `schema_migrations` (the ADR-037 baseline) vs ULID ledger coexistence — P1 migration is idempotent and must not conflict with the one-time bootstrap.
- **AI-assist trust**: generated SKILL.md/allowlist is untrusted; enforced by the same allowlist/validation — confirm no path lets generated content widen scope.
- **Learned Skills (P5)** remains explicit **ADR-032 YAGNI** ("learned/auto-tuned investigation skills") — deferred, not reopened.

---

## 15. ADR linkage

This spec **extends ADR-031** (runtime-customizable agents/skills; Addenda #2/#4/#5/#6 specifically — its toolAllowlist/revocation/upload controls are what §9/§11 discharge) and **consumes**: **ADR-004** (role-based gateway split — the section-gateway model frontier agents compose over; canonical count = 8), **ADR-008** (multi-account/account identity — v2 currently `'self'`), **ADR-009** (alert-triggered diagnosis — *Superseded by 032*; its correlation engine is ADR-032 Triage), **ADR-011** (external datasource layer + **SSRF defense** — egress READ observability re-derives this), **ADR-012** (SNS/Slack notification — Slack split by ownership), **ADR-015** (FinOps MCP — the FinOps agent composes it), **ADR-018** (per-user+per-account memory isolation), **ADR-021** (SSE event vocabulary — metadata carrier), **ADR-022** (HMAC webhook ingress — per-source auth, single edge exception), **ADR-023** (admin model — registration gate), **ADR-025** (multi-route parallel synthesis — the chat-path multi-domain mechanism, distinct from federation), **ADR-029/036** (mutating gate — single P2 spine + six controls), **ADR-032** (Lead/Sub federation + Triage), **ADR-033** (per-account+per-user token budget), **ADR-034** (RCA write-back + self-marker/concurrency loop-breaker), **ADR-035** (K8sGPT in-cluster MCP — modeling TBD §14), **ADR-037/030** (v2 foundation — Aurora + single P2 worker spine + schema_migrations baseline), **ADR-038** (hybrid routing — the picker is an explicit pin). Given the new Integrations axis + frontier-agent entity + read/write governance + ingress, ratify as **ADR-039: Multi-Agent Platform — Frontier Agents + Integrations Axis** (extends ADR-031, does NOT supersede it; mechanism via 036; federation via 032). The **Status "Supersedes"** line supersedes only the 2026-05-31 companion *spec*, not ADR-031 itself.

---

## 16. ADR reconciliation (cross-check resolutions)

> **🧊 2026-06-11 reversal reconciliation (added 2026-06-14, synced via PR #50).** This spec was written 2026-06-13 on a line that predated the **2026-06-11 multi-AI reversal**: **ADR-029/036 ⛔ REVERSED** (mutating/execution substrate frozen·do-not-enable), **ADR-031 Phase 3 BYO-MCP + Phase 4 mutating-tools ⚠️ 폐기**, **ADR-032/035 ⚠️ DOWNGRADED** to read-only. Therefore the rows below that depend on the **mutating gate** (`ADR-029` 4-eyes, `ADR-036` single P2 spine) and on **write/READ_WRITE/BYO-MCP-write** are **FROZEN — do-not-enable**. **Compatible & live**: egress **READ** observability (§7 READ path; ADR-011 re-derivation) + **read-only ingress→ADR-032 triage** (recommendation-only) — no writes/autonomy. See ADR-039 § Amendment (2026-06-14).

A multi-AI cross-check (2026-06-13) against ADRs 001–038 found the relationships below; each is resolved inline as cited. **Deliberate deviations from accepted ADRs** (must be ratified with ADR-039):

| Existing ADR | Relationship | Resolution in this spec |
|---|---|---|
| **ADR-031 Addendum #6** (admin-only authoring/uploads) | **deviation** (co-agent Q3) | ADR-039 lets non-admins do **form-based** skill/agent authoring within read-only scope, **behind a per-account `nonAdminAuthoring` flag (default OFF = admin-only)** (safe: disabled-by-default + server allowlist + SAFEGUARD + admin-only ENABLE). **Zip uploads stay admin-only until cosign** (Addendum #6 retained for the supply-chain surface). §10/§11. |
| **ADR-031** per-account `mcp_registrations` | **deviation** | `integrations` (kind=custom_mcp) supersedes it; registration is global catalog + per-account **enablement**; per-account **isolation** preserved via credential scoping + Addendum #4. §7. |
| **ADR-011** external datasource layer | subsumed | egress-READ observability = v2 re-derivation on MCP; v1 `datasources` frozen; **SSRF defense inherited verbatim** (§11). |
| **ADR-012** Slack/SNS | de-duplicated | ADR-012 = system notifications (Block Kit); Integrations `slack` = agent governed writes (reuses ADR-012 client). cloudwatch_sns ingress = SNS-confirm/SQS-poll, not HMAC. §7. |
| **ADR-022** HMAC webhook | corrected | per-source inbound auth (HMAC push-emitters only); existing v2 `incidents/webhook` route reused; SaaS needs an edge carve-out. §7. |
| **ADR-029** 4-eyes | corrected | default-ON 4-eyes **with** the logged single-operator escape hatch (solo-admin). §7/§11. |
| **ADR-036** single P2 spine | corrected | renamed "remediation SM" → the shared P2 worker SFN extended with executor branches (no second engine). §3/§7. |
| **ADR-032** roster scoping | reframed | per-account roster scoping is an ADR-032-decided property → framed as gap-closure, not new. §8. |
| **ADR-033** budget | corrected | per account+`userSub` (not per-Agent-Space); Agent-Space caps layered on top. §11. |
| **ADR-004** gateway count | corrected | canonical 8; `catalog.py` external-obs vs `agent.py` diagnostics divergence flagged. §14. |
| **ADR-009/013/018/021/025/035/037/030/015/034** | aligned/cited | all added to §15 linkage; no contradiction (see §14/§9.5/§11/§8). |
| ADR-016 (model select), ADR-027 (code-interpreter isolation) | **OK** | model picker constrained to the canonical set; AI-assist uses classifier/Bedrock, not the Code Interpreter — isolation untouched. |
