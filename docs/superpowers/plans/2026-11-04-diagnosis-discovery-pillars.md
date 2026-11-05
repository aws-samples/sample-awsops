# Discovery-driven Six-pillar Diagnosis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Diagnose observed instance-to-DB dependencies and guarded right sizing through bounded discovery, six specialist agents and deterministic evidence-based reports.

**Architecture:** The existing report worker owns one deadline and evidence index. A default-off path collects scoped evidence, runs six structured specialist calls and a cross-pillar reviewer, optionally follows up once, and renders admitted observations locally. The existing disabled path remains intact.

**Tech Stack:** Python 3.14, boto3/botocore, PostgreSQL/pg8000, TypeScript, Vitest, Terraform provider mocks.

**Spec:** `docs/superpowers/specs/2026-11-04-diagnosis-discovery-pillars-design.md`

## Global Constraints

- Read-only source changes; no deployment, AWS apply, paid model probes or image publication.
- `diagnosis_evidence_loop_enabled` defaults false and comes from worker environment only.
- Host-only live AWS; member evidence stays scoped and never falls back to host credentials, external traces or FinOps data.
- At most 200 resources, 400 relationships, eight regions, three X-Ray pages per region and 192 KiB discovery context.
- Light has one pass; mid/deep have at most two. Six initial specialists, one reviewer, at most two specialist reruns and one final review; concurrency at most four.
- One handler-owned, thread-safe budget: 3300-second worker deadline, 600-second export reserve, attempts 20/24/32, input 2/3/4 MiB and reserved output 100000/120000/200000 tokens for light/mid/deep.
- Each model attempt reserves serialized input (at most 96 KiB) and requested output plus thinking (at most 8192 tokens), including failed attempts. Missing actual usage is unknown.
- Strict `output_config.format` JSON schema, every object has `additionalProperties: false`; exact verified Sonnet/Opus capability lookup.
- Enabled reports and title/tags are deterministic. Model explanations are hypotheses; models cannot supply displayed numeric observations or confirmed causality.
- Preserve report locales, 9/16 sections, invariant verdicts, ownership, lineage and partial status.
- Preserve ARM64, worker CMD, read-only IAM, feature gates, SG descriptions, governed connectors and dark remediation/chat loops.
- No dependency additions or schema migrations. Developer documentation is English-only.

## Review Focus

- Two instances of the same service must preserve A→DB1 and B→DB2 without invented cross-pairs.
- Missing graph state, stale retained rows, collisions and capped provider pages must remain incomplete rather than evidence of absence.
- Model-injected numbers, fabricated references, duplicate savings and member/host substitutions must fail semantic admission.
- Deadline exhaustion, retry races and grammar compilation must not bypass the shared budget or block artifact reserve.
- Missing memory/I/O, low lookback, protected resources and mixed currencies must prevent definitive downsizing claims.

## File ownership and shared data contracts

Trace work owns `web/lib/trace-source.ts`, `trace-graph.ts`, related trace parsers and tests. Discovery work owns new `scripts/v2/workers/diagnosis/discovery.py`, its tests, `terraform/foundation/{variables,workers}.tf` and associated mock tests. Analysis work owns new `budget.py`, `evidence.py`, `pillar_agents.py`, `loop.py` and their tests. Integration owns `report.py`, `handlers.py`, new `presentation.py`, integration tests, runtime tool corrections and documentation.

The discovery bundle is plain JSON:

```python
{
    "resources": [{"id": scoped_id, "account": account, "region": region,
                   "kind": kind, "resource_id": native_id, "facts": {...}}],
    "evidence": [{"id": evidence_id, "source": source, "resource_ids": [scoped_id],
                  "kind": kind, "facts": {...}, "captured_at": iso_or_none,
                  "window": {...}, "coverage": {...}, "fresh": bool}],
    "relationships": [{"id": edge_id, "source": scoped_id, "target": scoped_id,
                       "kind": kind, "evidence_ids": [evidence_id]}],
    "coverage": {...}, "gaps": [str], "degraded": [str], "incomplete": [str]
}
```

All fact projections are allowlisted. `EvidenceIndex(bundle, account)` owns admission; finding JSON uses `id`, `pillar`, `severity`, `resource_ids`, `evidence_ids`, `claim`, `explanation`, `prerequisites`, `verification`. `claim` is one of `observation`, `hypothesis`, `sizing_candidate`, `coverage_gap`. `verification` is a controlled capability name, not arbitrary CLI. Findings cannot carry numeric values or savings; rendering reads those from admitted facts.

