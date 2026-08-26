---
sidebar_position: 9
title: Alert Pipeline Settings
description: Webhook ingestion + HMAC auth + correlation + AI auto-diagnosis + Slack notifications (admin-only)
---

import Screenshot from '@site/src/components/Screenshot';

# Alert Pipeline Settings

The `/alert-settings` page configures the entire pipeline — webhook ingestion, AI auto-diagnosis triggering, and Slack notification dispatch — in one place. **Admin-only**: gated by `adminEmails` in `data/config.json`.

<Screenshot src="/screenshots/overview/alert-settings.png" alt="Alert Pipeline Settings (Access Denied screen — admin-only)" />

:::caution Admin-only
Non-admin users see the **Access Denied** screen shown above. See the textual description below for what admin users actually see.
:::

## End-to-End Flow

```
[External]                       [AWSops]
CloudWatch SNS  ─┐
Alertmanager    ─┤              ┌─→ Correlation ─→ Diagnosis ─→ Slack
Grafana         ─┼─→ Webhook ───┤                  (Bedrock      (Block Kit)
SQS poller      ─┤    + HMAC    ├─→ Knowledge      Opus)
Generic JSON    ─┘              │   Base
                                └─→ Stats
```

## Page Sections

### 1. Master Toggle
Enable/disable the entire pipeline. When off, webhooks are still received but diagnosis is not triggered.

### 2. Alert Sources (5)

| Source | Label | Payload normalizer | Auth |
|--------|-------|-------------------|------|
| `cloudwatch` | CloudWatch Alarm (SNS) | `normalizeCloudWatchAlarm()` | SNS subscription confirm |
| `alertmanager` | Prometheus Alertmanager | `normalizeAlertmanager()` | HMAC-SHA256 secret |
| `grafana` | Grafana Alerting | `normalizeGrafana()` | HMAC-SHA256 secret |
| `sqs` | AWS SQS Queue | SNS→SQS message body | IAM (SQS poller) |
| `generic` | Generic Webhook | `normalizeGeneric()` | HMAC-SHA256 secret |

For each source:
- **Enabled** toggle
- **Secret** — HMAC verification secret (active + standby pair during rotation)
- **(SQS only)** Queue URL + Region

### 3. Webhook URL
The page shows the copy-ready endpoint:

```
https://<your-host>/awsops/api/alert-webhook?source=alertmanager
```

The sender must compute HMAC with the same secret and pass it in the `X-AWSops-Signature` header.

### 4. Diagnosis Config (Advanced)

| Field | Default | Description |
|-------|---------|-------------|
| `correlationWindowSeconds` | 30 | Window to group same-incident alerts |
| `deduplicationWindowMinutes` | 15 | Window to ignore identical incidents |
| `cooldownMinutes` | 5 | Minimum interval before re-diagnosing the same resource |
| `maxConcurrentInvestigations` | 3 | Concurrent Bedrock invocation cap (cost control) |
| `investigationTimeoutSeconds` | 120 | Bedrock response timeout |
| `includeChangeDetection` | true | Auto-attach recent git / CloudTrail changes |
| `knowledgeBaseEnabled` | true | Search past similar incidents and attach |
| `minimumSeverity` | `warning` | Minimum severity for auto-diagnosis |

Set `minimumSeverity = critical` to limit AI runs to critical incidents only (cost saving).

### 5. Slack

| Field | Description |
|-------|-------------|
| `enabled` | Master Slack toggle |
| `method` | `bot` (Bot Token) / `webhook` (Incoming Webhook) |
| `botToken` | Slack Bot Token (`xoxb-...`) |
| `webhookUrl` | Webhook URL when `method=webhook` |
| `defaultChannel` | Fallback channel like `#ops-alerts` |
| `channelMapping` | Severity → channel routing |
| `threadUpdates` | Group follow-ups in the same Slack thread |

