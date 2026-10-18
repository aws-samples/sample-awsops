# Custom MCP Read Governance

## Symptoms

A registered MCP connection contributes no tools, its Enable control is unavailable,
or enablement returns HTTP 409 after a configuration edit or credential rotation.

## Candidate causes

- `CUSTOM_MCP_ENABLED` is absent or false. It defaults OFF in both web and runtime;
  registration preparation does not authorize activation.

- The registration has no exact exposed tool names, requests a write capability, or
  uses runtime-role SigV4 instead of a server-scoped secret.
- The account has not explicitly selected the integration in its Agent Space.
- The administrator has not confirmed the displayed endpoint, authentication method,
  credential reference and exact tool list as read-only.
- The operator has not provisioned the registration's secret, or its current version
  differs from the version recorded during enablement.

## Verification

Use an authenticated administrator session to inspect `GET /api/integrations` and the
account's Agent Space in Customization. Registration assigns the exact secret name
`ops/<project>/integrations/custom/<integration-id>`; client-chosen names and ARNs are
not accepted. Inspect metadata through the authorized operator console without
copying secret values into logs, issue comments or diagnostics.

The focused runtime tests make no AWS calls:

```bash
cd agent
python3 -m pytest test_agent.py test_readiness.py test_custom_mcp_policy.py -q
```

Web unit verification:

```bash
cd web
npx vitest run lib/custom-mcp-policy.test.ts lib/custom-mcp-secret.test.ts \
  lib/custom-mcp-catalog.test.ts lib/integration-validation.test.ts \
  lib/integrations.test.ts lib/agent-resolver.test.ts app/api/integrations/route.test.ts \
  app/api/chat/route.test.ts
```

The additional `web/lib/custom-mcp-postgres.test.ts` suite requires an operator-prepared,
disposable PostgreSQL 17 socket. Its database must be named `awsops_mcp_test` and have
the marker `awsops-disposable-mcp-test`; it refuses an unmarked database before
replacing its schema. Set `CUSTOM_MCP_TEST_POSTGRES_SOCKET` to that socket and run the
suite explicitly. An unset socket skips this optional fixture; a skipped fixture is
not PostgreSQL verification evidence.

## Action

Do not activate a connection while private ADR-022 remains Proposed. Complete the
final panel and dated owner acceptance, then obtain a separately reviewed release
that enables `CUSTOM_MCP_ENABLED=true` in **both** web and AgentCore. Missing or
non-`true` values block enablement, catalog selection, resolver connection and runtime
connection before credential, DNS or network access. Preparing disabled registrations
and immediate disablement remain available. These steps describe post-acceptance
operation, not permission to enable now.

Before that release, apply the reviewed standalone attestation-audit migration
`01M57KRRZG3CZ7YZ4M4N7KQH2N_custom_mcp_attestation_audit.sql` through the existing
migration controller. Its `ALTER` is not an automatic web-migration exemption.
Missing `customization_audit.details` causes enablement to roll back. The same
transaction records actor, server time, endpoint, transport, exact tools, row-bound
credential reference and current version as non-secret JSON. Later registration edits
clear the active attestation without deleting the audit snapshot. Rejected enablement
attempts record actor and integration ID, without supplied secrets or unsafe details.

Existing enabled custom or vendor-labelled live MCP rows require fresh per-row
credentials and renewed confirmation; they receive no legacy fallback. The configured
`INTEGRATIONS_SECRET_NAME` must be the same plain `ops/<project>/integrations/credentials`
name in web and runtime, not its ARN. Registration owner identity is now Cognito `sub`.
Runtime IAM still covers the integration namespace: per-row binding is an application
check, not a separate IAM role per registration. The runtime trusts the authenticated
BFF invocation for the endpoint, attestation, credential version and account. These
fields are unsigned and the runtime does not independently compare them with Aurora.
Its checks verify consistency within the payload. The BFF validates a registered,
enabled member target and reads its account Space before constructing that payload.

Before owner acceptance, record the effective `InvokeAgentRuntime` callers, their
identity and resource policies, and their role trust relationships. Include the web
role and any approved operator or worker callers; resolve unbounded or untrusted
direct access. A direct caller that knows a registration's current Secret version
could forge a matching endpoint and attestation and send that credential to its own
endpoint. A version ID is metadata rather than secret material, but it is a security-relevant trust input here. A principal with invocation authority and knowledge of the current version can forge the self-consistent payload described above; version secrecy is not an authorization boundary. The
owner must explicitly assess this residual risk; payload consistency is not proof
of an independently authorized endpoint.

