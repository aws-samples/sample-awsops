import { enqueueJob } from '@/lib/jobs';

const CONNECTOR_TARGET_KINDS = new Set(['clickhouse', 'prometheus', 'loki', 'tempo', 'mimir']);

/**
 * Ask the worker to register this datasource kind's connector on its AgentCore catalog
 * gateway (external-obs or monitoring) (connector_target_sync, scripts/v2/workers/connector_targets.py), so chat can use it
 * once the gateway finishes registering the target. The worker is idempotent and only
 * creates/updates one connector target (ADR-023, ADR-005 owner-override exception, 2026-11-05). Best-effort: a
 * failed enqueue never blocks registration; `make agentcore` remains the full reconciler.
 */
export async function enqueueConnectorTargetSync(kind: string, requestedBy?: string | null): Promise<void> {
  if (process.env.CONNECTOR_TARGET_SYNC_ENABLED !== 'true') return;
  if (!CONNECTOR_TARGET_KINDS.has(kind)) return;
  try {
    await enqueueJob('connector_target_sync', { kind }, { requestedBy: requestedBy ?? null });
  } catch {
    /* swallow — registration already succeeded */
  }
}