**Default channel mapping:**
```
critical → #ops-critical
warning  → #ops-alerts
info     → #ops-general
```

**Test Slack** sends a dummy message to verify the wiring.

### 6. Diagnosis History
The history section shows:

- Recent incidents (incidentId, timestamp, alertNames, rootCause, confidence)
- Stats: total incidents, severity distribution, category distribution, top alert names, avg processing time
- Each row expands to show the full Bedrock diagnosis markdown

## How Correlation Works

`alert-correlation.ts` groups alerts by:

1. **Time** — within `correlationWindowSeconds` (default 30s)
2. **Service** — same `service` label (e.g. `eks`, `rds`)
3. **Resource** — same `resourceArn`/`namespace`/`instanceId`
4. **Severity escalation** — accumulated `warning`s in a group get escalated to `critical`
5. **Dedup** — identical signatures within `deduplicationWindowMinutes` (default 15m) merge into a single incident

When a grouped incident meets `minimumSeverity`, `alert-diagnosis.ts` auto-fires.

## AI Diagnosis Flow

1. Scope is limited to the affected services/resources/namespaces
2. Collectors (`src/lib/collectors/*.ts`) and external datasources (Prometheus, Loki, etc.) are called in parallel
3. If `includeChangeDetection` is on, recent git commits and CloudTrail events are attached
4. If `knowledgeBaseEnabled` is on, the 5 most similar past incidents are attached
5. Bedrock Claude Opus runs the analysis → markdown answer + evidence metadata
6. Slack receives a Block Kit card (replied into the existing thread if `threadUpdates` is on)

## HMAC Secret Rotation

1. Enter a new secret in the **Standby** slot and save
2. Switch the sender to the new secret (both secrets are valid)
3. Once the sender is fully cut over, **Promote** standby to active
4. Discard the old secret

This active+standby 2-key policy enables zero-downtime secret rotation.

## API

```bash
# Read config
curl '/awsops/api/steampipe?action=config'

# Admin check
curl '/awsops/api/steampipe?action=admin-check'

# Diagnosis history
curl '/awsops/api/alert-webhook'

# Slack test
curl -X POST '/awsops/api/notification' \
  -H 'Content-Type: application/json' \
  -d '{"action":"test","channel":"#ops-alerts"}'

# Send a synthetic alert (testing)
curl -X POST '/awsops/api/alert-webhook?source=generic' \
  -H 'X-AWSops-Signature: <hmac>' \
  -H 'Content-Type: application/json' \
  -d '{"source":"manual","title":"Test alert","severity":"warning","message":"Hello"}'
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| 401 Unauthorized | HMAC verification failed | Re-sync secret; header name is `X-AWSops-Signature` |
| No auto-diagnosis | Severity below minimum | Lower `minimumSeverity` or fix the source severity mapping |
| No Slack message | Bot Token missing scopes | Add `chat:write`, `chat:write.public` to the OAuth scopes |
| Bedrock timeout | `investigationTimeoutSeconds` too short | Raise 120s → 180s, check datasource latency |
| Alert flood | `deduplicationWindowMinutes` too short | Raise 15m → 30m, add per-source cooldown |

## Related Pages

- [AI Comprehensive Diagnosis](./ai-diagnosis) — base of alert-triggered partial diagnosis
- [External Datasources](./datasources) — what gets queried in parallel during diagnosis
- [Monitoring](./monitoring.md) — alarm origin (CloudWatch metrics view)
- [AgentCore](../overview/agentcore) — the AI runtime that performs diagnosis

## References

- ADR-022: alert correlation policy
- ADR-026: HMAC active+standby 2-key rotation
- `src/lib/alert-types.ts` — 5-source normalization
- `src/lib/alert-correlation.ts` — grouping / dedup / escalation
- `src/lib/alert-diagnosis.ts` — Bedrock diagnosis orchestration
- `src/lib/slack-notification.ts` — Block Kit + channel routing
