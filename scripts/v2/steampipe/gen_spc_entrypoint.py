#!/usr/bin/env python3
"""Steampipe container entrypoint: generate aws.spc from Aurora, then supervise the service.

Reads the enabled accounts + their scan scope from Aurora (account_regions / all_regions), renders
the multi-account/region connection config via spc_render, writes it, then starts `steampipe
service start` as a child process (Python stays alive as the ECS PID-1 supervisor).

Aurora auth uses IAM database authentication (M1 fix): the task role has `rds-db:connect` scoped
to the dedicated least-privilege `steampipe_reader` Postgres role (SELECT-only on accounts/
account_regions — see the steampipe_reader migration), and this entrypoint generates a fresh
short-lived signed token per connection via boto3 `generate_db_auth_token`. NO Aurora secret of
any kind (master or otherwise) is ever granted to this task or held in its environment/heap — the
network-listening Steampipe process (port 9193) cannot leak a DB credential it never has.

On Aurora-unreachable: bounded retry, then fail-closed (exit non-zero) — never start with an
empty/stale config. A background watchdog re-queries Aurora every SCOPE_WATCH_INTERVAL seconds and
restarts Steampipe when account/region scope changes (MAJOR 3 fix — M3).
"""
import os
import signal
import ssl
import subprocess
import sys
import threading
import time

import boto3
import pg8000.native

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from spc_render import render_spc  # noqa: E402

SPC_PATH = os.environ.get("AWS_SPC_PATH", "/home/steampipe/.steampipe/config/aws.spc")
AURORA_USER = os.environ.get("AURORA_USER", "steampipe_reader")
# RDS global CA truststore bundle, baked into the image at build time (see Dockerfile) — enables
# certificate-verified TLS (VERIFY_FULL) on the Aurora connection (M3 fix).
RDS_CA_BUNDLE = os.environ.get("RDS_CA_BUNDLE", "/app/rds-ca-bundle.pem")
# Scope watchdog interval. Re-querying Aurora every 5 min keeps the hot Steampipe config in sync
# with account/region mutations without requiring a full task replacement. Low enough to catch
# changes within a single sync-lambda cycle; high enough to avoid Aurora connection spam.
SCOPE_WATCH_INTERVAL = int(os.environ.get("SCOPE_WATCH_INTERVAL", "300"))

# Mirrors lib/account-regions.ts listScanScope(): one row per enabled account with its scan scope.
QUERY = (
    "SELECT a.account_id, a.is_host, a.role_name, a.external_id, a.all_regions, "
    "COALESCE(array_agg(r.region ORDER BY r.region) FILTER (WHERE r.enabled), '{}') AS regions "
    "FROM accounts a LEFT JOIN account_regions r ON r.account_id = a.account_id "
    "WHERE a.enabled = true "
    "GROUP BY a.account_id, a.is_host, a.role_name, a.external_id, a.all_regions "
    "ORDER BY a.account_id"
)


