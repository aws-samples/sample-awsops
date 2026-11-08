# Managed Service Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use Application Signals and CloudWatch Omni as bounded discovery providers for the existing read-only six-pillar diagnosis.

**Architecture:** Extend the existing worker evidence bundle, not the web request path. Reuse native inventory identities and DNS/trace/network-flow evidence. Application Signals uses the existing host or verified member session; Omni obtains space-scoped credentials for explicitly configured, existing organization spaces through its documented credential API.

**Tech Stack:** Python, pinned boto3 1.43.123, Terraform 1.17.1; no new dependencies.

**Spec:** The three-layer discovery design approved in the conversation on 2026-11-08: managed relationships, DNS/inventory identity binding, then trace/NFM evidence qualification.

## Global Constraints

- Read-only, default-off `diagnosis_managed_discovery_enabled`, requiring the existing evidence-loop gate.
- No service activation, instrumentation installation, domain/space/grant creation, deployment or Neptune provisioning.
- Preserve validated account/region scope, registered member roles, model redaction and shared analysis deadline.
- Bound each provider to 3 pages per operation, 16 requests and 40 nodes per region, with at most 20 new logical resources globally.
- Preserve the existing 200-resource, 400-relationship, 1,200-evidence and 192 KiB bundle caps.
- Empty, stale, unauthorized, unresolved and capped results disclose gaps; no absence-of-traffic or sizing conclusion.
- Configuration and access-policy edges are not observed calls. Shared telemetry is not independent corroboration.
- Native-resource joins require an exact, unique identifier; service names, DNS labels and shared tags alone do not prove compute identity.
- Omni supports pre-existing organization spaces via `GetSpaceCredentialsForOrganization`; its worker principal must already be a management/delegated administrator with space access. No ordinary-session graph fallback.

## Review Focus

- Mixed account/region identities and ambiguous inventory matches must not become confirmed connections.
- Configuration-only and stale managed edges must not become fresh traffic observations.
- Pagination, fan-out and shared request/deadline limits must qualify previously collected evidence too.
- Credential errors must never leak secrets or fall back to host graph reads.
- Two projections of the same telemetry must preserve a common provenance family rather than increase confidence.

### Task 1: Discovery providers and evidence admission

**Files:** Create `scripts/v2/workers/diagnosis/managed_discovery.py` and `test_managed_discovery.py`; modify `discovery.py` and `evidence.py`.

**Interfaces:** `collect(bundle, budget, regions, *, client_factory, control_factory)` appends bounded resources, evidence and coverage through existing discovery helpers.

- [x] Write and run failing end-to-end Application Signals binding tests. Preserve logical service-to-DB calls and separate compute membership; reject instance-to-DB fan-out.
- [x] Implement bounded providers, exact native binding, source qualification and space-session authentication.
- [x] Add scope, missing credentials, stale/config-only edge, pagination, ambiguity, redaction and deadline fixtures; verify them against real EvidenceIndex admission.
- [x] Run `/tmp/awsops-discovery-py312/bin/python -m pytest -q scripts/v2/workers/diagnosis` (initial run: 1,341 passed, 36 skipped; final run with runtime policy and Terraform read contracts: 1,401 passed, 36 skipped, 194 subtests passed).

### Task 2: Default-off configuration, IAM and operator contract

**Files:** Modify `terraform/foundation/variables.tf`, `workers.tf`, `tests/runtime_iam.tftest.hcl`, `docs/reference/06-workers.md`, `docs/reference/diagnosis-discovery.md` and the existing feature entries in `CHANGELOG.md`. Reuse the established runtime IAM mock-provider fixtures.

**Interfaces:** Worker environment uses `DIAGNOSIS_MANAGED_DISCOVERY_ENABLED` and `DIAGNOSIS_OMNI_SPACES`; space keys are `<account>/<region>` and values are existing UUIDs.

- [x] Write failing policy/configuration tests for default-off behavior and gated read actions.
- [x] Add validated space configuration and gated Fargate-only read policy, preserving member-role separation.
- [x] Document instrumentation, organization-space prerequisites and incomplete evidence semantics.
- [x] Run Terraform validation and runtime IAM mock-provider tests (52 passed).
- [x] Complete the final Python contracts and diff review (49 managed-provider tests; real locked SDK schemas; cap, member-session and observation-admission regressions).
- [ ] Obtain an independent final review and fix material findings before merge. The owner requested PR publication on 2026-11-08 while external review transmission approval remains pending; publish a draft without invoking the external reviewer.
