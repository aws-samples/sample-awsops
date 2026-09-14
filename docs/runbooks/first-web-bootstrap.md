# First web bootstrap

## Symptoms and scope

A brand-new development stack has no web image, migration ledger or working login.
Runtime activation requires authenticated database and host-registry preparation,
so it cannot create that first usable web application itself.

Use this procedure **only for a new, unpublished, inactive stack**. It is an
operator bootstrap using existing Terraform workflows and local Make targets;
there is no first-web GitHub Actions workflow. Never disable an active runtime
profile, remove published aliases, or use this path to ship an existing service
around mandatory development CI. Operator provisioning does not enable product
AWS-resource mutation or autonomy (ADR-005).

## Candidate causes

| Failure | Check before retrying |
|---|---|
| Web image cannot be pulled | The private web ECR repository and matching ARM64 image must exist before the full base apply. |
| `schema_migrations missing` | A genuinely empty database needs the guarded initializer, then all migrations. |
| New image has no effect | `make deploy` does not register a task definition; `IMAGE_TAG` must match the applied web container image tag. |
| Edge returns 504 | A new VPC can require a second reviewed apply to add the CloudFront-managed SG ingress rule. |
| Runtime host preparation fails | Verify real login, database access and the enabled host registry before activation. |

## Prerequisites and verification

Run commands from the root of a clean checkout of the reviewed development
commit, on the operator's private deployment host. Coordinate the sequence so no
other deployment changes its source, configuration, state or image tag.

- Use Terraform **1.15.7**, Node.js **20 or newer**, npm, Make, AWS CLI, GitHub CLI,
  curl and Docker with a working Buildx builder supporting `linux/arm64`.
  This procedure explicitly uses `DOCKER=docker`; the local deploy script otherwise
  defaults to `sudo docker`. Use the same daemon/builder for both image builds.
- Establish the intended AWS account, region, roles and unique backend bucket/key
  through [CI setup](dev-repo-setup.md). The bucket must already exist;
  `make configure` writes configuration, not a state bucket. Obtain approved
  private copies of the same `backend.hcl` and `terraform.tfvars` used by CI.
  Do not copy another environment's backend or overwrite an active configuration.
- The deployment host needs private DNS/routing to Aurora on TCP 5432. Review
  `allow_vpc_db_access` in `data.tf`: it permits the VPC CIDR when enabled, not an
  arbitrary external workstation. The migrator verifies the server hostname and
  certificate with `scripts/v2/eks/rds-ca-bundle.pem`; never disable TLS validation.
  The operator needs backend access, reads of the exact migration secrets and
  their KMS keys, web ECR push, and the scoped ECS rollout/read permissions.
- Arrange a normal non-admin login in the new Cognito pool through the existing
  account-provisioning process. For CI's managed-demo path, explicitly configure
  `create_demo_user=true`, the intended `demo_email` and the existing protected
  credential channel described in [CI setup](dev-repo-setup.md). Keep source
  credentials in Secrets Manager/SSM and only private transient files where
  needed. Do not embed passwords in commands, committed tfvars or documentation.
  Do not reset a password or promote an account to admin to pass a probe.
- Have explicit approval for the new base resources and any DNS/certificate
  issuance. Verify the intended public hosted zone and delegation. Unpublished
  service A records do **not** mean no DNS changes: managed ACM issuance creates
  validation CNAMEs. Retain the private HTTPS edge.

Set these nonsecret shell values from the reviewed operator configuration.
Replace the angle-bracket placeholders; never publish resolved account values:

```bash
export AWS_PROFILE='<operator-profile>'
export AWS_REGION='<stack-region>'
export EXPECTED_BOOTSTRAP_ACCOUNT_ID='<expected-account-id>'
export DOCKER=docker
export IMAGE_TAG=web-latest
set -euo pipefail
umask 077
test "$(aws sts get-caller-identity --query Account --output text)" = "$EXPECTED_BOOTSTRAP_ACCOUNT_ID"
git rev-parse HEAD
node --version
terraform version
docker buildx inspect --bootstrap
npm ci --prefix scripts/v2
```

Identity equality is a consistency check, not authorization or stack isolation.
The current public dev workflows use `ap-northeast-2`; local `AWS_REGION`,
Terraform `region`, backend region and CI configuration must agree. If selecting
another region for a separate installation, review its provider/AZ/CI configuration
first. `make configure` reads `AWS_REGION` but does not write Terraform's `region`
or `azs`; its defaults must not silently select another region.

### 1. Configure an inactive base

For a new local configuration only, `make configure` is the existing interactive
entrypoint. Leave optional features off. It does not configure all settings below:
review the resulting private tfvars and reconcile them with CI before planning.
Alternatively, use the already approved matching files from the prerequisite.

