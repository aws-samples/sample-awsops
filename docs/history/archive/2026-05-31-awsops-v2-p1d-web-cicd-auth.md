# AWSops v2 — P1d: Real Next.js Web (thin-BFF) + CI/CD + Auth Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (auto plan+apply). Steps use checkbox (`- [ ]`).

**Goal:** Replace the placeholder `spine/server.js` with a **real Next.js 14 standalone web image** (thin-BFF: UI + light `/api/*`), wire **Aurora secret** into ECS, ship a **`make deploy`** loop to **dual-tier ECR** (dev-private + prod-public), and **harden the Lambda@Edge auth** (JWKS RS256 signature verification + OAuth `state` + PKCE/public-client so the client secret leaves the edge code).

**Architecture:** Next.js App Router served at root `/` (no basePath) on ECS Fargate (arm64) behind the existing GREEN edge (CloudFront VPC Origin → internal ALB TLS → Fargate). The web tier stays light: SSR + a thin `/api/*` layer (`/api/health`, `/api/stream` SSE, `/api/db` Aurora ping). All heavy/async work is deferred to P2 (SQS+SFN+workers) / P3 (AgentCore). `make deploy` builds arm64 locally on the in-VPC deploy host, pushes to ECR, force-deploys ECS, waits stable, and smoke-tests. Auth moves to a public client + PKCE so no client secret is compiled into the edge function, and the edge function cryptographically verifies the Cognito ID token (RS256 via JWKS) instead of trusting `exp` only.

**Tech Stack:** Next.js 14.2.x (App Router, `output: 'standalone'`), Node 20 (alpine, arm64), `pg`, Terraform `>= 1.15` + AWS provider `~> 6.0` (+ `aws.use1` for ECR Public + Lambda@Edge), ECS Fargate, Secrets Manager (RDS-managed), Lambda@Edge (python3.12, pure-python RS256 — no extra deps, 1 MB viewer-request limit).

**Builds on P1a–P1c:** `terraform/foundation/` (network locals, edge, Aurora `aws_rds_cluster.aurora` + `aws_kms_key.aurora` + `master_user_secret`, `aws_security_group.{alb,service,aurora}`, `aws_ecs_*`, `aws_lambda_function.edge`). The in-VPC deploy host (mgmt-vpc) runs the build; **`docker` needs `sudo`** (user not in the docker group). v1 standalone Dockerfile (`./Dockerfile`) is the proven pattern.

**Review-driven hard requirements (from the 3-AI cross review, `docs/reviews/v2-p1d-readiness-architecture-review.md`):**
- **Blocker A** — secret injection uses ECS `secrets`(`valueFrom`) ⇒ the **execution role** (not task role) needs `secretsmanager:GetSecretValue` + `kms:Decrypt`, else `ResourceInitializationError`. (Task D3)
- **Blocker B** — container + target-group health checks are `/healthz`; the new app exposes `/api/health` ⇒ **unify the health path** or the task fails health checks and circuit-breaker-loops. (Task D3)
- **CRITICAL** — Lambda@Edge verifies `exp` only ⇒ verify **RS256 via JWKS** + `iss`/`aud`/`token_use`. (Task D4)
- **HIGH** — no OAuth `state` ⇒ login CSRF; **client_secret rendered into edge code** ⇒ move to **PKCE/public client**. (Task D4)
- **MEDIUM** — ALB SG full VPC-CIDR :443 and Aurora SG full VPC-CIDR :5432 over-broad; `/_next/static/*` runs the auth Lambda every request. (Tasks D3/D4)

---

## File Structure

```
web/                                  # NEW — v2 thin-BFF Next.js app (replaces spine/)
  package.json                        # next 14.2.35, react 18, pg
  next.config.mjs                     # output:standalone, NO basePath
  tsconfig.json
  .dockerignore
  Dockerfile                          # multi-stage standalone arm64 (v1 pattern)
  public/.gitkeep                     # standalone COPY needs public/
  app/layout.tsx                      # navy theme shell
  app/page.tsx                        # landing (server component) + live status
  app/api/health/route.ts            # GET -> {status:ok} (public; smoke target)
  app/api/stream/route.ts            # GET -> SSE, heartbeat 15s (<=20s)
  app/api/db/route.ts                # GET -> Aurora ping via pg

scripts/v2/deploy.mjs                 # NEW — build arm64 -> ECR -> ECS -> wait -> smoke
Makefile                              # MODIFY — add `deploy` target

terraform/foundation/
  ecr.tf                              # NEW — web dev-private repo + prod-public (us-east-1)
  workload.tf                         # MODIFY — spine->web rename, image, /api/health, exec-role secret policy, secrets injection, ALB SG min, moved{}
  data.tf                             # MODIFY — gate Aurora VPC-CIDR :5432 behind a var
  variables.tf                        # MODIFY — image_tag default web-latest, allow_vpc_db_access
  outputs.tf                          # MODIFY — ecr_web_uri, ecr_public_uri, ecs_cluster_name, ecs_service_name
  auth.tf                             # MODIFY — public client (generate_secret=false), template vars (user_pool_id, region)
  edge-lambda/cognito_edge.py.tftpl   # REWRITE — JWKS RS256 + state + PKCE + public-path bypass
```

After cutover, `spine/` is deleted (Task D5). **Prereq (Task D0):** `web/` currently holds the Docusaurus guide site → relocated to `docs-site/` first so the v2 app can use `web/`.