`ReportBudget(tier, started_at=None)` owns `remaining(analysis=True)`, `reserve(stage, model_id, input_bytes, max_tokens)`, `record(attempt_id, outcome, usage=None)` and `snapshot()`. Calls reserve before every actual HTTP attempt. `BudgetExceeded` is a visible failure.

`discovery.collect(conn, account, budget, *, scope="self") -> dict` returns the bundle. `discovery.follow_up(conn, account, bundle, requests, budget) -> dict` validates resource/capability and returns a new merged bundle. `loop.run(bundle, *, account, tier, model_id, budget, lang="en", collect_follow_up=None) -> dict` returns `findings`, `pillar_coverage`, `rejected`, `review`, `passes`, `degraded`, `incomplete` and model-stage metadata. `presentation.render(catalog, bundle, analysis, *, lang, invariant_md) -> list[tuple[str, str]]` returns catalog-ordered section bodies.

### Task 1: Scoped instance identity and observed DB pairs

**Files:** trace source/graph parsers and their existing/new tests.

**Interfaces:** Store allowlisted `instance_observations` on observed service→DB edge metadata, containing native `instance_id`, scoped `instance_ref`, exact `database_ref`, opaque `correlation_id`, account and region. Worker discovery admits these pairs only after independent inventory validation.

- [x] Write regressions for allowlisted identity parsing, exact scoped unique EC2/RDS joins and A→DB1/B→DB2 same-service traces without Cartesian fanout.
- [x] Run the trace tests; confirm missing instance observations fail.
- [x] Implement narrow claim parsing, exact endpoint/resource binding and additive observed-pair metadata; preserve existing graph IDs, K8s and invariant contracts.
- [x] Run affected trace/graph suites and record results.
- [x] Commit the reviewed trace change.

### Task 2: Bounded discovery and runtime gating

**Files:** new `diagnosis/discovery.py`, `test_discovery.py`, Terraform variables/worker configuration/provider-mock tests.

**Interfaces:** Produce the shared bundle and validated follow-up capabilities `resource_metrics`, `provider_sizing`, `graph_refresh` for already admitted resource IDs. Read inventory, topology state/rows and existing FinOps only through scoped queries.

- [x] Write failing fixtures for host/member isolation, stale/missing graph state, exact same-span pairs, repeated X-Ray tokens/later-page references and every collection cap.
- [x] Write failing 14-day EC2/RDS metrics/provider tests, including dimensions/region/status/coverage, missing memory/I/O, protected tags, generation/lookback/rank/currency.
- [x] Implement bounded scoped DB projections, paginated X-Ray and regional metrics; use cached clients with explicit timeouts, zero hidden retries and budget/deadline checks.
- [x] Add default-off worker environment flag and exactly two gated Compute Optimizer read actions without enabling FinOps.
- [x] Run discovery tests and isolated Terraform mock validation/tests; verify default-off plans and no mutation actions.
- [x] Commit the reviewed discovery change.

### Task 3: Evidence admission, shared budget and structured agents

**Files:** new `diagnosis/{budget,evidence,pillar_agents,loop}.py`, corresponding tests.

**Interfaces:** Produce budget/index/loop contracts above. Model client accepts strict schema, trusted instructions and separately serialized untrusted facts. Follow-up callback accepts validated request lists and returns the merged bundle.

- [x] Write failing budget tests for concurrent reservations, retries, input/output ceilings, deadline/export reserve and unknown actual usage.
- [x] Write failing semantic-admission tests for wrong account/region, fabricated refs, configuration-as-traffic, stale sizing, numeric injection and duplicate provider savings.
- [x] Implement thread-safe budgets, exact model capabilities, six distinct pillar prompts and strict schemas with bounded model attempts/read timeouts.
- [x] Write failing loop-order tests for six specialists→review→at most two reruns→final review, light no-follow-up, no-progress and provider/model failures.
- [x] Implement bounded loop and validator/reviewer stages; record model IDs, usage, versions, attempts and outcomes.
- [x] Run all affected analysis tests and commit the reviewed analysis change.

### Task 4: Deterministic reports and handler integration

**Files:** new `diagnosis/presentation.py` and `supporting.py`, `report.py`, `handlers.py`, report/handler/integration tests.