The effective base inputs must include:

```hcl
image_tag                  = "web-latest"
publish_service_dns        = false
agentcore_enabled          = false
workers_enabled            = false
steampipe_enabled          = false
ci_readiness_enabled       = false
ci_runtime_profile_enabled = false
ci_runtime_rollout         = false
inventory_host_only        = false
remediation_enabled        = false
rca_writeback_enabled      = false
integrations_write_enabled = false
diagnosis_notify_enabled   = false
```

Keep other optional features at their default-off values. On this **new** CI
configuration, leave `CI_READONLY_RUNTIME_DEV` unset/false and set the independent
`CI_READINESS_ENABLED_DEV=false`. These are initial settings, not instructions to
turn off an existing profile. Use `web-latest` for the normal CI handoff:
`variables.tf` defaults to it and Deploy Web pins that tag. A custom local
`IMAGE_TAG` alone cannot change the applied task definition.

```bash
terraform -chdir=terraform/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/foundation validate
```

### 2. Review/apply only the web repository, then push the first image

Use the existing certificate-neutral `ecr-bootstrap` scope. Leave external
certificate inputs unset/null for managed issuance and `domain_rollout=false`.

```bash
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=plan -f plan_scope=ecr-bootstrap -f domain_rollout=false \
  -f publish_service_dns=false -f allow_dns_changes=false
gh run list -R aws-samples/sample-awsops --workflow terraform.yml --branch dev --event workflow_dispatch
```

Identify the successful plan dispatch at the reviewed commit. Inspect its exact
saved plan through [private plan inspection](dev-repo-setup.md); only
`aws_ecr_repository.web` may change. Set `BOOTSTRAP_PLAN_RUN_ID` to that run's
numeric ID, then have the authorized controller apply:

```bash
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=apply -f plan_scope=ecr-bootstrap \
  -f plan_run_id="$BOOTSTRAP_PLAN_RUN_ID" -f allow_dns_changes=false
```

Wait for successful apply. Every apply in this procedure consumes the reviewed
saved plan and its authenticated encrypted assets at the same branch/SHA.
PR/push advisory plans are not eligible. If the branch or intended inputs change,
create and review a fresh plan. Never use `-auto-approve` or rebuild plan assets
during apply.

The remote state now supplies `ecr_web_uri`. Prebuild the reviewed web commit
before creating the ECS service; mirror `deploy.mjs`, including its changelog copy:

```bash
BOOTSTRAP_WEB_URI=$(terraform -chdir=terraform/foundation output -raw ecr_web_uri)
BOOTSTRAP_REGISTRY=${BOOTSTRAP_WEB_URI%%/*}
aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$BOOTSTRAP_REGISTRY"
cp CHANGELOG.md web/CHANGELOG.md
docker buildx build --platform linux/arm64 \
  -t "${BOOTSTRAP_WEB_URI}:${IMAGE_TAG}" --push web/
docker buildx imagetools inspect "${BOOTSTRAP_WEB_URI}:${IMAGE_TAG}"
```

Confirm the runtime image is `linux/arm64`; record its digest and source commit
privately. ECR bootstrap creates no service, database or readiness evidence.

### 3. Review/apply the full base with service A publication deferred

For approved managed issuance, use the existing `CERTIFICATE_MODE_DEV=managed`
configuration with null external certificate inputs. For approved external reuse,
retain `preserve` and the explicitly selected trusted matching certificates.
Follow [domain rollout](dev-domain-rollout.md) for ownership and delegation checks.
The following issuance path requires explicit DNS permission on both dispatches:

```bash
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=plan -f plan_scope=full -f domain_rollout=true \
  -f publish_service_dns=false -f allow_dns_changes=true
```

Review the entire base, including networking, Aurora, Cognito, ECR Public,
certificates and the web task/service. Confirm the runtime flags remain off,
the web image matches the pushed tag, and no service A alias is created or
retired. DNS changes must be limited to the expressly authorized owners.
Set `BOOTSTRAP_PLAN_RUN_ID` to this new successful plan, then apply it:

```bash
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=apply -f plan_scope=full \
  -f plan_run_id="$BOOTSTRAP_PLAN_RUN_ID" -f allow_dns_changes=true
```

After successful apply, inspect `cf_vpc_origin_sg_present`. If the first plan ran
before `CloudFront-VPCOrigins-Service-SG` existed, `workload.tf` deliberately
leaves ALB port 443 closed. Repeat this full plan/review/apply sequence with the
same unpublished settings to add the managed-SG ingress rule in place.
Do not change the SG description, add a CIDR fallback or expose the ALB.