---

## Task D0: relocate Docusaurus guide site (web/ → docs-site/)

**Why:** `web/` is already a tracked Docusaurus docs site (v1 user guide, 322 files, deployed by `.github/workflows/deploy-guide.yml` and wired into the guide-sync hooks/skill). The plan's D1–D5 use `web/` for the v2 Next.js app, so the guide site must move first. (Discovered during execution — the directory wasn't inspected at plan time.)

**Files:** `git mv web docs-site`; Modify `.github/workflows/deploy-guide.yml`, root `.dockerignore`, `.claude/hooks/{check-guide-i18n-sync,check-menu-guide-sync,accumulate-pending-guides}.sh`, `.claude/skills/sync-guides/SKILL.md`, `tests/hooks/test-hook-behavior.sh`.

- [ ] **Step 1: move the directory** — `git mv web docs-site`
- [ ] **Step 2: `.github/workflows/deploy-guide.yml`** — `paths: ['web/**']`→`['docs-site/**']`, `working-directory: web`→`docs-site`, `cache-dependency-path: web/package-lock.json`→`docs-site/package-lock.json`, `path: web/build`→`docs-site/build`
- [ ] **Step 3: root `.dockerignore`** — change the `web/` line to `docs-site/` AND add a new `web/` line (v1 root build then excludes BOTH the guide site and the future v2 app)
- [ ] **Step 4: hooks + skill + test** — replace `web/docs`→`docs-site/docs`, `web/i18n`→`docs-site/i18n`, `web/sidebars.ts`→`docs-site/sidebars.ts`, `web/src`→`docs-site/src` across `.claude/hooks/check-guide-i18n-sync.sh`, `.claude/hooks/check-menu-guide-sync.sh`, `.claude/hooks/accumulate-pending-guides.sh`, `.claude/skills/sync-guides/SKILL.md`, `tests/hooks/test-hook-behavior.sh`
- [ ] **Step 5: verify** — `git grep -nE "web/(docs|i18n|sidebars|src|build|package-lock)" -- ':(exclude)docs-site/' ':(exclude)docs/superpowers/plans/'` returns nothing; `web/` no longer exists; `docs-site/docusaurus.config.ts` exists
- [ ] **Step 6: commit** — `chore(v2-p1d): relocate Docusaurus guide site web/ -> docs-site/ (free web/ for v2 app)`

---

## Task D1: v2 web skeleton (real Next.js 14, thin-BFF)

**Files:** Create everything under `web/`.

- [ ] **Step 1: `web/package.json`**
```json
{
  "name": "awsops-web",
  "version": "2.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "14.2.35",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "pg": "8.13.1"
  },
  "devDependencies": {
    "typescript": "5.6.3",
    "@types/node": "20.16.5",
    "@types/react": "18.3.8",
    "@types/react-dom": "18.3.0",
    "@types/pg": "8.11.10"
  }
}
```

- [ ] **Step 2: `web/next.config.mjs`** (NO basePath — v2 serves at root)
```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
};
export default nextConfig;
```

- [ ] **Step 3: `web/tsconfig.json`**
```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: `web/.dockerignore`**
```
node_modules
.next
.git
npm-debug.log
```

- [ ] **Step 5: `web/public/.gitkeep`** (standalone Dockerfile COPYs `public/`)
```
```
(empty file)

- [ ] **Step 6: `web/app/layout.tsx`** (navy theme shell)
```tsx
import type { ReactNode } from 'react';

export const metadata = {
  title: 'AWSops v2',
  description: 'AWSops v2 — thin-BFF web tier',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          background: '#0a0e1a',
          color: '#e2e8f0',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 7: `web/app/page.tsx`** (landing + live status; server component, no data deps so it renders even if Aurora is down)
```tsx
export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '64px 24px' }}>
      <h1 style={{ color: '#00d4ff', fontSize: 40, margin: 0 }}>AWSops v2</h1>
      <p style={{ color: '#94a3b8', marginTop: 8 }}>
        thin-BFF web tier — Next.js 14 standalone on ECS Fargate (arm64), behind CloudFront VPC Origin → internal ALB.
      </p>
      <ul style={{ marginTop: 32, lineHeight: 2 }}>
        <li>
          <a style={{ color: '#00ff88' }} href="/api/health">/api/health</a> — liveness
        </li>
        <li>
          <a style={{ color: '#00ff88' }} href="/api/stream">/api/stream</a> — SSE (heartbeat ≤20s)
        </li>
        <li>
          <a style={{ color: '#00ff88' }} href="/api/db">/api/db</a> — Aurora connectivity
        </li>
      </ul>
      <p style={{ color: '#64748b', marginTop: 48, fontSize: 13 }}>
        Heavy/async work (AI, reports, scans) runs in the P2 worker tier — not here.
      </p>
    </main>
  );
}
```

- [ ] **Step 8: `web/app/api/health/route.ts`** (public liveness — also the deploy smoke target)
```ts
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'awsops-web',
    ts: new Date().toISOString(),
  });
}
```

- [ ] **Step 9: `web/app/api/stream/route.ts`** (SSE — heartbeat 15s, comfortably under CloudFront `origin_read_timeout=60` and the ≤20s requirement)
```ts
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let n = 0;
      const send = (data: string) => controller.enqueue(encoder.encode(data));
      send(': connected\n\n'); // comment line opens the stream immediately
      send(`data: ${JSON.stringify({ tick: ++n, ts: Date.now() })}\n\n`);
      const timer = setInterval(() => {
        send(`data: ${JSON.stringify({ tick: ++n, ts: Date.now() })}\n\n`);
      }, 15000);
      const close = () => {
        clearInterval(timer);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener('abort', close);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 10: `web/app/api/db/route.ts`** (Aurora ping — proves the secret wiring from D3)
```ts
import { NextResponse } from 'next/server';
import { Pool } from 'pg';

export const dynamic = 'force-dynamic';

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.AURORA_ENDPOINT,
      port: 5432,
      database: process.env.AURORA_DATABASE || 'awsops',
      user: process.env.AURORA_USER,
      password: process.env.AURORA_PASSWORD,
      ssl: { rejectUnauthorized: false }, // RDS CA not bundled in P1d; tighten later
      max: 3,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    });
  }
  return pool;
}

