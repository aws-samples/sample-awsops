#!/bin/bash
# When Sidebar.tsx is edited (menu added), remind to create web guide docs.
# Parses navGroups labels/hrefs and checks for matching docs-site/docs/ files.

FILE_PATH="${1:-}"
[ -z "$FILE_PATH" ] && exit 0

# Only trigger for Sidebar.tsx
[[ "$FILE_PATH" != *"Sidebar.tsx"* ]] && exit 0

SIDEBAR_FILE="src/components/layout/Sidebar.tsx"
[ ! -f "$SIDEBAR_FILE" ] && exit 0

WEB_DOCS_DIR="docs-site/docs"
SIDEBARS_FILE="docs-site/sidebars.ts"

# Extract href values from navGroups (e.g., '/ebs' -> ebs, '/k8s' -> k8s, '/k8s/explorer' -> k8s/explorer)
HREFS=$(grep -oP "href:\s*'(/[^']+)'" "$SIDEBAR_FILE" | sed "s/href: '//;s/'//" | sed 's|^/||')

# Map sidebar groups to docs-site/docs categories
declare -A CATEGORY_MAP
CATEGORY_MAP[ec2]="compute/ec2"
CATEGORY_MAP[lambda]="compute/lambda"
CATEGORY_MAP[ecs]="compute/ecs"
CATEGORY_MAP[ecr]="compute/ecr"
CATEGORY_MAP[k8s]="compute/eks"
CATEGORY_MAP[k8s/explorer]="compute/eks-explorer"
CATEGORY_MAP[container-cost]="compute/ecs-container-cost"
CATEGORY_MAP[eks-container-cost]="compute/eks-container-cost"
CATEGORY_MAP[vpc]="network/vpc"
CATEGORY_MAP[cloudfront-cdn]="network/cloudfront"
CATEGORY_MAP[waf]="network/waf"
CATEGORY_MAP[topology]="network/topology"
CATEGORY_MAP[ebs]="storage/ebs"
CATEGORY_MAP[s3]="storage/s3"
CATEGORY_MAP[rds]="storage/rds"
CATEGORY_MAP[dynamodb]="storage/dynamodb"
CATEGORY_MAP[elasticache]="storage/elasticache"
CATEGORY_MAP[opensearch]="storage/opensearch"
CATEGORY_MAP[msk]="storage/msk"
CATEGORY_MAP[monitoring]="monitoring/monitoring"
CATEGORY_MAP[bedrock]="monitoring/bedrock"
CATEGORY_MAP[cloudwatch]="monitoring/cloudwatch"
CATEGORY_MAP[cloudtrail]="monitoring/cloudtrail"
CATEGORY_MAP[cost]="monitoring/cost"
CATEGORY_MAP[inventory]="monitoring/inventory"
CATEGORY_MAP[iam]="security/iam"
CATEGORY_MAP[security]="security/security"
CATEGORY_MAP[compliance]="security/compliance"

MISSING=()

for HREF in $HREFS; do
    # Skip top-level pages (dashboard, ai, agentcore)
    [[ "$HREF" == "" || "$HREF" == "ai" || "$HREF" == "agentcore" ]] && continue

    DOC_PATH="${CATEGORY_MAP[$HREF]}"
    [ -z "$DOC_PATH" ] && continue

    if [ ! -f "$WEB_DOCS_DIR/$DOC_PATH.md" ]; then
        MISSING+=("$DOC_PATH")
    fi
done

# Also check if sidebars.ts has the entry
for M in "${MISSING[@]}"; do
    SIDEBAR_ID=$(echo "$M" | sed 's|/|-|g')
    echo "[menu-guide-sync] Menu item added but web guide missing: docs-site/docs/$M.md — Create the guide doc and add '$M' to docs-site/sidebars.ts"
done

if [ ${#MISSING[@]} -eq 0 ]; then
    # Check for new hrefs not in CATEGORY_MAP (potential new menu items)
    for HREF in $HREFS; do
        [[ "$HREF" == "" || "$HREF" == "ai" || "$HREF" == "agentcore" ]] && continue
        DOC_PATH="${CATEGORY_MAP[$HREF]}"
        if [ -z "$DOC_PATH" ]; then
            echo "[menu-guide-sync] New menu item '$HREF' has no web guide mapping. Add guide to docs-site/docs/ and update this hook's CATEGORY_MAP."
        fi
    done
fi