Check the actual service task definition's image before using the local deploy:

```bash
BOOTSTRAP_CLUSTER=$(terraform -chdir=terraform/foundation output -raw ecs_cluster_name)
BOOTSTRAP_SERVICE=$(terraform -chdir=terraform/foundation output -raw ecs_service_name)
BOOTSTRAP_TASK_DEFINITION=$(aws ecs describe-services \
  --cluster "$BOOTSTRAP_CLUSTER" --services "$BOOTSTRAP_SERVICE" \
  --region "$AWS_REGION" --query 'services[0].taskDefinition' --output text)
test "$(aws ecs describe-task-definition --task-definition "$BOOTSTRAP_TASK_DEFINITION" \
  --region "$AWS_REGION" \
  --query "taskDefinition.containerDefinitions[?name=='web'].image | [0]" --output text)" \
  = "${BOOTSTRAP_WEB_URI}:${IMAGE_TAG}"
```

### 4. Initialize Aurora, migrate and deploy the first usable web

Use a clean deployment shell without inherited runtime `AURORA_*`,
`SQL_READER_*`, `DRY_RUN`, `OFFLINE` or `BOOTSTRAP` overrides. The CLI reads
`aurora_endpoint`, `aurora_secret_arn` and `agent_sql_reader_secret_arn` from
Terraform; credentials are fetched from Secrets Manager in memory.

```bash
INITIALIZE_EMPTY_DB=1 make migrate
IMAGE_TAG="$IMAGE_TAG" DOCKER=docker make deploy
```

Use `INITIALIZE_EMPTY_DB=1` only for this new empty database. Under the migration
advisory lock, the initializer rejects an occupied database without a ledger,
installs the frozen baseline transactionally and upgrades the ledger to text.
An existing ledger skips initialization; pending checksum-verified ULID migrations
still run. `BOOTSTRAP=1` is for legacy integer ledgers, not this installation.
Never manually import `schema.sql` or remove a ledger to make initialization pass.

`make deploy` runs migrations again, then ECR login, ARM64 build/push, a
force-new-deployment of the **current** ECS service task definition, a
services-stable wait and `/api/health`. Reusing the same builder/source allows
the second build to use its cache; cache hits are not guaranteed.
There is no task-definition registration or tag switch in this target.

The health CLI uses `public_url` and `cloudfront_domain` with curl `--connect-to`,
preserving the service Host, TLS SNI and certificate validation before DNS
publication. Successful health proves process/edge liveness only.

### 5. Perform real login, database and host-registry preparation

