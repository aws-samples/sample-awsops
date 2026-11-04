import { enqueueJob } from '@/lib/jobs';

/**
 * Ask the worker to register this datasource kind's connector on the AgentCore external-obs
 * gateway (connector_target_sync, scripts/v2/workers/connector_targets.py), so chat can call it
 * right after an administrator adds the datasource. The worker is idempotent and only
 * creates/updates awsops-owned targets (ADR-005 owner clarification 2026-11-04). Best-effort: a
 * failed enqueue never blocks registration; `make agentcore` remains the full reconciler.
 */
export async function enqueueConnectorTargetSync(kind: string): Promise<void> {
  if (process.env.CONNECTOR_TARGET_SYNC_ENABLED !== 'true') return;
  try {
    await enqueueJob('connector_target_sync', { kind });
  } catch {
    /* swallow — registration already succeeded */
  }
}
