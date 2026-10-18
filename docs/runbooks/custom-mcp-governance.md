# Custom MCP Read Governance

## Symptoms and causes

If tools are absent, Enable unavailable, or enablement returns HTTP 409 after edits
or rotation, check:

- `CUSTOM_MCP_ENABLED` is exactly `true` in both web and runtime; it defaults OFF.
- The registration specifies exact read-only tool names and server-scoped secret
  authentication, without write capability or runtime-role SigV4.
- An administrator confirmed the endpoint, transport, credential reference and tool
  list, and each intended account explicitly selected it in its Agent Space.
- The assigned Secret exists and its current version matches the enablement record.

## Verification

As an authenticated administrator, inspect `GET /api/integrations` and the account's
Customization Agent Space. The assigned Secret is
`ops/<project>/integrations/custom/<integration-id>`; chosen names/ARNs are rejected.
Inspect metadata in the authorized operator console; never log credential values.

Run separately from repository root; these tests make no AWS calls:

```bash
cd agent
python3 -m pytest test_agent.py test_readiness.py test_custom_mcp_policy.py -q
```

```bash
cd web
npx vitest run lib/custom-mcp-policy.test.ts lib/custom-mcp-secret.test.ts \
  lib/custom-mcp-catalog.test.ts lib/integration-validation.test.ts \
  lib/integrations.test.ts lib/agent-resolver.test.ts app/api/integrations/route.test.ts \
  app/api/chat/route.test.ts
```

Run `web/lib/custom-mcp-postgres.test.ts` explicitly with
`CUSTOM_MCP_TEST_POSTGRES_SOCKET` pointing to operator-prepared disposable PG 17.
Schema replacement requires database `awsops_mcp_test` and marker
`awsops-disposable-mcp-test`. No socket skips this optional fixture; a skip proves
no PostgreSQL verification.

## Release prerequisites

ADR-022 remains **Proposed**. Its final panel and dated owner acceptance must precede
a separately reviewed release setting `CUSTOM_MCP_ENABLED=true` in web and AgentCore.
This preparation adds no activation plumbing to Terraform, the web task definition
or AgentCore provisioner. Source/tests prove neither acceptance nor deployment.

Absent/non-`true` flags block enablement, catalog selection and resolver/runtime
connections before credential, DNS or network access. Disabled preparation and
immediate disablement remain available; the later procedure authorizes no activation.

Before activation, use the existing controller to apply reviewed standalone
`01M57KRRZG3CZ7YZ4M4N7KQH2N_custom_mcp_attestation_audit.sql`; its `ALTER` has no
automatic web-migration exemption. Missing `customization_audit.details` rolls back
enablement. The transaction records actor, server time, endpoint, transport, exact
tools, bound credential reference/version as non-secret JSON. Edits clear active
attestation but retain audit snapshots. Rejections audit actor and integration ID,
without secrets/unsafe details. New owners/attestations use Cognito `sub`; historical
email creators/audit actors remain unchanged.

Web/runtime require the same plain `INTEGRATIONS_SECRET_NAME`
`ops/<project>/integrations/credentials`, not an ARN. Existing custom/vendor-labelled
MCP rows need per-row credentials and fresh confirmation; no legacy fallback.

### Invocation trust and owner evidence

Binding is application-level; runtime IAM covers the integration namespace. Runtime
checks consistency of unsigned endpoint, attestation, Secret version and account
from the authenticated BFF, without checking Aurora. The BFF validates the
registered/enabled member target and reads its account Space before invocation.

Before acceptance, record effective `InvokeAgentRuntime` callers, identity/resource
policies and role trusts, including web and approved operators/workers; resolve
unbounded/untrusted direct access. A caller knowing the current version can forge
an endpoint/attestation and exfiltrate credentials. Version IDs are relevant metadata,
not an authorization boundary. Owner assessment must cover this residual risk;
payload consistency does not independently authorize endpoints.

### Existing registration handling

Vendor-labelled `read_write` rows with tools are quarantined from catalog and
generic enablement, without legacy proposal fallback. For proposal metadata, an
operator reviews the row, clears `exposedTools`, retains reviewed `writeActionRefs`
and `providedContext`, then re-enables; edits disable it. Metadata neither connects
MCP nor writes; ADR-007 still gates external writes. Empty-tool `custom_mcp` remains
governed, so this procedure cannot enable custom writes.

Native bundled datasource rows retain enable/disable only with no MCP transport or
credential reference and empty tools. Vendor labels with any such field are governed.
Malformed legacy egress tools are excluded per row for operator correction; they
cannot certify read-only tools.

## Post-acceptance operator procedure

1. Register HTTPS egress/read and exact tool names. Vendor-labelled administrator
   endpoints share these controls. New/edited rows are disabled and edits remove
   attestation.
2. The approved operator provisions the assigned Secret with server-scoped read
   credentials. The product creates no Secrets or new AWS write grants: web reads
   metadata, runtime the bound value. Apply their existing grants first. Encrypt
   with `alias/<project>-integrations` or a separately reviewed compatible decrypt
   grant; arbitrary keys are uncovered. Supported **SecretString** shapes:

   | Transport | SecretString | Runtime behavior |
   |---|---|---|
   | `api_key` | `{"header":"Authorization","value":"<scoped-credential>"}` | Sends the selected header; omitted header defaults to Authorization. `{"api_key":"<scoped-credential>"}` or a raw string also works. |
   | `oauth_client_credentials` | `{"token":"<access-token>"}` | Sends `Authorization: Bearer <access-token>`; a raw token also works. |

   OAuth uses stored bearer tokens without issuance/refresh; `client_id`/
   `client_secret` objects are unsupported. The approved operator obtains/refreshes
   restricted tokens and re-attests their current version.
3. Review endpoint, authentication, credential and tool behavior; confirm read-only
   in Customization and enable. Durable audit binds `sub`, server time, exact row
   and current Secret version. Concurrent edits invalidate confirmation.
4. Select and save in each intended account's Agent Space. Missing account policy
   never selects custom MCP globally.
5. Re-review/re-enable after endpoint/tool edits or rotation. Disable stops later
   turns immediately; existing sessions last until their run ends.

Preserve ADR-005's mutation/autonomy freeze, ADR-007's write gate, ADR-015's sole
exception and ADR-017's curated/ClickHouse stdio gates. Tool ceilings/attestation do
not guarantee stable semantics; reassess server permissions/implementation after
changes. Keep registration/runtime SSRF guards. This patch replaces no address
pinning and proves no deployment of the separate pinned transport release.

## Related files and decisions

- `web/lib/custom-mcp-policy.ts`, `web/lib/custom-mcp-secret.ts`
- `web/lib/integrations.ts`, `web/lib/agent-resolver.ts`
- `web/app/api/integrations/route.ts`, `web/app/api/chat/route.ts`
- `agent/agent.py`, `agent/test_custom_mcp_policy.py`
- `terraform/foundation/workload.tf`
- ADR-005, ADR-007, ADR-015, ADR-017; private Proposed ADR-022.
