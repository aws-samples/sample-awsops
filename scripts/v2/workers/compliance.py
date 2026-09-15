"""CIS benchmark via Powerpipe against the warm Steampipe FDW. Parsing is pure (unit-tested);
run_powerpipe shells out (treats Powerpipe's exit 2 = controls-in-alarm as success); persistence
writes compliance_runs/_results in Aurora. Read-only: Powerpipe only QUERIES Steampipe."""
import json
import os
import re
import subprocess

MOD_DIR = os.environ.get("POWERPIPE_MOD_DIR", "/app/powerpipe")  # baked at image build (Task 8)
ALLOWED = {"cis_v150", "cis_v200", "cis_v300", "cis_v400"}

# Redact the Steampipe password from any Powerpipe stderr before it is persisted/returned.
_PW_RE = re.compile(r"(postgres(?:ql)?://[^:/@\s]+:)[^@\s]+(@)")


def _scrub(text):
    return _PW_RE.sub(r"\1***\2", text or "")


def _walk_controls(node, section, out):
    """Collect leaf control RESULTS (one row per checked resource) for the detail list."""
    for c in node.get("controls", []) or []:
        for r in c.get("results", []) or []:
            dims = {d.get("key"): d.get("value") for d in (r.get("dimensions") or [])}
            out.append({
                "control_id": c.get("control_id") or c.get("name", ""),
                "title": c.get("title", ""),
                # Gap L70: the recommendation rationale shown in the control detail panel.
                "description": c.get("description", "") or "",
                "section": section,
                "status": r.get("status", ""),
                "reason": r.get("reason", ""),
                "resource": r.get("resource", ""),
                "region": dims.get("region", ""),
                "severity": (c.get("tags") or {}).get("severity", ""),
            })
    for g in node.get("groups", []) or []:
        _walk_controls(g, g.get("title", section), out)


def _top_group_totals(doc):
    """Run-level control counts from the TOP-LEVEL groups' rollup summaries (v1 parity; each
    top group's summary already includes its descendants, so we never sum nested groups)."""
    agg = {"total": 0, "ok": 0, "alarm": 0, "info": 0, "skip": 0, "error": 0}
    found = False
    for g in doc.get("groups", []) or []:
        ctrl = (g.get("summary") or {}).get("control")
        if isinstance(ctrl, dict):
            found = True
            for k in agg:
                agg[k] += int(ctrl.get(k, 0) or 0)
    return agg if found else None


def parse_powerpipe_json(doc):
    """-> (totals, controls). totals: {total_controls, ok, alarm, info, skip, error, pass_rate}.
    controls: leaf result rows for compliance_results. pass_rate = ok/(ok+alarm+info+skip+error)*100."""
    controls = []
    for g in doc.get("groups", []) or []:
        _walk_controls(g, g.get("title", ""), controls)
    agg = _top_group_totals(doc)
    if agg is None:
        # No rollup summaries (e.g. empty doc) → derive from leaf result statuses.
        agg = {"total": 0, "ok": 0, "alarm": 0, "info": 0, "skip": 0, "error": 0}
        for c in controls:
            if c["status"] in agg:
                agg[c["status"]] += 1
        agg["total"] = sum(agg[k] for k in ("ok", "alarm", "info", "skip", "error"))
    denom = agg["ok"] + agg["alarm"] + agg["info"] + agg["skip"] + agg["error"]
    pass_rate = (agg["ok"] / denom * 100) if denom else 0
    totals = {
        "total_controls": agg["total"], "ok": agg["ok"], "alarm": agg["alarm"],
        "info": agg["info"], "skip": agg["skip"], "error": agg["error"], "pass_rate": pass_rate,
    }
    return totals, controls


def run_powerpipe(benchmark, db_url, scope="all"):
    if benchmark not in ALLOWED:
        raise ValueError(f"benchmark not allowed: {benchmark!r}")
    cmd = ["powerpipe", "benchmark", "run", f"aws_compliance.benchmark.{benchmark}",
           "--mod-location", MOD_DIR, "--output", "json", "--progress=false"]
    # Account scoping (v1 parity): a 12-digit scope pins the search path to that account's
    # Steampipe connection (aws_<id>); "all" keeps the aggregator default (every account merged).
    # The id is validated here too (defense-in-depth vs a forged worker payload).
    if scope and scope != "all":
        if not re.fullmatch(r"[0-9]{12}", str(scope)):
            raise ValueError(f"scope not allowed: {scope!r}")
        cmd += ["--search-path", f"public,aws_{scope}"]
    proc = subprocess.run(cmd, capture_output=True, text=True,
                          env={**os.environ, "POWERPIPE_DATABASE": db_url})
    out = (proc.stdout or "").strip()
    if not out:
        # Scrub the password — a connection error can echo POWERPIPE_DATABASE in stderr.
        raise RuntimeError(f"powerpipe produced no output (exit {proc.returncode}): {_scrub(proc.stderr)[:2000]}")
    return json.loads(out)  # exit 2 (alarms present) is expected; valid JSON ⇒ success


