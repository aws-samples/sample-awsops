# Plan: P2-infra Increment 2 — Integrations egress LIVE MCP connection (ADR-039)

> Branch `fix/v2-upgrade-snapshot-id`. Companion: ADR-039, spec `2026-06-12-custom-agent-platform-design.md` (§7/§9/§11), P2 plan `2026-06-13-custom-agent-platform-p2-plan.md` ("Out of scope (P2-infra)"). Design locked by prior co-agent decision **Q3=B** (runtime Secrets-Manager fetch; ARN-ref-only payload) **+ Q3-sigv4=C** (sts-assume cross-account deferred).

## Goal
`agent.py` connects **live** to a registered egress-READ integration's external MCP endpoint and actually uses its tools, with credentials fetched at runtime from Secrets Manager (payload carries only the ARN ref). Per-integration failure isolation, connection-time SSRF defense, and a count-gated IAM/KMS grant.

## Non-goals (stay out of scope — P3 / later increments)
- READ_WRITE write-action executors / mutating gate (P3).
- A credential-WRITE UX. Secrets are created out-of-band by an admin under the `ops/${project}/integrations/*` namespace (CLI) and registered as `credentials_ref`. This increment delivers the READ side (agent fetch) + IAM.
- `oauth_3lo` transport (only `sigv4`, `api_key`, `oauth_client_credentials`/bearer-style here; oauth_3lo errors out cleanly = integration dropped).
- sigv4 **cross-account** `sts:AssumeRole` (Q3-sigv4=C deferred). sigv4 here = same-account IAM-auth MCP (service/region parameterized).
- Federation parity (`scripts/v2/incident/agent_bridge.py` integration context) — deferred to P4 (flag-off); keep the existing inline PARITY NOTE.
- Lambda@Edge ingress carve-out (was increment 1, already APPLIED).

## Key existing contracts (grounding — do not break)
- `agent.py`: `_filter_tools(tools, allowlist)` already enforces the resolver allowlist (`None`/`[]` ⇒ no restriction). Handler reads payload `{messages,gateway,skill,systemPromptOverride,toolAllowlist,accountId,accountAlias}`. Gateway connect is one `with mcp_client:` block; **any** exception → full Bedrock-direct fallback (too coarse for per-integration failure — must be narrowed).
- `streamable_http_sigv4.py`: `streamablehttp_client_with_sigv4(url, credentials, service, region, …)` — `service`/`region` are already params (the "hardcoding" is in `agent.py.create_gateway_transport` passing `SERVICE`/`GATEWAY_REGION`).
- `web/lib/agent-resolver.ts`: `EgressReadIntegration {name, exposedTools, providedContext}`; custom branch already unions integration tools (catalog-bypassed, space-capped) into `toolAllowlist` and renders `## Integration context`. Built-in branch ignores integrations. **Connection details (endpoint/transport/credentialsRef) are NOT yet surfaced.**
- `web/lib/agentcore.ts`: `invokeAgent(InvokeInput)` builds the payload; integrations not yet threaded.
- `web/app/api/chat/route.ts`: maps integration rows → `{name, exposedTools, providedContext}` (drops connection details) and passes the array to `resolveAgent`. `space.allowPrivateDatasource` is available here.
- `agent/test_agent.py`: stdlib-`unittest`, stubs strands/boto3/mcp/httpx-using modules in `sys.modules`; tests `_filter_tools`. **httpx is NOT installed locally** → keep all agent unit tests stdlib-only.
- agent `Dockerfile` only `COPY`s `agent.py` + `streamable_http_sigv4.py` → **no new agent .py files** (else the image misses them). Put new pure logic in `agent.py`; new transport in `streamable_http_sigv4.py`.
- IAM: `aws_iam_role.agentcore` (count-gated on `agentcore_enabled`) is the runtime role; secret grants always scope to an exact ARN/prefix (workers.tf is the reference). KMS today is the single `aws_kms_key.aurora`.
- Deploy: `agent.py` ships via `make agentcore` (arm64 build+push + idempotent provision). IAM/KMS ship via `terraform -target` apply. provision.py passes only `AWS_REGION`+`GATEWAYS_JSON` env → **no provision.py change** (integrations arrive per-request in the payload).

---

