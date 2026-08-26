#!/usr/bin/env bash
# upgrade.sh — safe AWSops v2 release upgrade (snapshot → migrate → deploy). CONTROLLER-RUN.
#
# The standard way to roll a deployment to a new release. Migrations are cumulative (ULID ledger):
# running this from any release tag applies exactly the migrations the live DB is missing — you do
# NOT write per-version-pair scripts. The first run also performs the one-time legacy bootstrap
# (schema_migrations.version INTEGER→TEXT + checksum/app_version columns) automatically; thereafter
# it's a normal migrate. Idempotent and fail-loud, so re-running is safe.
#
# Upgrade ANY old version → a target release:
#     git fetch --tags && git checkout v2.1.5
#     bash scripts/v2/upgrade.sh            # PREVIEW (no writes, no deploy) — run this FIRST
#     CONFIRM=go bash scripts/v2/upgrade.sh # EXECUTE: snapshot → migrate → verify → deploy
#     NO_DEPLOY=1 CONFIRM=go bash …         # migrate only (deploy separately)
#
# PRECONDITION: a coordinated quiet window — no other session running make deploy / make migrate /
# psql schema.sql concurrently (the advisory lock does NOT block raw schema.sql writers).
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-2}"
TF=terraform/foundation
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # scripts/v2 → repo root
cd "$ROOT"

VER="$(node -e "process.stdout.write(require('./web/package.json').version||'?')" 2>/dev/null || echo '?')"
VER_SAFE="${VER//./-}"   # RDS snapshot identifiers allow only letters/digits/hyphens — no dots
MODE="PREVIEW (no writes/deploy; re-run with CONFIRM=go)"; [ "${CONFIRM:-}" = go ] && MODE=EXECUTE
echo "════════════════════════════════════════════════════════════════"
echo "  AWSops v2 — release upgrade"
echo "  repo    : $ROOT"
echo "  release : v$VER   ($(git rev-parse --short HEAD)  $(git log -1 --format=%s))"
echo "  mode    : $MODE"
echo "════════════════════════════════════════════════════════════════"

# ── 0. sanity + resolve/verify the DB cluster ────────────────────────────────
[ -f "$TF/backend.hcl" ] || { echo "✗ $TF/backend.hcl missing — run from a configured worktree (make configure)"; exit 1; }
ls "$TF"/migrations/*.sql >/dev/null 2>&1 || { echo "✗ no migration files under $TF/migrations/"; exit 1; }
echo "▶ migrations + declared release:"; node scripts/v2/migrate.mjs --status | sed -n '2,$p'

ENDPOINT="$(terraform -chdir="$TF" output -raw aurora_endpoint 2>/dev/null || true)"
CLUSTER="${AURORA_CLUSTER_ID:-${ENDPOINT%%.*}}"      # '<id>.cluster-xxx.<region>.rds...' → '<id>'
[ -n "$CLUSTER" ] || { echo "✗ could not resolve cluster id (terraform output aurora_endpoint empty?)"; exit 1; }
echo "▶ aurora cluster: $CLUSTER  (region $REGION)"
aws rds describe-db-clusters --db-cluster-identifier "$CLUSTER" --region "$REGION" \
  --query 'DBClusters[0].Status' --output text >/dev/null \
  || { echo "✗ cluster '$CLUSTER' not found — set AURORA_CLUSTER_ID=<id> and retry"; exit 1; }

# ── read-only preview (always; no writes) ────────────────────────────────────
echo ""
echo "▶ pending preview (DRY_RUN=1 BOOTSTRAP=1 — connects + reads, NO writes):"
DRY_RUN=1 BOOTSTRAP=1 node scripts/v2/migrate.mjs

if [ "${CONFIRM:-}" != "go" ]; then
  echo ""
  echo "■ PREVIEW COMPLETE — nothing changed, no snapshot, no deploy."
  echo "  If the pending list looks right, EXECUTE with:  CONFIRM=go bash scripts/v2/upgrade.sh"
  exit 0
fi

# ── 1. snapshot (safety net, first real action) ──────────────────────────────
SNAP="awsops-v2-preupgrade-v${VER_SAFE}-$(date +%Y%m%d%H%M)"
echo ""
echo "▶ [1/4] RDS cluster snapshot $SNAP (rollback target) …"
aws rds create-db-cluster-snapshot --db-cluster-identifier "$CLUSTER" \
  --db-cluster-snapshot-identifier "$SNAP" --region "$REGION" >/dev/null
echo "  …waiting for 'available' (a few minutes)…"
aws rds wait db-cluster-snapshot-available --db-cluster-snapshot-identifier "$SNAP" --region "$REGION"
echo "  ✅ snapshot available: $SNAP"

# ── 2. migrate (BOOTSTRAP=1 = auto one-time legacy bootstrap; no-op once on TEXT ledger) ──
echo ""
echo "▶ [2/4] BOOTSTRAP=1 make migrate — apply pending ULID migrations (stamps release v$VER) …"
BOOTSTRAP=1 make migrate

# ── 3. verify idempotent ─────────────────────────────────────────────────────
echo ""
echo "▶ [3/4] verify (expect 'up to date — no pending') …"
make migrate

# ── 4. deploy ────────────────────────────────────────────────────────────────
if [ "${NO_DEPLOY:-}" = "1" ]; then
  echo ""
  echo "▶ [4/4] NO_DEPLOY=1 → skipping make deploy (migration done; deploy separately when ready)"
else
  echo ""
  echo "▶ [4/4] make deploy — migrate (no-op) → arm64 build → ECR → ECS rolling → wait stable → smoke /api/health …"
  make deploy
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  ✅ upgraded to v$VER.   rollback snapshot: $SNAP"
echo "  Post-deploy smoke (browser, auth-gated — /api/health alone is insufficient):"
echo "    /topology  /bedrock  /cost  /eks   +  chat drawer   +  GET→PUT→GET /api/opencost/<cluster>"
echo "  Rollback if needed:"
echo "    DB : one advisory-locked psql txn — DELETE FROM schema_migrations WHERE version !~ '^[0-9]+\$';"
echo "         ALTER TABLE schema_migrations ALTER COLUMN version TYPE INTEGER USING version::integer;"
echo "         ALTER TABLE schema_migrations DROP COLUMN checksum; DROP COLUMN app_version;  (order load-bearing)"
echo "    web: roll ECS service to the prior task-definition revision"
echo "    catastrophe only: restore snapshot $SNAP (new cluster endpoint)"
echo "════════════════════════════════════════════════════════════════"
