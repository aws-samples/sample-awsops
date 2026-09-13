# Runbooks

Operational playbooks organized by scenario. Each follows symptoms → diagnosis → action.

## Index

| Runbook | Topic |
|---|---|
| [start-services.md](start-services.md) | **⚠️ v1 (legacy)** — start all services (Steampipe + Next.js on EC2); v2 runs ECS always-on |
| [deploy-new-version.md](deploy-new-version.md) | **⚠️ v1 (legacy)** — deploy a new version (CDK); v2 uses `make deploy` |
| [add-new-page.md](add-new-page.md) | Adding a new dashboard page |
| [multi-account-setup.md](multi-account-setup.md) | **⚠️ v1 (legacy)** — onboard a new AWS account (Steampipe Aggregator); v2 uses `onboard-target-account.md` |
| [onboard-target-account.md](onboard-target-account.md) | v2 target-account onboarding (`AWSopsReadOnlyRole` + ExternalId) |
| [istio-agent-eks-access.md](istio-agent-eks-access.md) | Granting `istio-read` MCP access to an EKS cluster (agent Lambda role Access Entry) |
| [network-path-eks-access.md](network-path-eks-access.md) | Granting Network Path Check live-identity verification access to an EKS cluster's Nodes/Pods (worker task role / `AWSopsReadOnlyRole` Access Entry, AdminView) |
| [k8sgpt-operator-install.md](k8sgpt-operator-install.md) | Out-of-band K8sGPT operator install (manual operator work, ADR-005 precedent) |
| [alert-pipeline-troubleshoot.md](alert-pipeline-troubleshoot.md) | Alert pipeline failure response (ADR-008/013) |
| [cache-warmer-issues.md](cache-warmer-issues.md) | Cache warmer staleness / error response |
| [tempo-query-generation.md](tempo-query-generation.md) | Tempo query generation — connector/web deployment, admin API schema refresh, cached summaries, and recent-window limits |
| [source-sync-observability.md](source-sync-observability.md) | Public source rollout — graph evidence/identity boundaries, DX assessment scope, migrations and Lambda deployment prerequisites |
| [cognito-auth-issues.md](cognito-auth-issues.md) | Login failures, Lambda@Edge verification errors |
| [user-offboarding.md](user-offboarding.md) | Offboarding a departing employee's Cognito account — closing the account-takeover path (ADR-002/009) |
| [v1-to-v2-aurora-backfill.md](v1-to-v2-aurora-backfill.md) | v1→v2 Aurora history backfill |
| [v1-decommission.md](v1-decommission.md) | v1 legacy decommission — 5-phase procedure (ADR-016) |
| [branch-strategy.md](branch-strategy.md) | Single-repo branch/PR chain (user → dev → main + guard), external-PR handling, domain map, production-domain decision, per-user preview stacks |
| [dev-repo-setup.md](dev-repo-setup.md) | CI/OIDC and protected review recovery; ECR preflight; state-preserving DNS deferral, certificate ownership, dispatch-only same-SHA saved plans and private authenticated assets, Host/SNI smoke, default-off manual private DB migration, opt-in authenticated verification and manual opt-in advisory read-only DB diagnostics (ADR-002/005/016) |
| [dev-domain-rollout.md](dev-domain-rollout.md) | Unpublished/same-domain dev rollout; explicit saved-plan domain scope, certificate issuance, smoke-before-publication and owned-record-preserving rollback (ADR-005/016) |
| [steampipe-quota-and-staleness.md](steampipe-quota-and-staleness.md) | Steampipe quota guard — rate limiter knobs, partial runs, freshness ledger/staleness response |
| [agent-sql-reader.md](agent-sql-reader.md) | `execute_sql`/`inventory-read` Data API auth failures — `awsops_sql_reader` role/password sync (`apply → make migrate → make agentcore`) |

## Deployment invariants
- `scripts/v2/ci_tf_assets.py` shares one locked pg8000 installer with Terraform.
  Prepare invalidates markers and removes stale regular ZIPs, rejecting ZIP symlinks.
  Pack requires known planned ZIPs and binds plan/SHA/scope, paths, modes and hashes with
  `TF_PLAN_ENC_KEY` HMAC. Both pack/restore APIs allow only push/pull_request/workflow_dispatch
  in GitHub, or explicit local commits without an event; other events fail before work.
  Targeted plans omit untargeted Lambda resources from planned_values; preserve the ZIP check.
  The 0600 tarball can contain signing keys. The integrating workflow must encrypt it before
  upload and clean its own plaintext/staging; pack/restore has no workflow caller yet.
  `CI_ASSETS_READY=true` makes layer provisioners validate restored files without reinstalling.
  See `scripts/v2/ci/pg8000-requirements.txt`, `scripts/v2/test_ci_tf_assets.py` and
  `docs/reference/06-workers.md`. Key rotation invalidates prior signed bundles.
