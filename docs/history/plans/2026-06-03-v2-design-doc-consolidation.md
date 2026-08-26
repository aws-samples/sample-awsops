# v2 Design-Document Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate 11 dated, phase-oriented v2 design documents into a component-oriented `docs/superpowers/reference/` set (one file per component) + README index, then archive the originals — so any v2 component can be understood/implemented from a single file.

**Architecture:** Create `reference/` with 7 component docs (each using a fixed 7-section template) + a README index. Extract content from the existing v2 specs/plans + the v2 root `CLAUDE.md` (an authoritative condensed source) + cited ADRs. Then `git mv` the 11 v2 specs/plans into `archive/` with a mapping README. ADRs are never modified — only cited.

**Tech Stack:** Markdown only. No code, no build. Verification = `grep`/`test -f` checks that template sections exist and that every cited file path actually exists in the repo.

---

## Reference facts (authoritative — use for all tasks)

Spec: `docs/superpowers/specs/2026-06-03-v2-design-doc-consolidation-design.md`. The v2 root `CLAUDE.md` (sections "아키텍처 (v2)", "주요 파일", "알려진 이슈") is a verified condensed source — prefer it + the named archived plan for each doc. Do NOT invent facts; if a fact isn't in CLAUDE.md or the source plan, omit it.

**Fixed 7-section template** (every `reference/NN-*.md`, bilingual KO/EN headers, concise):
```
# NN. <Component> — v2 Reference
## Purpose / 목적
## Current design / 현행 설계
## Decisions (ADRs) / 결정
## Key files / 핵심 파일
## Status / 상태
## Learnings & gotchas / 학습·함정
## Source / 출처   ← archived plan/spec + docs/reviews/* links
```

**Source docs (under `docs/superpowers/`, to be archived in Task 9):**
- specs: `2026-05-30-awsops-v2-architecture-design.md`, `2026-05-31-custom-agents-skills-design.md`, `2026-06-02-awsops-v2-p2-async-worker-backbone-design.md`
- plans: `2026-05-30-awsops-v2-p1a-foundation-edge-spine.md`, `2026-05-31-awsops-v2-p1b-cognito-edge-auth.md`, `2026-05-31-awsops-v2-p1c-aurora.md`, `2026-05-31-awsops-v2-p1d-web-cicd-auth.md`, `2026-05-31-awsops-v2-p1e-eks-onboarding.md`, `2026-05-31-awsops-v2-p1f-agentcore-provisioner.md`, `2026-05-31-adr-031-phase1.md`, `2026-06-02-awsops-v2-p2-async-worker-backbone.md`