## Payload contract extension (the wire format this increment adds)
`invokeAgent` payload gains an optional `integrations` array (custom-agent path only):
```jsonc
"integrations": [
  { "name": "datadog",
    "endpoint": "https://mcp.example.com/mcp",
    "transport": "api_key|sigv4|oauth_client_credentials",
    "credentialsRef": "arn:aws:secretsmanager:…:secret:ops/awsops-v2/integrations/datadog-xxxxxx",
    "exposedTools": ["datadog_query"],
    "allowPrivate": false,
    "sigv4Service": "execute-api",   // optional, sigv4 only; default derived from endpoint
    "sigv4Region":  "ap-northeast-2" // optional, sigv4 only; default derived/agent region
  }
]
```
`endpoint` MUST be **https** (enforced at connection time, Task 1) — secret-bearing transports never go over plaintext. `transport=='sigv4'` REQUIRES `sigv4Service` (no safe default; absent ⇒ integration dropped, never reuse the gateway signer). Secret `SecretString` schema (parsed by `agent.py`, JSON or raw):
- `api_key`: `{"header":"DD-API-KEY","value":"…"}` (or `{"api_key":"…"}` → header defaults to `Authorization`); raw string ⇒ `Authorization: <raw>`.
- `oauth_client_credentials` (bearer-style in this increment): `{"token":"…"}` → `Authorization: Bearer <token>`; raw string ⇒ bearer.
- `sigv4`: no secret headers; the runtime's own IAM creds sign (same-account). `credentials_ref` may be empty for sigv4.

---

## Tasks (TDD; bite-sized; per-task commit; web vitest + `python3 -m unittest` green each task)

### Task 1: connection-time SSRF guard (pure, stdlib)
**Files:**
- Modify: `agent/agent.py`
- Test: `agent/test_agent.py`
> **R1 gate fix (codex CRITICAL):** `allow_private` is the ADR-011 *private-datasource* opt-in — it must open ONLY RFC1918 / ULA private ranges, NEVER link-local/metadata(169.254.169.254)/loopback/multicast/reserved. Two classifiers, not one. Also enforce **https** (no plaintext secrets).
- [ ] Failing tests (extend `test_agent.py`): `_ip_always_blocked('169.254.169.254')`/`127.0.0.1`/`::1`/`fe80::1`/`224.0.0.1` ⇒ True (blocked **regardless of allow_private**); `_ip_always_blocked('10.0.0.1')`/`172.16.0.1`/`192.168.1.1`/`fc00::1`/`8.8.8.8` ⇒ False. `_ip_is_private('10.0.0.1')`/`172.16.0.1`/`192.168.1.1`/`fc00::1` ⇒ True; `_ip_is_private('8.8.8.8')`/`169.254.169.254` ⇒ False. `_assert_host_allowed(url, allow_private, *, resolver=fake)`: raises `SsrfBlocked` for a private IP when `allow_private=False`, **passes** when `allow_private=True`; **always raises** for 169.254.169.254 / 127.0.0.1 / ::1 even when `allow_private=True`; raises for `http://` (non-https) before resolving; passes for a public https host; raises when resolution yields **no** address; **raises if ANY** resolved IP is always-blocked or (private && !allow_private) (mixed-result hosts).
- [ ] Implement with stdlib `ipaddress`: `_ip_always_blocked = is_loopback or is_link_local or is_multicast or is_reserved or is_unspecified` (169.254.169.254 is link-local ⇒ covered); `_ip_is_private = is_private and not _ip_always_blocked` (RFC1918 + fc00::/7 ULA). `_assert_host_allowed(url, allow_private, resolver=socket.getaddrinfo)`: parse URL → **reject non-https**; resolve host → for each IP, block if `_ip_always_blocked` OR (`_ip_is_private` and not `allow_private`). Injectable `resolver` (default `socket.getaddrinfo`) so tests need no network. Define `class SsrfBlocked(Exception)`.
- [ ] Commit: `feat(agent-platform): P2-infra inc2 T1 — connection-time SSRF guard (https + private-opt-in, metadata always blocked)`.

