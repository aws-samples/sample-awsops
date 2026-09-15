#!/usr/bin/env python3
"""Generate SPC/shared profiles from Aurora, then supervise the Steampipe service.

Reads the enabled accounts + their scan scope from Aurora (account_regions / all_regions), renders
the multi-account/region SPC and AWS shared profiles via spc_render, publishes both while
the service is stopped, then launches its child (Python remains the ECS PID-1 supervisor).

Aurora auth uses IAM database authentication (M1 fix): the task role has `rds-db:connect` scoped
to the dedicated least-privilege `steampipe_reader` Postgres role (SELECT-only on accounts/
account_regions — see the steampipe_reader migration), and this entrypoint generates a fresh
short-lived signed token per connection via boto3 `generate_db_auth_token`. NO Aurora secret of
any kind (master or otherwise) is ever granted to this task or held in its environment/heap — the
network-listening Steampipe process (port 9193) cannot leak a DB credential it never has.

On Aurora-unreachable: bounded retry, then fail-closed (exit non-zero) — never start with an
empty/stale config. A background watchdog re-queries Aurora every SCOPE_WATCH_INTERVAL seconds and
restarts Steampipe when scope or profile metadata changes, including ExternalId-only changes.
Failure to confirm listener closure or publish the stopped service's pair causes fatal
shutdown; bounded child waits let that failure reach PID 1.

Every render also discloses the effective plugin rate-limiter knobs to stderr as a
`steampipe_limiter_config` JSON event (max_concurrency / bucket_size / fill_rate), so the
configured quota posture is visible in its logs; this event does not prove launch or readiness.
"""
import errno
import json
import os
import re
import shutil
import signal
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Optional

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
import pg8000.native

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from spc_render import limiter_config_from_env, render_aws_config, render_spc  # noqa: E402

SPC_PATH = os.environ.get("AWS_SPC_PATH", "/home/steampipe/.steampipe/config/aws.spc")
RUNTIME_CONFIG_DIR = "/home/steampipe/.awsops-runtime"
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


class HostScopeError(ValueError):
    """Fixed, safe failure codes for the opt-in host inventory boundary."""


@lru_cache(maxsize=2)
def _host_sts_client(region):
    return boto3.client("sts", region_name=region, config=Config(
        # Bound transient transport/throttle retries inside identity verification.
        # Exhaustion still raises HostScopeError; it never keeps an unverified scope.
        connect_timeout=3, read_timeout=5,
        retries={"total_max_attempts": 3, "mode": "standard"}))


def _validate_host_scope(rows):
    mode = os.environ.get("INVENTORY_HOST_ONLY", "false")
    if mode not in ("false", "true"):
        raise HostScopeError("invalid_host_scope_mode")
    raw = os.environ.get("INVENTORY_TARGET_ACCOUNT_IDS", "")
    try:
        targets = json.loads(raw) if raw else []
        if (not isinstance(targets, list) or len(targets) > 5
                or any(not isinstance(t, str) or not re.fullmatch(r"[0-9]{12}", t) for t in targets)
                or len(set(targets)) != len(targets)):
            raise ValueError
    except (TypeError, ValueError):
        raise HostScopeError("invalid_target_account_scope") from None
    if mode == "false" and not targets:
        return
    expected = os.environ.get("EXPECTED_HOST_ACCOUNT_ID", "")
    if not re.fullmatch(r"[0-9]{12}", expected):
        raise HostScopeError("expected_host_account_required")
    # QUERY returns enabled accounts only. Even an unrenderable foreign row is
    # a scope conflict, not a row to silently discard.
    if targets:
        if mode == "true" or expected in targets:
            raise HostScopeError("invalid_target_account_scope")
        allowed = {expected, *targets}
        if (not isinstance(rows, list) or not rows or any(not isinstance(row, dict) for row in rows)
                or any(not isinstance(row.get("account_id"), str) or row["account_id"] not in allowed
                       or row.get("is_host") is not (row["account_id"] == expected)
                       or (row["account_id"] != expected and (
                           row.get("role_name") != "AWSopsReadOnlyRole"
                           or (row.get("all_regions") is not True and not (
                               isinstance(row.get("regions"), list)
                               and any(isinstance(region, str) and region for region in row["regions"])
                           ))
                       ))
                       for row in rows)
                or len({row["account_id"] for row in rows}) != len(rows)
                or sum(row["account_id"] == expected for row in rows) != 1):
            raise HostScopeError("invalid_enabled_target_scope")
    elif (not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict)
          or rows[0].get("account_id") != expected or rows[0].get("is_host") is not True):
        raise HostScopeError("invalid_enabled_host_scope")
    try:
        caller = _host_sts_client(os.environ.get("AWS_REGION", "ap-northeast-2")).get_caller_identity()
    except (BotoCoreError, ClientError):
        raise HostScopeError("host_identity_unavailable") from None
    if not isinstance(caller, dict) or caller.get("Account") != expected:
        raise HostScopeError("actual_host_account_mismatch")