def steampipe_db_url():
    import boto3
    host = os.environ["STEAMPIPE_HOST"]
    sm = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    pw = sm.get_secret_value(SecretId=os.environ["STEAMPIPE_SECRET_ARN"])["SecretString"].strip()
    return f"postgres://steampipe:{pw}@{host}:9193/steampipe?sslmode=require"


def persist(conn, run_id, totals, controls):
    conn.run("UPDATE compliance_runs SET status='succeeded', finished_at=now(), "
             "pass_rate=:pr, total_controls=:t, ok=:ok, alarm=:al, info=:inf, skip=:sk, error=:er "
             "WHERE id=:id",
             pr=totals["pass_rate"], t=totals["total_controls"], ok=totals["ok"], al=totals["alarm"],
             inf=totals["info"], sk=totals["skip"], er=totals["error"], id=run_id)
    for c in controls:
        conn.run("INSERT INTO compliance_results "
                 "(run_id, control_id, title, section, status, reason, resource, region, severity, description) "
                 "VALUES (:r,:cid,:ti,:se,:st,:re,:res,:reg,:sev,:de)",
                 r=run_id, cid=c["control_id"], ti=c["title"], se=c["section"], st=c["status"],
                 re=c["reason"], res=c["resource"], reg=c["region"], sev=c["severity"],
                 de=c["description"])


# SNS rejects a non-ASCII Subject (→ publish fails → no email) — keep the subject English,
# Korean goes in the body (the diagnosis/notify._SUBJECT precedent; tests assert isascii).
_NOTIFY_SUBJECT = "[AWSops] Compliance Benchmark Completed"
# Per-benchmark dedup window: a user-triggerable per-run mail must not re-blast the subscriber
# list (the retired per-report diagnosis mail is exactly what the digest replaced) — at most
# one completion mail per benchmark per hour, dedup'd on compliance_runs.notified_at.
_NOTIFY_DEDUP_MINUTES = 60


def _record_notify_outcome(conn, run_id, outcome, notified=False, only_if_blank=False):
    """Durable delivery record (the ADR-013 diagnosis_reports.notify_outcome precedent).
    Best-effort: a pre-migration DB (columns absent) must not fail the run. only_if_blank
    guards skip-class outcomes: a manual SFN re-drive of an already-notified run lands in the
    dedup branch and must not overwrite the run's own emailed/publish_failed record."""
    try:
        guard = " AND notify_outcome=''" if only_if_blank else ""
        if notified:
            conn.run(f"UPDATE compliance_runs SET notified_at=now(), notify_outcome=:o WHERE id=:id{guard}",
                     o=outcome, id=run_id)
        else:
            conn.run(f"UPDATE compliance_runs SET notify_outcome=:o WHERE id=:id{guard}", o=outcome, id=run_id)
    except Exception as e:  # noqa: BLE001
        print(f"[compliance] notify-outcome record failed (non-fatal): {e}")