### Task 2: non-sigv4 transport + secret/header/sigv4-params helpers
**Files:**
- Modify: `agent/agent.py`
- Modify: `agent/streamable_http_sigv4.py`
- Test: `agent/test_agent.py`
> **R1 gate fix:** `follow_redirects=False` on BOTH integration transports (sigv4 too — codex CRITICAL); sigv4 service/region threaded explicitly + tested, unsafe guess denied (codex MAJOR); extend the test stub for the new import (codex MINOR).
- [ ] Failing tests (`test_agent.py`, stdlib-only): `parse_secret('{"token":"t"}') == {"token":"t"}`; `parse_secret('raw') == {"_raw":"raw"}`; `parse_secret('') == {}`. `auth_headers('api_key', {"header":"DD-API-KEY","value":"k"}) == {"DD-API-KEY":"k"}`; `auth_headers('api_key', {"api_key":"k"}) == {"Authorization":"k"}`; `auth_headers('oauth_client_credentials', {"token":"t"}) == {"Authorization":"Bearer t"}`; `auth_headers('api_key', {"_raw":"k"}) == {"Authorization":"k"}`; `auth_headers('sigv4', …) == {}`; unknown transport ⇒ `ValueError`. `sigv4_params('https://abc.execute-api.ap-northeast-2.amazonaws.com/mcp', service='execute-api', region=None) == ('execute-api','ap-northeast-2')` (region derived from host); explicit `region` overrides the derived one; **`sigv4_params(endpoint, service=None, region=None)` raises `ValueError`** (no safe service default — caller drops the integration; never silently reuse the gateway `bedrock-agentcore` signer); region falls back to `GATEWAY_REGION` only when it cannot be derived from the host.
- [ ] Implement `parse_secret`/`auth_headers`/`sigv4_params` in `agent.py` (stdlib only — importable without httpx). **Add `streamablehttp_client_with_headers` to the existing `streamable_http_sigv4` stub in `test_agent._install_stubs`** so the new import resolves under unittest.
- [ ] Add `streamablehttp_client_with_headers(url, headers, timeout=…, sse_read_timeout=…)` to `streamable_http_sigv4.py`: wraps mcp `streamablehttp_client` with static `headers=` and a `httpx_client_factory` (built from `create_mcp_http_client`) that sets `follow_redirects=False`. Also add the same `follow_redirects=False` factory to the **sigv4** integration call path (a thin `…_with_sigv4(..., follow_redirects=False)` arg or a shared factory) so redirect:'manual' holds for sigv4 egress too. (api_key/bearer are static per-request headers; sigv4 keeps dynamic signing.) The transport wrappers are not unit-tested (need httpx/mcp); covered by live verify.
- [ ] Commit: `feat(agent-platform): P2-infra inc2 T2 — secret/header/sigv4-params helpers + redirect-manual transports`.

### Task 3: agent.py integration connect + tool merge + failure isolation
**Files:**
- Modify: `agent/agent.py`
- Test: `agent/test_agent.py`
> **R1 gate fix:** explicit two-level structure (kimi); sigv4 service/region via `sigv4_params` else drop (codex); https+SSRF enforced per integration; runtime tool-call errors are explicitly out of scope (connection-time isolation only).
- [ ] Failing tests (`test_agent.py`): `select_integration_tools(live_tools, exposed_tools)` keeps only `tool_name ∈ exposed_tools`, preserves order, empty `exposed_tools` ⇒ `[]` (admin ceiling: a READ integration with no exposed tools contributes nothing). `gather_integration_tools(specs, connect)` — injectable `connect(spec) -> list[tool]`: returns the union of healthy integrations' tools; when `connect` **raises** for one spec (SsrfBlocked, ValueError from `sigv4_params`, connect/list error), that spec is dropped and the others survive (**never raises**, gateway tools unaffected); `specs=[]`/`None` ⇒ `[]`; an integration whose `exposed_tools` filters everything out contributes `[]`.
- [ ] Implement the pure helpers, then wire the handler with an explicit **two-level** structure: the existing **outer** `try/except` (gateway connect + `Agent(...)` + `agent(user_input)`) stays the catastrophic Bedrock-direct fallback; **inside** the gateway `with mcp_client:` block, after `get_all_tools(gateway)`, open each integration via `contextlib.ExitStack` (sessions stay live during `agent(user_input)`), each wrapped in its **own inner** `try/except`: `_assert_host_allowed(endpoint, allow_private)` (https+SSRF) → for `transport=='sigv4'`: `sigv4_params(endpoint, sigv4Service, sigv4Region)` (ValueError ⇒ drop) + existing dynamic signer; else `parse_secret(get_secret_value(credentialsRef))` → `auth_headers` → static-header transport (short per-integration `timeout`, default 8s) → `list_tools` → `select_integration_tools(...)`. Any inner error: `logging.warning` + skip that integration (gateway tools retained — never bubble to the outer fallback). Then `tools = _filter_tools(gateway_tools + integration_tools, tool_allowlist)`.
- [ ] Secret fetch via a module-level lazy `boto3.client('secretsmanager', region_name=GATEWAY_REGION)`; sigv4 integrations need no secret (`credentials_ref` may be empty).
- [ ] **Scope note (codex MAJOR, accepted):** a *runtime* tool-call exception during `agent(user_input)` (after tools loaded) still reaches the outer fallback — that is connection-vs-execution and out of scope for this increment (Strands surfaces tool errors as results, not aborts); this increment isolates *connection-time* failures only. Documented, not silently dropped.
- [ ] Commit: `feat(agent-platform): P2-infra inc2 T3 — agent.py live integration connect + per-integration isolation`.

