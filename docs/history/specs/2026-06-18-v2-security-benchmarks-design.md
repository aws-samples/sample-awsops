# v2 Security Benchmarks — Design Spec

- **Date:** 2026-06-18
- **Branch / worktree:** `worktree-v2-security-benchmarks` (off `feat/v2-architecture-design` HEAD)
- **Status:** Approved (brainstorming) → consensus pipeline P0–P5
- **Goal:** Port v1's two security features to v2, preserving their *intent* while re-wiring the data path to v2 architecture (thin-BFF + Aurora + async workers + warm Steampipe).

## Background

v1 (`src/`) ships two distinct security surfaces:

1. **Security findings** (`/security`) — direct Steampipe SQL (`src/lib/queries/security.ts`): Public S3, IAM MFA, Open Security Groups, Unencrypted EBS, plus container CVEs (Trivy).
2. **CIS Compliance benchmark** (`/compliance`) — Powerpipe CLI (`powerpipe benchmark run aws_compliance.benchmark.<cis_vX>`) via `src/app/api/benchmark/route.ts`, background `exec` → `/tmp` JSON.

v2 has **neither**. v2 is a thin-BFF on Fargate (heavy work → async workers), uses Aurora (node-pg), has no Powerpipe, and Steampipe exists only as a **flag-gated warm Fargate FDW** (`steampipe_enabled`) feeding `inventory_resources` in Aurora via `sync_lambda`. So "port v1 as-is" is impossible at the code level; we keep the features, re-route the plumbing.

### Key discovery (drives Track A)

`web/app/api/inventory/summary/route.ts` **already** computes `ebs_unencrypted`, `iam_user_no_mfa`, and `sg_open_ingress` directly from `inventory_resources`. The `ebs_volume`, `iam_user`, and `security_group` inventory types are already synced (Steampipe → Aurora). **Three of the four findings already have their raw data in Aurora.** Only Public-S3 data is absent (the `s3` inventory sync deliberately omits public-access fields — per `sync_lambda.py`, `bucket_policy_is_public` triggers per-bucket `GetBucketPolicyStatus` which a restrictive bucket policy can deny, failing the *whole* `aws_s3_bucket` query).

## Scope

**In scope**

- Track A — Security Findings page (`/security`): Public S3, Open SG, Unencrypted EBS, IAM-no-MFA.
- Track B — CIS Compliance benchmark (`/compliance`): CIS v1.5.0 / v2.0.0 / v3.0.0 / v4.0.0 via Powerpipe in a Fargate worker, results persisted to Aurora with run history.

**Out of scope (deferred)**

- **CVE / Trivy findings.** v2 warm Steampipe has no Trivy plugin/connection and there is no Trivy scanner in v2 (v1 ran Trivy on the EC2 host). Re-introducing a Trivy data source is a separate effort. The `/security` page omits the CVE tab; a follow-up can add it.
- Multi-account search-path scoping (v1 `--search-path`). v2 is single-account (`account_id='self'`). Design leaves room but does not implement per-account scoping.
- SNS "benchmark completed" email (v1 `notifyBenchmarkCompleted`). Not part of v2's notification surface yet; omit.

## Prerequisites / shared constraints

- Both features require **`steampipe_enabled = true`** (the warm Steampipe FDW). When the flag is OFF, the BFF returns a `disabled` state and the pages render an "enable Steampipe inventory" notice — consistent with v2's flag-gated, $0-default philosophy. No always-on cost added.
- **arm64** for any new/changed container image (worker image gains Powerpipe).
- New Aurora tables go in `terraform/foundation/migrations/<ULID>_*.sql` (NOT appended to `schema.sql`); the migrate runner stamps `schema_migrations` itself.
- v2 web rules: root path (`/api/*`, no `/awsops`), `export default` components, `HOSTNAME=0.0.0.0` already handled by the platform.

---

## Track A — Security Findings (`/security`)

### A1. Data path — derive from `inventory_resources` (no new table, no new sync for 3/4 checks)