- `CI_DB_DIAGNOSTICS_DEV` is false/unset by default; literal `true` plus `workflow_dispatch`
  enables advisory dev plan diagnostics only after encrypted artifact upload. Require
  `--target dev`, region `ap-northeast-2`, and state-account/STS consistency; this is not
  authorization or same-account stack validation. Use existing read-only grants and an exact
  CLI verb allowlist. No IAM/resource writes or DB connection. Opt-in publishes fenced safe
  JSON, including posture booleans, to the public Actions log/summary.
  Only this optional step tolerates failure; DNS/CI/readiness gates remain required.
  Retain all four sections independently: `logs`, `configuration`, `server_logs`, `rds_metrics`.
  Distinguish unavailable sources from unknown derived comparisons; early input/context/identity
  failure returns only `{"status":"unavailable"}`, not fabricated empty sections.
  Empty samples explicitly expose `no_matching_events` and `no_error_inference`; zero counts
  in any status are not health proof. Interpretation requires a known probe in the returned window.
  Successful task-definition reads stay source-available for missing/malformed web containers;
  `web_container_found` and derived-unknown flags describe the configuration defect.
  Web logs cover a fixed one-hour window, oldest-first, at most 3 × 100 events; disclose actual
  bounds, truncation and count meanings. JSON `evt` OR selects ping errors and connection-stage
  observations; phase/milestone names are fixed, durations finite and bounded to one hour,
  and latest timing describes only the returned sample. RDS lists at most three PostgreSQL-file pages for the
  configured first Aurora instance and reads at most two newest-500-line tails without download
  Markers. Only FATAL/ERROR/PANIC web-role lines count as errors. `benign_role_mentions` counts
  exactly non-error-severity lines mentioning `awsops_web`; lines for other database roles are
  ignored. Capped/failed reads retaining evidence are partial; download failure retains metadata.
  Discarded milestones and regex text shortened to 4,096 characters also mark samples partial.
  The same opt-in uses one bounded CloudWatch get-metric-data read for the configured first
  instance: seven IAM-auth Sum metrics, CPU Average, free-memory Minimum and capacity Average.
  Preserve fixed IDs/status/missing/invalid flags and at most 60 minute points per series;
  never emit remote labels, messages or pagination tokens. Configured min/max ACUs are numeric
  or null; no capacity, authentication or timeout tuning is authorized.
  Separate read status from data presence: clean Complete+empty is available with missing=true;
  Forbidden/InternalError is unavailable; PartialData/malformed/degraded reads are partial.
  `read_ok` describes an accepted response envelope, not an authentication outcome.
  Every lifecycle observation needs the web user in a recognized RDS prefix and an anchored
  message, separately from error counts. Full-prefix SQL continuations and RAISE LOG can forge
  matching text: lifecycle_source_integrity stays unverified_text, lifecycle_injection_possible
  is always true, and probe outcome stays unknown. Auth success messages require log_connections
  (PostgreSQL default off; not enabled here). The effective value is not inspected;
  log_connections_enabled=null is explicitly unknown.
  Metrics aggregate IAM clients and never prove an individual probe outcome or authorize tuning.
  Publish fixed projections only, including on Terraform/AWS failures; never raw logs/filenames.
  Service-target/declaration comparisons and error categories are hypotheses, not proof of
  running revisions, effective access, runtime credentials, connectivity or readiness.
- `ci_migrations_enabled` / `CI_MIGRATIONS_ENABLED_DEV` is a default-off operator capability.
  `deploy-migrations.yml` builds an ARM64 image and `run-migration.mjs` launches/verifies one
  private task. The task role reads exact Aurora secrets; DDL uses DB credentials. This is
  operator CI, not product autonomy or an ADR-005 AWS-resource-mutation exception.
- `dev-repo-setup.md` covers CI/OIDC, protected review recovery, ECR preflight, state-preserving
  DNS deferral and explicit same-branch/SHA dispatch plans. PR/push plans are advisory.
- Dev repo domain overrides feed both console and plan through a gitignored auto-tfvars
  file; reject a tracked override before generation. `CERTIFICATE_MODE_DEV` preserves
  ownership or selects managed issuance. Dev advisory preflight uses state only, without
  live certificate/SAN/trust validation; DNS allowance is reporting, never apply authority.