def _render_spc(rows):
    _validate_host_scope(rows)
    limiter = limiter_config_from_env()
    print(json.dumps({
        "event": "steampipe_limiter_config",
        "max_concurrency": limiter.max_concurrency,
        "bucket_size": limiter.bucket_size,
        "fill_rate": limiter.fill_rate,
    }, sort_keys=True), file=sys.stderr)
    return render_spc(rows, limiter)


def _render_runtime_config(rows):
    try:
        return _render_spc(rows), render_aws_config(rows)
    except HostScopeError:
        raise
    except (ValueError, KeyError, TypeError):
        raise HostScopeError("invalid_runtime_configuration") from None


def _write_private(path, contents):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(contents)
        stream.flush()
        os.fsync(stream.fileno())


def write_spc(spc: str, aws_config: str = "") -> None:
    """Publish private profiles and a regular SPC before the service starts.

    Each replacement is atomic; the stopped service protects the pair. Publication
    failure forbids launch. Retired generations live for this container's lifetime.
    """
    root, path = Path(RUNTIME_CONFIG_DIR), Path(SPC_PATH)
    generation = None
    temporary = []
    published = False
    try:
        if not root.is_absolute() or not path.is_absolute():
            raise ValueError()
        expected = str(root / "current" / "config")
        if os.environ.get("AWS_CONFIG_FILE") not in (None, expected):
            raise ValueError()
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = root.lstat()
        if (not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700
                or info.st_uid != os.geteuid()):
            raise ValueError()
        current = root / "current"
        if current.is_symlink():
            target = os.readlink(current)
            if not re.fullmatch(r"gen-[A-Za-z0-9_]+", target) or (root / target).is_symlink():
                raise ValueError()
        elif current.exists():
            raise ValueError()
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.parent.is_symlink() or (path.is_symlink() and os.readlink(path) != str(current / "aws.spc")):
            raise ValueError()
        generation = Path(tempfile.mkdtemp(prefix="gen-", dir=root))
        _write_private(generation / "aws.spc", spc)
        _write_private(generation / "config", aws_config)
        staged_spc = path.parent / (".awsops-spc-" + uuid.uuid4().hex)
        temporary.append(staged_spc)
        _write_private(staged_spc, spc)
        pointer = root / (".current-" + uuid.uuid4().hex)
        temporary.append(pointer)
        os.symlink(generation.name, pointer)
        os.environ["AWS_CONFIG_FILE"] = expected
        os.replace(pointer, current)
        os.replace(staged_spc, path)
        published = True
    except Exception:
        raise HostScopeError("runtime_configuration_write_failed") from None
    finally:
        for link in temporary:
            link.unlink(missing_ok=True)
        # A signal/error after replace may interrupt the Python assignment even
        # though the profile pointer was committed. Keep its generation intact.
        committed = (generation is not None and (root / "current").is_symlink()
                     and os.readlink(root / "current") == generation.name)
        if generation is not None and not published and not committed:
            shutil.rmtree(generation)


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


class SteampipeRestartError(RuntimeError):
    """A failed teardown cannot safely admit another service start."""


