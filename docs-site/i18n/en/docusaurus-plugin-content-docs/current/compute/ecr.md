---
sidebar_position: 4
title: ECR
description: ECR repositories, images, vulnerability scan information
---

import Screenshot from '@site/src/components/Screenshot';

# ECR (Elastic Container Registry)

A page for viewing ECR repository and image information.

:::info How this is served in v2
This screen isn't a dedicated page — it's served through v2's shared inventory view (`/inventory/ecr`, under the "Compute" group in the sidebar). The content below reflects the actual v2 inventory view configuration (`HIGHLIGHTS.ecr`/`INVENTORY_TYPES.ecr` in `web/lib/inventory-types.ts`), not v1's dedicated ECR page.
:::

<Screenshot src="/screenshots/compute/ecr.png" alt="ECR" />

## Key Features

### Highlight Cards
- **Scan on Push**: Number of repositories with automatic scan on image push enabled
- **Immutable tags**: Number of repositories with tag immutability (IMMUTABLE) set
- **Mutable tags**: Number of repositories with tag mutability (MUTABLE) set

There is no card showing total repository count (check the table row count instead).

### Repository Table
| Column | Description |
|--------|-------------|
| URI | Repository URI (image push/pull address) |
| Tag mutability | Tag mutability (MUTABLE/IMMUTABLE) |
| Created | Creation date |

Scan-on-push status and encryption type are **not table columns** — scan-on-push is shown on the highlight cards above, and encryption is in the detail panel below.

### Detail Panel
Click a repository to view detailed information:
- **Identity section**: Name, Account, Region, ARN, Registry ID, URI, Created
- **Config section**: Tag Mutability, Image Scanning Configuration (includes scan-on-push), Lifecycle Policy
- **Security section**: Encryption Configuration (AES256/KMS)
- **Tags section**: Tags configured on the repository

## How to Use

1. Click **Compute > ECR** in the sidebar
2. Review Scan on Push / immutable-tag status from the highlight cards at the top
3. Click a repository to view its URI, Scan on Push, and Encryption settings

## Security Configuration Guide

### Scan on Push
- **Recommended**: Enable on all repositories
- Automatically runs vulnerability scan on image push
- Discovered CVEs can be viewed on the Security page

### Immutable Tags
- **Recommended**: Enable on production repositories
- Tags pushed once cannot be overwritten
- Useful for deployment tracking and rollback

### Encryption
- **AES256**: Default AWS managed encryption
- **KMS**: When using Customer Managed Keys (CMK)

## Tips

:::tip Enable Scan on Push
If the Scan on Push count on the highlight card is lower than the total repository count, some repositories have scanning disabled. Check each one in the Config section of its detail panel.
:::

:::tip Copy Image URI
You can find the full address for `docker pull` or `docker push` in the URI field of the detail panel.
:::

:::info AI Analysis
You can analyze with the AI Assistant using queries like "ECR repository list", "Find repositories with scan disabled", "Analyze container image vulnerabilities", etc.
:::

## Related Pages

- [ECS](../compute/ecs) - ECS services using ECR images
- [EKS](../compute/eks) - EKS clusters using ECR images
- [Security](../security) - Image vulnerabilities (CVE) check
