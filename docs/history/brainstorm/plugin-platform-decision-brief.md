# Decision brief: AWSops plugin platform — standards vs proprietary spec, and regulation handling

## What AWSops is (constraints you must respect)
- A **read-only AWS/Kubernetes ops dashboard + AI diagnosis** for a **regulated financial** customer.
- Hard doctrine (multi-AI consensus, do-not-enable): AWS-resource **mutation + autonomy are permanently frozen**. ADR-031 Phase 3 **"BYO-MCP" (arbitrary user-supplied MCP servers) was REVERSED (2026-06-11)** for SSRF/secret/mutation-wedge risk. External DATA read + governed external record/ticket/message WRITE are allowed under governance (ADR-040/041): SSRF guard, secrets in Aurora+KMS, DLP/redaction, curation, human-gate, flag-OFF default.
- AI stack: **AgentCore** Runtime (Strands) + **8 section gateways** (network/container/data/security/cost/monitoring/iac/ops) exposing ~125 read-only MCP tools, + an almost-empty `external-obs` gateway, + ADR-040 integrations. Chat routes to gateways; AI diagnosis collects inventory and reasons.
- Capability is currently **scattered & hardcoded**: catalog.py (8 gateways), external-obs connectors, integrations — three ad-hoc lists. AI diagnosis cannot enumerate "what capability exists."

## The idea (owner's motivation)
Make AWSops a **plugin platform** so it can **interoperate with the growing universe of external/managed agents** (AWS Bedrock AgentCore agents and third-party agents), instead of building everything first-party. Publish a **plugin API spec so others can author plugins**. Owner explicitly worries that putting a full external/managed-agent platform into a **regulated finance** product distorts its original shape (external-SaaS use is restricted by regulation).
Owner already chose a **2-layer plugin model**: agent-plugin (persona = prompt + curated toolset + UI) ≠ source-plugin (connector = tool supply).

## Claude's recommendation (UNDER REVIEW — attack it)
1. **Adopt standards, do NOT invent a proprietary plugin API spec.** The "plugin API spec" should be a thin conformance/manifest layer over **MCP (source-plugins)** + **A2A / Agent-to-Agent (agent-plugins)** — the protocols AWS AgentCore and the broader ecosystem already speak. A bespoke spec fragments AWSops away from the very ecosystem it wants to join. Third-party "plug in your own" = register an A2A/MCP endpoint that conforms.
2. **"Others can develop and plug in" must mean "public AUTHORING, curated EXECUTION"** — NOT open BYO that just runs. (Verified-publisher / reviewed-install / signed + allowlisted + flag-gated.) Open BYO-that-runs would re-reverse the 2026-06-11 security reversal.
3. **Regulation = a deployment ALLOWLIST POLICY, not an architecture fork.** One registry. Finance deployment allows only in-account/in-VPC plugins (external-SaaS endpoints off-allowlist), reusing the ADR-040 SSRF/secrets/curation envelope. A future/non-finance deployment flips the allowlist to permit external A2A endpoints — **zero rework**.
4. **Phase split (YAGNI):**
   - Phase 1 — internal plugin spine: a manifest + single registry; refactor the 8 gateways + external + integration to be registry-driven; wire AI diagnosis to enumerate the registry. **Regulation-neutral, shape-preserving, immediate win, ~0 new external attack surface.**
   - Phase 2 — publish the **source-plugin** API spec (= MCP conformance) with **curated install**. Lower-risk (read-only data behind the governance envelope), most attractive to third-party authors.
   - Phase 3 — agent-plugin spec (A2A) + managed hosting. Highest product/security work — **frozen until real non-regulated demand.** Don't build a marketplace before the spine.
5. Net: build the spine now even though external-agent interop is regulation-blocked, because Phase 1 pays off internally regardless, and standards-conformance is cheap insurance against a costly future rewrite.
