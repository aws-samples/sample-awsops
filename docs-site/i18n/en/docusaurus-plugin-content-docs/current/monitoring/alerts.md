---
sidebar_position: 9
title: Alert Pipeline
description: CloudWatch / Alertmanager / Grafana webhook ingestion, correlation, automatic AI diagnosis, Slack notifications
---

# Alert Pipeline

Ingest alerts from external systems into AWSops and chain **correlation → automatic AI diagnosis → Slack notification** in a single pipeline.

## Supported Sources

| Source | Delivery | Normalizer |
|--------|---------|-----------|
| **CloudWatch Alarms** | SNS → SQS → EC2 poller | CloudWatch event schema |
| **Prometheus Alertmanager** | Direct webhook (HMAC) | Alertmanager v4 schema |
| **Grafana Alerting** | Direct webhook (HMAC) | Grafana unified alerting |
| **Generic JSON** | Direct webhook (HMAC) | Custom schema mapping |

## Architecture

```
[CloudWatch Alarm] → SNS Topic → SQS Queue
                                    ↓
                            [EC2 Poller (15s)]
                                    ↓
[Alertmanager/Grafana/Generic] → POST /awsops/api/alert-webhook
                                    ↓
                            [alert-correlation.ts]
                                    ↓
                         [alert-diagnosis.ts (AI)]
                                    ↓
                          [Slack/SNS dispatch]
```

Setup steps live in the server-side [runbook](https://github.com/Atom-oh/awsops/tree/main/docs/runbooks/alert-pipeline-troubleshoot.md).

## Webhook Endpoint

### POST /awsops/api/alert-webhook

| Parameter | Location | Description |
|-----------|----------|-------------|
| `X-Alert-Source` | Header | `cloudwatch`, `alertmanager`, `grafana`, `generic` |
| `X-Signature-256` | Header | HMAC-SHA256 signature (shared secret) |
| Body | JSON | Source-specific raw payload |

### HMAC Signature

Store the shared secret in `alertWebhookSecret` in `data/config.json`. The sender must HMAC-SHA256 the raw body and submit the result as `X-Signature-256: sha256=<hex>`.

```yaml
# Alertmanager webhook_configs example
- url: https://awsops.example.com/awsops/api/alert-webhook
  http_config:
    authorization:
      type: HMAC
      credentials: "<shared-secret>"
```

### GET /awsops/api/alert-webhook

Lists active incidents. The 🚨 badge in the dashboard header and the "Recent Incidents" card on the home page poll this endpoint every 30 seconds.

```json
{
  "activeCounts": { "total": 3, "critical": 1, "warning": 2 },
  "activeIncidents": [
    {
      "id": "inc-20260422-093015",
      "severity": "critical",
      "status": "investigating",
      "alertCount": 7,
      "affectedServices": ["payment-api", "order-service"],
      "topAlertName": "HTTPErrorRateHigh"
    }
  ]
}
```

## Correlation Engine

`src/lib/alert-correlation.ts` groups individual alerts into **incidents** using:

| Criterion | Default | Description |
|-----------|---------|-------------|
| **Time window** | 5 min | Merge alerts in the same service within 5 min |
| **Shared service** | ≥1 | `labels.service` or `resource` match |
| **Shared namespace** | ≥1 | `labels.namespace` match for K8s alerts |
| **Dedup** | 1 min | Same `fingerprint` within 1 min is suppressed |
| **Severity escalation** | `warning` → `critical` | 3 warnings in 5 min → escalate to critical |

## Automatic AI Diagnosis

`critical` incidents automatically trigger a scoped partial diagnosis:

1. **Build AlertContext** — extract affected services, resources, namespaces, earliest `since`
2. **Scoped collection** — filter CloudWatch queries to ±10 min around `since` and the affected resources
3. **Select sections** — run only 3–5 of the 15 sections (Compute / Network / Container as applicable)
4. **Change detection** — diff against recent Terraform state / CloudTrail events
5. **Bedrock analysis** — Claude Sonnet proposes probable root causes and next steps

:::tip Difference from full diagnosis
[AI Comprehensive Diagnosis](./ai-diagnosis.md) runs all 15 sections across all resources. Alert-Triggered Diagnosis is limited to the **alert's scope** and finishes in 1–2 minutes.
:::

## Slack Notifications

### Block Kit messages

Routed by severity per `slackChannels` in `data/config.json`:

| Severity | Default channel | Color |
|----------|----------------|-------|
| `critical` | `#incidents` | Red |
| `warning` | `#alerts` | Orange |
| `info` | `#alerts-low` | Blue |

### Thread updates

The first incident notification is posted as the **main message**; subsequent events (additional merged alerts, AI diagnosis results, resolution) are posted as **replies in the same thread**. Works in both Slack Webhook and Bot Token modes.

### Resolution

On CloudWatch `OK` or Alertmanager `resolved` events, a ✅ resolution reply is appended to the original thread.

## Alert Knowledge Base

Diagnosis records are persisted under `data/alert-diagnosis/`:

| File | Contents |
|------|----------|
| `incidents/<id>.json` | Individual incident + AI diagnosis |
| `summary-<YYYY-MM>.json` | Monthly stats (top services, alert names, resolution time) |

The **Knowledge Base** tab lets you search past similar incidents. When a new incident arrives, similar records are auto-suggested by similarity score.

## Noise Control

### Silences
Suppress label combinations for a period:

```json
{
  "silences": [
    {
      "matcher": { "service": "batch-job", "alertname": "HighCPU" },
      "startsAt": "2026-04-22T00:00:00Z",
      "endsAt":   "2026-04-22T06:00:00Z",
      "reason": "Overnight batch window"
    }
  ]
}
```

### Deduplication
Same `fingerprint` within 1 min → silently dropped.

## Tips

### Sending a test event
```bash
curl -X POST https://awsops.example.com/awsops/api/alert-webhook \
  -H 'X-Alert-Source: generic' \
  -H "X-Signature-256: sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')" \
  -H 'Content-Type: application/json' \
  -d "$BODY"
```

### Checking active incidents
Click the 🚨 badge in the dashboard header to jump to `/ai-diagnosis` and see in-flight incident details.

### No alerts coming through
The server-side runbook [alert-pipeline-troubleshoot.md](https://github.com/Atom-oh/awsops/tree/main/docs/runbooks/alert-pipeline-troubleshoot.md) has a symptom-based checklist.

## Related Pages

- [AI Comprehensive Diagnosis](./ai-diagnosis.md) — full 15-section diagnosis
- [CloudWatch](./cloudwatch) — alarm origin
- [External Datasources](./datasources) — Alertmanager/Grafana query sources

## References

- ADR-009: Alert-triggered AI diagnosis
- ADR-012: SNS notification strategy
- ADR-013: Auto-collection investigation agent
