import { NextResponse } from 'next/server';

/**
 * Fail-closed gate shared by every Network Path Check route. NETWORK_PATH_CHECK_ENABLED is set on
 * the web task ONLY when `network_path_check_enabled=true` in Terraform
 * (terraform/foundation/network-path.tf's local.npc) — off (the default) means no worker
 * capability exists to ever process a `network_path` job, so every route here 503s instead of
 * silently enqueuing a job nothing will process (mirrors the steampipe_enabled-gated routes'
 * "flag off -> unconfigured" contract, e.g. app/api/compliance/run and app/api/sg/rules/refresh).
 */
export function networkPathCheckGate(): NextResponse | null {
  if (process.env.NETWORK_PATH_CHECK_ENABLED !== 'true') {
    return NextResponse.json(
      { status: 'unconfigured', message: 'network path check is disabled' },
      { status: 503 },
    );
  }
  return null;
}

/**
 * Capability probe (L2 finding #3, round 2; corrected round 17). `scripts/v2/workers/
 * network_path.py`'s `fetch_live_topology()` is REAL now — best-effort discovery from CACHED
 * Aurora topology (`topology_nodes`/`topology_edges`, `class='infra'`), not the `NotImplementedError`
 * stub this comment used to describe. What is STILL missing is the full live-topology guarantee
 * this gate is meant to cover: a live AWS/Kubernetes re-read at run time (the design spec's
 * original "re-read SG/NACL/routes/etc. live" promise) — `fetch_live_topology()` deliberately makes
 * no live AWS/K8s call at all, so its output can be stale relative to the account's current state.
 * `LIVE_TOPOLOGY_IMPLEMENTED` therefore stays `false` — this is a deliberate product decision (ship
 * the cache-only accelerator now, gate the LIVE guarantee separately), not an oversight left behind
 * by the round-17 pass that made the fetcher real. Flip it to `true` only in the same commit that
 * gives Network Path a genuine live AWS/K8s re-read path — this is a code-level fact, not an
 * environment toggle, so it is not read from `process.env`.
 */
const LIVE_TOPOLOGY_IMPLEMENTED = false;

export function networkPathLiveTopologyCapabilityGate(): NextResponse | null {
  if (!LIVE_TOPOLOGY_IMPLEMENTED) {
    return NextResponse.json(
      {
        status: 'unimplemented',
        message: 'Network Path Check cannot start a new run yet — discovery uses cached ' +
          'topology data only; a full live AWS/Kubernetes re-read (fetch_live_topology) is not ' +
          'implemented in this release. Existing checks and prior run history remain viewable.',
      },
      { status: 503 },
    );
  }
  return null;
}