def _steampipe_listener_closed(port: int = 9193, timeout: float = 1) -> Optional[bool]:
    """True = refused, False = listening, None = unconfirmed local probe."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return False
    except OSError as error:
        return True if error.errno == errno.ECONNREFUSED else None


def _wait_for_steampipe_listener_closed() -> str:
    """Give the listener one bounded grace period, including probe time."""
    deadline = time.monotonic() + 10
    reason = "listener_unconfirmed"
    while (remaining := deadline - time.monotonic()) > 0:
        closed = _steampipe_listener_closed(timeout=min(1, remaining))
        if closed is True:
            return "closed"
        reason = "listener_open" if closed is False else "listener_unconfirmed"
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(0.2, remaining))
    return reason


def _stop_steampipe_service(timeout: int = 30) -> bool:
    """Report the bounded full-service stop outcome without exposing CLI output.

    Completed CLI exit codes do not prove embedded PostgreSQL stopped. Require a
    refused loopback connection within ten seconds; shutdown is best-effort,
    restart requires True. Probe errors remain unconfirmed and can be retried.
    """
    exit_code = "unknown"
    try:
        result = subprocess.run(["steampipe", "service", "stop", "--force"],
                                timeout=timeout, capture_output=True)
        if isinstance(result.returncode, int):
            exit_code = str(result.returncode)
        reason = _wait_for_steampipe_listener_closed()
        if reason == "closed":
            return True
    except subprocess.TimeoutExpired:
        reason = "timeout"
    except Exception:  # noqa: BLE001 — fixed diagnostic, never raw CLI/exception text
        reason = "error"
    print(f"[gen-spc] steampipe_service_stop_failed ({reason}; exit_code={exit_code})", file=sys.stderr)
    return False


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


def _terminate_steampipe(proc: "subprocess.Popen[bytes]") -> bool:
    """Reap the tracked child, then report whether the embedded service stopped."""
    try:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=30)
    finally:
        stopped = _stop_steampipe_service()
    return stopped


def _restart_steampipe(proc_ref: list, restart_lock: threading.Lock, old: "subprocess.Popen[bytes]",
                       stop: "threading.Event" = None, fatal: "threading.Event" = None, prepare=None) -> bool:
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
        if (stop is not None and stop.is_set()) or proc_ref[0] is not old:
            return False
        failure = None
        try:
            stopped = _terminate_steampipe(old)
        except Exception:  # Keep the tracked child for bounded final cleanup.
            stopped = False
            failure = "steampipe_child_stop_failed"
        # Signal handlers set stop without taking this lock.
        if stop is not None and stop.is_set():
            return False
        if stopped is True and prepare is not None:
            try:
                prepare()
            except HostScopeError as error:
                if str(error) == "runtime_configuration_write_failed":
                    print("[gen-spc] FATAL: runtime_configuration_write_failed", file=sys.stderr)
                failure = "steampipe_configuration_publish_failed"
            except Exception:
                failure = "steampipe_configuration_publish_failed"
            if stop is not None and stop.is_set():
                return False
        if failure or stopped is not True:
            # Publish failure before releasing the restart lock: queued restart
            # callers must observe stop, never revive the stale singleton service.
            if fatal is not None:
                fatal.set()
            if stop is not None:
                stop.set()
            if failure != "steampipe_child_stop_failed":
                proc_ref[0] = None  # Foreground child was reaped; PID 1 must now exit.
            raise SteampipeRestartError(failure or "steampipe_service_stop_failed")
        proc_ref[0] = _start_steampipe()
        return True


def _scope_watchdog(
    initial_config,
    proc_ref: list,
    restart_lock: threading.Lock,
    stop: threading.Event,
    fatal: "threading.Event" = None,
) -> None:
    """Background thread: re-query Aurora every SCOPE_WATCH_INTERVAL seconds. If the rendered
    aws.spc changes (account added/removed/disabled, region scope updated), write the new config
    and restart the Steampipe subprocess (M3)."""
    current = initial_config
    while not stop.wait(SCOPE_WATCH_INTERVAL):
        try:
            new_config = _render_runtime_config(fetch_rows())
            if new_config == current:
                continue
            print("[gen-spc] account scope changed — rewriting config and restarting steampipe",
                  file=sys.stderr)
            old = proc_ref[0]
            if _restart_steampipe(proc_ref, restart_lock, old, stop, fatal,
                                  prepare=lambda: write_spc(*new_config)):
                current = new_config
                print("[gen-spc] steampipe restart launched for updated scope", file=sys.stderr)
        except SteampipeRestartError as e:
            # The restart path already published fatal/stop under the lock.
            print(f"[gen-spc] FATAL: {e}", file=sys.stderr)
            return
        except HostScopeError as e:
            # A revoked/foreign scope must stop collection, not leave the last
            # accepted configuration running while the watchdog reports an error.
            print(f"[gen-spc] FATAL: {e}", file=sys.stderr)
            if fatal is not None:
                fatal.set()  # Preserve failure classification even if SIGTERM arrives during teardown.
            with restart_lock:
                # Publish shutdown under the same lock as process launch. A queued
                # crash/scope restart must observe stop before starting another child.
                stop.set()
                try:
                    if proc_ref[0] is not None:
                        _terminate_steampipe(proc_ref[0])
                finally:
                    proc_ref[0] = None
            return
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

    try:
        configuration = _render_runtime_config(rows)
        write_spc(*configuration)
    except HostScopeError as e:
        print(f"[gen-spc] FATAL: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"[gen-spc] wrote {SPC_PATH} for {len(rows)} enabled account(s)", file=sys.stderr)

    # Start Steampipe (no Aurora credential in its env at all — M1).
    restart_lock = threading.Lock()
    proc_ref = [_start_steampipe()]
    stop = threading.Event()
    fatal = threading.Event()

    # Signal handler is lock-free (M3) — see _on_signal's docstring for why.
    signal.signal(signal.SIGTERM, lambda signum, frame: _on_signal(signum, frame, proc_ref, stop))
    signal.signal(signal.SIGINT, lambda signum, frame: _on_signal(signum, frame, proc_ref, stop))

    # Start scope watchdog (daemon — exits with the supervisor).
    threading.Thread(
        target=_scope_watchdog,
        args=(configuration, proc_ref, restart_lock, stop, fatal),
        daemon=True,
    ).start()

    # Supervisor loop: wait for the child process and restart on unexpected exit.
    # Backoff state prevents a hot-restart loop if steampipe crashes immediately at start
    # (e.g. bad config, port conflict), which would otherwise spin the CPU and flood logs.
    rapid_restart_count = 0
    last_restart_time = 0.0
    try:
        while not stop.is_set() and not fatal.is_set():
            with restart_lock:
                if stop.is_set() or fatal.is_set():
                    break
                current = proc_ref[0]
            # A failed watchdog teardown can leave this child alive. Events do
            # not interrupt Popen.wait(), so bound it before rechecking shutdown.
            try:
                code = current.wait(timeout=1)
            except subprocess.TimeoutExpired:
                continue
            if stop.is_set() or fatal.is_set():
                break
            if proc_ref[0] is not current:
                # The watchdog already replaced it; this exit was not a crash.
                continue
            elapsed = time.time() - last_restart_time
            if elapsed < 30:
                rapid_restart_count += 1
                delay = min(2 ** rapid_restart_count, 60)
                print(f"[gen-spc] steampipe exited (code {code}) — backoff {delay}s "
                      f"(rapid restart #{rapid_restart_count})", file=sys.stderr)
                # Keep backoff outside the lock, but interrupt it on fatal/graceful stop.
                if stop.wait(delay):
                    break
            else:
                rapid_restart_count = 0
                print(f"[gen-spc] steampipe exited unexpectedly (code {code}) — restarting",
                      file=sys.stderr)
            last_restart_time = time.time()
            try:
                _restart_steampipe(proc_ref, restart_lock, current, stop, fatal)
            except SteampipeRestartError as error:
                print(f"[gen-spc] FATAL: {error}", file=sys.stderr)
                break
    finally:
        try:
            with restart_lock:
                stop.set()
                if proc_ref[0] is not None:
                    try:
                        _terminate_steampipe(proc_ref[0])
                    finally:
                        proc_ref[0] = None
        finally:
            if fatal.is_set():
                sys.exit(1)


if __name__ == "__main__":
    main()
