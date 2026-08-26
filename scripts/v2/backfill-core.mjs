// scripts/v2/backfill-core.mjs
// Pure helpers for the v1 → v2 Aurora backfill (driven by scripts/v2/backfill-v1.mjs).
// No fs, no DB, no side effects — unit-tested in backfill-core.test.mjs (`node --test`).
//
// Spec:    docs/superpowers/specs/2026-06-12-v1-to-v2-aurora-backfill-design.md
// Mapping: derived verbatim from src/lib/db/*-writer.ts (zero parity drift with the
//          v1 runtime dual-write layer) and the DDL in
//          terraform/foundation/data/schema.sql.

const DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/;
const MONTH_DIR_RE = /^\d{4}-\d{2}$/;
const SUMMARY_TOP_RE = /^summary-\d{4}-\d{2}\.json$/;

// ---------------------------------------------------------------------------
// Directory / file classification
// ---------------------------------------------------------------------------

/** A per-(account,day) snapshot file: exactly `YYYY-MM-DD.json`. */
export function isDateFile(name) {
  return DATE_FILE_RE.test(name);
}

/** An alert-diagnosis month directory: exactly `YYYY-MM`. */
export function isMonthDir(name) {
  return MONTH_DIR_RE.test(name);
}

/** A per-incident alert record file: a `.json` that is not a monthly summary. */
export function isAlertRecordFile(name) {
  return name.endsWith('.json') && name !== 'summary.json' && !SUMMARY_TOP_RE.test(name);
}

/** The Steampipe aggregator key `aws` is stored as `aggregate` (mirrors the writers). */
export function normalizeAccount(id) {
  return id === 'aws' ? 'aggregate' : id;
}

/**
 * Partition an `inventory/` or `cost/` directory listing into per-account
 * subdirectories (multi-account layout) and root-level single-account date
 * files. Skips `.prev_*`, the root aggregate, and any non-date file at the root.
 *
 * @param {Array<{name: string, isDirectory: boolean}>} entries
 * @returns {{accountDirs: string[], rootDateFiles: string[]}}
 */
export function partitionAccountDir(entries) {
  const accountDirs = [];
  const rootDateFiles = [];
  for (const e of entries) {
    if (e.isDirectory) accountDirs.push(e.name);
    else if (isDateFile(e.name)) rootDateFiles.push(e.name);
  }
  return { accountDirs, rootDateFiles };
}

// ---------------------------------------------------------------------------
// Record → row mappers  (one per v1 store; columns match schema.sql exactly)
// ---------------------------------------------------------------------------

function utcDayBounds(iso) {
  const t = new Date(iso);
  const start = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  const next = new Date(start.getTime() + 24 * 3_600_000);
  return { dayStartISO: start.toISOString(), dayNextISO: next.toISOString() };
}

/**
 * v1 InventorySnapshot {date, timestamp, resources:{label→count}} →
 * one inventory_snapshots row per label (fan-out). DELETE-day bounds and
 * captured_at both use the RESOLVED timestamp (post-fallback) so a missing
 * `timestamp` still clears the correct day. Mirrors src/lib/db/inventory-writer.ts.
 */
export function mapInventory(snapshot, accountId) {
  const account = normalizeAccount(accountId);
  const capturedAt = snapshot.timestamp || `${snapshot.date}T00:00:00Z`;
  const { dayStartISO, dayNextISO } = utcDayBounds(capturedAt);
  const payload = JSON.stringify({ date: snapshot.date, timestamp: snapshot.timestamp });
  const rows = Object.entries(snapshot.resources || {}).map(([resourceType, count]) => ({
    account, capturedAt, resourceType, resourceCount: Number(count) || 0, payload,
  }));
  return { account, capturedAt, dayStartISO, dayNextISO, rows };
}

/**
 * v1 CostSnapshot {date, timestamp, monthlyCost, dailyCost, serviceCost} →
 * one cost_snapshots row, granularity sentinel 'SNAPSHOT'. UPSERT on
 * (account_id, period_start, period_end, granularity). Mirrors cost-writer.ts.
 */
export function mapCost(snapshot, accountId) {
  const account = normalizeAccount(accountId);
  const payload = JSON.stringify({
    monthlyCost: snapshot.monthlyCost ?? [],
    dailyCost: snapshot.dailyCost ?? [],
    serviceCost: snapshot.serviceCost ?? [],
    capturedAt: snapshot.timestamp,
  });
  return { account, periodStart: snapshot.date, periodEnd: snapshot.date, granularity: 'SNAPSHOT', payload };
}

/**
 * v1 DiagnosisRecord → alert_diagnosis row. INSERT … ON CONFLICT(incident_id)
 * DO NOTHING. `source` is not in the record (default via opts), `fingerprint`
 * is not in the record (NULL). payload = the whole record (matches the writer's
 * buildPayload shape). Backfill-specific (the writer takes Incident+Result).
 */
export function mapAlert(record, opts = {}) {
  const source = opts.source || 'unknown';
  if (!record.incidentId || !record.timestamp || !record.severity) {
    return { skip: true, reason: 'missing required incidentId/timestamp/severity' };
  }
  return {
    incidentId: record.incidentId,
    occurredAt: record.timestamp,
    severity: record.severity,
    source,
    services: record.affectedServices ?? [],
    resources: record.affectedResources ?? [],
    fingerprint: null,
    payload: JSON.stringify(record),
  };
}

export const VALID_SCALING_STATUS = new Set([
  'planned', 'analyzing', 'plan-ready', 'approved', 'cancelled',
]);

/**
 * v1 ScalingEvent → event_scaling_plans row. UPSERT on plan_id. A record that
 * would violate a CHECK/NOT NULL constraint (status outside the set, or missing
 * eventId/name/eventStart) is reported as {skip}. Mirrors event-scaling-writer.ts.
 */
export function mapScaling(event) {
  if (!event.eventId || !event.name || !event.eventStart) {
    return { skip: true, reason: 'missing required eventId/name/eventStart' };
  }
  if (!VALID_SCALING_STATUS.has(event.status)) {
    return { skip: true, reason: `status '${event.status}' not in CHECK set` };
  }
  return {
    planId: event.eventId,
    eventName: event.name,
    eventStartAt: event.eventStart,
    eventEndAt: event.eventEnd ?? null,
    status: event.status,
    ownerEmail: event.createdBy ?? null,
    payload: JSON.stringify(event),
  };
}