Prepare expires at most 30 minutes after entry, including login and database requests;
an earlier caller limit shortens it. Insufficient request time reports `release_timeout`
even in prepare mode. Stop, inspect the cause and rerun with fresh private credentials;
see the [runtime probe contract](runtime-foundation.md#reusable-runtime-probe-contract).

Use the existing `authenticated-smoke.mjs` CLI in `prepare` mode. Have the
authorized operator supply a Secrets Manager secret containing the normal login
as JSON fields `email` and `password`; it must match the provisioned account.
Set `BOOTSTRAP_LOGIN_SECRET_ID` to that secret's identifier privately. This is a
credential read, not a password reset. The following subshell owns all scratch:

```bash
(
  set -euo pipefail
  umask 077
  export RUNNER_TEMP
  RUNNER_TEMP=$(mktemp -d)
  BOOTSTRAP_CREDENTIAL_DIR=$(mktemp -d "$RUNNER_TEMP/awsops-smoke-credentials-XXXXXX")
  export SMOKE_CREDENTIAL_FILE="$BOOTSTRAP_CREDENTIAL_DIR/credentials.json"
  export SMOKE_RUNTIME_CONFIG_FILE="$BOOTSTRAP_CREDENTIAL_DIR/runtime.json"
  trap 'rm -rf -- "$RUNNER_TEMP"' EXIT
  aws secretsmanager get-secret-value --secret-id "$BOOTSTRAP_LOGIN_SECRET_ID" \
    --region "$AWS_REGION" --query SecretString --output text > "$SMOKE_CREDENTIAL_FILE"
  node --input-type=module <<'NODE'
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.SMOKE_RUNTIME_CONFIG_FILE, JSON.stringify({
  schemaVersion: 1, mode: 'prepare', hostOnly: true,
  expectedAccountId: process.env.EXPECTED_BOOTSTRAP_ACCOUNT_ID,
}), { mode: 0o600, flag: 'wx' });
NODE
  export PUBLIC_URL CLOUDFRONT_DOMAIN
  PUBLIC_URL=$(terraform -chdir=terraform/foundation output -raw public_url)
  CLOUDFRONT_DOMAIN=$(terraform -chdir=terraform/foundation output -raw cloudfront_domain)
  node scripts/v2/authenticated-smoke.mjs
)
```

Require `Authenticated host registry preparation passed.` The CLI performs
normal `/api/auth/login`, checks the session cookie and edge-authenticated
`/api/db`, then reads `/api/accounts`. That authenticated GET calls `ensureHostRow`
to seed the host from the web task identity; no admin promotion or account POST is
needed. Preparation requires exactly one enabled matching host and no enabled
foreign account. A positive table count is not a complete migration-ledger audit.
This mode does not invoke the billed readiness probe or start worker jobs.

### 6. Hand off to normal runtime activation and mandatory release verification

Record the reviewed commit, plan/apply run IDs, image digest, migration outcome,
health outcome and host preparation outcome privately. Keep service A publication
false and follow [runtime activation](runtime-foundation.md):

1. Configure the authorized dev read-only profile and bootstrap the three runtime
   repositories with `runtime-ecr-bootstrap`. Build the ARM64 Steampipe/worker
   images and configure their verified digests before the full runtime plan.
2. Make the separate readiness decision and apply it with the authorized full
   runtime rollout. Apply `ci_migrations_enabled=true` before dev Deploy AgentCore;
   its reusable migration workflow must run before AgentCore provisioning and
   SQL-reader use. Preserve the real host preflight at both plan and apply.
3. After inventory infrastructure/image activation, allow the configured
   EventBridge `rate(15 minutes)` / `type=all` sweep to run before the first gated
   release. Wait for its per-type durable success evidence; elapsed time or
   catalog acknowledgement alone is insufficient. Investigate failures using
   [inventory diagnostics](steampipe-quota-and-staleness.md); never fabricate
   ledger rows or declare an unseeded catalog ready.
4. Run the normal dev release workflow after those prerequisites:

   ```bash
   gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev -f build=true
   ```

   Current Deploy Web integrates `runtime-release.mjs`: require the complete
   mandatory AI/CI and authenticated checks, including web identity/image,
   every catalog type's clean post-marker collection, SSM/AgentCore/model access
   and both owned Lambda/Fargate jobs. Legacy revisions with only health or
   optional DB smoke cannot establish this proof. Publication requires the full
   integrated gate; this runbook provides no skip input.
5. Only after the full gate passes, use the separately authorized service A
   publication stage in [domain rollout](dev-domain-rollout.md), with a fresh
   reviewed saved plan. Bootstrap completion is never a full-ready report.

## Stop and recovery

Stop on account/backend mismatch, missing private connectivity, initialization
refusal, image mismatch, failed login or incomplete runtime evidence. Preserve the
unpublished state and inspect private diagnostics. A failed/partial apply needs a
fresh plan and review of actual state before retry; do not destroy or recreate
Aurora, remove migration history, weaken TLS/CI, or disable an active profile.
There is no active-service rollback or teardown authorization in this procedure.

## Source evidence

Command path checked against source on 2026-09-14; this is not a live execution report.

- [Makefile](../../Makefile), [deploy.mjs](../../scripts/v2/deploy.mjs),
  [Dockerfile](../../web/Dockerfile): migration dependency, ARM64 build, tag and rollout behavior.
- [migrate.mjs](../../scripts/v2/migrate.mjs), [initialize-db.mjs](../../scripts/v2/initialize-db.mjs),
  [SQL-reader configuration](../../scripts/v2/sql-reader-config.mjs): TLS, initialization and sync guards.
- [Terraform workflow](../../.github/workflows/terraform.yml), [inputs](../../terraform/foundation/variables.tf),
  [ECR](../../terraform/foundation/ecr.tf), [web/edge workload](../../terraform/foundation/workload.tf),
  [edge](../../terraform/foundation/edge.tf), [outputs](../../terraform/foundation/outputs.tf):
  saved-plan scopes, deferred publication and CloudFront SG bootstrap.
- [Authenticated smoke](../../scripts/v2/authenticated-smoke.mjs),
  [runtime smoke](../../scripts/v2/runtime-smoke.mjs),
  [account route](../../web/app/api/accounts/route.ts): login/DB/host preparation.
- [Release controller](../../scripts/v2/ci/runtime-release.mjs),
  [Deploy Web](../../.github/workflows/deploy-web.yml),
  [manual collect-runtime](../../.github/workflows/collect-runtime.yml):
  full-catalog collection, bounded authenticated proof and both owned workers.

Related ADRs: 001 (data), 002/009 (auth/ownership), 005 (mutation freeze),
011 (account scope), 016 (deployment/domain boundaries).