def notify_completed(conn, run_id, benchmark, totals, scope="all"):
    """Best-effort SNS mail when a benchmark run SUCCESSFULLY completes (gap L192, v1
    notifyBenchmarkCompleted parity: benchmark name + scope + total/alarm/ok counts).
    Reuses the diagnosis notify plumbing end-to-end — the DIAGNOSIS_SNS_TOPIC_ARN env +
    sns:Publish grant the worker already carries when diagnosis_notify_enabled (env absent →
    silent no-op, zero Terraform), the notify._client publish path, and the
    diagnosis_notify_paused app_settings admin pause (paused → skip; a pause-read failure
    fails OPEN to publishing — the digest precedent). Flood guard: an ATOMIC per-benchmark
    _NOTIFY_DEDUP_MINUTES window claim on compliance_runs.notified_at, taken BEFORE the
    publish and serialized by an advisory lock — concurrent same-benchmark runs cannot each
    pass a check and all publish (round-2 race fix); a publish failure keeps the claim (no
    retry-blast). Every path records a durable notify_outcome on the run row. NEVER raises:
    notification must not fail the run. Returns the MessageId or None. Recorded in ADR-013
    (2026-09-02 amendment)."""
    topic = os.environ.get("DIAGNOSIS_SNS_TOPIC_ARN", "")
    if not topic:
        _record_notify_outcome(conn, run_id, "skipped_no_topic", only_if_blank=True)
        return None
    try:
        failopen = False
        try:
            rows = conn.run("SELECT value FROM app_settings WHERE key = 'diagnosis_notify_paused'")
            if bool(rows) and str(rows[0][0]).strip().lower() == "true":
                print("[compliance] notify paused (diagnosis_notify_paused) — skipping publish")
                _record_notify_outcome(conn, run_id, "dropped_paused", only_if_blank=True)
                return None
        except Exception as e:  # noqa: BLE001 — fail-open: a settings-read failure must not mute mail
            print(f"[compliance] pause-flag read failed (fail-open, publishing): {e}")
            failopen = True
        # ATOMIC window claim (review round-2: the SELECT→publish→UPDATE flow was a
        # check-then-publish race — N concurrent runs each passed the SELECT before any
        # stamped notified_at, bypassing the documented one-mail-per-hour guard). The claim
        # is a single autocommitted UPDATE … NOT EXISTS … RETURNING, serialized across
        # connections by a per-benchmark advisory lock (namespaced 772026; session-scoped —
        # auto-released on connection close if the worker dies mid-claim). notified_at now
        # means "window claimed": a publish failure KEEPS the claim (no retry-blast) and
        # records publish_failed. Claim failure (e.g. pre-migration columns absent) fails
        # OPEN to publishing — a broken claim path must not mute mail (logged).
        claimed = False
        locked = False
        try:
            conn.run("SELECT pg_advisory_lock(772026, hashtext(:b))", b=benchmark)
            locked = True
            rows = conn.run(
                "UPDATE compliance_runs SET notified_at = now() "
                # notified_at IS NULL: a manual SFN re-drive of an already-notified run must not re-claim its own window
                "WHERE id = :id AND notified_at IS NULL AND NOT EXISTS ("
                "  SELECT 1 FROM compliance_runs c2 WHERE c2.benchmark = :b AND c2.id <> :id "
                "  AND c2.notified_at > now() - make_interval(mins => :m)) RETURNING id",
                id=run_id, b=benchmark, m=_NOTIFY_DEDUP_MINUTES)
            if not rows:
                print(f"[compliance] dedup — a {benchmark} mail went out within {_NOTIFY_DEDUP_MINUTES}m, skipping")
                _record_notify_outcome(conn, run_id, "skipped_dedup", only_if_blank=True)
                return None
            claimed = True
        except Exception as e:  # noqa: BLE001 — fail-open (a broken claim path must not mute mail)
            print(f"[compliance] dedup claim failed (fail-open, publishing): {e}")
            failopen = True
        finally:
            if locked:
                try:
                    conn.run("SELECT pg_advisory_unlock(772026, hashtext(:b))", b=benchmark)
                except Exception as e:  # noqa: BLE001
                    print(f"[compliance] advisory unlock failed (non-fatal): {e}")

        from diagnosis import notify  # the governed publish path (hardened _client)

        domain = os.environ.get("APP_DOMAIN", "")
        pr = totals.get("pass_rate")
        parts = [
            "컴플라이언스 벤치마크 완료",
            "=" * 40,
            f"벤치마크: {benchmark}",
            f"범위(scope): {scope}",
            f"전체 컨트롤: {totals.get('total_controls', 0)} (info/skip/error 포함) · 통과: {totals.get('ok', 0)} · 실패(Alarm): {totals.get('alarm', 0)}",
        ]
        if pr is not None:
            parts.append(f"통과율: {round(float(pr), 1)}%")
        if domain:
            parts += ["", f"상세 보기: https://{domain}/compliance"]
        parts += ["", "이 메일은 AWSops 벤치마크 완료 시 발송되었습니다.",
                  "수신 거부 / 구독 관리는 관리자에게 문의하세요."]
        resp = notify._client(None).publish(
            TopicArn=topic, Subject=_NOTIFY_SUBJECT, Message="\n".join(parts),
            # message-class discriminator: lets subscribers filter compliance mail from
            # diagnosis mail on the shared topic (SNS filter policy) — no IAM change.
            MessageAttributes={"awsops_class": {"DataType": "String", "StringValue": "compliance_completed"}})
        mid = resp.get("MessageId")
        print(f"[compliance] published completion mail → {topic} (MessageId={mid})")
        _record_notify_outcome(conn, run_id, "emailed_failopen" if failopen else "emailed", notified=True)
        return mid
    except Exception as e:  # noqa: BLE001 — best-effort; never fail the run over a mail
        print(f"[compliance] notify publish failed (non-fatal): {e}")
        _record_notify_outcome(conn, run_id, "publish_failed")
        return None