### Task 4: resolver surfaces egress-READ connection details
**Files:**
- Modify: `web/lib/agent-resolver.ts`
- Test: `web/lib/agent-resolver.test.ts`
- [ ] Failing tests: extend `EgressReadIntegration` with optional `endpoint?/transport?/credentialsRef?/allowPrivate?/sigv4Service?/sigv4Region?`. `ResolvedAgentSpec` gains `integrations?: ResolvedIntegration[]`. Custom path: `integrations` lists only entries with a non-empty `endpoint` **and** `transport` (connectable); maps `{name,endpoint,transport,credentialsRef,exposedTools,allowPrivate,sigv4Service,sigv4Region}`. Built-in path: `integrations` undefined. An egress-READ integration **without** endpoint/transport still contributes tools+context (existing behavior) but is **excluded** from the connect list. No integrations ⇒ `integrations` undefined (Phase-2 baseline unchanged — assert tool/prompt outputs identical to today).
- [ ] Implement; keep the existing tool-union/context-render logic byte-identical (SAFEGUARD_LINE first).
- [ ] Commit: `feat(agent-platform): P2-infra inc2 T4 — resolver surfaces integration connection details`.

### Task 5: agentcore.ts threads integrations into the payload
**Files:**
- Modify: `web/lib/agentcore.ts`
- Test: `web/lib/agentcore.test.ts`
- [ ] Failing tests (mirror the accountId test): `InvokeInput.integrations` present+non-empty ⇒ `sent.integrations` equals it; absent/empty ⇒ `'integrations' in sent === false`.
- [ ] Implement: `if (input.integrations?.length) body.integrations = input.integrations;`.
- [ ] Commit: `feat(agent-platform): P2-infra inc2 T5 — invokeAgent payload carries integrations`.

### Task 6: chat route forwards connection details + allowPrivate
**Files:**
- Modify: `web/app/api/chat/route.ts`
- Test: `web/app/api/chat/route.test.ts`
- [ ] **Update** the existing failing assertion ("passes ONLY enabled egress-READ integrations…") — the mapping now includes `endpoint/transport/credentialsRef/allowPrivate` (allowPrivate from `space?.allowPrivateDatasource ?? false`). Add: `invokeAgent` is called with `integrations` = `spec.integrations` (assert via the `invokeAgent` mock args). Ingress + READ_WRITE still excluded.
- [ ] Implement: extend the `egressReadIntegrations` map to include the connection fields; pass `integrations: spec.integrations` into the `invokeAgent({...})` call.
- [ ] Commit: `feat(agent-platform): P2-infra inc2 T6 — chat route forwards integration connection details`.

### Task 7: terraform integrations_enabled flag + dedicated KMS + scoped IAM (count-gated, additive)
**Files:**
- Modify: `terraform/foundation/ai.tf`
- [ ] `variable "integrations_enabled" { type=bool default=false }`; `local.integ_count = var.agentcore_enabled && var.integrations_enabled ? 1 : 0`.
- [ ] `aws_kms_key.integrations` (count=`local.integ_count`, distinct `description`) + `aws_kms_alias.integrations` (`alias/${var.project}-integrations`) — dedicated CMK for integration secrets.
- [ ] **New separate** resource `aws_iam_role_policy.agentcore_integrations` (count=`local.integ_count`, **distinct `name="${var.project}-agentcore-integrations"`**, role=`aws_iam_role.agentcore[0].id`) — do NOT edit the existing `aws_iam_role_policy.agentcore` (keeps the targeted apply purely additive, 0-change to existing): `secretsmanager:GetSecretValue` scoped to `arn:aws:secretsmanager:${var.region}:${acct}:secret:ops/${var.project}/integrations/*`; `kms:Decrypt` scoped to `aws_kms_key.integrations[0].arn`.
- [ ] `terraform fmt` + `terraform validate` clean. (No TF unit-test framework; the 0-destroy gate is the apply-time check.)
- [ ] **Flag persistence (codex MAJOR):** `integrations_enabled` default-false means a later *full* apply with the flag unset would DESTROY these resources. Set `integrations_enabled = true` in the **live** `terraform.tfvars` (and add it to `scripts/v2/configure.mjs` as a follow-up so `make configure` re-emits it) so the resource set is stable. This worktree is not the deploy source-of-truth → the live tfvars/configure is where persistence must land; the `-var` below is only for the dev targeted apply.
- [ ] Commit: `feat(agent-platform): P2-infra inc2 T7 — integrations_enabled flag + scoped Secrets/KMS IAM (apply deferred)`.