The BFF computes findings on read from already-synced inventory JSONB. Severity and remediation text are **static metadata in the BFF** (TypeScript), not stored.

| Check | Source resource_type | Predicate (over `data` JSONB) | Severity |
|---|---|---|---|
| Open Security Group | `security_group` | ingress rule with `cidr_ip`/`cidr_ipv4` = `0.0.0.0/0` OR `::/0` | high |
| Unencrypted EBS | `ebs_volume` | `data->>'encrypted' = 'false'` | medium |
| IAM user without MFA | `iam_user` | `data->>'mfa_enabled' = 'false'` | medium |
| Public S3 bucket | `s3_public_access` (NEW, see A2) | `bucket_policy_is_public` OR NOT `block_public_acls` OR NOT `block_public_policy` | high |

This fixes a v1 latent bug: v1 hard-coded `mfa_not_enabled = 0` and never actually evaluated MFA. v2 evaluates it for real from `iam_user.mfa_enabled` (already synced).

The open-SG predicate must be anchored to the cidr field key (so a description containing `0.0.0.0/0` cannot false-trigger) and must cover IPv6 `::/0` and both Steampipe key casings — reuse the regex already in `inventory/summary/route.ts` (`"(cidr_ip|CidrIp|cidr_ipv6|CidrIpv6)"\s*:\s*"(0\.0\.0\.0/0|::/0)"`) but extract per-rule detail for the finding list (not just a count).

### A2. New inventory type `s3_public_access` (robust, isolated)

Add one inventory resource type so Public-S3 data lands in Aurora **without** destabilizing the existing `s3` sync.

- **Robustness requirement:** must tolerate per-bucket `AccessDenied` (a single denied bucket must not fail the whole sync). Two implementation options for the plan to choose:
  - (a) **SDK sync** (`SDK_SYNCS` pattern in `sync_lambda.py`): list buckets, then per-bucket `GetPublicAccessBlock` + `GetBucketPolicyStatus`, catching `AccessDenied`/`NoSuchPublicAccessBlock` per bucket and recording `unknown` flags. Robust by construction.
  - (b) Steampipe per-bucket queries in a loop with try/except per bucket.
  - **Recommendation: (a) SDK sync** — matches the existing `cloudfront_vpc_origin`/`alb_listener_rule` SDK_SYNCS precedent and is denial-safe. Requires the sync Lambda role to allow `s3:GetBucketPolicyStatus`, `s3:GetBucketPublicAccessBlock`, `s3:ListAllMyBuckets` (read-only).
- Stored `data` columns: `name`, `region`, `bucket_policy_is_public`, `block_public_acls`, `block_public_policy`, `restrict_public_buckets`, `ignore_public_acls`.
- Registered in `sync_lambda.py` (so `type:"all"` fan-out includes it) and in `web/lib/inventory-types.ts` (`group: 'Security'`) for the generic inventory viewer + nav grouping.

### A3. BFF routes

- `GET /api/security` — auth-gated. If `steampipe_enabled` data absent (no synced rows / flag off) → `{ enabled: false }`. Else returns, per check: `{ summary: {<check>: count}, findings: { open_sg: [...], unencrypted_ebs: [...], iam_no_mfa: [...], public_s3: [...] } }` where each finding carries `{ resource_id, region, title, severity, detail, remediation }`. One round-trip where practical (UNION ALL for counts; per-check selects for detail).
- `POST /api/security/refresh` — auth-gated. Invokes the inventory sync Lambda for the relevant types (`security_group`, `ebs_volume`, `iam_user`, `s3_public_access`), mirroring the existing inventory `/refresh` (`task_inv_sync_invoke` permission already grants the web role `lambda:InvokeFunction`). Returns `202`.

### A4. Page `/security`

Port the v1 UI to v2 conventions:

- Tabbed table view: Public S3 / IAM MFA / Open SG / Unencrypted EBS (no CVE tab).
- `StatsCards` row (counts per check), severity distribution chart (recharts, **theme-reactive** via `useChartColors` — v2 pattern), per-row detail slide-in panel with the static remediation hint.
- v2 styling (paper/ink + Cobalt theme tokens), `export default`, fetch `/api/security` (root path).
- Reuse existing v2 table/detail-panel/StatsCard components where present (match `inventory/[type]/page.tsx` and other v2 pages).
- "Refresh" button → `POST /api/security/refresh`, then re-fetch.
- Flag-off state: friendly "Steampipe inventory is disabled" panel.

### A5. Navigation

- Add a fixed nav item **Security** (`href: '/security'`) to `web/components/shell/Sidebar.tsx` `FIXED[]`, with an i18n `nav.security` key (`web/lib/i18n.ts`, KO+EN).
- Wire into `MobileNav.tsx` / `BottomTabBar.tsx` / `CommandPalette.tsx` as other fixed pages are.

---

## Track B — CIS Compliance benchmark (`/compliance`)

### B1. Job type `compliance` (Fargate worker)

- Register `"compliance": (_compliance, "fargate")` in `scripts/v2/workers/handlers.py` `REGISTRY`, and add `'compliance'` to the `ALLOWED` set in `web/app/api/jobs/route.ts` (the two must stay mirrored; dispatcher re-validates).
- `payload`: `{ benchmark: 'cis_v150'|'cis_v200'|'cis_v300'|'cis_v400', run_id: <pre-created>, requested_by }`. Benchmark id is allowlisted server-side in `handlers.py` (reject anything else — defense against arbitrary `powerpipe` arg injection).

### B2. Worker handler `_compliance(payload, dry_run)`

