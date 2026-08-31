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
| [cognito-auth-issues.md](cognito-auth-issues.md) | Login failures, Lambda@Edge verification errors |
| [user-offboarding.md](user-offboarding.md) | Offboarding a departing employee's Cognito account — closing the account-takeover path (ADR-002/009) |
| [v1-to-v2-aurora-backfill.md](v1-to-v2-aurora-backfill.md) | v1→v2 Aurora history backfill |
| [v1-decommission.md](v1-decommission.md) | v1 legacy decommission — 5-phase procedure (ADR-016) |
| [agent-sql-reader.md](agent-sql-reader.md) | `execute_sql`/`inventory-read` Data API auth failures — `awsops_sql_reader` role/password sync (`apply → make migrate → make agentcore`) |

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