**Per-doc verification helper** (reused in every component task — run from repo root):
```bash
# section check
for s in "## Purpose" "## Current design" "## Decisions" "## Key files" "## Status" "## Learnings" "## Source"; do
  grep -q "$s" "$DOC" || echo "MISSING SECTION: $s"
done
# file-path check: every `path` in backticks that looks like a repo path must exist
grep -oE '`(terraform|scripts/v2|web|agent)[^`]*`' "$DOC" | tr -d '`' | sed 's/[:#].*//' | while read p; do
  [ -e "$p" ] || echo "MISSING PATH: $p"
done
```
Expected: no output (all sections present, all cited paths exist). Glob-y paths like `scripts/v2/workers/*.py` — strip the `*` segment or check the dir.

---

## Task 1: Edge & Networking reference (`01-edge-network.md`)

**Files:**
- Create: `docs/superpowers/reference/01-edge-network.md`
- Read sources: `docs/superpowers/plans/2026-05-30-awsops-v2-p1a-foundation-edge-spine.md`, root `CLAUDE.md` (아키텍처/알려진 이슈), `terraform/foundation/{edge,network,providers,backend}.tf`

- [ ] **Step 1: Read sources** — the P1a plan + CLAUDE.md edge/known-issues + skim the four `.tf` files for real resource/variable names.

- [ ] **Step 2: Write `01-edge-network.md`** using the template. Must include:
  - **Current design**: CloudFront (TLS) → **VPC Origin `https-only:443`** → **internal ALB HTTPS:443** (regional ACM) → HTTP → Fargate `awsops-v2-web:3000`. No public ALB. ALB SG allows 443 from the CloudFront managed SG `CloudFront-VPCOrigins-Service-SG` (data lookup by name + vpc-id). VPC is new-or-reuse via `create_network` flag (live: reused mgmt-vpc `vpc-0123456789abcdef0`, 10.254.0.0/16; new-VPC default 10.30.0.0/16). Partial S3 backend (`awsops-v2-tfstate`, `use_lockfile`, no DynamoDB), TF ≥1.15, provider `~>6.0`.
  - **Decisions**: ADR-030 (ECS Fargate + Aurora; v2 topology), ADR-028 (CloudFront `CACHING_DISABLED`).
  - **Key files**: `terraform/foundation/edge.tf`, `network.tf`, `providers.tf`, `backend.tf`; `backend.hcl` (generated).
  - **Status**: P1a ✅ GREEN — `https://awsops-v2.example.com` → HTTP 200, SSE 1/s, account `123456789012`.
  - **Learnings & gotchas**: 504→200 root cause — CF→ALB must be TLS end-to-end (VPC Origin `https-only` + origin `domain_name` = public FQDN to drive SNI match; ALB needs HTTPS:443 + regional ACM validated via the CloudFront cert's Route53 CNAMEs); ALB SG **must** allow 443 from `CloudFront-VPCOrigins-Service-SG` (VPC-CIDR-only → persistent 504); VPC Origin protocol can't update in-place while attached → `create_before_destroy` + distinct name + `-replace`.
  - **Source**: archived `2026-05-30-awsops-v2-p1a-foundation-edge-spine.md`.

- [ ] **Step 3: Verify** — `DOC=docs/superpowers/reference/01-edge-network.md` then run the verification helper. Expected: no output.

- [ ] **Step 4: Commit**
```bash
git add docs/superpowers/reference/01-edge-network.md
git commit -m "docs(v2-ref): edge & networking reference (P1a)"
```

---

## Task 2: Auth reference (`02-auth.md`)

**Files:**
- Create: `docs/superpowers/reference/02-auth.md`
- Read sources: `docs/superpowers/plans/2026-05-31-awsops-v2-p1b-cognito-edge-auth.md`, the P1d plan (auth-hardening section), `docs/decisions/020-cognito-lambda-edge-auth.md` (incl. 2026-06-03 RS256 deviation note), `terraform/foundation/auth.tf`, `terraform/foundation/edge-lambda/cognito_edge.py.tftpl`

- [ ] **Step 1: Read sources.**

- [ ] **Step 2: Write `02-auth.md`** using the template. Must include:
  - **Current design**: Cognito User Pool (`ap-northeast-2_EXAMPLE01`) + app client (`EXAMPLECLIENTID0123456789`, **PKCE public client, no secret**) + hosted domain `a-ops-v2-auth-123456789012`. **Lambda@Edge** `awsops-v2-cognito-auth` (`us-east-1`, python3.12, viewer-request) does **RS256 JWKS signature verification** + iss/aud/token_use + OAuth `state` + PKCE. Admin `admin@awsops.local` (in gitignored tfvars).
  - **Decisions**: ADR-020 (Cognito + Lambda@Edge) — note its 2026-06-03 correction: v2 hardened from exp-only to full RS256.
  - **Key files**: `terraform/foundation/auth.tf`, `terraform/foundation/edge-lambda/cognito_edge.py.tftpl`.
  - **Status**: P1b + P1d ✅ — browser login e2e verified (Cognito → web via state/PKCE; forged token → 302).
  - **Learnings & gotchas**: `'aws'` is a Cognito reserved word → domain dropped the prefix (`a-ops-v2-…`); v1 edge was exp-only (insecure — a decode-only app trusting it accepts forged JWTs), v2 fixed with RS256 JWKS (pure-python, no deps, 1 MB-safe); Cognito client was replaced when switching to PKCE (old client destroyed, admin creds unchanged).
  - **Source**: archived `2026-05-31-awsops-v2-p1b-cognito-edge-auth.md` + P1d plan; `docs/reviews/v2-p1d-readiness-architecture-review.md`.

- [ ] **Step 3: Verify** — `DOC=docs/superpowers/reference/02-auth.md`; run helper. Expected: no output.

- [ ] **Step 4: Commit**
```bash
git add docs/superpowers/reference/02-auth.md
git commit -m "docs(v2-ref): auth reference (P1b + P1d RS256 hardening)"
```

---

## Task 3: Data / Aurora reference (`03-data-aurora.md`)

**Files:**
- Create: `docs/superpowers/reference/03-data-aurora.md`
- Read sources: `docs/superpowers/plans/2026-05-31-awsops-v2-p1c-aurora.md`, `terraform/foundation/data.tf`, `terraform/foundation/data/schema.sql`, root `CLAUDE.md` (Aurora upgrade gotcha)

- [ ] **Step 1: Read sources.**

- [ ] **Step 2: Write `03-data-aurora.md`** using the template. Must include:
  - **Current design**: Aurora Serverless v2 cluster `awsops-v2-aurora` (**PG 17.9**, 0.5–4 ACU, KMS CMK, RDS-managed master secret, app-only SG :5432 in mgmt-vpc), db `awsops`, endpoint `awsops-v2-aurora.cluster-ch0io48c0dqx.ap-northeast-2.rds.amazonaws.com`. **ADR-030 7-table schema** (tracked by `schema_migrations`) + P2 `worker_jobs`; applied via psql from the in-VPC deploy host. App accesses via node-pg.
  - **Decisions**: ADR-030 (Aurora replaces the `data/*.json` state layer, not Steampipe; v2 has no Steampipe).
  - **Key files**: `terraform/foundation/data.tf`, `terraform/foundation/data/schema.sql` (root `.gitignore` `data/` has a `!terraform/foundation/data/` carve-out).
  - **Status**: P1c ✅; PG 15→17.9 major upgrade ✅ (in-place, endpoint/secret unchanged).
  - **Learnings & gotchas**: major upgrade procedure — set exact minor (`17.9`) + `allow_major_version_upgrade` + `apply_immediately`, apply FIRST (upgrade), THEN add `lifecycle{ignore_changes=[engine_version]}` to BOTH cluster and instance (absorbs minor auto-upgrades); pinning just `"17"` misbehaves on `aws_rds_cluster`; SG `description` is immutable (forces replace); `deletion_protection=false`/`skip_final_snapshot=true` are dev-only (flip for prod); pre-upgrade manual snapshot is the rollback anchor (major in-place downgrade impossible).
  - **Source**: archived `2026-05-31-awsops-v2-p1c-aurora.md`.

- [ ] **Step 3: Verify** — `DOC=docs/superpowers/reference/03-data-aurora.md`; run helper. Expected: no output.

- [ ] **Step 4: Commit**
```bash
git add docs/superpowers/reference/03-data-aurora.md
git commit -m "docs(v2-ref): data/Aurora reference (P1c + PG17 upgrade)"
```

---

## Task 4: Web thin-BFF reference (`04-web-bff.md`)

**Files:**
- Create: `docs/superpowers/reference/04-web-bff.md`
- Read sources: `docs/superpowers/plans/2026-05-31-awsops-v2-p1d-web-cicd-auth.md`, `web/app/api/*/route.ts`, `web/lib/db.ts`, `web/Dockerfile`, `terraform/foundation/{workload,ecr}.tf`, `scripts/v2/deploy.mjs`, root `CLAUDE.md` (HOSTNAME gotcha)

- [ ] **Step 1: Read sources.**

- [ ] **Step 2: Write `04-web-bff.md`** using the template. Must include:
  - **Current design**: Next.js 14 **thin-BFF** at `web/` (standalone **arm64**, **root path — no basePath**). Routes: `/api/health` (public), `/api/stream` (SSE), `/api/db` (Aurora ping via node-pg `getPool`), `/api/jobs` (+`/[id]`, P2 async). Heavy/long/OOM work is **enqueued**, not run inline. **Dual-tier ECR**: dev-private `awsops-v2-web`, prod-public `public.ecr.aws/r7z4t3s6/awsops-v2-web`. `make deploy` (`scripts/v2/deploy.mjs`): login → buildx arm64 push → ECS force-new-deployment → wait stable → smoke `/api/health`. Aurora secret wired via ECS `secrets` valueFrom on the **execution role**.
  - **Decisions**: ADR-030 (Fargate workload), ADR-024 (three-stack split precedent — superseded for v2 infra topology).
  - **Key files**: `web/app/api/{health,stream,db,jobs}/route.ts`, `web/app/api/jobs/[id]/route.ts`, `web/lib/db.ts`, `web/Dockerfile`, `terraform/foundation/workload.tf`, `terraform/foundation/ecr.tf`, `scripts/v2/deploy.mjs`.
  - **Status**: P1d ✅ GREEN.
  - **Learnings & gotchas**: **set `HOSTNAME=0.0.0.0` as a runtime env** in the task def (an image ENV is overwritten by ECS with the ENI IP → standalone binds only the ENI IP → 127.0.0.1 healthcheck fails); container + target-group health path must both be `/api/health`; ECS `secrets` needs execution-role perms (not task role); `web/` was previously a Docusaurus guide site → relocated to `docs-site/` before the v2 web went in (always `ls` a dir before declaring it "new").
  - **Source**: archived `2026-05-31-awsops-v2-p1d-web-cicd-auth.md`; `docs/reviews/v2-p1d-readiness-architecture-review.md`.

- [ ] **Step 3: Verify** — `DOC=docs/superpowers/reference/04-web-bff.md`; run helper. Expected: no output.

- [ ] **Step 4: Commit**
```bash
git add docs/superpowers/reference/04-web-bff.md
git commit -m "docs(v2-ref): web thin-BFF reference (P1d)"
```

---

## Task 5: AgentCore reference (`05-agentcore.md`)

**Files:**
- Create: `docs/superpowers/reference/05-agentcore.md`
- Read sources: `docs/superpowers/plans/2026-05-31-awsops-v2-p1f-agentcore-provisioner.md`, `docs/superpowers/specs/2026-05-31-custom-agents-skills-design.md`, `docs/superpowers/plans/2026-05-31-adr-031-phase1.md`, `terraform/foundation/ai.tf`, `scripts/v2/agentcore/{catalog,provision}.py`, `docs/decisions/031-runtime-customizable-agents-skills.md`

- [ ] **Step 1: Read sources.**

- [ ] **Step 2: Write `05-agentcore.md`** using the template. Must include:
  - **Current design**: AgentCore Runtime (Strands, reuses `agent/agent.py` with `GATEWAYS_JSON` env routing) + **9 section gateways** `awsops-v2-{network,container,data,security,cost,monitoring,iac,ops,external-obs}-gateway` + Memory `awsops_v2_memory-*` + Code Interpreter `awsops_v2_code_interpreter-*`. **Design target: 9 section agents + 1 incident orchestrator** (replaces v1's 8 Gateways). **Currently deployed: 2 read-only target slices** (iam-mcp 14 tools → security, flow-monitor 1 tool → network); full Lambda fleet is P3. Idempotent provisioner `scripts/v2/agentcore/{catalog.py,provision.py}` (boto3 list→create/update); `make agentcore` (arm64 image build → push → provision; `--smoke` to invoke). All gated by `agentcore_enabled`. **Config source of truth = SSM** `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}` (web BFF reads at runtime; no valueFrom).
  - **Decisions**: ADR-031 (runtime-customizable agents & skills), ADR-004 (gateway role split — note 7→8 correction), ADR-002 / ADR-025 (AI routing & multi-route synthesis).
  - **Key files**: `terraform/foundation/ai.tf`, `scripts/v2/agentcore.mjs`, `scripts/v2/agentcore/catalog.py`, `scripts/v2/agentcore/provision.py`, `agent/agent.py`, `agent/lambda/`.
  - **Status**: P1f ✅ A7 GREEN — provision 0 errors, smoke OK (runtime → security gw → `list_roles` → real IAM data), idempotent re-run (EXISTS + Runtime UPDATED), drift re-run = `update_gateway_target`.
  - **Learnings & gotchas**: SSM rejects an `aws…` prefix (reserved) → use `/ops/${project}/…`; a just-created gateway not yet READY makes the first `create_gateway_target` throw ValidationException → resolved by re-running (provisioner is idempotent/re-runnable); Code Interpreter & Memory names are underscores-only; Memory `eventExpiryDuration` ≤ 365; Runtime update must re-pass `roleArn` + `networkConfiguration`; gateways renamed `awsops-{key}` → `awsops-v2-{key}-gateway` to avoid collisions in the shared account.
  - **P3 backlog (do not implement here)**: full Lambda fleet + section=routing + right-dock chat UI + OpenCost install button (ADR-029 mutating action on the P2 worker backbone).
  - **Source**: archived `2026-05-31-awsops-v2-p1f-agentcore-provisioner.md`, `2026-05-31-custom-agents-skills-design.md`, `2026-05-31-adr-031-phase1.md`; `docs/reviews/v2-p1f-scope-architecture-review.md`.

- [ ] **Step 3: Verify** — `DOC=docs/superpowers/reference/05-agentcore.md`; run helper (note: `agent/lambda/` is a dir — the helper's dir check covers it). Expected: no output.

- [ ] **Step 4: Commit**
```bash
git add docs/superpowers/reference/05-agentcore.md
git commit -m "docs(v2-ref): AgentCore reference (P1f + ADR-031)"
```

---

## Task 6: Async workers reference (`06-workers.md`)

**Files:**
- Create: `docs/superpowers/reference/06-workers.md`
- Read sources: `docs/superpowers/specs/2026-06-02-awsops-v2-p2-async-worker-backbone-design.md`, `docs/superpowers/plans/2026-06-02-awsops-v2-p2-async-worker-backbone.md`, `terraform/foundation/workers.tf`, `scripts/v2/workers/` (all files), `web/app/api/jobs/route.ts`, `web/app/api/jobs/[id]/route.ts`

- [ ] **Step 1: Read sources.**

- [ ] **Step 2: Write `06-workers.md`** using the template. Must include:
  - **Current design**: web `POST /api/jobs` → insert `worker_jobs` row (queued) + SQS send → **ESM (= kill-switch)** → dispatcher Lambda (no VPC, idempotent on `job_id`) → **Step Functions Standard**, `Choice` on `$.runtime` → `RunLambda` (short) **or** `ecs:runTask.sync` Fargate (long/OOM) → worker claims running + writes succeeded itself → on any `Catch`, status_updater Lambda sets failed (**SFN cannot write VPC Aurora**) → JobFailed. reaper (EventBridge 5 min) reconciles stale rows. **All gated by `workers_enabled`** (default false → `terraform plan` = No changes, $0).
  - **Decisions**: ADR-029 (mutating-action framework — workers execute the gated mutating ops), ADR-030 (Aurora `worker_jobs`).
  - **Key files**: `terraform/foundation/workers.tf`; `scripts/v2/workers/db.py`, `dispatcher.py`, `handlers.py`, `reaper.py`, `status_updater.py`, `worker_lambda.py`, `fargate_worker.py`, `sfn.asl.json`; `web/app/api/jobs/route.ts`, `web/app/api/jobs/[id]/route.ts`, `web/lib/db.ts`; `scripts/v2/workers.mjs`.
  - **Status**: P2 ✅ W9 GREEN — 5/5 (Lambda noop, Fargate noop-heavy, OOM via SFN→exit137→failed with web unaffected, kill-switch, idempotency); outputs `jobs_queue_url`, `workers_state_machine_arn`, `dispatcher_esm_uuid`, `worker_ecr_uri`.
  - **Learnings & gotchas**: Fargate worker Dockerfile must use **`CMD` (not exec-form ENTRYPOINT)** — SFN `containerOverrides.command` replaces CMD but is appended to ENTRYPOINT → argv doubles → argparse dies; SQS ESM disable has ~1–2 min poller-drain latency (kill-switch test must wait ~120 s); `pg8000` vendored as a Lambda **layer** (pure-python, arch-agnostic); reuse `aws_security_group.service` for worker lambdas+Fargate (Aurora SG already allows it); ESM `lifecycle{ignore_changes=[enabled]}` so an out-of-band pause survives applies; reaper `RUNNING_STALE_MIN` (75) must exceed the Fargate SFN `TimeoutSeconds` (3600 s); SFN `.sync` shows RUNNING briefly after the worker already wrote succeeded — the `worker_jobs` ledger is the source of truth.
  - **Source**: archived `2026-06-02-awsops-v2-p2-async-worker-backbone-design.md` + `2026-06-02-awsops-v2-p2-async-worker-backbone.md`.

- [ ] **Step 3: Verify** — `DOC=docs/superpowers/reference/06-workers.md`; run helper. For the `scripts/v2/workers/*.py` paths, confirm the dir: `ls scripts/v2/workers/`. Expected: no missing output.

- [ ] **Step 4: Commit**
```bash
git add docs/superpowers/reference/06-workers.md
git commit -m "docs(v2-ref): async workers reference (P2)"
```

---

## Task 7: EKS onboarding reference (`07-eks.md`)

**Files:**
- Create: `docs/superpowers/reference/07-eks.md`
- Read sources: `docs/superpowers/plans/2026-05-31-awsops-v2-p1e-eks-onboarding.md`, `terraform/foundation/eks.tf`, `scripts/v2/configure.mjs`

- [ ] **Step 1: Read sources.**

- [ ] **Step 2: Write `07-eks.md`** using the template. Must include:
  - **Current design**: `scripts/v2/configure.mjs` offers an EKS multi-select (`eks:ListClusters` + auth-mode preflight) → writes `onboard_eks_clusters` to tfvars. `terraform/foundation/eks.tf` does `for_each onboard_eks_clusters` → grants the web task role (`awsops-v2-task`) an **Access Entry + AmazonEKSViewPolicy** (cluster scope) + task-role IAM `eks:DescribeCluster/ListClusters/DescribeAccessEntry` + an `onboarded_eks_clusters` output (endpoint/CA, for P3 kubeconfig). Host-account only.
  - **Decisions**: no dedicated ADR (gap — onboarding inherits ADR-008 multi-account model but is host-only); kubeconfig auto-registration / query UI deferred to P3.
  - **Key files**: `terraform/foundation/eks.tf`, `scripts/v2/configure.mjs`.
  - **Status**: P1e ✅ — `fsi-demo-cluster` onboarded and verified (access entry = `awsops-v2-task`, View policy, output endpoint/CA). Host clusters are all `API_AND_CONFIG_MAP`.
  - **Learnings & gotchas**: OpenCost install excluded → P3 (becomes a UI button = ADR-029 mutating action on the P2 worker backbone, not raw Lambda); multi-account excluded (host only); web code consumes the `onboarded_eks_clusters` output in P3, not here.
  - **Source**: archived `2026-05-31-awsops-v2-p1e-eks-onboarding.md`.

- [ ] **Step 3: Verify** — `DOC=docs/superpowers/reference/07-eks.md`; run helper. Expected: no output.

- [ ] **Step 4: Commit**
```bash
git add docs/superpowers/reference/07-eks.md
git commit -m "docs(v2-ref): EKS onboarding reference (P1e)"
```

---

## Task 8: README index (`reference/README.md`)

**Files:**
- Create: `docs/superpowers/reference/README.md`
- Read sources: `docs/superpowers/specs/2026-05-30-awsops-v2-architecture-design.md` (master overview), the 7 reference docs from Tasks 1–7, root `CLAUDE.md` (status table)

- [ ] **Step 1: Read** the master architecture spec + the 7 reference docs (so links/titles match exactly).

- [ ] **Step 2: Write `reference/README.md`** containing:
  - One-paragraph v2 overview (Terraform MSA; private edge; Aurora; AgentCore agents; async workers).
  - **Request flow** (mermaid):
    ```mermaid
    flowchart LR
      U[User] --> CF[CloudFront TLS]
      CF --> VO[VPC Origin https-only:443]
      VO --> ALB[internal ALB HTTPS:443]
      ALB --> W[Fargate web :3000]
      W --> A[(Aurora node-pg)]
      W --> Q[SQS] --> WK[async workers SFN+Lambda/Fargate]
      W --> AC[AgentCore SSM-configured]
    ```
  - **Component table**: | Component | Reference | Governing ADRs | Key files | Status | — one row per `01`–`07` with relative links (e.g. `[Edge](../reference/01-edge-network.md)`), the ADR numbers from each doc's Decisions section, the primary `.tf`/dir, and status (P1a–P2 ✅, P3/P4 🔜).
  - **Phase status**: P1a–P1f ✅, P2 ✅ (W9 GREEN), P3 🔜 (9+1 agents + right-dock UI + OpenCost button), P4 🔜 (incident/ChatOps + DevOps Agent federation).
  - Pointer: "Execution history for each phase lives in `../archive/` (see its README)."

- [ ] **Step 3: Verify** — links resolve and table covers all 7:
```bash
cd docs/superpowers/reference
for n in 01-edge-network 02-auth 03-data-aurora 04-web-bff 05-agentcore 06-workers 07-eks; do
  grep -q "$n.md" README.md || echo "README missing link: $n"
  test -f "$n.md" || echo "missing doc: $n.md"
done
```
Expected: no output.

- [ ] **Step 4: Commit**
```bash
git add docs/superpowers/reference/README.md
git commit -m "docs(v2-ref): README index — request flow + component map"
```

---

## Task 9: Archive the originals (`archive/` + mapping README)

**Files:**
- Create: `docs/superpowers/archive/README.md`
- Move (git mv): 3 v2 specs + 8 v2 plans → `docs/superpowers/archive/`

- [ ] **Step 1: Create archive dir and move the 11 v2 docs**
```bash
cd /home/atomoh/awsops
mkdir -p docs/superpowers/archive
git mv docs/superpowers/specs/2026-05-30-awsops-v2-architecture-design.md docs/superpowers/archive/
git mv docs/superpowers/specs/2026-05-31-custom-agents-skills-design.md docs/superpowers/archive/
git mv docs/superpowers/specs/2026-06-02-awsops-v2-p2-async-worker-backbone-design.md docs/superpowers/archive/
git mv docs/superpowers/plans/2026-05-30-awsops-v2-p1a-foundation-edge-spine.md docs/superpowers/archive/
git mv docs/superpowers/plans/2026-05-31-awsops-v2-p1b-cognito-edge-auth.md docs/superpowers/archive/
git mv docs/superpowers/plans/2026-05-31-awsops-v2-p1c-aurora.md docs/superpowers/archive/
git mv docs/superpowers/plans/2026-05-31-awsops-v2-p1d-web-cicd-auth.md docs/superpowers/archive/
git mv docs/superpowers/plans/2026-05-31-awsops-v2-p1e-eks-onboarding.md docs/superpowers/archive/
git mv docs/superpowers/plans/2026-05-31-awsops-v2-p1f-agentcore-provisioner.md docs/superpowers/archive/
git mv docs/superpowers/plans/2026-05-31-adr-031-phase1.md docs/superpowers/archive/
git mv docs/superpowers/plans/2026-06-02-awsops-v2-p2-async-worker-backbone.md docs/superpowers/archive/
```

- [ ] **Step 2: Verify the move** — exactly the v1 docs remain in specs/plans, 11 in archive:
```bash
echo "specs remaining:"; ls docs/superpowers/specs/   # expect only: 2026-03-16-container-cost-design.md + this consolidation spec
echo "plans remaining:"; ls docs/superpowers/plans/   # expect only: 2026-03-16-container-cost-phase1.md + this consolidation plan
echo "archived ($(ls docs/superpowers/archive/*.md | wc -l) expect 11):"; ls docs/superpowers/archive/
```
Expected: no v2-named file left in specs/plans (other than the 2026-06-03 consolidation spec & this plan); 11 in archive.

- [ ] **Step 3: Write `archive/README.md`** — state these are historical execution artifacts **superseded by `../reference/`**, with an original → reference map:
  - `2026-05-30-awsops-v2-architecture-design.md` → `reference/README.md`
  - `…-p1a-foundation-edge-spine.md` → `reference/01-edge-network.md`
  - `…-p1b-cognito-edge-auth.md` → `reference/02-auth.md`
  - `…-p1c-aurora.md` → `reference/03-data-aurora.md`
  - `…-p1d-web-cicd-auth.md` → `reference/04-web-bff.md` (+ auth → `02-auth.md`)
  - `…-p1f-agentcore-provisioner.md`, `…-custom-agents-skills-design.md`, `…-adr-031-phase1.md` → `reference/05-agentcore.md`
  - `…-p2-async-worker-backbone-design.md`, `…-p2-async-worker-backbone.md` → `reference/06-workers.md`
  - `…-p1e-eks-onboarding.md` → `reference/07-eks.md`

- [ ] **Step 4: Commit**
```bash
git add -A docs/superpowers/archive/ docs/superpowers/specs/ docs/superpowers/plans/
git commit -m "docs(v2-ref): archive 11 dated v2 specs/plans (superseded by reference/)"
```

---

## Task 10: Wire up the docs index (`docs/CLAUDE.md`)

**Files:**
- Modify: `docs/CLAUDE.md` (the Structure table)

- [ ] **Step 1: Read** `docs/CLAUDE.md` and locate the "구조 / Structure" table.

- [ ] **Step 2: Add two rows** to the Structure table (after the `decisions/` row):
```markdown
| [superpowers/reference/](superpowers/reference/) | v2 컴포넌트별 현행 설계 레퍼런스 (single source per component) |
| [superpowers/archive/](superpowers/archive/) | v2 설계문서 실행 이력 (reference/로 대체됨) |
```

- [ ] **Step 3: Verify**
```bash
grep -q "superpowers/reference/" docs/CLAUDE.md && grep -q "superpowers/archive/" docs/CLAUDE.md && echo OK
```
Expected: `OK`.

- [ ] **Step 4: Commit**
```bash
git add docs/CLAUDE.md
git commit -m "docs(v2-ref): point docs index at reference/ + archive/"
```

---

## Final verification (after all tasks)

- [ ] **All 8 reference files exist + 11 archived:**
```bash
ls docs/superpowers/reference/   # README + 01..07 = 8 files
ls docs/superpowers/archive/*.md | wc -l   # 11
```
- [ ] **No cited repo path is broken across all reference docs:**
```bash
for DOC in docs/superpowers/reference/*.md; do
  grep -oE '`(terraform|scripts/v2|web|agent)[^`]*`' "$DOC" | tr -d '`' | sed 's/[:#].*//; s#/\*.*##' | while read p; do
    [ -e "$p" ] || echo "$DOC → MISSING: $p"
  done
done
```
Expected: no output.
- [ ] **ADRs untouched:** `git diff --name-only origin/main...HEAD -- docs/decisions/ | grep -v 'CLAUDE.md\|0[0-9][0-9]-' ; echo "(only prior ADR correction commits, none from this plan)"` — this plan creates zero changes under `docs/decisions/`.

---

## Notes for the executor
- **Docs-only — no code, no terraform, no deploy.** Safe to run inline or via subagents; no infra risk.
- **Do not invent facts.** If something isn't in the named source plan / root `CLAUDE.md` / cited ADR, omit it rather than guessing.
- **Commit per task** (small units — this repo has concurrent sessions that switch branches; uncommitted work can be lost).
- Tasks 1–7 are independent (one component each) → ideal for parallel subagents. Task 8 (README) depends on 1–7. Task 9 (archive) must run after 1–8 (content extracted first). Task 10 last.
