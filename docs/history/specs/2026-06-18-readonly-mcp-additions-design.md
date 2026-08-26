# Design — read-only MCP additions to the v2 agent fleet

> Date: 2026-06-18 · Branch `feat/v2-architecture-design` · Owner session: **AI-diag** (this session)
> Status: design (awaiting spec review). Implementation deferred until the **datasource session**
> commits its `ai.tf`/`catalog.py` work (shared files), then runs in an isolated worktree.

## Goal

Restore high-value v1 agent tool coverage that v2's section-gateway fleet is currently missing —
**without** violating v2's keystone constraints. Add **read-only** MCP tool-sources only; the literal
v1 sources that mutate or need live Steampipe are NOT ported (kept dark).

The "5 missing MCPs" collapse, after ADR/ownership/safety screening, to **3 read-only additions**:

| # | MCP (read-only variant) | Gateway | v1 source (NOT reused as-is) |
|---|--------------------------|---------|------------------------------|
| 1 | **core-helpers** — `prompt_understanding` + `suggest_aws_commands` (static, zero-dep) | `ops` | `aws_core_mcp.py` (drops `call_aws`) |
| 2 | **istio-read** — Istio CRDs via k8s API (presigned-STS), not Steampipe | `container` | `aws_istio_mcp.py` (drops pg8000/Steampipe) |
| 3 | **reachability-read** — computed ENI↔EC2 / resource-to-resource connectivity from describe-only | `network` | `reachability.py` (drops path *creation*) |

**Excluded (with cause):**
- `steampipe-query` — ADR-037 keystone *"No live Steampipe in v2"*; no source file exists anyway.
- `call_aws` (core) — arbitrary AWS-CLI executor = the mutation vector permanently frozen by the
  2026-06-11 read-only/do-not-enable reversal (ADR-029/036).