- `domain_rollout=false` is the ordinary full-plan default. Every authorized domain-stage
  plan sets it true (dev/full only), stored as declared Terraform metadata `ci_domain_rollout`.
  Apply derives scoping from the saved plan, not current repo variables or apply inputs.
  Active rollout allows only configured service A/ACM CNAME owners in the selected zone.
  Published old-domain retirement needs a separate expressly authorized old-configuration plan.
- Preserve managed certificates as JSON null and existing service aliases. External certificates
  must be operator-selected or already attached; never scan the account. Routine CI cannot
  externalize a managed certificate or delete/replace owned validation CNAMEs even when DNS is
  allowed; ownership migration and validation-record retirement need separate reviewed procedures.
- ALLDNS includes private Cloud Map, certificate validation and registered ECS task changes.
  Steampipe tuning, hydrate-fallback remedies and rollback/disable can change private DNS and are
  blocked too. No private-DNS exception. Future authorized cutovers explicitly set
  `allow_dns_changes=true` on both plan and apply dispatches; examples do not grant permission.
- Public summaries include managed/external certificate suffixes, publication, change counts/
  addresses and active-rollout public zone name/ID/NS; diagnostics additionally permit bounded
  metric values. Never expose full ARNs, account IDs or
  raw configuration/state/plan JSON. Deploy Web/manual smoke share the argv-safe Host/SNI/TLS
  CLI; health is liveness only. DB/auth checks precede service A publication.
- Offline Terraform checks use `bash scripts/v2/terraform-test.sh` from the repo root:
  Terraform 1.15.7, tracked working files copied in isolation, fresh `TF_DATA_DIR`,
  `init -backend=false`, mocked providers and no real backend. Test dependencies are declared in
  `scripts/v2/requirements-test.txt`; deployment Node tests also run in the shared merge script.
  Root-level Python command: `python3 -m pytest -q scripts/v2/test_ci_*.py`.

## Authenticated development verification
- Verify requires applied `agentcore_enabled=true` and `ci_readiness_enabled=true`, then AgentCore
  provisioning, active inventory/dispatch, `workers_enabled=true` and deployed ARM64 worker images.
  Only the output boolean sets `DEPLOYMENT_READINESS_ENABLED`, with no shell override.
  False/missing is `runtime_disabled`; this flag grants no Cognito group membership.
  Capped samples cannot prove absence. Missing ledger, partial/failed runs and unknown attributes
  remain distinct failures; accepted degraded inventory is not a deployment-readiness exception.
- The runtime smoke capability uses a private 0600 `SMOKE_RUNTIME_CONFIG_FILE` beside the
  credentials. Prepare checks host registration (optional hostOnly); verify additionally
  requires applied CloudFront identity, complete queued types and pre-dispatch timestamp,
  fresh collection, web-role SSM/AgentCore proof and Lambda/Fargate completion. Current Deploy
  Web remains DB-only until the release controller supplies this file. The billed readiness
  route requires admin or deployment-verifiers, one in-flight call and a 60-second cooldown.

- Deploy Web `verify_database=true` is dev-only and runs after required migrations. It prepares
  effective demo credentials privately with unwrapped Terraform before rollout, then verifies
  login and edge-authenticated `/api/db`. A positive table count is not a full ledger audit.
- Credentials and HTTP scratch share one 0700 run directory with 0600 files, covered by
  always-cleanup. Public diagnostics contain only fixed phases and validated HTTP status.
  Never relay Terraform diagnostics, response bodies or cookies, or reset a user's password.
- Curl/OpenSSL, PyYAML and Terraform 1.15.7 are mandatory for the authenticated smoke fixtures;
  missing tools fail the shared runner. Only final fmt/validate diagnostics are informational.

## Conventions
- Filename: `kebab-case.md`, domain-then-topic order.
- Structure: **symptoms → candidate causes → verification commands → action → related files/ADRs**.
- Runbook *bodies* (the linked `*.md` files above) must be bilingual Korean/English (a small
  number of existing runbooks are English-only and should be brought into line, not treated as
  precedent) — this index file itself follows the repo's CLAUDE.md-is-English-only rule
  (`docs/CLAUDE.md`).
- Commands should be copy-paste ready.
- Cite the related ADR number(s) at the bottom.
- Do not let a runbook embed secrets, AWS account IDs, ARNs, or live domains.

## Adding a Runbook
1. Add it to this index.
2. Use an existing runbook's structure as a template (`start-services.md`, `deploy-new-version.md`).
3. Follow the symptoms → diagnosis → action order strictly.
4. Always include the related file paths.