export async function GET() {
  if (!process.env.AURORA_ENDPOINT) {
    return NextResponse.json({ status: 'unconfigured', message: 'AURORA_ENDPOINT not set' }, { status: 503 });
  }
  try {
    const r = await getPool().query(
      "SELECT count(*)::int AS public_tables FROM pg_tables WHERE schemaname = 'public'",
    );
    return NextResponse.json({
      status: 'ok',
      database: process.env.AURORA_DATABASE || 'awsops',
      public_tables: r.rows[0].public_tables,
    });
  } catch (e) {
    return NextResponse.json(
      { status: 'error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 11: `web/Dockerfile`** (multi-stage standalone, arm64 — v1 pattern; `web/` build context)
```dockerfile
# Stage 1: build Next.js standalone output
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --prefer-offline --no-audit || npm install
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 2: minimal runtime
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 12: install deps + verify the build locally** (node 20 present; no docker needed)
```bash
cd web && npm install && npm run build
```
Expected: `✓ Compiled successfully`, a `Route (app)` table listing `/`, `/api/health`, `/api/stream`, `/api/db`, and `.next/standalone/server.js` emitted. Fix any type/build error before committing. Then `cd ..`.

- [ ] **Step 13: commit**
```bash
cd /home/atomoh/awsops
git add web/ && git add -f web/public/.gitkeep
git commit -m "feat(v2-p1d): real Next.js 14 thin-BFF web skeleton (root path, /api/{health,stream,db})"
```

---

## Task D2: dual-tier ECR + `make deploy` + first web image push

**Files:** Create `terraform/foundation/ecr.tf`, `scripts/v2/deploy.mjs`; Modify `Makefile`, `variables.tf`, `outputs.tf`.

- [ ] **Step 1: `terraform/foundation/ecr.tf`** (dev-private `web` repo + prod-public ECR Public in us-east-1; the old `aws_ecr_repository.spine` in `workload.tf` stays until D3 cutover)
```hcl
resource "aws_ecr_repository" "web" {
  name                 = "${var.project}-web"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  force_delete = true
}

# Prod-public image distribution (OSS). ECR Public is us-east-1 only.
resource "aws_ecrpublic_repository" "web" {
  provider        = aws.use1
  repository_name = "${var.project}-web"
  catalog_data {
    about_text    = "AWSops v2 web tier (Next.js thin-BFF on Fargate)."
    architectures = ["ARM 64"]
    description   = "AWSops v2 dashboard web image."
  }
}
```

- [ ] **Step 2: add ECR outputs to `outputs.tf`** (ECS outputs are added in D3 — `aws_ecs_service.web` doesn't exist yet)
```hcl
output "ecr_web_uri"    { value = aws_ecr_repository.web.repository_url }
output "ecr_public_uri" { value = aws_ecrpublic_repository.web.repository_uri }
```

- [ ] **Step 3 — DEFERRED TO D3 (do NOT modify `variables.tf` here):** Setting `image_tag` to `web-latest` now would make the still-live `spine` task definition reference a nonexistent tag and break on the next ECS reconcile. The `image_tag` + `allow_vpc_db_access` variable changes happen in **D3 Step 0**, alongside the cutover.

- [ ] **Step 4: validate + apply ECR only**
```bash
cd terraform/foundation
terraform fmt && terraform validate
terraform plan -out tfplan   # inspect: MUST be only the 2 ECR repos + 2 outputs; NO ECS/ALB/spine/edge changes
terraform apply tfplan
```
Expected: creates ONLY `aws_ecr_repository.web` + `aws_ecrpublic_repository.web`. NO changes to ECS/ALB/edge/spine. `terraform output ecr_web_uri` prints a URL.

- [ ] **Step 5: `scripts/v2/deploy.mjs`** (build arm64 → push → force-deploy → wait → smoke; `sudo docker` by default per the deploy host)
```js
#!/usr/bin/env node
// AWSops v2 deploy: build arm64 -> push ECR -> ECS force-new-deployment -> wait stable -> smoke.
import { execSync } from 'node:child_process';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const CHDIR = 'terraform/foundation';
const TAG = process.env.IMAGE_TAG || 'web-latest';
const DOCKER = process.env.DOCKER || 'sudo docker';

const tf = (out) => execSync(`terraform -chdir=${CHDIR} output -raw ${out}`, { encoding: 'utf8' }).trim();
const sh = (cmd) => execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });

const repo = tf('ecr_web_uri');
const registry = repo.split('/')[0];
const cluster = tf('ecs_cluster_name');
const service = tf('ecs_service_name');
const url = tf('public_url');

console.log(`\n[1/5] ECR login -> ${registry}`);
sh(`aws ecr get-login-password --region ${REGION} | ${DOCKER} login --username AWS --password-stdin ${registry}`);

console.log(`\n[2/5] build + push arm64 -> ${repo}:${TAG}`);
sh(`${DOCKER} buildx build --platform linux/arm64 -t ${repo}:${TAG} --push web/`);

console.log(`\n[3/5] ECS force-new-deployment -> ${cluster}/${service}`);
sh(`aws ecs update-service --cluster ${cluster} --service ${service} --force-new-deployment --region ${REGION} >/dev/null`);

console.log(`\n[4/5] wait services-stable (may take a few minutes)`);
sh(`aws ecs wait services-stable --cluster ${cluster} --services ${service} --region ${REGION}`);

console.log(`\n[5/5] smoke -> ${url}/api/health`);
sh(`curl -fsS --max-time 15 ${url}/api/health && echo`);

console.log('\n✅ deploy complete');
```

- [ ] **Step 6: add the `deploy` target to `Makefile`**
```makefile
deploy: ## Build arm64, push to ECR, roll ECS, wait stable, smoke /api/health
	@node scripts/v2/deploy.mjs
```
(Also add `deploy` to the `.PHONY` line.)

- [ ] **Step 7: push the FIRST web image** (ECS is still `spine`; this only loads the image so D3's cutover apply has something to pull)
```bash
cd /home/atomoh/awsops
REGION=ap-northeast-2
REPO=$(terraform -chdir=terraform/foundation output -raw ecr_web_uri)
aws ecr get-login-password --region $REGION | sudo docker login --username AWS --password-stdin ${REPO%/*}
sudo docker buildx build --platform linux/arm64 -t $REPO:web-latest --push web/
aws ecr describe-images --repository-name awsops-v2-web --region $REGION --query 'imageDetails[].imageTags' --output text
```
Expected: image pushed; `web-latest` tag listed.

- [ ] **Step 8: commit**
```bash
git add terraform/foundation/ecr.tf terraform/foundation/outputs.tf terraform/foundation/variables.tf scripts/v2/deploy.mjs Makefile
git commit -m "feat(v2-p1d): dual-tier ECR (dev-private + prod-public) + make deploy + first web image"
```

---

## Task D3: cutover spine → web (rename + Aurora secret wiring + health path + SG min)

**Files:** Modify `terraform/foundation/variables.tf`, `workload.tf`, `data.tf`, `outputs.tf`.

> This is the apply that swaps the running service to the real Next.js image. The first web image already exists in ECR (D2), so the new task can pull and pass health checks. `moved {}` blocks preserve state where names are stable; name-changing resources recreate once (brief, the image is throwaway/idempotent).

- [ ] **Step 0: `variables.tf` — point `image_tag` at the web image + add the DB-access gate** (deferred from D2 so the live spine task def wasn't broken early)
```hcl
# (MODIFY existing image_tag default)
variable "image_tag" {
  type        = string
  description = "Web image tag in ECR"
  default     = "web-latest"
}

# (ADD) dev convenience: allow the in-VPC deploy host to reach Aurora on 5432 for
# psql migrations. Set false in prod to drop the broad VPC-CIDR ingress (review #4).
variable "allow_vpc_db_access" {
  type    = bool
  default = true
}
```

- [ ] **Step 1: replace `workload.tf`** (full file — spine→web everywhere; delete the old `aws_ecr_repository.spine` since `aws_ecr_repository.web` now lives in `ecr.tf`)
```hcl
resource "aws_ecs_cluster" "main" {
  name = var.project
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.project}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Review Blocker A: ECS `secrets`(valueFrom) is resolved by the EXECUTION role at
# task start — it must be allowed to read the RDS-managed secret + decrypt with the CMK.
resource "aws_iam_role_policy" "execution_secrets" {
  name = "${var.project}-exec-aurora-secret"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [aws_rds_cluster.aurora.master_user_secret[0].secret_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [aws_kms_key.aurora.arn]
      }
    ]
  })
}

resource "aws_iam_role" "task" {
  name               = "${var.project}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${var.project}-web"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.project}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name         = "web"
      image        = "${aws_ecr_repository.web.repository_url}:${var.image_tag}"
      essential    = true
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      environment = [
        { name = "PORT", value = "3000" },
        { name = "AURORA_ENDPOINT", value = aws_rds_cluster.aurora.endpoint },
        { name = "AURORA_DATABASE", value = aws_rds_cluster.aurora.database_name }
      ]
      # RDS-managed secret JSON has username/password keys -> inject as env via the execution role.
      secrets = [
        { name = "AURORA_USER", valueFrom = "${aws_rds_cluster.aurora.master_user_secret[0].secret_arn}:username::" },
        { name = "AURORA_PASSWORD", valueFrom = "${aws_rds_cluster.aurora.master_user_secret[0].secret_arn}:password::" }
      ]
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q -O - http://127.0.0.1:3000/api/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 40
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.web.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "web"
        }
      }
    }
  ])
}

# CloudFront provisions VPC Origin ENIs into a managed SG ("CloudFront-VPCOrigins-Service-SG").
# The ALB allows ONLY that SG on 443 (review #3: dropped the broad VPC-CIDR rule).
data "aws_security_group" "cf_vpc_origin" {
  filter {
    name   = "group-name"
    values = ["CloudFront-VPCOrigins-Service-SG"]
  }
  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

resource "aws_security_group" "alb" {
  name        = "${var.project}-alb-sg"
  description = "Internal ALB - CloudFront VPC Origin ENIs only"
  vpc_id      = local.vpc_id

  ingress {
    description     = "HTTPS from CloudFront VPC Origin managed SG"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [data.aws_security_group.cf_vpc_origin.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "service" {
  name        = "${var.project}-service-sg"
  description = "web Fargate tasks"
  vpc_id      = local.vpc_id

  ingress {
    description     = "ALB to Fargate"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Regional ACM cert for the ALB HTTPS listener (CloudFront VPC Origin connects TLS with SNI=domain).
resource "aws_acm_certificate" "alb" {
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "alb" {
  certificate_arn         = aws_acm_certificate.alb.arn
  validation_record_fqdns = [for r in aws_route53_record.cf_validation : r.fqdn]
}

resource "aws_lb" "internal" {
  name               = "${var.project}-alb"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.private_subnet_ids
  idle_timeout       = 120 # SSE: hold streaming connections (heartbeat is 15s)
}

resource "aws_lb_target_group" "web" {
  name        = "${var.project}-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    path                = "/api/health"
    matcher             = "200-399"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  deregistration_delay = 30
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.alb.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_ecs_service" "web" {
  name            = "${var.project}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]
}

# Only the target group rename needs a moved block: its name ("${var.project}-tg")
# is unchanged, so moving the state address makes the spine->web rename an in-place
# update (just the health-check path changes) instead of a destroy/recreate that
# would collide on the duplicate TG name. Resources whose address does NOT change
# (cluster, SGs, ALB, listener, certs, IAM roles) must NOT get a moved block —
# a same-address `moved` is a hard Terraform error. The log group's NAME changes
# (-spine -> -web) so it recreates regardless; no moved needed there either.
moved {
  from = aws_lb_target_group.spine
  to   = aws_lb_target_group.web
}
```
> The `aws_lb_target_group` keeps `name = "${var.project}-tg"`, so `moved` makes the rename in-place (only the health-check path updates). `aws_cloudwatch_log_group` name changes (`-spine`→`-web`) so it recreates — fine. The old `aws_ecs_service.spine`/`aws_ecs_task_definition.spine`/`aws_ecr_repository.spine` are simply gone from the config → destroyed; the new `aws_ecs_service.web` is created.

- [ ] **Step 2: gate the broad Aurora ingress in `data.tf`** (review #4 — replace the unconditional VPC-CIDR :5432 ingress with a `dynamic` block gated by `allow_vpc_db_access`)

Replace the second `ingress` block of `aws_security_group.aurora` with:
```hcl
  dynamic "ingress" {
    for_each = var.allow_vpc_db_access ? [1] : []
    content {
      description = "In-VPC migration (deploy host) - dev only"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [local.vpc_cidr]
    }
  }
```
(Keep the first `ingress` from `aws_security_group.service` and the `egress`.)

- [ ] **Step 3: add ECS outputs to `outputs.tf`** (now that `aws_ecs_service.web` exists — these feed `make deploy`)
```hcl
output "ecs_cluster_name" { value = aws_ecs_cluster.main.name }
output "ecs_service_name" { value = aws_ecs_service.web.name }
```

- [ ] **Step 4: validate + apply the cutover**
```bash
cd terraform/foundation
terraform fmt && terraform validate
terraform plan -out tfplan
# Review the plan: expect web TG rename in-place, log group/service/taskdef create, spine service/taskdef/ecr destroy,
# ALB SG rule replace (drop VPC-CIDR 443), exec-role secret policy create, Aurora ingress shrink. NO vpc/subnet/nat/edge-cert changes.
terraform apply tfplan
```
Expected: `aws_ecs_service.web` reaches a running task on the `web-latest` image; circuit breaker does NOT roll back (health check `/api/health` passes).

- [ ] **Step 5: verify the running service + DB wiring**
```bash
aws ecs describe-services --cluster awsops-v2 --services awsops-v2-web --region ap-northeast-2 \
  --query 'services[0].{running:runningCount,desired:desiredCount,deploy:deployments[0].rolloutState}'
# target health
TG=$(aws elbv2 describe-target-groups --names awsops-v2-tg --region ap-northeast-2 --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 describe-target-health --target-group-arn "$TG" --region ap-northeast-2 --query 'TargetHealthDescriptions[].TargetHealth.State'
```
Expected: `running:1, deploy:COMPLETED`; target health `["healthy"]`. (Auth is still exp-only here — hardened in D4. The browser path requires login already.)

- [ ] **Step 6: commit**
```bash
cd /home/atomoh/awsops
git add terraform/foundation/workload.tf terraform/foundation/data.tf terraform/foundation/outputs.tf
git commit -m "feat(v2-p1d): cutover spine->web — Aurora secret (exec role), /api/health checks, ALB/Aurora SG min"
```

---

## Task D4: harden Lambda@Edge auth (JWKS RS256 + state + PKCE/public client)

**Files:** Rewrite `terraform/foundation/edge-lambda/cognito_edge.py.tftpl`; Modify `auth.tf`.

> Moves the Cognito client to **public + PKCE** (no client secret in edge code — review HIGH), verifies the ID token **RS256 signature via JWKS** (review CRITICAL), enforces `state` (review HIGH), and **bypasses auth for public paths** `/_next/static/*` and `/api/health` (review #5 + enables the deploy smoke through CloudFront). Pure-python RS256 — no extra deps, stays under the 1 MB viewer-request limit.

- [ ] **Step 1: rewrite `edge-lambda/cognito_edge.py.tftpl`** (full file)
```python
import json, base64, hashlib, hmac, os, time, secrets, urllib.request, urllib.parse

CONFIG = {
    'CLIENT_ID': '${client_id}',
    'COGNITO_DOMAIN': '${cognito_domain}',
    'JWKS_URL': 'https://cognito-idp.${region}.amazonaws.com/${user_pool_id}/.well-known/jwks.json',
    'ISSUER': 'https://cognito-idp.${region}.amazonaws.com/${user_pool_id}',
    'CALLBACK_PATH': '/_callback',
    # HMAC key for signing the short-lived state/PKCE cookie (derived at deploy time).
    'STATE_KEY': '${state_key}',
}

# Public paths skip auth: immutable static assets + the liveness probe (smoke target).
def is_public(uri):
    return uri.startswith('/_next/static/') or uri == '/api/health'

_JWKS = None
def get_jwks():
    global _JWKS
    if _JWKS is None:
        with urllib.request.urlopen(CONFIG['JWKS_URL'], timeout=3) as r:
            _JWKS = json.loads(r.read())
    return _JWKS

def b64url_decode(s):
    s += '=' * (-len(s) % 4)
    return base64.urlsafe_b64decode(s)

def b64url_encode(b):
    return base64.urlsafe_b64encode(b).decode().rstrip('=')

# Pure-python RS256 (RSASSA-PKCS1-v1_5 + SHA-256) verification against the JWKS key.
SHA256_DIGESTINFO = bytes.fromhex('3031300d060960864801650304020105000420')

def verify_rs256(token):
    try:
        h_b64, p_b64, s_b64 = token.split('.')
    except ValueError:
        return None
    header = json.loads(b64url_decode(h_b64))
    if header.get('alg') != 'RS256':
        return None
    kid = header.get('kid')
    key = next((k for k in get_jwks().get('keys', []) if k.get('kid') == kid), None)
    if not key:
        return None
    n = int.from_bytes(b64url_decode(key['n']), 'big')
    e = int.from_bytes(b64url_decode(key['e']), 'big')
    sig = int.from_bytes(b64url_decode(s_b64), 'big')
    k_len = (n.bit_length() + 7) // 8
    em = pow(sig, e, n).to_bytes(k_len, 'big')
    digest = hashlib.sha256((h_b64 + '.' + p_b64).encode()).digest()
    expected = b'\x00\x01' + b'\xff' * (k_len - len(SHA256_DIGESTINFO) - len(digest) - 3) + b'\x00' + SHA256_DIGESTINFO + digest
    if not hmac.compare_digest(em, expected):
        return None
    return json.loads(b64url_decode(p_b64))

def claims_valid(payload):
    now = time.time()
    return (
        payload.get('iss') == CONFIG['ISSUER'] and
        payload.get('aud') == CONFIG['CLIENT_ID'] and
        payload.get('token_use') == 'id' and
        payload.get('exp', 0) > now and
        payload.get('iat', now + 1) <= now + 60 and
        payload.get('nbf', 0) <= now + 60
    )

def sign(value):
    return hmac.new(CONFIG['STATE_KEY'].encode(), value.encode(), hashlib.sha256).hexdigest()

def lambda_handler(event, context):
    request = event['Records'][0]['cf']['request']
    uri = request.get('uri', '')
    headers = request.get('headers', {})

    if uri == CONFIG['CALLBACK_PATH']:
        return handle_callback(request, headers)

    if is_public(uri):
        return request

    cookies = parse_cookies(headers)
    token = cookies.get('awsops_token', '')
    if token:
        payload = verify_rs256(token)
        if payload and claims_valid(payload):
            return request

    return start_login(headers)

def start_login(headers):
    host = headers.get('host', [{}])[0].get('value', '')
    cb = f'https://{host}{CONFIG["CALLBACK_PATH"]}'
    # PKCE: verifier (kept in a signed cookie) + S256 challenge sent to Cognito.
    verifier = b64url_encode(secrets.token_bytes(32))
    challenge = b64url_encode(hashlib.sha256(verifier.encode()).digest())
    state = b64url_encode(secrets.token_bytes(16))
    flow = f'{state}.{verifier}'
    flow_cookie = f'{flow}.{sign(flow)}'
    url = (f'https://{CONFIG["COGNITO_DOMAIN"]}/login?'
           f'client_id={CONFIG["CLIENT_ID"]}&response_type=code&'
           f'scope=openid+email+profile&state={state}&'
           f'code_challenge={challenge}&code_challenge_method=S256&'
           f'redirect_uri={urllib.parse.quote(cb)}')
    return {
        'status': '302', 'statusDescription': 'Found',
        'headers': {
            'location': [{'key': 'Location', 'value': url}],
            'set-cookie': [{'key': 'Set-Cookie',
                'value': f'awsops_flow={flow_cookie};Path=/;Secure;HttpOnly;SameSite=Lax;Max-Age=600'}],
            'cache-control': [{'key': 'Cache-Control', 'value': 'no-cache'}],
        },
    }

def handle_callback(request, headers):
    params = dict(urllib.parse.parse_qsl(request.get('querystring', '')))
    code = params.get('code', '')
    state = params.get('state', '')
    cookies = parse_cookies(headers)
    flow_cookie = cookies.get('awsops_flow', '')

    # Validate state + recover PKCE verifier from the signed cookie (CSRF defense).
    parts = flow_cookie.split('.')
    if len(parts) != 3 or not code or not state:
        return {'status': '400', 'statusDescription': 'Bad Request', 'body': 'Invalid auth state'}
    c_state, verifier, mac = parts
    if not hmac.compare_digest(sign(f'{c_state}.{verifier}'), mac) or not hmac.compare_digest(c_state, state):
        return {'status': '400', 'statusDescription': 'Bad Request', 'body': 'State mismatch'}

    host = headers.get('host', [{}])[0].get('value', '')
    cb = f'https://{host}{CONFIG["CALLBACK_PATH"]}'
    data = urllib.parse.urlencode({
        'grant_type': 'authorization_code', 'code': code,
        'redirect_uri': cb, 'client_id': CONFIG['CLIENT_ID'],
        'code_verifier': verifier,
    }).encode()
    req = urllib.request.Request(
        f'https://{CONFIG["COGNITO_DOMAIN"]}/oauth2/token', data=data,
        headers={'Content-Type': 'application/x-www-form-urlencoded'})
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            tokens = json.loads(resp.read())
    except Exception as e:
        return {'status': '500', 'statusDescription': 'Server Error', 'body': str(e)}

    id_token = tokens.get('id_token', '')
    if not verify_rs256(id_token) or not claims_valid(verify_rs256(id_token)):
        return {'status': '401', 'statusDescription': 'Unauthorized', 'body': 'Token verification failed'}

    return {
        'status': '302', 'statusDescription': 'Found',
        'headers': {
            'location': [{'key': 'Location', 'value': f'https://{host}/'}],
            'set-cookie': [
                {'key': 'Set-Cookie', 'value': f'awsops_token={id_token};Path=/;Secure;HttpOnly;SameSite=Lax;Max-Age=3600'},
                {'key': 'Set-Cookie', 'value': 'awsops_flow=;Path=/;Secure;HttpOnly;SameSite=Lax;Max-Age=0'},
            ],
            'cache-control': [{'key': 'Cache-Control', 'value': 'no-cache'}],
        },
    }

def parse_cookies(headers):
    cookies = {}
    for c in headers.get('cookie', []):
        for p in c.get('value', '').split(';'):
            if '=' in p:
                k, v = p.strip().split('=', 1)
                cookies[k] = v
    return cookies
```
> Note: `verify_rs256` is called twice in the callback for readability; that's fine (in-memory, JWKS cached). The token exchange uses **no client secret** — PKCE `code_verifier` authenticates the public client.

- [ ] **Step 2: update `auth.tf`** — make the client public (PKCE) and pass the new template vars + a state-signing key

Change the client resource (`generate_secret`):
```hcl
resource "aws_cognito_user_pool_client" "main" {
  name                                 = "${var.project}-client"
  user_pool_id                         = aws_cognito_user_pool.main.id
  generate_secret                      = false # public client + PKCE (no secret in edge code)
  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true
  callback_urls                        = ["https://${var.domain_name}/_callback"]
  logout_urls                          = ["https://${var.domain_name}/"]
}
```

Add a state-signing key and update the `templatefile` call:
```hcl
resource "random_password" "edge_state_key" {
  length  = 48
  special = false
}

locals {
  edge_src = templatefile("${path.module}/edge-lambda/cognito_edge.py.tftpl", {
    client_id      = aws_cognito_user_pool_client.main.id
    cognito_domain = "${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com"
    region         = var.region
    user_pool_id   = aws_cognito_user_pool.main.id
    state_key      = random_password.edge_state_key.result
  })
}
```
> Removes `client_secret` from the template entirely. Add the `random` provider to `backend.tf` `required_providers` if not present:
```hcl
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
```

- [ ] **Step 3: validate + apply** (edge Lambda republishes; CloudFront propagation takes a few minutes)
```bash
cd terraform/foundation
terraform init -upgrade   # picks up the random provider
terraform fmt && terraform validate
terraform plan -out tfplan
# Expect: cognito client in-place update (generate_secret), random_password create, lambda code update + new version, distribution association update.
terraform apply tfplan
```

- [ ] **Step 4: commit**
```bash
cd /home/atomoh/awsops
git add terraform/foundation/edge-lambda/cognito_edge.py.tftpl terraform/foundation/auth.tf terraform/foundation/backend.tf terraform/foundation/.terraform.lock.hcl
git commit -m "feat(v2-p1d): harden edge auth — JWKS RS256 verify + OAuth state + PKCE public client (drop secret)"
```

---

## Task D5: end-to-end verification + docs/memory + retire spine

**Files:** Delete `spine/`; Modify `CLAUDE.md`, `docs/architecture.md` (v2 notes), this plan's status.

- [ ] **Step 1: full `make deploy` loop** (proves the improvement loop end-to-end after cutover)
```bash
cd /home/atomoh/awsops
make deploy
```
Expected: login → build/push arm64 → ECS force-deploy → `services-stable` → `curl /api/health` returns `{"status":"ok",...}` (200 through CloudFront, since `/api/health` is a public path).

- [ ] **Step 2: edge + SSE + DB verification (CloudFront path)**
```bash
URL=https://awsops-v2.example.com
echo "health (public, no auth):"; curl -fsS $URL/api/health; echo
echo "root without cookie -> 302 to Cognito:"; curl -s -o /dev/null -w '%{http_code}\n' $URL/
echo "SSE (public? no — needs auth); checking it streams a heartbeat directly from a target is done via ECS exec/logs"
```
Expected: `/api/health` → 200 JSON; `/` (no cookie) → `302` (login redirect). Then **manually verify in a browser** (user): log in via Cognito → redirected back → root page renders → open `/api/stream` (SSE ticks every ~15s) → `/api/db` returns `{"status":"ok","public_tables":8}`.

- [ ] **Step 3: negative auth test (signature verification works)** — a forged token must NOT bypass auth
```bash
# Forged token: valid-looking header/payload with future exp, garbage signature.
H=$(printf '{"alg":"RS256","kid":"forged"}' | base64 | tr '+/' '-_' | tr -d '=')
P=$(printf '{"token_use":"id","exp":9999999999}' | base64 | tr '+/' '-_' | tr -d '=')
curl -s -o /dev/null -w '%{http_code}\n' --cookie "awsops_token=$H.$P.Zm9yZ2Vk" https://awsops-v2.example.com/
```
Expected: `302` (forged token rejected → redirected to login). A pre-D4 build would have returned `200`.

- [ ] **Step 4: retire the placeholder spine**
```bash
git rm -r spine/
git commit -m "chore(v2-p1d): retire placeholder spine (replaced by web/)"
```

- [ ] **Step 5: update root `CLAUDE.md`** — add a short v2 section noting: v2 lives in `web/` + `terraform/`, served at root `/` (no `/awsops` basePath), thin-BFF (UI + light `/api/*`), `make configure` + `make deploy`, auth = Cognito public client + PKCE with JWKS-verified edge. (Keep it brief; v1 content unchanged.)

- [ ] **Step 6: update the v2 effort memory** at `/home/atomoh/.claude/projects/-home-atomoh-awsops/memory/awsops-v2-effort.md` — mark **P1d DONE** (web image live, dual ECR, `make deploy`, Aurora wired, auth hardened: JWKS RS256 + state + PKCE), note remaining **P1e** (full `make configure`) / **P1f** (AgentCore provisioner) → **P2/P3/P4**.

- [ ] **Step 7: final commit**
```bash
git add CLAUDE.md docs/architecture.md docs/superpowers/plans/2026-05-31-awsops-v2-p1d-web-cicd-auth.md
git commit -m "docs(v2-p1d): mark P1d complete — web + CI/CD + hardened auth"
```

---

## Self-Review

**Spec coverage:** §2 thin-BFF web (UI + light `/api/*`, SSE) → D1; §2.1 GREEN edge preserved (moved blocks, ALB cert untouched) → D3; §5 root path / no basePath / `/api/*` → D1; §7 Aurora secret consumed → D3; §8 Terraform + `make deploy` + dual-tier ECR + circuit breaker → D2/D3; auth hardening (P1b memory debt) → D4. ✓ Review blockers A (exec-role secret), B (health path) → D3; CRITICAL/HIGH/MEDIUM (JWKS, state, PKCE, SG, static bypass) → D3/D4. ✓

**Placeholder scan:** none — all code (Next.js routes, Dockerfile, deploy.mjs, full workload.tf, full edge python, auth.tf deltas) is concrete. The only "added later" note is `ecs_*` outputs, explicitly deferred to D3 with the reason (resource doesn't exist in D2).

**Type/name consistency:** ECR `aws_ecr_repository.web` (ecr.tf) referenced by `aws_ecs_task_definition.web` (workload.tf); outputs `ecr_web_uri`/`ecs_cluster_name`/`ecs_service_name` consumed by `deploy.mjs` (`tf('ecr_web_uri')` etc.); container name `web` matches service `load_balancer.container_name`; health path `/api/health` matches in route, container healthCheck, TG, and smoke; secret JSON keys `username`/`password` → env `AURORA_USER`/`AURORA_PASSWORD` read by `app/api/db/route.ts`; template vars `client_id`/`cognito_domain`/`region`/`user_pool_id`/`state_key` all provided by `auth.tf` `templatefile`. Consistent.

**Risk notes:** (1) The spine→web service rename causes one brief web blip during D3 apply (dev, acceptable). (2) ECR Public requires the `ecr-public`/`sts` GetServiceBearerToken perms — already covered by the broad role per P1a perm verification; if `aws_ecrpublic_repository` create fails on perms, it's isolated to D2 and doesn't block the dev path. (3) Lambda@Edge JWKS fetch adds a cold-start outbound call (cached in module global) — within the 5s timeout.

## Execution Handoff
Subagent-driven, auto plan+apply. Order is strict: **D1 → D2 (apply ECR + push image) → D3 (cutover apply) → D4 (auth apply) → D5 (verify+docs)**. D3 and D4 each trigger CloudFront/ECS propagation (minutes). The browser-login verification in D5 Step 2 needs the user.
