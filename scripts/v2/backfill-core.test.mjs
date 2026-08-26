// scripts/v2/backfill-core.test.mjs — unit tests for the pure backfill core.
// Run: node --test scripts/v2/backfill-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDateFile, isMonthDir, isAlertRecordFile, normalizeAccount, partitionAccountDir,
  mapInventory, mapCost, mapAlert, mapScaling, VALID_SCALING_STATUS,
} from './backfill-core.mjs';

// --- classification --------------------------------------------------------

test('isDateFile accepts YYYY-MM-DD.json, rejects everything else', () => {
  assert.ok(isDateFile('2026-06-01.json'));
  assert.ok(!isDateFile('.prev_123456789012.json'));
  assert.ok(!isDateFile('latest.json'));
  assert.ok(!isDateFile('2026-06-01.txt'));
  assert.ok(!isDateFile('2026-6-1.json')); // not zero-padded
  assert.ok(!isDateFile('2026-06-01'));
});

test('isMonthDir matches YYYY-MM only', () => {
  assert.ok(isMonthDir('2026-06'));
  assert.ok(!isMonthDir('2026-06-01'));
  assert.ok(!isMonthDir('summary-2026-06'));
});

test('isAlertRecordFile skips summaries', () => {
  assert.ok(isAlertRecordFile('inc-abc123.json'));
  assert.ok(!isAlertRecordFile('summary.json'));
  assert.ok(!isAlertRecordFile('summary-2026-06.json'));
  assert.ok(!isAlertRecordFile('inc-abc123.txt'));
});

test('normalizeAccount maps aws→aggregate, leaves others', () => {
  assert.equal(normalizeAccount('aws'), 'aggregate');
  assert.equal(normalizeAccount('123456789012'), '123456789012');
  assert.equal(normalizeAccount('self'), 'self');
});

test('partitionAccountDir splits account dirs vs root date files, skips junk', () => {
  const entries = [
    { name: '123456789012', isDirectory: true },
    { name: 'aws', isDirectory: true },
    { name: '2026-06-01.json', isDirectory: false },
    { name: '.prev_123456789012.json', isDirectory: false },
    { name: 'latest.json', isDirectory: false },
  ];
  const { accountDirs, rootDateFiles } = partitionAccountDir(entries);
  assert.deepEqual(accountDirs, ['123456789012', 'aws']);
  assert.deepEqual(rootDateFiles, ['2026-06-01.json']);
});

test('partitionAccountDir on a pure single-account dir', () => {
  const { accountDirs, rootDateFiles } = partitionAccountDir([
    { name: '2026-06-01.json', isDirectory: false },
    { name: '2026-06-02.json', isDirectory: false },
  ]);
  assert.deepEqual(accountDirs, []);
  assert.deepEqual(rootDateFiles, ['2026-06-01.json', '2026-06-02.json']);
});

// --- mappers ---------------------------------------------------------------

test('mapInventory fans out one row per label + correct payload', () => {
  const r = mapInventory(
    { date: '2026-06-01', timestamp: '2026-06-01T09:30:00Z', resources: { 'EC2 Instances': 12, 'S3 Buckets': 3 } },
    '123456789012',
  );
  assert.equal(r.account, '123456789012');
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows.map((x) => x.resourceType), ['EC2 Instances', 'S3 Buckets']);
  assert.equal(r.rows[0].resourceCount, 12);
  assert.deepEqual(JSON.parse(r.rows[0].payload), { date: '2026-06-01', timestamp: '2026-06-01T09:30:00Z' });
  assert.equal(r.capturedAt, '2026-06-01T09:30:00Z');
  assert.equal(r.dayStartISO, '2026-06-01T00:00:00.000Z');
  assert.equal(r.dayNextISO, '2026-06-02T00:00:00.000Z');
});

test('mapInventory falls back to date when timestamp absent; empty resources → no rows', () => {
  const r = mapInventory({ date: '2026-06-05', resources: {} }, 'aws');
  assert.equal(r.account, 'aggregate'); // aws → aggregate
  assert.equal(r.capturedAt, '2026-06-05T00:00:00Z');
  assert.equal(r.dayStartISO, '2026-06-05T00:00:00.000Z');
  assert.equal(r.dayNextISO, '2026-06-06T00:00:00.000Z');
  assert.equal(r.rows.length, 0);
});

test('mapCost → SNAPSHOT granularity + bundled payload', () => {
  const r = mapCost(
    { date: '2026-06-01', timestamp: '2026-06-01T09:30:00Z', monthlyCost: [{ m: 1 }], dailyCost: [{ d: 2 }], serviceCost: [{ s: 3 }] },
    'self',
  );
  assert.equal(r.account, 'self');
  assert.equal(r.periodStart, '2026-06-01');
  assert.equal(r.periodEnd, '2026-06-01');
  assert.equal(r.granularity, 'SNAPSHOT');
  const p = JSON.parse(r.payload);
  assert.deepEqual(p.monthlyCost, [{ m: 1 }]);
  assert.deepEqual(p.dailyCost, [{ d: 2 }]);
  assert.deepEqual(p.serviceCost, [{ s: 3 }]);
  assert.equal(p.capturedAt, '2026-06-01T09:30:00Z');
});

test('mapAlert defaults source=unknown, fingerprint=null, payload=record', () => {
  const rec = {
    incidentId: 'inc-1', timestamp: '2026-06-01T00:00:00Z', severity: 'critical',
    affectedServices: ['api'], affectedResources: ['i-1'], rootCause: 'x',
  };
  const r = mapAlert(rec);
  assert.equal(r.source, 'unknown');
  assert.equal(r.fingerprint, null);
  assert.equal(r.occurredAt, '2026-06-01T00:00:00Z');
  assert.deepEqual(r.services, ['api']);
  assert.deepEqual(r.resources, ['i-1']);
  assert.deepEqual(JSON.parse(r.payload), rec);
  assert.equal(mapAlert(rec, { source: 'cloudwatch' }).source, 'cloudwatch');
});

test('mapAlert skips a record missing required NOT NULL fields', () => {
  const r = mapAlert({ severity: 'high' }); // no incidentId/timestamp
  assert.equal(r.skip, true);
});

test('mapScaling maps fields and null-coalesces optionals', () => {
  const ev = { eventId: 'e-1', name: 'Black Friday', eventStart: '2026-11-27T00:00:00Z', status: 'approved' };
  const r = mapScaling(ev);
  assert.equal(r.planId, 'e-1');
  assert.equal(r.eventName, 'Black Friday');
  assert.equal(r.eventEndAt, null);
  assert.equal(r.ownerEmail, null);
  assert.equal(r.status, 'approved');
  assert.deepEqual(JSON.parse(r.payload), ev);
});

test('mapScaling skips out-of-set status and missing required fields', () => {
  assert.equal(mapScaling({ eventId: 'e', name: 'n', eventStart: 't', status: 'bogus' }).skip, true);
  assert.equal(mapScaling({ name: 'n', eventStart: 't', status: 'approved' }).skip, true); // no eventId
  assert.ok(VALID_SCALING_STATUS.has('plan-ready'));
});