**Interfaces:** `report.generate(..., budget=None)` dispatches on environment only. Enabled summaries add discovery/pillar/model/budget metadata and deterministic `title_and_tags`; handler creates budget at entry and refreshes final ledger after export/title.

- [x] Write failing regressions for disabled-path parity, payload inability to enable, locale/catalog progress, local title selection and admitted-only numeric rendering.
- [x] Implement deterministic localized tables, controlled verification templates, hypothesis labels, admitted-finding-only executive/recommendations and existing invariant block.
- [x] Collect bounded host-only cost, posture, change and commitment summaries with explicit currency/window/sample scope; account summaries never become resource-level costs or sizing proof.
- [x] Integrate scoped discovery/loop into report worker without changing ordinary chat or report ownership/status behavior.
- [x] Add end-to-end offline fixtures covering two distinct instance→DB pairs, rightsizing gaps and degraded/partial output.
- [x] Run report/handler/all worker suites and commit the reviewed integration change.

### Task 5: Runtime tool prompt corrections and evaluation guide

**Files:** `agent/agent.py`, `agent/lambda/aws_cloudwatch_mcp.py`, registered tool catalog, related tests, diagnosis evaluation documentation.

- [x] Write failing tests for namespace-only metrics without `MetricName=None`, optional metric dimensions/statistic/window schema and prompt references to actual tools.
- [x] Fix `check_reachability` reference, distinguish flow-log configuration from traffic, and direct sizing questions to the registered provider tool. Keep normal chat loop and mutating tools dark.
- [x] Document deterministic connection/sizing acceptance fixtures and enabled-path rollout limits.
- [x] Run relevant agent/Lambda/catalog suites and context/documentation consistency checks.
- [x] Commit the reviewed tool/documentation change.

### Task 6: Final verification and independent review

- [x] Run web tests/build, complete worker and agent suites, required offline CI and relevant disposable PostgreSQL tests, Terraform validate and provider-mock tests.
- [x] Review the complete change independently, including read-only IAM, default-off gate, member isolation, model/schema/loop budgets, trace correlation and deterministic presentation.
- [x] Fix actionable review findings and re-run checks justified by those fixes.
- [x] Record exact verification evidence, limitations and local branch state; leave deployment and model probing unperformed.

## Execution and verification record

The approved design was implemented in the isolated diagnosis feature branch. The
trace, discovery, analysis and report seams were reviewed together and committed
as one implementation change after the design commit; intermediate commits from
the task outline were consolidated so the default-off path is reviewable as one
unit. The dependency/runtime refresh is a separate four-PR stack. Its final tree
exactly equals the original refresh, and this feature is based on that tree.

Final local verification on November 4, 2026:

- Web: 5,537 tests passed, 279 existing optional skips; production build passed.
- Workers: 1,922 tests passed, 106 existing optional skips; four existing
  `datetime.utcnow()` deprecation warnings.
- Agent: 196 tests and five subtests passed. Lambda tools: 988 tests and 402
  subtests passed, 18 existing skips and seven existing deprecation warnings.
- Required Node offline CI: 333 passed, zero skips. Required disposable
  PostgreSQL migration, web connection and tool-policy suites: 73 passed,
  zero skips.
- Terraform: formatting and foundation validation passed; 48 backend-disabled
  provider mock plans passed, including default-off and gated read-only IAM.
- Whitespace checks passed. Provider requests and supporting collection inputs
  were also checked against real installed SDK input contracts using fixtures.

An independent code and IaC review reproduced and verified fixes for stale
retained graph observations, redaction of opaque references, incomplete report
status, multilingual numeric prose and timestamp-only follow-up progress.
Requested locale now reaches every trusted specialist/reviewer instruction,
including reruns; unsupported locales fail before collection or model calls.
Focused locale propagation coverage passed 83 tests. Defensive rendering and
numeric admission coverage passed 71 tests, including retained nonnumeric prose
in all four locales. Ordinary Chinese and Japanese words containing an isolated
numeral character are retained; measured counts and numeral sequences remain
withheld, including single-numeral numeric predicates. The full worker result
above includes these regressions.

Logs are local verification artifacts under `/tmp/awsops-diagnosis-*`; their
contents are summarized here rather than committed as generated output. The
unrelated pre-existing core dump is excluded. No deployment, Terraform apply,
image publication, real AWS discovery or paid model call was performed. The
feature flag remains false by default; offline fixtures establish source and
contract behavior, not live model accuracy or deployed acceptance.
