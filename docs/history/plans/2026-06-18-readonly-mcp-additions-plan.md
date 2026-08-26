# Plan — read-only MCP additions to the v2 agent fleet (TDD)

> Spec: `docs/superpowers/specs/2026-06-18-readonly-mcp-additions-design.md`.
> Branch `feat/v2-readonly-mcp` (worktree, base = current `feat/v2-architecture-design` HEAD).
> TDD: failing pytest → minimal handler → refactor; per-task commit. All behind `agentcore_enabled`.
> istio (Tasks 4–5) is the heaviest + **separable**: if its EKS-token/access-entry proves too heavy,
> abort Tasks 4–5 and ship core + reachability (Tasks 1–3, 6).

## Allowed file scope
- `agent/lambda/core_helpers_mcp.py`
- `agent/lambda/test_core_helpers_mcp.py`
- `agent/lambda/reachability_read_mcp.py`
- `agent/lambda/test_reachability_read_mcp.py`
- `agent/lambda/istio_read_mcp.py`
- `agent/lambda/test_istio_read_mcp.py`
- `scripts/v2/agentcore/catalog.py`
- `terraform/foundation/ai.tf`
- `terraform/foundation/eks.tf`
- `agent/lambda/CLAUDE.md`

## Out of scope
v1 source edits (`aws_core_mcp.py`, `aws_istio_mcp.py`, `reachability.py` stay dark), `call_aws`, any
mutating call, live Steampipe, datasource/external-obs connectors (other session), provision.py logic
(it already iterates `catalog.TARGETS`), web BFF, `make agentcore`/apply (controller, post-merge).

Conventions (match the existing fleet): unittest-style tests run by `python3 -m pytest`; handler
`lambda_handler(event, _ctx)` reads `event["tool_name"]` + `event["arguments"]`, returns
`{"statusCode": 200, "body": json}` on success / a non-200 + error on failure; pop `target_account_id`
(cross-account parity); reject unknown tools.

---

### Task 1: core-helpers MCP (ops gateway) — static, zero-dep
- Create: `agent/lambda/core_helpers_mcp.py`
- Test: `agent/lambda/test_core_helpers_mcp.py`
- [ ] Failing tests: `prompt_understanding` returns the static guide string (statusCode 200, non-empty);
      `suggest_aws_commands` with a query returns a list of suggestions; an unknown `tool_name` → error;
      **`call_aws` is NOT a valid tool** (handler returns unknown-tool error for it — the escape hatch
      is absent, not gated).
- [ ] Implement: lift `prompt_understanding` + `suggest_aws_commands` verbatim from `aws_core_mcp.py`
      (pure/static, no boto3). `lambda_handler` dispatches ONLY those two; no `call_aws` code path exists
      in the file. No AWS calls, no IAM.
- [ ] Run `python3 -m pytest agent/lambda/test_core_helpers_mcp.py` (green).
- [ ] Commit: `feat(agent): core-helpers MCP (prompt_understanding + suggest_aws_commands, no call_aws)`.

### Task 2: reachability-read MCP (network gateway) — computed ENI↔EC2, describe-only
- Create: `agent/lambda/reachability_read_mcp.py`
- Test: `agent/lambda/test_reachability_read_mcp.py`
- [ ] Failing tests (mock boto3 ec2 with stubbed describe_* responses): one tool `check_reachability`
      with `{source, destination, port, protocol}`. Cases: (a) allowed via CIDR rule → `reachable: true`;
      (b) **[P2] allowed via SG-to-SG reference** (dst SG ingress references the src ENI's SG-ID, not a
      CIDR) → `reachable: true` (must NOT false-negative); (c) SG ingress on dst missing the port →
      `false` + `blocking_component` names the dst SG + `sg-ingress`; (d) NACL forward deny → `false` +
      nacl layer; (e) **[P2] NACL stateless RETURN-path deny** (ephemeral 1024-65535 inbound on src
      subnet denied) → `false` + nacl-return layer; (f) no route src-subnet → dst → `false` + route
      layer; (g) unknown tool → error; (h) `target_account_id` popped.
- [ ] Implement: resolve src/dst ENIs (`describe_network_interfaces`; accept instance-id →
      `describe_instances` → primary ENI, or eni-id, or private-ip). Collect each ENI's SGs (full rule
      sets), subnet, route table, subnet NACL. Evaluate **statically**: (1) src SG egress permits
      dst:port/proto, (2) dst SG ingress permits src:port/proto — **resolving BOTH CIDR (`IpRanges`)
      AND SG-ID references (`UserIdGroupPairs`)** against the peer ENI's SG-IDs/IPs, and prefix-list
      refs best-effort; (3) NACLs (stateless) on both subnets allow the FORWARD flow AND the RETURN
      flow on ephemeral ports (src-subnet inbound 1024-65535 from dst, dst-subnet inbound src:port,
      etc.); (4) a route exists src-subnet → dst (local / peering / tgw / nat / igw). Return
      `{reachable, blocking_component:[{layer, resource, reason}], checked:[...], disclaimer}` where
      **`disclaimer`** states: static SG/NACL/route approximation, same-account, does NOT model TGW
      route tables/blackholes, instance-level firewalls, or DNS — use AWS Reachability Analyzer for
      definitive verification. **Describe-only — no path creation.** Same caveat in the module docstring.
- [ ] IAM note (no code): `ec2:Describe*` is already on the agent read-only exec role — no IAM change.
- [ ] Run `python3 -m pytest agent/lambda/test_reachability_read_mcp.py` (green).
- [ ] Commit: `feat(agent): reachability-read MCP (computed ENI<->EC2 connectivity, describe-only)`.