- `dry_run` → return `{dry_run, would_run: benchmark}`.
- Connect Powerpipe to the warm Steampipe FDW: `POWERPIPE_DATABASE=postgres://steampipe:<secret>@${STEAMPIPE_HOST}:9193/steampipe` (password from `STEAMPIPE_SECRET_ARN` via Secrets Manager, same as `sync_lambda._steampipe()`; SSL context as the FDW requires).
- Run: `powerpipe benchmark run aws_compliance.benchmark.<benchmark> --mod-location <baked-mod-dir> --output json --progress=false`. Powerpipe exits `2` when controls alarm — treat non-empty valid JSON as success regardless of exit code (v1 lesson, `benchmark/route.ts:73`).
- Parse JSON → walk `groups[].summary.control` for run totals; walk leaf controls for per-control rows.
- Persist to Aurora (B3): update `compliance_runs` row (status, totals, pass_rate, finished_at) + bulk insert `compliance_results`.
- On exception: update run `status='failed'`, `error=str(e)[:2000]`, re-raise so SFN Catch → `status_updater` marks the job failed (mirror the `report` handler's connection-release + error pattern, including the pg8000 `finally: conn.close()`).

### B3. Aurora schema — `migrations/<ULID>_compliance.sql`

```
compliance_runs(
  id            BIGSERIAL PK,
  worker_job_id UUID REFERENCES worker_jobs(job_id),
  benchmark     TEXT NOT NULL,           -- cis_v300 ...
  status        TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','succeeded','failed')),
  requested_by  TEXT NOT NULL,
  pass_rate     NUMERIC,                 -- ok / (ok+alarm+info+skip+error) * 100
  total_controls INT, ok INT, alarm INT, info INT, skip INT, error INT,
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()         -- touch_updated_at() trigger
);
compliance_results(
  id          BIGSERIAL PK,
  run_id      BIGINT NOT NULL REFERENCES compliance_runs(id) ON DELETE CASCADE,
  control_id  TEXT NOT NULL,
  title       TEXT,
  section     TEXT,                      -- benchmark group title / path
  status      TEXT NOT NULL,             -- ok | alarm | skip | info | error
  reason      TEXT,
  resource    TEXT,
  region      TEXT,
  severity    TEXT
);
CREATE INDEX idx_compliance_results_run ON compliance_results(run_id);
CREATE INDEX idx_compliance_runs_created ON compliance_runs(created_at DESC);
```

(Follow the `diagnosis_reports` migration conventions: `IF NOT EXISTS`, the `touch_updated_at()` trigger guard, do NOT insert into `schema_migrations`.)

### B4. Worker image — bake Powerpipe + the aws_compliance mod

Extend `scripts/v2/workers/Dockerfile` (the single shared worker image, **CMD not ENTRYPOINT** — keep that):

- Install the **Powerpipe arm64** binary.
- Pre-install (`powerpipe mod install` at build time) the upstream `github.com/turbot/steampipe-mod-aws-compliance` mod into a baked mod dir → no GitHub egress at run time, reproducible.
- `COPY` the new handler code paths already happen via `handlers.py` (already COPY'd). No ENTRYPOINT change; SFN `containerOverrides.command` still selects `python fargate_worker.py --job-id …`.
- `workers.mjs` build step: ensure the build context has what it needs (mirror the existing remediation-module `cp` precedent if any new files sit outside the context).

### B5. Terraform (`terraform/foundation/`)

- **Steampipe ingress:** the Fargate worker task SG must reach Steampipe `:9193`. `steampipe.tf` currently allows ingress only from the web/lambda service SG — add the worker task SG to that ingress (in-place rule add; **keep the SG `description` verbatim** — immutability rule).
- **Worker task env:** add `STEAMPIPE_HOST` + `STEAMPIPE_SECRET_ARN` to the Fargate worker `container_definitions.environment` in `workers.tf`, and grant the worker **task role** `secretsmanager:GetSecretValue` on the Steampipe secret (the worker reads it at runtime via boto3, like `sync_lambda`; not a task-def `secrets`/valueFrom, so task-role not execution-role).
- All gated by the existing flags — the worker image + job type ship regardless, but a `compliance` run only works when `steampipe_enabled=true` (warm FDW up). If Steampipe is off, `_compliance` fails fast with a clear error.
- No `-auto-approve`; controller runs `apply tfplan` for shared infra. New migration auto-applies via `make deploy` (migrate step).

### B6. BFF routes

- `POST /api/compliance/run` — auth-gated thin wrapper (mirrors the `report` precedent): validate `benchmark` against the allowlist → INSERT a `compliance_runs` row (`status='running'`) → `enqueueJob('compliance', { benchmark, run_id, requested_by })` → return `{ run_id, job_id }`. Pre-creating the row fixes the UI race + the `worker_job_id` linkage.
- `GET /api/compliance/runs` — list recent runs (id, benchmark, status, pass_rate, totals, timestamps).
- `GET /api/compliance/runs/[id]` — one run + its `compliance_results` (grouped by section for the UI). Page polls this for status while `running`.
- `GET /api/compliance/benchmarks` — static allowlist (id/name/description), or inline the list in the page (v1 `action=list`).
- Flag-off / unconfigured (no `JOBS_QUEUE_URL`) → `503`/`disabled` as the jobs route already does.

### B7. Page `/compliance`

Port v1 UI to v2:

- Benchmark selector (CIS v3.0.0 default) + **Run Benchmark** button → `POST /api/compliance/run`.
- Poll `GET /api/compliance/runs/[id]` every ~5s while `running`.
- On result: pass-rate `StatsCards` (Pass Rate %, Total, Passed, Alarm, Skipped, Error), status-distribution pie, alarms-by-section bar, expandable section cards with per-section pass% progress bars, control list, control detail slide-in (status/reason/resource/description). Color thresholds: green ≥80%, orange ≥50%, red below (v1 parity).
- Recharts theme-reactive; v2 styling; `export default`.
- Optionally surface recent runs (history) from `GET /api/compliance/runs`.

### B8. Navigation

- Add a fixed nav item **Compliance** (`href: '/compliance'`) alongside **Security** (A5), same wiring (Sidebar FIXED + i18n + mobile + command palette).

---

## Testing

Follow v2 conventions (`*.test.ts(x)` with the existing web test runner; `pytest test_*.py` for worker Python).

**Track A**
- BFF `GET /api/security`: finding derivation from fixture `inventory_resources` rows (open-SG cidr anchoring incl. IPv6 + casing, EBS encrypted=false, IAM mfa_enabled=false, S3 public flags); flag-off `{enabled:false}` path; auth gate (401).
- `POST /api/security/refresh`: invokes the sync Lambda; 202.
- `sync_lambda` `s3_public_access`: per-bucket AccessDenied tolerated (one denied bucket doesn't fail the sync); flag mapping.
- Page component: tab render, counts, detail panel, flag-off notice.

**Track B**
- `_compliance` handler: `dry_run`; JSON-parse → run totals + per-control row mapping (fixture Powerpipe JSON); exit-code-2-with-valid-JSON treated as success; failure path writes `status='failed'` + re-raises; connection released.
- BFF `/api/compliance/run` (allowlist reject, row pre-create, enqueue), `/runs`, `/runs/[id]`.
- Page component: selector, run, polling, charts, control detail, color thresholds.

`bash tests/run-all.sh` (+ web + worker tests) green is the gate for each task.

## Implementation sequencing (two phases, one spec)

1. **Phase 1 — Track A (Findings).** Validates the inventory→Aurora→BFF→page pattern with minimal new infra (one new inventory type + BFF + page + nav). Lower risk; ships independently.
2. **Phase 2 — Track B (CIS benchmark).** Worker image (Powerpipe), job type, migration, terraform (SG ingress + worker env/role), BFF, page, nav.

Each task: TDD (failing test → minimal code → refactor), per-task commit, multi-model consensus gate on the diff, scope-guarded to this spec's files.

## Risks / open questions

- **Powerpipe arm64 + mod bake size:** the worker image grows (Powerpipe binary + aws_compliance mod). Acceptable; it's the existing report image already carrying chromium. Verify arm64 Powerpipe release availability in the build.
- **Steampipe FDW reachability from the worker SG:** must add the worker task SG to the `:9193` ingress without mutating the SG description (replace hang). Verify the worker task actually uses a distinct SG vs the web service SG.
- **Powerpipe ⇄ remote Steampipe auth:** v1 used a local `steampipe service status --show-password`; v2 must point `POWERPIPE_DATABASE` at the remote FDW with the Secrets-Manager password + SSL. Validate the connection string format Powerpipe accepts.
- **Long benchmark runtime:** CIS v3/v4 across a populated account can take minutes — that's exactly why it's a Fargate worker (no 15-min Lambda cap). Confirm SFN `runTask.sync` timeout headroom.
- **`steampipe_enabled` currently OFF in prod?** Both features are inert until the flag is on. Surfacing this in the UI (disabled notice) is part of scope; flipping the flag + cost is an operator decision, not this change.

## Files touched (scope)

- `terraform/foundation/migrations/<ULID>_compliance.sql` (new)
- `terraform/foundation/steampipe.tf` (worker SG → :9193 ingress)
- `terraform/foundation/workers.tf` (worker task env + task-role secret read)
- `scripts/v2/steampipe/sync_lambda.py` (+ IAM for s3 read in `steampipe.tf`) — `s3_public_access` sync
- `scripts/v2/workers/handlers.py` (`_compliance` + REGISTRY)
- `scripts/v2/workers/Dockerfile` (Powerpipe + mod) + `scripts/v2/workers.mjs` (build context if needed)
- `web/app/api/security/route.ts`, `web/app/api/security/refresh/route.ts` (new)
- `web/app/api/compliance/run/route.ts`, `web/app/api/compliance/runs/route.ts`, `web/app/api/compliance/runs/[id]/route.ts`, `web/app/api/compliance/benchmarks/route.ts` (new)
- `web/app/api/jobs/route.ts` (`ALLOWED` += compliance)
- `web/app/security/page.tsx`, `web/app/compliance/page.tsx` (new)
- `web/lib/inventory-types.ts` (`s3_public_access` type)
- `web/components/shell/Sidebar.tsx`, `web/lib/i18n.ts`, `web/components/shell/MobileNav.tsx`, `web/components/shell/BottomTabBar.tsx`, `web/lib/mobile-tabs.ts`, `web/components/shell/CommandPalette.tsx` (nav wiring)
- tests alongside each.