def _generate_auth_token() -> str:
    """A fresh short-lived (15 min) IAM-signed token, used as the Postgres password for
    AURORA_USER. Generated from the TASK role's credentials (ECS metadata endpoint) — no
    Aurora secret is read or stored anywhere (M1 fix)."""
    client = boto3.client("rds", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    return client.generate_db_auth_token(
        DBHostname=os.environ["AURORA_ENDPOINT"], Port=5432, DBUsername=AURORA_USER,
    )


def _connect():
    # IAM database auth over a certificate-VERIFIED TLS channel (M3 fix, round 5): the RDS global
    # CA bundle is baked into the image at build time, so ssl.create_default_context(cafile=...)
    # defaults to check_hostname=True + verify_mode=CERT_REQUIRED (VERIFY_FULL) — a genuine
    # improvement over the earlier CERT_NONE, which relied on VPC network controls alone for MITM
    # protection on a credential-bearing connection.
    ctx = ssl.create_default_context(cafile=RDS_CA_BUNDLE)
    return pg8000.native.Connection(
        user=AURORA_USER, password=_generate_auth_token(),
        host=os.environ["AURORA_ENDPOINT"], database=os.environ["AURORA_DATABASE"],
        port=5432, ssl_context=ctx,
    )


def fetch_rows():
    conn = _connect()
    try:
        rows = conn.run(QUERY)
        cols = [c["name"] for c in conn.columns]
        return [dict(zip(cols, r)) for r in rows]
    finally:
        conn.close()


def write_spc(spc: str) -> None:
    os.makedirs(os.path.dirname(SPC_PATH), exist_ok=True)
    with open(SPC_PATH, "w") as f:
        f.write(spc)


def _start_steampipe() -> "subprocess.Popen[bytes]":
    # No Aurora credential of any kind is ever in this process's environment (M1) — Steampipe
    # inherits the parent env unchanged; the only DB-adjacent secret it needs is its OWN network-
    # listener auth password (STEAMPIPE_DATABASE_PASSWORD), which is legitimately its concern.
    return subprocess.Popen(
        ["steampipe", "service", "start",
         "--database-listen", "network",
         "--database-port", "9193",
         "--foreground"],
    )


def _stop_steampipe_service(timeout: int = 30) -> None:
    """Explicitly stop the Steampipe service via its own CLI before every restart (M-A fix).
    `steampipe service start --foreground` manages an embedded PostgreSQL plus an on-disk
    service-state lock; killing only our immediate Popen child (terminate()/kill()) does not
    guarantee that lock/embedded-PG teardown completes synchronously — the next `service start`
    could then fail with "already running" or a still-bound port 9193, turning a routine
    scope-change or crash restart into a restart loop. `service stop --force` is Steampipe's own
    documented, canonical way to guarantee a clean stop regardless of how our process-level
    terminate()/kill() sequence went. Best-effort: if this itself fails/times out, we still
    proceed to `_start_steampipe()` — a failed `service start` there will fail closed via the
    existing crash-restart/backoff path rather than silently degrading."""
    try:
        subprocess.run(["steampipe", "service", "stop", "--force"],
                        timeout=timeout, capture_output=True)
    except Exception as e:  # noqa: BLE001
        print(f"[gen-spc] steampipe service stop --force failed (continuing): {e}", file=sys.stderr)


def _on_signal(signum: int, _frame: object, proc_ref: list, stop: "threading.Event") -> None:
    """SIGTERM/SIGINT handler. Signal handlers in CPython run on the main thread at the next
    bytecode boundary — if the main thread is inside `with proc_lock:` (e.g. the supervisor loop's
    restart block) when the signal arrives, and this handler tried to re-acquire `proc_lock`, the
    SAME thread would try to lock a plain (non-reentrant) threading.Lock it already holds — a
    guaranteed self-deadlock (M3 fix). So this handler intentionally touches NO lock: it only
    sets `stop` and sends SIGTERM directly to whatever proc_ref currently holds. Reading/using
    proc_ref[0] without the lock is safe — a single list-index read/terminate() is atomic under
    the GIL, and worst case (a race with the watchdog's restart) we signal the process being
    replaced, which is being torn down anyway. sys.exit(0) then unwinds the main thread, running
    any `with proc_lock:` __exit__ blocks normally (exception unwinding still releases locks)."""
    print(f"[gen-spc] signal {signum} — forwarding to steampipe and exiting", file=sys.stderr)
    stop.set()
    try:
        proc_ref[0].terminate()
    except Exception:  # noqa: BLE001 — best-effort; we're exiting regardless
        pass
    sys.exit(0)


def _restart_steampipe(proc_ref: list, restart_lock: threading.Lock, old: "subprocess.Popen[bytes]") -> None:
    """The FULL restart sequence — terminate the old process, guarantee a clean service stop, and
    start a new one — run under `restart_lock` from start to finish (M-1 fix, round 8).

    `steampipe service stop --force` (M-A, round 7) is a GLOBAL/singleton operation on the
    embedded-PG service, not scoped to a specific Popen handle. Round 7 ran it OUTSIDE any lock in
    both the watchdog and the supervisor-loop restart paths (mirroring the round-5 backoff-sleep
    fix, which correctly keeps an UNBOUNDED exponential-backoff sleep off the lock). But
    stop-then-start is a BOUNDED, always-necessary sequence, and having TWO independent call sites
    invoke the global stop/start without mutual exclusion between them created a new race: if the
    watchdog starts a fresh process (procD) while the supervisor loop's OWN (already-decided,
    stale) restart sequence is mid-flight, the supervisor's `_stop_steampipe_service()` call would
    indiscriminately kill procD too, right after it was started — an unnecessary extra restart
    cycle stacking on top of the intended one. A single lock serializing the ENTIRE
    terminate->wait->stop->start sequence (used by both call sites) makes only one such sequence
    possible at a time globally, so neither path's stop-force call can ever land on a process the
    OTHER path just started.

    The `proc_ref[0] is not old` guard right after acquiring the lock closes a second, subtler
    race: Python's Popen caches `returncode` after a successful `wait()`, so calling
    terminate()/wait() again on an ALREADY-reaped `old` (from a caller that lost the race to
    acquire the lock first) is a safe no-op — but WITHOUT this guard, that stale caller would
    still fall through to `_stop_steampipe_service()` + `_start_steampipe()`, clobbering whatever
    the FIRST caller just started. The guard makes a losing caller a true no-op: the desired new
    state (whatever the winner produced) is already in place."""
    with restart_lock:
        if proc_ref[0] is not old:
            return  # someone else already restarted while we waited for the lock — nothing to do
        old.terminate()
        try:
            old.wait(timeout=30)
        except subprocess.TimeoutExpired:
            old.kill()
            old.wait()
        _stop_steampipe_service()
        proc_ref[0] = _start_steampipe()


def _scope_watchdog(
    initial_spc: str,
    proc_ref: list,
    restart_lock: threading.Lock,
    stop: threading.Event,
) -> None:
    """Background thread: re-query Aurora every SCOPE_WATCH_INTERVAL seconds. If the rendered
    aws.spc changes (account added/removed/disabled, region scope updated), write the new config
    and restart the Steampipe subprocess (M3)."""
    current = initial_spc
    while not stop.wait(SCOPE_WATCH_INTERVAL):
        try:
            new_spc = render_spc(fetch_rows())
            if new_spc == current:
                continue
            print("[gen-spc] account scope changed — rewriting config and restarting steampipe",
                  file=sys.stderr)
            write_spc(new_spc)
            current = new_spc
            old = proc_ref[0]
            _restart_steampipe(proc_ref, restart_lock, old)
            print("[gen-spc] steampipe restarted with updated scope", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"[gen-spc] scope watchdog error (non-fatal): {e}", file=sys.stderr)


def main() -> None:
    # Pre-flight config check: fail fast with a clear signal rather than spending the
    # retry budget (~14 s) before reporting "Aurora unreachable" (addresses MINOR-5).
    for var in ("AURORA_ENDPOINT", "AURORA_DATABASE"):
        if not os.environ.get(var):
            print(f"[gen-spc] FATAL: required env var '{var}' is not set (config error)",
                  file=sys.stderr)
            sys.exit(1)

    # Bounded retry budget (~2+4+8 ≈ 14 s — sleeps happen only between attempts, none after the
    # last) stays well under the ECS healthcheck startPeriod (120 s) so a transient Aurora delay
    # can't exhaust the grace window and trigger a loop.
    last = None
    rows = None
    attempts = 4
    for attempt in range(1, attempts + 1):
        try:
            rows = fetch_rows()
            break
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"[gen-spc] Aurora unreachable (attempt {attempt}/{attempts}): {e}",
                  file=sys.stderr)
            if attempt < attempts:
                time.sleep(min(2 ** attempt, 8))
    if rows is None:
        print(f"[gen-spc] FATAL: Aurora unreachable after {attempts} attempts — "
              f"failing closed: {last}", file=sys.stderr)
        sys.exit(1)

    spc = render_spc(rows)
    write_spc(spc)
    print(f"[gen-spc] wrote {SPC_PATH} for {len(rows)} enabled account(s)", file=sys.stderr)

    # Start Steampipe (no Aurora credential in its env at all — M1).
    restart_lock = threading.Lock()
    proc_ref = [_start_steampipe()]
    stop = threading.Event()

    # Signal handler is lock-free (M3) — see _on_signal's docstring for why.
    signal.signal(signal.SIGTERM, lambda signum, frame: _on_signal(signum, frame, proc_ref, stop))
    signal.signal(signal.SIGINT, lambda signum, frame: _on_signal(signum, frame, proc_ref, stop))

    # Start scope watchdog (daemon — exits with the supervisor).
    threading.Thread(
        target=_scope_watchdog,
        args=(spc, proc_ref, restart_lock, stop),
        daemon=True,
    ).start()

    # Supervisor loop: wait for the child process and restart on unexpected exit.
    # Backoff state prevents a hot-restart loop if steampipe crashes immediately at start
    # (e.g. bad config, port conflict), which would otherwise spin the CPU and flood logs.
    rapid_restart_count = 0
    last_restart_time = 0.0
    while not stop.is_set():
        current = proc_ref[0]  # a single list-index read is atomic under the GIL; no lock needed
        code = current.wait()
        if stop.is_set():
            break
        if proc_ref[0] is not current:
            # The watchdog already replaced it (this exit was its terminate(), not a crash).
            continue
        # Unexpected exit — apply exponential backoff for rapid crashes. This sleep runs BEFORE
        # acquiring restart_lock: it is UNBOUNDED/growing (up to 60s per rapid crash), unlike the
        # bounded terminate->wait->stop->start sequence in _restart_steampipe, which DOES need to
        # hold restart_lock for its whole duration (M-1 fix) — see that function's docstring.
        elapsed = time.time() - last_restart_time
        if elapsed < 30:
            rapid_restart_count += 1
            delay = min(2 ** rapid_restart_count, 60)
            print(f"[gen-spc] steampipe exited (code {code}) — backoff {delay}s "
                  f"(rapid restart #{rapid_restart_count})", file=sys.stderr)
            time.sleep(delay)
        else:
            rapid_restart_count = 0
            print(f"[gen-spc] steampipe exited unexpectedly (code {code}) — restarting",
                  file=sys.stderr)
        last_restart_time = time.time()
        # _restart_steampipe's own `proc_ref[0] is not old` guard (checked under restart_lock)
        # handles the case where the watchdog raced in and already restarted during our backoff
        # sleep above — no separate re-check needed here.
        _restart_steampipe(proc_ref, restart_lock, current)


if __name__ == "__main__":
    main()
