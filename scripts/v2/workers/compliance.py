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
                 "(run_id, control_id, title, section, status, reason, resource, region, severity) "
                 "VALUES (:r,:cid,:ti,:se,:st,:re,:res,:reg,:sev)",
                 r=run_id, cid=c["control_id"], ti=c["title"], se=c["section"], st=c["status"],
                 re=c["reason"], res=c["resource"], reg=c["region"], sev=c["severity"])
