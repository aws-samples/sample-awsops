#!/bin/bash
# Accumulate changed src/ page files into pending-guides list for batch processing.
# Triggered by PostToolUse (Write|Edit) on src/ files.
# The /sync-guides skill reads this list and generates guide docs via Agent.

FILE_PATH="${1:-}"
[ -z "$FILE_PATH" ] && exit 0

# Only trigger for src/app/ page files and src/lib/queries/ and src/components/
# These are the files that affect user-facing guide documentation
case "$FILE_PATH" in
    src/app/*/page.tsx)  ;;
    src/app/*/*/page.tsx) ;;
    src/lib/queries/*.ts) ;;
    src/components/*.tsx) ;;
    src/components/*/*.tsx) ;;
    infra-cdk/lib/*.ts) ;;
    agent/agent.py) ;;
    scripts/0*.sh) ;;
    *) exit 0 ;;
esac

# Derive the page route from the file path
# src/app/ebs/page.tsx -> ebs
# src/app/k8s/explorer/page.tsx -> k8s/explorer
# src/lib/queries/ebs.ts -> ebs (query change)
# src/components/layout/Sidebar.tsx -> sidebar (menu change)
ROUTE=""
case "$FILE_PATH" in
    src/app/*/page.tsx)
        ROUTE=$(echo "$FILE_PATH" | sed 's|src/app/||;s|/page.tsx||')
        ;;
    src/app/*/*/page.tsx)
        ROUTE=$(echo "$FILE_PATH" | sed 's|src/app/||;s|/page.tsx||')
        ;;
    src/lib/queries/*.ts)
        ROUTE=$(basename "$FILE_PATH" .ts)
        ;;
    src/components/layout/Sidebar.tsx)
        ROUTE="__sidebar__"
        ;;
    src/components/*.tsx|src/components/*/*.tsx)
        ROUTE="__component__:$(basename "$FILE_PATH" .tsx)"
        ;;
    infra-cdk/lib/*.ts)
        ROUTE="__infra__"
        ;;
    agent/agent.py)
        ROUTE="__agentcore__"
        ;;
    scripts/0*.sh)
        ROUTE="__deployment__"
        ;;
esac

[ -z "$ROUTE" ] && exit 0

# Route to docs-site/docs category mapping
declare -A ROUTE_TO_DOC
ROUTE_TO_DOC[ec2]="compute/ec2"
ROUTE_TO_DOC[lambda]="compute/lambda"
ROUTE_TO_DOC[ecs]="compute/ecs"
ROUTE_TO_DOC[ecr]="compute/ecr"
ROUTE_TO_DOC[k8s]="compute/eks"
ROUTE_TO_DOC[k8s/explorer]="compute/eks-explorer"
ROUTE_TO_DOC[k8s/pods]="compute/eks-pods"
ROUTE_TO_DOC[k8s/nodes]="compute/eks-nodes"
ROUTE_TO_DOC[k8s/deployments]="compute/eks-deployments"
ROUTE_TO_DOC[k8s/services]="compute/eks-services"
ROUTE_TO_DOC[container-cost]="compute/ecs-container-cost"
ROUTE_TO_DOC[eks-container-cost]="compute/eks-container-cost"
ROUTE_TO_DOC[vpc]="network/vpc"
ROUTE_TO_DOC[cloudfront-cdn]="network/cloudfront"
ROUTE_TO_DOC[waf]="network/waf"
ROUTE_TO_DOC[topology]="network/topology"
ROUTE_TO_DOC[ebs]="storage/ebs"
ROUTE_TO_DOC[s3]="storage/s3"
ROUTE_TO_DOC[rds]="storage/rds"
ROUTE_TO_DOC[dynamodb]="storage/dynamodb"
ROUTE_TO_DOC[elasticache]="storage/elasticache"
ROUTE_TO_DOC[opensearch]="storage/opensearch"
ROUTE_TO_DOC[msk]="storage/msk"
ROUTE_TO_DOC[monitoring]="monitoring/monitoring"
ROUTE_TO_DOC[bedrock]="monitoring/bedrock"
ROUTE_TO_DOC[cloudwatch]="monitoring/cloudwatch"
ROUTE_TO_DOC[cloudtrail]="monitoring/cloudtrail"
ROUTE_TO_DOC[cost]="monitoring/cost"
ROUTE_TO_DOC[inventory]="monitoring/inventory"
ROUTE_TO_DOC[iam]="security/iam"
ROUTE_TO_DOC[security]="security/security"
ROUTE_TO_DOC[compliance]="security/compliance"
ROUTE_TO_DOC[__infra__]="overview/dashboard"
ROUTE_TO_DOC[__agentcore__]="overview/agentcore"
ROUTE_TO_DOC[__deployment__]="getting-started/deployment"

# Resolve doc path
DOC_PATH="${ROUTE_TO_DOC[$ROUTE]}"

# For query files, try to match the query name to a route
if [ -z "$DOC_PATH" ] && [[ "$FILE_PATH" == src/lib/queries/*.ts ]]; then
    # Query file name might match a route directly
    for key in "${!ROUTE_TO_DOC[@]}"; do
        base=$(basename "$key")
        if [ "$base" = "$ROUTE" ] || [ "$key" = "$ROUTE" ]; then
            DOC_PATH="${ROUTE_TO_DOC[$key]}"
            break
        fi
    done
fi

# Pending file location
PENDING_FILE=".omc/state/pending-guides.json"
mkdir -p "$(dirname "$PENDING_FILE")"

# Initialize if not exists
if [ ! -f "$PENDING_FILE" ]; then
    echo '{"pending":[]}' > "$PENDING_FILE"
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build entry JSON
ENTRY="{\"route\":\"$ROUTE\",\"src_file\":\"$FILE_PATH\",\"doc_path\":\"${DOC_PATH}\",\"timestamp\":\"$TIMESTAMP\"}"

# Check if route already exists in pending (avoid duplicates)
if command -v jq &>/dev/null; then
    EXISTS=$(jq -r --arg route "$ROUTE" '.pending[] | select(.route == $route) | .route' "$PENDING_FILE" 2>/dev/null)
    if [ -z "$EXISTS" ]; then
        jq --argjson entry "$ENTRY" '.pending += [$entry]' "$PENDING_FILE" > "${PENDING_FILE}.tmp" && mv "${PENDING_FILE}.tmp" "$PENDING_FILE"
        COUNT=$(jq '.pending | length' "$PENDING_FILE")
        echo "[pending-guides] Queued: $ROUTE (${COUNT} pending). Run /sync-guides when ready."
    else
        # Update timestamp for existing entry
        jq --arg route "$ROUTE" --arg ts "$TIMESTAMP" --arg src "$FILE_PATH" \
            '(.pending[] | select(.route == $route)) |= (.timestamp = $ts | .src_file = $src)' \
            "$PENDING_FILE" > "${PENDING_FILE}.tmp" && mv "${PENDING_FILE}.tmp" "$PENDING_FILE"
    fi
else
    # Fallback without jq: simple grep check
    if ! grep -q "\"$ROUTE\"" "$PENDING_FILE" 2>/dev/null; then
        # Simple append (less robust but works without jq)
        sed -i "s/\"pending\":\[/\"pending\":[$ENTRY,/" "$PENDING_FILE"
        echo "[pending-guides] Queued: $ROUTE. Run /sync-guides when ready."
    fi
fi