Existing vendor-labelled `read_write` registrations with nonempty `exposedTools`
are quarantined: they are omitted from the enabled catalog and cannot be enabled
through the generic helper. They receive no legacy proposal fallback. To retain
proposal metadata, an operator must review the vendor registration, clear
`exposedTools`, retain the reviewed `writeActionRefs` and `providedContext`, and
enable the edited row again. Edits disable the row. Such metadata never opens an
MCP connection or executes a write; ADR-007's external-write gate still applies.
A `custom_mcp` row remains governed even with an empty tool list, so this procedure
cannot enable a custom write connection.

1. Register an HTTPS egress/read connection and its exact exposed tool names.
   Administrator-supplied endpoints with vendor kind labels follow the same MCP
   controls. Registrations start disabled; every edit disables them and removes
   the previous attestation.
2. Through the approved operator provisioning process, create the assigned per-row
   Secret with a credential restricted to this external server's read APIs.
   The product does not create Secrets or gain a new AWS write permission. Its web
   role reads only custom-secret metadata; the runtime reads the bound value.
   The integration runtime grants and web custom-secret metadata grant must already
   be applied. Encrypt the Secret with the configured dedicated integration key
   (`alias/<project>-integrations`), or obtain a separately reviewed compatible
   decrypt grant. An arbitrary encryption key is not covered by the runtime policy.
   Store a Secrets Manager **SecretString** in one of these supported shapes,
   replacing the placeholder with the scoped external credential:

   | Transport | SecretString | Runtime behavior |
   |---|---|---|
   | `api_key` | `{"header":"Authorization","value":"<scoped-credential>"}` | Sends the value in the specified header; an omitted header defaults to Authorization. `{"api_key":"<scoped-credential>"}` and a raw string are also supported. |
   | `oauth_client_credentials` | `{"token":"<access-token>"}` | Sends `Authorization: Bearer <access-token>`. A raw token string is also supported. |

   The current OAuth transport consumes a stored bearer token; it performs no token
   issuance or refresh. A conventional `client_id`/`client_secret` object is not
   supported. Obtain and refresh the restricted token through the approved operator
   process, then re-attest its new current Secret version.
3. Review the endpoint, authentication method, credential and every listed tool's
   behavior. In Customization, check the read-only confirmation and enable the
   integration. The server durably audits the authenticated Cognito `sub`, server time,
   exact registration and current Secret version. A concurrent registration edit
   invalidates the confirmation.
4. Explicitly select the integration in each intended account's Agent Space and save.
   Missing account policy never selects custom MCP connections from the global catalog.
5. After an endpoint/tool edit or Secret rotation, review and enable again. Disable
   immediately to stop subsequent turns; an existing session lasts until its run ends.

These controls prepare the policy reconciliation requested by the owner. The private
ADR-022 remains **Proposed** until its completed panel and dated owner sign-off are
recorded. Source implementation and test evidence do not establish policy acceptance
or deployment. ADR-005's AWS mutation/autonomy freeze, ADR-007's external-write gate,
ADR-015's sole exception and ADR-017's curated preset/ClickHouse stdio gates retain
their existing scope.

Tool-name intersection and administrator attestation cannot prove that an external
server will keep the same tool semantics. Reassess the server's permissions and
implementation after changes. Registration and runtime SSRF guards remain required;
this control patch does not replace transport-level address pinning or establish
that the separate pinned transport release has been deployed.

## Related files and decisions

- `web/lib/custom-mcp-policy.ts`, `web/lib/custom-mcp-secret.ts`
- `web/lib/integrations.ts`, `web/lib/agent-resolver.ts`
- `web/app/api/integrations/route.ts`, `web/app/api/chat/route.ts`
- `agent/agent.py`, `agent/test_custom_mcp_policy.py`
- `terraform/foundation/workload.tf`
- ADR-005, ADR-007, ADR-015, ADR-017; private Proposed ADR-022.

Activation environment plumbing is intentionally absent from Terraform, the web task definition and the AgentCore provisioner in this preparation change. A future separately reviewed activation release must supply it only after acceptance and the invocation-principal evidence above. Existing audit actors/creators may contain historical email identities; new MCP attestations bind the immutable Cognito `sub`, without backfilling those historical entries.

Native bundled datasource query rows with no MCP transport/reference and an empty tools array retain their existing enable/disable path. A datasource vendor label with MCP transport, credential reference or tools remains governed. Malformed legacy egress tools are excluded individually and require operator correction; they cannot certify a read-only ceiling.
