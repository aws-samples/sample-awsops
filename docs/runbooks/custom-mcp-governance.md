# Custom MCP Read Governance

## Purpose and prerequisites

Custom MCP remains intentional (owner clarification 2026-10-11).
It is a governed connector under ADR-007 (amended 2026-10-29). Trust evidence precedes
reviewed activation; tests prove no deployment. Web/AgentCore `CUSTOM_MCP_ENABLED` defaults OFF; only exact `true` enables it. Activation wiring is deferred. The next apply adds web read-only `DescribeSecret`
for the registration namespace on already-enabled stacks.

Before activation, the controller applies reviewed standalone migration
`01M57KRRZG3CZ7YZ4M4N7KQH2N_custom_mcp_attestation_audit.sql`; its `ALTER` has no
automatic web-migration exemption. Missing `customization_audit.details` rolls back
enablement. Non-secret JSON audit binds Cognito `sub`, server time, endpoint, transport, exact
tools and credential reference/version. Edits clear attestation, retaining snapshots;
rejections retain actor/ID, no unsafe details. Historical email identities stay.
Web/runtime need the same plain `INTEGRATIONS_SECRET_NAME`,
`ops/<project>/integrations/credentials`, not an ARN.

### Activation blocker: invocation trust

Runtime IAM covers the namespace, not individual rows. Runtime checks unsigned
BFF endpoint/attestation/account/Secret-version consistency without Aurora lookup.
BFF verifies enabled registered member targets and account Space. A direct `InvokeAgentRuntime` caller knowing the version can forge endpoint/attestation
and exfiltrate credentials; version metadata is no authorization boundary. Record
effective callers, identity/resource policies and trusts; remove untrusted/unbounded
access. Before acceptance require owner assessment of constrained callers, or signed/
authoritative runtime registration enforcement. Payload consistency cannot authorize
endpoints; default-off preparation leaves this activation blocker unresolved.

## Symptoms, diagnosis and action

Absent/non-`true` gates block MCP catalog/resolver/runtime before credentials/DNS/network.
Existing MCP rows may show Enabled but contribute no tools. A denied MCP
declaration also prevents a legacy custom agent without its own tool policy from
inheriting unrestricted gateway reads, even with activation off. The agent may
therefore suddenly have zero tools. Chat emits an `integration-unavailable`
status and a notice; streamed and stored metadata carry `mcpSuppression.reasons`:

- `denied`: an applicable MCP declaration lacks activation, account membership,
  valid attestation or another required control. Complete the reviewed controls;
  a gate remains off until acceptance and activation approval.
- `disabled-selected`: the account still selects a disabled MCP registration.
  Remove that selection if unintended, or correct and re-confirm it.
- `lookup-failed`: Aurora selection lookup failed. Restore database availability
  and retry; the failure never establishes unrestricted gateway access.

Explicit skill tool policies remain separate ceilings. Malformed vendor tool JSON
and legacy ingress/read_write rows are quarantined per row; they do not revoke
unrelated gateway reads unless explicitly declared as `custom_mcp`. Enable may be unavailable
or HTTP 409 after edits/rotation. Disabled preparation/immediate disablement remain
available; do not bypass acceptance by turning gates on.

Admins inspect `GET /api/integrations`/account Agent Space: egress/read, exact read-only
tools, confirmation, account selection and current version.
The server assigns `ops/<project>/integrations/custom/<integration-id>`; chosen
names/ARNs are rejected. Existing MCP rows need per-row credentials/fresh confirmation, no legacy fallback.
Inspect authorized metadata only; never log credentials.

Vendor read_write rows with tools are quarantined from catalog/generic enablement,
no proposal fallback. For proposal metadata review, clear exposedTools, retain reviewed
writeActionRefs/providedContext and re-enable; edits disable it. Metadata connects no
MCP or writes. Empty-tool custom_mcp stays governed. Native bundled datasources retain enable/disable only with no MCP transport/reference
and empty tools; vendor rows carrying these fields stay governed. Exclude malformed
legacy egress tools per row for correction.

## Post-acceptance operator procedure

1. Register HTTPS egress/read and exact tools, including vendor-labelled endpoints.
   New/edited rows are disabled/unattested.
2. Provision the assigned Secret with scoped read credentials. Product creates no
   Secret/write grants; web reads metadata, runtime the bound value. Apply reviewed
   grants first. Use `alias/<project>-integrations` or reviewed compatible decrypt
   permission; arbitrary keys are uncovered. SecretString shapes:

   | Transport | Stored value and behavior |
   |---|---|
   | api_key | `{"header":"Authorization","value":"<credential>"}` sends that header (default Authorization); `{"api_key":"<credential>"}` or raw string also works. |
   | oauth_client_credentials | `{"token":"<token>"}` or raw token sends Authorization: Bearer; no issuance/refresh, client_id/client_secret unsupported. |

   Operator refreshes scoped tokens and re-attests current versions.
3. Review endpoint/auth/credential/tools, confirm read-only in Customization, enable.
   Locked audit binds row/current version; concurrent edits invalidate confirmation.
4. Select/save per account; missing policy never selects MCP globally. With no
   Agent Space, enabled genuine MCP declarations remain applicable but denied
   without explicit membership. An explicit Space, including an empty one, limits
   declarations to its selected IDs; unselected rows do not revoke legacy gateway
   reads. An empty Space is not MCP authorization. Edits/rotation
   require disable/re-confirm/re-enable. Disable stops later turns; active sessions
   last until their run ends.

Preserve ADR-005 FROZEN mutation/autonomy, ADR-007 writes, ADR-015 sole exception and
ADR-017 pins/gates/FROZEN ClickHouse stdio. Reassess server permissions/code after
changes: ceilings/attestation cannot guarantee stable semantics. Keep registration/runtime
SSRF and the per-account allowPrivate opt-in. The runtime connection is pinned to the
address set validated at connect time (agent/pinned_http.py: original Host/SNI,
certificate verification, no redirects, no proxy); this is deployed preparation and does
not activate custom MCP, which stays behind the default-off gate. The pinned transport
trusts only the bundled CA store (`trust_env=False`); a private-CA endpoint under
allowPrivate fails verification by design.

## Verification

Run separately from repo root; no AWS calls:

```bash
cd agent
python3 -m pytest test_agent.py test_readiness.py test_custom_mcp_policy.py test_pinned_http.py -q
```

`test_pinned_http.py` needs Python 3.11+ and the `openssl` CLI (it starts a real local TLS server).

```bash
cd web
npx vitest run lib/custom-mcp-policy.test.ts lib/custom-mcp-secret.test.ts \
  lib/custom-mcp-catalog.test.ts lib/integration-validation.test.ts \
  lib/integrations.test.ts lib/agent-resolver.test.ts app/api/integrations/route.test.ts \
  app/api/chat/route.test.ts
```

For `web/lib/custom-mcp-postgres.test.ts`, set CUSTOM_MCP_TEST_POSTGRES_SOCKET to
prepared disposable PG 17, database awsops_mcp_test, marker awsops-disposable-mcp-test.
Only this fixture permits schema replacement. No socket skips the fixture;
a skip proves no PG verification.

## Related files

- web/lib/custom-mcp-policy.ts, custom-mcp-secret.ts, integrations.ts,
  integration-validation.ts, agent-resolver.ts
- web/app/api/integrations/route.ts, web/app/api/chat/route.ts,
  web/app/customization/page.tsx
- agent/agent.py, agent/test_custom_mcp_policy.py, agent/pinned_http.py,
  agent/streamable_http_sigv4.py, agent/test_pinned_http.py, terraform/foundation/workload.tf
- ADR-005/007/015/017.