### Task 3: wire core + reachability (catalog + terraform) — these two become shippable
- Modify: `scripts/v2/agentcore/catalog.py`
- Modify: `terraform/foundation/ai.tf`
- [ ] Failing test: add an assertion to an existing/`test_*` that `catalog.TARGETS` contains
      `core-helpers-target` (gateway `ops`) and `reachability-read-target` (gateway `network`) with
      non-empty `tools` and a `lambda_key`. (A tiny `agent/lambda/test_core_helpers_mcp.py` import-time
      check of catalog is fine, or a dedicated `test_catalog_targets.py` — but keep it inside scope:
      assert within the two MCP test files via `sys.path` to `scripts/v2/agentcore`.)
- [ ] Implement: `catalog.py` — add `core-helpers-target` (ops, lambda_key `core-helpers`, 2 tools) and
      `reachability-read-target` (network, lambda_key `reachability-read`, 1 tool) mirroring the existing
      TARGET schema shape. `ai.tf` — add `"core-helpers" = {file="core_helpers_mcp.py", handler=...}` and
      `"reachability-read" = {file="reachability_read_mcp.py", handler=...}` to `local.agent_lambdas`
      (still under the `var.agentcore_enabled` merge → flag-gated, $0 when off).
- [ ] Run `python3 -m pytest agent/lambda/` + `terraform -chdir=terraform/foundation validate` +
      `terraform fmt -check`.
- [ ] Commit: `feat(agent): wire core-helpers (ops) + reachability-read (network) targets + lambdas`.

### Task 4: istio-read MCP (container gateway) — k8s API via EKS token [SEPARABLE]
- Create: `agent/lambda/istio_read_mcp.py`
- Test: `agent/lambda/test_istio_read_mcp.py`
- [ ] Failing tests (mock the EKS token presign + a stubbed k8s HTTPS client): read-only tools
      `mesh_overview`, `list_virtual_services`, `list_destination_rules`, `list_istio_gateways`,
      `list_service_entries`, `list_authorization_policies`, `list_peer_authentications`. Cases: a CRD
      list parses items → names/namespaces; SSRF/host guard on the cluster endpoint; unknown tool →
      error; no Steampipe/pg8000 import present.
- [ ] Implement: **[P2] reuse the existing `k8s-aws-v1.` presigned-STS token pattern already in
      `datasource_diag_mcp.py` (`_check_k8s_service_endpoints` — `RequestSigner` →
      `generate_presigned_url` → `k8s-aws-v1.` + urlsafe-b64)** — do NOT reinvent it. HTTPS `GET` the
      Istio CRD collection endpoints (`/apis/networking.istio.io/v1beta1/...`, `/apis/security.istio.io/v1/...`)
      using **stdlib `urllib.request` + an `ssl.SSLContext` loaded from the cluster CA PEM** (agent
      Lambdas bundle NO `requests`/`kubernetes`). Read-only GET/LIST only. **Accept a `cluster_name`
      arg and resolve endpoint + CA at runtime via `boto3 eks.describe_cluster`** (role already has
      `eks:DescribeCluster`) rather than hardcoding env. SSRF: pin the request host to the
      describe_cluster-returned endpoint only.
- [ ] Run `python3 -m pytest agent/lambda/test_istio_read_mcp.py` (green).
- [ ] Commit: `feat(agent): istio-read MCP (read-only Istio CRDs via EKS k8s API, no Steampipe)`.

### Task 5: wire istio + EKS access entry (catalog + terraform) [SEPARABLE]
- Modify: `scripts/v2/agentcore/catalog.py`
- Modify: `terraform/foundation/ai.tf`
- Modify: `terraform/foundation/eks.tf`
- [ ] Implement: `catalog.py` — add `istio-read-target` (container, lambda_key `istio-read`, 7 tools).
      `ai.tf` — add `"istio-read" = {...}` to `local.agent_lambdas`; **[P2] if cluster endpoints are
      private-only**, also add `"istio-read"` to the `vpc_config` conditional + the VPC-ENI IAM policy
      `count` (default public-endpoint → no VPC, gated by an `istio_vpc_enabled` var defaulting false).
      **[REVISED — owner decision 2026-06-18] The EKS access entry is NOT terraform-managed.** Granting
      a principal k8s access is the cluster owner's call (read-only stance; the apply principal may lack
      `eks:CreateAccessEntry` on third-party clusters). Instead: `eks.tf` only removes any agent
      access-entry resource; `outputs.tf` emits `agent_lambda_role_arn`; and the operator registers the
      entry out-of-band via `scripts/v2/eks/register-istio-access.sh` (**`AmazonEKSViewPolicy`** — least
      privilege, no Secret/node read — NOT AdminView) + `docs/runbooks/istio-agent-eks-access.md`.
      (Confirm `eks:DescribeCluster` is on the agent role's read policy — it is, via ContainerRead.)
- [ ] Run `terraform -chdir=terraform/foundation validate` + `fmt -check` + `python3 -m pytest agent/lambda/`.
- [ ] Commit: `feat(agent): wire istio-read (container) target + lambda + agent-role EKS access entry`.

### Task 6: docs — refresh the lambda module tool inventory
- Modify: `agent/lambda/CLAUDE.md`
- [ ] Implement: update the gateway tool tables to add core-helpers (ops), reachability-read (network),
      istio-read (container); note these are the **read-only** v2 variants (v1 `call_aws`/Reachability-
      create/Steampipe-istio stay dark). No behavioral change.
- [ ] Run `bash tests/run-all.sh` (structure/doc checks green).
- [ ] Commit: `docs(agent): record read-only MCP additions (core-helpers/reachability-read/istio-read)`.
