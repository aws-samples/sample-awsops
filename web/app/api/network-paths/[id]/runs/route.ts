import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { EnqueueDeliveryError, IdempotencyKeyCollisionError } from '@/lib/jobs';
import { NotFoundError, createRun, getCheck, listRunsForCheck } from '@/lib/network-path';
import { networkPathCheckGate, networkPathLiveTopologyCapabilityGate } from '@/lib/network-path-gate';

export const dynamic = 'force-dynamic';

/**
 * Run history for one check (spec "UI and ownership": "Any authorized viewer may run the check
 * and view its history") — most-recent-first, capped at 50. 404s only when the parent check row
 * itself doesn't exist; a soft-deleted check's prior runs remain visible (softDeleteCheck never
 * touches network_path_runs/*, so its evidence must stay reachable for audit/comparison).
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  const blocked = networkPathCheckGate();
  if (blocked) return blocked;

  const check = await getCheck(params.id);
  if (!check) return NextResponse.json({ message: 'not found' }, { status: 404 });
  const runs = await listRunsForCheck(params.id);
  return NextResponse.json({ runs });
}

/**
 * Validates ownership/access via createRun() (check must exist and not be soft-deleted; any
 * authenticated user may run a visible check per the spec), snapshots the definition, creates the
 * run row, and enqueues the `network_path` job directly — this NEVER goes through the generic
 * POST /api/jobs (ADR-009 dedicated-route pattern, same as /api/diagnosis and /api/compliance/run).
 *
 * L2 finding #3 (round 2): a NEW run is refused outright by `networkPathLiveTopologyCapabilityGate`
 * — this is NOT because `fetch_live_topology()` is unimplemented (it is real now: a best-effort
 * cache-only discovery from Aurora's synced topology, see `network-path-gate.ts`'s own comment).
 * The gate stays closed because that cache-only fetcher does not yet satisfy this feature's
 * original promise of a full LIVE AWS/Kubernetes re-read at run time, so a new run's results could
 * be stale relative to the account's current state — a deliberate product decision (ship the
 * cache-only accelerator, gate the live guarantee separately), not a guaranteed-failure avoidance.
 * Existing checks and prior run history remain viewable regardless of this gate.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  const blocked = networkPathCheckGate();
  if (blocked) return blocked;
  const capabilityBlocked = networkPathLiveTopologyCapabilityGate();
  if (capabilityBlocked) return capabilityBlocked;

  try {
    const run = await createRun(user, params.id);
    return NextResponse.json({ run }, { status: 202 });
  } catch (e) {
    if (e instanceof NotFoundError) return NextResponse.json({ message: 'check not found or deleted' }, { status: 404 });
    if (e instanceof EnqueueDeliveryError) {
      return NextResponse.json({ run_id: e.job_id, enqueue: 'failed', message: e.message }, { status: 202 });
    }
    if (e instanceof IdempotencyKeyCollisionError) {
      return NextResponse.json({ message: e.message }, { status: 409 });
    }
    return NextResponse.json({ message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