### Task 8: docs spec/ADR phased note
**Files:**
- Modify: `docs/superpowers/specs/2026-06-12-custom-agent-platform-design.md`
- Modify: `docs/decisions/039-multi-agent-platform-frontier-agents-integrations.md`
- [ ] Note egress READ live connection + SSRF + Secrets/KMS IAM landed (code; apply via `-target` + `make agentcore`).
- [ ] Commit: `docs(agent-platform): P2-infra inc2 — egress live MCP connection recorded`.

---

## Apply / deploy (Stage C — controller/user-gated; NOT a per-task commit)
1. **Targeted plan** (worktree tfvars drifts from live + `.build` layers missing → NO full apply):
   `terraform -chdir=terraform/foundation plan -target=aws_kms_key.integrations -target=aws_kms_alias.integrations -target=aws_iam_role_policy.agentcore_integrations -var integrations_enabled=true -out tfplan`
2. **Verify the plan = adds only (KMS key+alias+1 IAM policy), 0 destroy, 0 change to existing.** Then `apply tfplan` (saved plan, no `-auto-approve`). v2 is dev → apply OK.
3. `make agentcore` — arm64 build+push + idempotent provision (deploys the new `agent.py`). **Ordering matters (kimi): IAM/KMS apply (steps 1-2) lands BEFORE the new image, and `integrations_enabled` default-false + no integration enabled means zero secret fetches until an admin enables one — so there is no runtime-permission gap.**

## Live verification
- **Tool actually called**: admin creates a Secrets-Manager secret under `ops/awsops-v2/integrations/<name>` (KMS=integrations key), registers an egress READ integration (endpoint+transport+credentials_ref+exposed_tools) via `/api/integrations`, enables it for `self` space; in chat, route to the owning custom agent and confirm the external tool is invoked (agent log shows the integration tool in the tool list; answer uses it).
- **SSRF block**: register an integration whose endpoint resolves to a private/metadata IP (allowPrivate=false) → agent log shows the integration dropped (`SsrfBlocked`), gateway tools still present, chat still answers.
- **Failure isolation**: point an integration at an unreachable endpoint → that integration dropped, gateway tools retained (no Bedrock-direct fallback).

## Risks / reviewer pre-empts
- **DNS-rebinding TOCTOU** between resolve and connect: accepted, consistent with ADR-011 / `ssrf-guard.ts` (both resolve-based). IP-pinning is a documented P3 hardening — not in this increment.
- **Live external MCP only on the custom-agent path** (built-in branch ignores integrations by design) — documented, safe.
- **Secret namespace coupling**: IAM scopes `GetSecretValue` to the `ops/${project}/integrations/*` name prefix; admins MUST create secrets there or the fetch is AccessDenied (→ integration dropped, gateway unaffected). Documented contract.
- **Targeted apply discipline**: only the 3 new additive resources are targeted; the 0-destroy/0-change-to-existing check is mandatory before `apply tfplan`.

## Verification commands
- `cd web && npx vitest run` (expect ≥598 green, +new cases).
- `cd agent && python3 -m unittest test_agent` (expect existing 6 + new cases).
- migration itest: N/A — **NO DB schema change this increment** (kimi clarify). `endpoint`/`transport`/`credentials_ref`/`exposed_tools` are already `integrations` columns (P1 migration `01KTY39P4S…`), `allow_private_datasource` is an `agent_spaces` column (P2 `01KV0JKFF7…`). The only "new fields" are TS-interface / JSON-payload additions (`sigv4Service`/`sigv4Region` on the resolved spec, `allowPrivate` derived from the existing space column) — in-memory wire format, not storage.
- `terraform -chdir=terraform/foundation fmt -check && … validate` (after `init`).