- `datasource-diag` + external-obs connectors — **already shipped** by the datasource session
  (PR #57); re-adding would collide. Its `_trace_network_path` is **VPC↔VPC only** (TGW/peering),
  so it does NOT overlap reachability-read's ENI↔EC2 path analysis.

## Safety / ADR alignment

All three are **describe/list/get-only**. No `create_*`/`start_*`/`put_*`/`call_aws`. They honor:
- the **read-only invariant** (AWS-resource mutation + autonomy stay frozen) — reachability-read
  computes a verdict from describe data instead of creating a NetworkInsightsPath;
- **ADR-037** — no live Steampipe; istio-read uses the k8s API directly;
- all gated behind the existing **`agentcore_enabled`** flag (default false → `plan` = no changes, $0).

## Component 1 — core-helpers MCP (`ops` gateway)

New source `agent/lambda/core_helpers_mcp.py` (do not edit `aws_core_mcp.py`). Two tools, both pure
and dependency-free, lifted verbatim from the v1 static implementations:
- `prompt_understanding` — returns the static AWS design-guide string.
- `suggest_aws_commands` — static regex pattern-match → suggested CLI commands (no execution).

The handler dispatches ONLY these two; any other `tool_name` → error. No `call_aws` code path present
in the new file at all (not just gated — absent), so there is no escape hatch to enable later by accident.

**IAM:** none (no AWS calls). **Risk:** none.

## Component 2 — istio-read MCP (`container` gateway)

New source `agent/lambda/istio_read_mcp.py`. Reads Istio CRDs through the **Kubernetes API**, reusing
the v2 in-cluster read pattern (`web/lib/eks-incluster.ts`): presigned STS `GetCallerIdentity` →
EKS bearer token → k8s API `GET` on the Istio CRD endpoints. Read-only tools (subset of v1's 12,
the read ones): `mesh_overview`, `list_virtual_services`, `list_destination_rules`,
`list_istio_gateways`, `list_service_entries`, `list_authorization_policies`, `list_peer_authentications`.
No Steampipe, no pg8000.

**IAM (the heaviest part of this design):** the agent Lambda execution role needs an **EKS Access
Entry + AmazonEKSViewPolicy** (cluster-scoped; **View, not AdminView** — least privilege: `view` reads
namespaced resources + namespaces but NOT Secrets/nodes, so the AI-agent principal never gains
cluster-wide Secret read. istio-read only LISTs namespaced Istio CRDs + namespaces; Istio aggregates
its CRD read into `view`, with an istio-reader ClusterRole as the fallback — see the runbook).
**This entry is NOT terraform-managed** (owner decision 2026-06-18): the cluster
owner registers it out-of-band via `scripts/v2/eks/register-istio-access.sh` (read-only stance —
AWSops never mutates a cluster, and the apply principal may lack `eks:CreateAccessEntry`). terraform
only emits `output.agent_lambda_role_arn` for the operator to register. The k8s bearer token is built
from a presigned STS `GetCallerIdentity` — **reuse the existing `k8s-aws-v1.` pattern already in
`datasource_diag_mcp.py` (`_check_k8s_service_endpoints`)** — over stdlib `urllib`+`ssl` (agent Lambdas
bundle no `requests`/`kubernetes`). Resolve endpoint+CA at runtime via `describe_cluster(cluster_name)`
(role already has `eks:DescribeCluster`); if the cluster endpoint is private-only the Lambda also needs
VPC attachment (conditional). This is a terraform change to shared infra → folds into the gated
`agentcore_enabled` path, applied by the controller (no `-auto-approve`). If too heavy this round,
istio-read defers to a follow-up (Tasks 4–5 are abortable).

## Component 3 — reachability-read MCP (`network` gateway)

New source `agent/lambda/reachability_read_mcp.py`. One tool: `check_reachability`.
- **Input:** `source` (instance-id | eni-id | private-ip), `destination` (instance-id | eni-id | ip),
  `port`, `protocol` (default tcp).
- **Logic (describe-only):** resolve src/dst ENIs (`describe_network_interfaces` /
  `describe_instances`) → collect their SGs, subnets, route tables, and subnet NACLs → evaluate the
  path: (a) src SG egress permits dst:port, (b) dst SG ingress permits src:port, (c) NACLs allow both
  directions on both subnets, (d) a route exists from src subnet toward dst (local / peering / TGW /
  NAT / IGW as applicable).
- **Output:** `reachable: true|false`, and on false a `blocking_component` list naming the exact layer
  + rule that blocks (e.g. `{layer:'sg-ingress', resource:'sg-abc', reason:'no rule for tcp/5432 from 10.x'}`).
- This is the ENI↔EC2 connectivity check the owner asked for, delivered without creating any AWS
  resource (the v1 mutation is dropped).

**IAM:** `ec2:Describe*` only — already granted to the v2 agent read-only exec role. **Risk:** none.

## Wiring (all three)

- `ai.tf` — add each as an entry in `local.agent_lambdas` (source dir, handler, role, env). istio-read
  also gets the EKS env (cluster name/endpoint/CA) + the Access Entry resource.
- `scripts/v2/agentcore/catalog.py` — add a TARGET per source under its gateway (network / container /
  ops), with `credentialProviderConfigurations: GATEWAY_IAM_ROLE` and the tool `inlinePayload` schemas.
- `scripts/v2/agentcore/provision.py` — picked up by the idempotent provisioner; `make agentcore`
  builds the arm64 image + (re)creates targets. `--smoke` validates an invoke.
- All behind `agentcore_enabled` (already the gate for the fleet).

`ai.tf` and `catalog.py` are **shared with the datasource session** → see Sequencing.

## Testing

- Per-tool unit tests with mocked boto3 (`moto`/stub) and a stubbed k8s API for istio. reachability-read
  gets table-driven cases: allowed path, blocked-by-SG-ingress, blocked-by-NACL, no-route, cross-VPC.
- istio-read mirrors `web/lib/eks-incluster.test.ts` token/HTTP stubbing.
- provisioner smoke (`make agentcore --smoke`) post-apply.

## Sequencing & auto-continuation

1. **Now (conflict-free):** this spec + (next) the implementation plan. No shared-file edits.
2. **Trigger:** the datasource session commits its `ai.tf`/`scripts/v2/agentcore/catalog.py` changes to
   `feat/v2-architecture-design` HEAD (so we build on top, no merge clobber).
3. **Then (auto):** run `/co-agent:consensus` (plan → TDD implement → P4 gate) in an **isolated git
   worktree** branched from the updated HEAD, so concurrent dirty files elsewhere don't block us.
4. Controller runs the shared-infra `terraform apply` (no `-auto-approve`); `make agentcore` for images.

## Out of scope

True token streaming, any mutating tool, live Steampipe, `call_aws`, datasource/external-obs connectors
(other session), the EKS *page* UI (separate), v1 source-file edits (kept dark).
