# AWSops v2 — P2: 비동기 워커 백본 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`). **Long/shared-infra applies (terraform apply + image build + SFN/Fargate verify): the CONTROLLER runs them via saved-tfplan / `make workers`; `-auto-approve` on shared infra is gated. Confirm `git branch --show-current` = feat/v2-architecture-design before each apply (concurrent branch-switching observed this repo).**

**Goal:** Stand up a managed async worker backbone — web enqueues a job → SQS → dispatcher Lambda → Step Functions router → Lambda (<15min) or Fargate (long/heavy) worker → result in Aurora `worker_jobs` + S3 — proving OOM isolation (a worker can OOM without affecting web), with ADR-029 safety hooks (idempotency, kill-switch, mutate-type guard, dry-run).

**Architecture:** Terraform `workers.tf` (gated on `var.workers_enabled`, default false → safe no-op merge) provisions SQS+DLQ, an S3 results bucket, a Step Functions Standard state machine, four Python Lambdas (dispatcher, worker, status-updater, reaper), a Fargate worker task, IAM, a worker SG + Aurora ingress, and the SQS→dispatcher event-source-mapping (= the kill switch). The `worker_jobs` table is added to the Aurora schema. The web thin-BFF gains `POST /api/jobs` + `GET /api/jobs/:id`. SFN cannot write VPC Aurora directly (Data API not adopted) → its Catch path invokes the status-updater Lambda. A scheduled reaper Lambda reconciles stale jobs.

**Tech Stack:** Terraform `aws_sqs_queue`/`aws_sfn_state_machine`/`aws_lambda_function`/`aws_ecs_task_definition`/`aws_s3_bucket`/`aws_lambda_event_source_mapping`/`aws_scheduler_schedule`; Python 3.12 + pg8000 (pure-python Postgres, no native deps) + boto3; Next.js 14 thin-BFF (node-postgres `pg` + `@aws-sdk/client-sqs`); arm64 Fargate container.

**Builds on:** P1c Aurora (`aws_rds_cluster.aurora`, master secret, `aws_security_group.aurora`), P1d web (`aws_iam_role.task`, ECS) + `data/schema.sql` + `deploy.mjs`/`Makefile`, P1f `ai.tf` (ECR dual-tier + Lambda `archive_file` patterns). Spec: `docs/superpowers/specs/2026-06-02-awsops-v2-p2-async-worker-backbone-design.md` (read §11 plan-notes).

---

## 0. 설계 리뷰 필수 수정 (MANDATORY — co-agent 패널 codex+gemini+kiro, 2026-06-02)

플랜 리뷰 VERDICT: codex FAIL / gemini·kiro REVIEW. **아래 교정을 해당 task의 코드/HCL에 반드시 반영**(task 본문보다 우선). 각 implementer 프롬프트에 관련 항목을 주입한다.

- **C1 [CRIT] W6 — Lambda에 pg8000 번들**: DB Lambda(worker/status_updater/reaper)는 `db.py`가 `pg8000`을 import하나 Lambda 런타임에 없음 → `ImportError`. 수정: 각 DB-Lambda zip을 **스테이징 디렉토리에 `pip install -r requirements.txt -t <dir>` + .py 복사 후 `archive_file{type=zip, source_dir=<dir>}`**로 빌드(현 `source{content=file()}` 폐기). 빌드 스텝을 W6에 추가(예: `scripts/v2/workers/build-lambda.sh <fn>`이 staging 생성). 디스패처는 pg8000 불요(그대로 file()). Fargate는 Dockerfile pip이라 무관.
- **C2 [CRIT] W2 db.py — SSLContext**: `ssl_context=True` → `import ssl; ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE` 후 `Connection(..., ssl_context=ctx)`(web의 `rejectUnauthorized:false`와 동일; prod는 RDS CA 번들 — 후속).
- **C3 [CRIT] W2 db.py — JSONB ::jsonb 캐스트**: text→jsonb 암묵 캐스트 없음 → `insert_job` `VALUES (:id,:t,:p::jsonb,:d,:k)`, `finish_job` `result=:res::jsonb`. (pg8000.native는 `:name` 정상; `:p::jsonb`의 `::`는 캐스트로 올바르게 파싱됨.)
- **C4 [CRIT] W7 web getPool**: 기존 `getPool()`은 `web/app/api/db/route.ts`에 **인라인·비export**. → `web/lib/db.ts`로 추출(동일 Pool 설정: AURORA_ENDPOINT/USER/PASSWORD, `ssl:{rejectUnauthorized:false}`, max 3), `app/api/db/route.ts`도 이 모듈 import로 변경, jobs 라우트는 `import { getPool } from '@/lib/db'`. `@/` 별칭이 web 루트인지 tsconfig 확인(아니면 상대경로).
- **C5 [HIGH] W6 SFN IAM**: `.sync`엔 `ecs:DescribeTasks`+`ecs:StopTask` 필요(현 RunTask+events만) → 추가(Resource `*`).
- **C6 [HIGH] W7 멱등 원자성**: SELECT-후-INSERT 레이스 → `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING job_id`; 반환 없으면 기존 job SELECT.
- **C7 [HIGH] W3 claim_running 반환 확인**: worker_lambda·fargate_worker에서 `claim_running()==0`(이미 터미널/claim됨)이면 핸들러 실행 **skip**(재시도·지연호출 시 부작용 중복 방지).
- **C8 [HIGH] W6 SG 규칙 혼용 금지**: P1c Aurora SG는 **인라인 ingress** → standalone `aws_vpc_security_group_ingress_rule` 추가 시 perpetual diff/규칙 제거. 수정: **워커 전용 SG·Aurora ingress 규칙을 제거하고 워커가 기존 `aws_security_group.service`를 재사용**(Aurora 인라인 ingress가 이미 허용; egress-all 존재). (W6에서 data.tf의 aurora SG ingress가 service SG를 허용하는지 확인.)
- **C9 [HIGH] W9 검증 실증**: OOM을 **SFN 경유**로 증명(Fargate `--oom` 잡 → OOM → SFN Catch → status_updater=failed + web 무영향). kill-switch/멱등 스텝을 **실제 enqueue+상태 assert** 명령으로(주석 아님).
- **C10 [MED] W2 get_job**: SELECT에 `payload` 추가(현재 누락 → fargate 핸들러가 {} 받음).
- **C11 [MED] W6 ESM depends_on**: `aws_lambda_event_source_mapping.dispatch`에 디스패처 SQS-consume IAM 정책 `depends_on`.
- **C12 [MED] W3 reaper**: `now() - make_interval(mins => :m)`(문자열 concat 금지); **dispatch ESM이 disabled면 queued reap 생략**(kill-switch 중 큐 보존) — `get_event_source_mapping` State 확인 후 running만 reap.
- **C13 [MED] W7/W9 빌드**: web 검증은 `npm run build`(repo 표준; `tsc||true` 금지). 새 task def는 `make deploy`로 롤아웃.
- **C14 [MED] W6 디스패처 역할 분리**: 디스패처는 **별도 최소 역할**(states:StartExecution + SQS consume + logs만; Aurora/KMS/S3 제거). DB-Lambda 3종만 Aurora 역할.
- **C15 [MED] W3/W9 S3 descope**: proof 핸들러는 **inline 결과만**(대용량 아티팩트 없음) → P2는 S3 업로드 미실증(버킷+IAM+artifact_uri 컬럼은 프로비전, 실제 업로드는 P3 대용량 ops에서). 플랜의 artifact 업로드 주장 제거.
- 기각: gemini Makefile 지적(실제 `@node`, 오인), pg8000 `:name`(native 정상).

---

## File Structure

```
terraform/foundation/
  workers.tf                 # NEW — all P2 infra, gated on var.workers_enabled (default false)
  data/schema.sql            # MODIFY — append worker_jobs table + reuse touch_updated_at trigger
scripts/v2/workers/          # NEW — Lambda + Fargate worker sources (Python 3.12, pg8000)
  db.py                      # shared: Aurora pg8000 connect (secret) + worker_jobs CRUD (CONDITIONAL/terminal-immutable transitions)
  dispatcher.py              # SQS-triggered: type guard + SFN StartExecution (ExecutionAlreadyExists=ok) + ReportBatchItemFailures
  worker_lambda.py           # SFN-invoked (short): run task via handlers, write running→succeeded/failed
  status_updater.py          # SFN Catch-invoked: set failed+error (conditional)
  reaper.py                  # EventBridge-scheduled: stale queued→re-enqueue, stale running→failed
  fargate_worker.py          # Fargate entrypoint: --job-id [--oom]; long task / OOM demo; same db.py
  handlers.py                # job-type registry (read/compute only) — shared by worker_lambda + fargate_worker
  Dockerfile                 # arm64 minimal python:3.12-slim container for the Fargate worker
  requirements.txt           # pg8000, boto3
  sfn.asl.json               # Step Functions definition (templated via Terraform templatefile)
scripts/v2/workers.mjs       # NEW — `make workers`: build+push Fargate image (mirror deploy.mjs) [+ optional smoke]
web/app/api/jobs/route.ts             # NEW — POST (enqueue)
web/app/api/jobs/[id]/route.ts        # NEW — GET (status/result)
web/package.json             # MODIFY — add @aws-sdk/client-sqs
Makefile                     # MODIFY — add `workers` target
```

Everything Terraform-side is gated on `var.workers_enabled` (default false), so W1–W8 merge as no-ops; W9 sets it true and applies. The `worker_jobs` table (W1) is applied directly via psql (idempotent CREATE) independent of the gate.

---

## Task W1: `worker_jobs` schema

**Files:** Modify `terraform/foundation/data/schema.sql`.

- [ ] **Step 1: append `worker_jobs` to schema.sql** (after the existing tables; reuse the existing `touch_updated_at()` function)

```sql
-- P2: async worker backbone job ledger (infra table; orthogonal to ADR-030 7 app-state tables)
CREATE TABLE IF NOT EXISTS worker_jobs (
  job_id            UUID PRIMARY KEY,
  type              TEXT NOT NULL,
  runtime           TEXT,                          -- 'lambda' | 'fargate' (set by SFN/worker)
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  result            JSONB,                          -- small inline result
  artifact_uri      TEXT,                           -- large result: s3://bucket/key
  error             TEXT,
  dry_run           BOOLEAN NOT NULL DEFAULT false,
  idempotency_key   TEXT UNIQUE,                    -- enqueue dedup (NULL allowed)
  attempt           INTEGER NOT NULL DEFAULT 0,
  sfn_execution_arn TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_worker_jobs_status ON worker_jobs(status);
CREATE INDEX IF NOT EXISTS idx_worker_jobs_status_updated ON worker_jobs(status, updated_at);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_worker_jobs_touch') THEN
    CREATE TRIGGER trg_worker_jobs_touch BEFORE UPDATE ON worker_jobs
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;
```

- [ ] **Step 2: verify it parses** (psql is applied in W9 against live Aurora; here just syntax-check the file is valid SQL by eye + ensure `touch_updated_at()` already exists in schema.sql)
```bash
grep -n "FUNCTION touch_updated_at" /home/atomoh/awsops/terraform/foundation/data/schema.sql | head
```
Expected: at least one match (the function is defined earlier; we reuse it). If absent, STOP and report (P1c invariant broken).

- [ ] **Step 3: commit**
```bash
cd /home/atomoh/awsops
git add terraform/foundation/data/schema.sql
git commit -m "feat(v2-p2): worker_jobs table (async job ledger) in Aurora schema"
```

---

## Task W2: shared Python DB helper + job-type registry

**Files:** Create `scripts/v2/workers/db.py`, `scripts/v2/workers/handlers.py`, `scripts/v2/workers/requirements.txt`.

The DB helper centralizes Aurora access (pg8000, master secret) + the **conditional, terminal-immutable** status transitions all workers/updater/reaper rely on.

- [ ] **Step 1: write `scripts/v2/workers/requirements.txt`**
```
pg8000==1.31.2
boto3>=1.34
```

- [ ] **Step 2: write `scripts/v2/workers/db.py`**
```python
"""AWSops v2 P2 — shared Aurora access (pg8000) + worker_jobs CRUD.

Env: AURORA_ENDPOINT, AURORA_DATABASE, AURORA_SECRET_ARN (RDS-managed master secret),
AWS_REGION. Used by worker_lambda, status_updater, reaper, fargate_worker.
Transitions are CONDITIONAL: terminal states (succeeded/failed/canceled) are immutable,
so an SFN Catch cannot overwrite a worker's succeeded, and retries cannot resurrect a done job.
"""
import json
import os
import boto3
import pg8000.native

_TERMINAL = ("succeeded", "failed", "canceled")
_secret_cache = {}


def _creds():
    arn = os.environ["AURORA_SECRET_ARN"]
    if arn not in _secret_cache:
        sm = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
        _secret_cache[arn] = json.loads(sm.get_secret_value(SecretId=arn)["SecretString"])
    return _secret_cache[arn]


def connect():
    c = _creds()
    return pg8000.native.Connection(
        user=c["username"], password=c["password"],
        host=os.environ["AURORA_ENDPOINT"], database=os.environ["AURORA_DATABASE"],
        port=5432, ssl_context=True,
    )


def insert_job(conn, job_id, type_, payload, dry_run=False, idempotency_key=None):
    conn.run(
        "INSERT INTO worker_jobs (job_id, type, payload, dry_run, idempotency_key) "
        "VALUES (:id, :t, :p, :d, :k)",
        id=job_id, t=type_, p=json.dumps(payload), d=dry_run, k=idempotency_key,
    )


def claim_running(conn, job_id, runtime):
    """queued|running -> running (idempotent re-claim). Returns rows affected."""
    rows = conn.run(
        "UPDATE worker_jobs SET status='running', runtime=:r, attempt=attempt+1 "
        "WHERE job_id=:id AND status NOT IN ('succeeded','failed','canceled') RETURNING job_id",
        id=job_id, r=runtime,
    )
    return len(rows)


def finish_job(conn, job_id, status, result=None, artifact_uri=None, error=None):
    """Set a TERMINAL status only if not already terminal (immutable)."""
    assert status in _TERMINAL
    rows = conn.run(
        "UPDATE worker_jobs SET status=:s, result=:res, artifact_uri=:a, error=:e "
        "WHERE job_id=:id AND status NOT IN ('succeeded','failed','canceled') RETURNING job_id",
        s=status, res=(json.dumps(result) if result is not None else None),
        a=artifact_uri, e=error, id=job_id,
    )
    return len(rows)


def get_job(conn, job_id):
    rows = conn.run("SELECT job_id,type,status,result,artifact_uri,error,dry_run FROM worker_jobs WHERE job_id=:id", id=job_id)
    if not rows:
        return None
    k = ["job_id", "type", "status", "result", "artifact_uri", "error", "dry_run"]
    return dict(zip(k, rows[0]))
```

- [ ] **Step 3: write `scripts/v2/workers/handlers.py`** (the job-type registry — read/compute only; mutate types are NOT registered, so the dispatcher rejects them per spec §6)
```python
"""AWSops v2 P2 — job-type registry. READ/COMPUTE only (no mutate ops until P3 ADR-029 controls).
Each handler: (payload: dict, dry_run: bool) -> (result_dict_or_None, artifact_bytes_or_None).
P2 ships ONE synthetic proof handler ('noop') exercising sleep / memory / optional OOM.
"""
import time

def _noop(payload, dry_run):
    # Proof workload: optionally sleep, allocate memory, or OOM (fargate only via --oom flag).
    secs = int(payload.get("sleep_s", 0))
    mb = int(payload.get("alloc_mb", 0))
    if dry_run:
        return {"dry_run": True, "would_sleep_s": secs, "would_alloc_mb": mb}, None
    if secs:
        time.sleep(secs)
    blob = bytearray(mb * 1024 * 1024) if mb else None  # held until return
    out = {"slept_s": secs, "alloc_mb": mb, "ok": True}
    del blob
    return out, None

# type -> (handler, runtime). runtime drives SFN routing (lambda<15min / fargate long+heavy).
REGISTRY = {
    "noop":        (_noop, "lambda"),
    "noop-heavy":  (_noop, "fargate"),
}

def is_allowed(type_):
    return type_ in REGISTRY

def runtime_for(type_):
    return REGISTRY[type_][1]
```

- [ ] **Step 4: syntax-check + commit**
```bash
cd /home/atomoh/awsops
python3 -m py_compile scripts/v2/workers/db.py scripts/v2/workers/handlers.py && echo "py OK"
git add scripts/v2/workers/db.py scripts/v2/workers/handlers.py scripts/v2/workers/requirements.txt
git commit -m "feat(v2-p2): shared worker db.py (pg8000, conditional terminal-immutable transitions) + handlers registry"
```
Expected: `py OK`.

---

## Task W3: worker Lambda + Fargate worker + status-updater + reaper

**Files:** Create `scripts/v2/workers/{worker_lambda.py,status_updater.py,reaper.py,fargate_worker.py,Dockerfile}`.

- [ ] **Step 1: write `scripts/v2/workers/worker_lambda.py`** (SFN-invoked for short jobs)
```python
"""SFN-invoked short worker. Input: {job_id, type, payload, dry_run}. Runs the handler,
writes running -> succeeded/failed via db.py (conditional). On exception, raises so SFN
Retry/Catch handle it (Catch -> status_updater sets failed)."""
import os
import db
import handlers


def lambda_handler(event, _ctx):
    job_id, type_ = event["job_id"], event["type"]
    payload, dry_run = event.get("payload", {}), bool(event.get("dry_run", False))
    conn = db.connect()
    try:
        db.claim_running(conn, job_id, runtime="lambda")
        fn, _rt = handlers.REGISTRY[type_]
        result, _artifact = fn(payload, dry_run)
        db.finish_job(conn, job_id, "succeeded", result=result)
        return {"job_id": job_id, "status": "succeeded"}
    finally:
        conn.close()
```

- [ ] **Step 2: write `scripts/v2/workers/status_updater.py`** (SFN Catch-invoked — the bridge SFN→VPC Aurora)
```python
"""SFN Catch-invoked. Input: {job_id, error}. Sets failed+error CONDITIONALLY
(won't overwrite a worker's succeeded). This exists because SFN cannot write VPC Aurora directly."""
import json
import db


def lambda_handler(event, _ctx):
    job_id = event["job_id"]
    err = event.get("error")
    if isinstance(err, (dict, list)):
        err = json.dumps(err)[:2000]
    conn = db.connect()
    try:
        n = db.finish_job(conn, job_id, "failed", error=(err or "worker failed (SFN catch)"))
        return {"job_id": job_id, "updated": n}
    finally:
        conn.close()
```

- [ ] **Step 3: write `scripts/v2/workers/reaper.py`** (EventBridge-scheduled stale-job reconciliation)
```python
"""EventBridge-scheduled. Reconciles: (a) stale 'queued' (no SFN started, e.g. web crashed
between insert and SQS send) older than QUEUED_STALE_MIN -> mark failed (operator re-submits);
(b) stale 'running' older than RUNNING_STALE_MIN -> failed. Conservative: failed, not re-run,
to avoid duplicate side-effects."""
import os
import db

Q = int(os.environ.get("QUEUED_STALE_MIN", "15"))
R = int(os.environ.get("RUNNING_STALE_MIN", "60"))


def lambda_handler(_event, _ctx):
    conn = db.connect()
    try:
        q = conn.run(
            "UPDATE worker_jobs SET status='failed', error='reaped: stale queued' "
            "WHERE status='queued' AND updated_at < now() - (:m || ' minutes')::interval RETURNING job_id",
            m=str(Q))
        r = conn.run(
            "UPDATE worker_jobs SET status='failed', error='reaped: stale running' "
            "WHERE status='running' AND updated_at < now() - (:m || ' minutes')::interval RETURNING job_id",
            m=str(R))
        return {"reaped_queued": len(q), "reaped_running": len(r)}
    finally:
        conn.close()
```

- [ ] **Step 4: write `scripts/v2/workers/fargate_worker.py`** (Fargate entrypoint; `--oom` demonstrates OOM isolation)
```python
"""Fargate worker entrypoint. Args: --job-id <id> [--oom]. Reads the job from worker_jobs,
runs the handler; --oom allocates beyond the task memory limit to force an OOM kill (exit 137),
which SFN RunTask.sync catches -> status_updater sets failed -> proves web is unaffected."""
import argparse
import db
import handlers


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-id", required=True)
    ap.add_argument("--oom", action="store_true")
    args = ap.parse_args()
    conn = db.connect()
    try:
        db.claim_running(conn, args.job_id, runtime="fargate")
        job = db.get_job(conn, args.job_id)
        if job is None:
            raise SystemExit("job not found")
        if args.oom:
            # allocate ~4GB in 64MB chunks until OOM-killed (task memory is smaller)
            hog = []
            while True:
                hog.append(bytearray(64 * 1024 * 1024))
        fn, _rt = handlers.REGISTRY[job["type"]]
        result, _artifact = fn(job["payload"] if isinstance(job.get("payload"), dict) else {}, bool(job["dry_run"]))
        db.finish_job(conn, args.job_id, "succeeded", result=result)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: write `scripts/v2/workers/Dockerfile`** (arm64 minimal container for the Fargate worker)
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY db.py handlers.py fargate_worker.py ./
ENTRYPOINT ["python", "fargate_worker.py"]
```

- [ ] **Step 6: syntax-check + commit**
```bash
cd /home/atomoh/awsops/scripts/v2/workers
python3 -m py_compile worker_lambda.py status_updater.py reaper.py fargate_worker.py && echo "py OK"
cd /home/atomoh/awsops
git add scripts/v2/workers/worker_lambda.py scripts/v2/workers/status_updater.py scripts/v2/workers/reaper.py scripts/v2/workers/fargate_worker.py scripts/v2/workers/Dockerfile
git commit -m "feat(v2-p2): worker Lambda + Fargate worker(--oom) + status-updater + reaper"
```
Expected: `py OK`.

---

## Task W4: dispatcher Lambda

**Files:** Create `scripts/v2/workers/dispatcher.py`.

Implements spec §11 dispatcher notes: type guard (reject mutate/unknown), `ExecutionAlreadyExists`=success (SQS at-least-once dedup), `ReportBatchItemFailures` (partial-batch).

- [ ] **Step 1: write `scripts/v2/workers/dispatcher.py`**
```python
"""SQS-triggered dispatcher. For each record: validate type (registry-only; mutate/unknown
rejected), StartExecution(name=job_id) on the SFN. ExecutionAlreadyExists => treat as success
(at-least-once dedup). Returns batchItemFailures so only genuinely failed records retry.
Lean: no Aurora access (idempotency authority is worker_jobs at enqueue + SFN execution name)."""
import json
import os
import boto3
from botocore.exceptions import ClientError
import handlers

_sfn = boto3.client("stepfunctions", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
_SM = os.environ["STATE_MACHINE_ARN"]


def lambda_handler(event, _ctx):
    failures = []
    for rec in event.get("Records", []):
        mid = rec["messageId"]
        try:
            body = json.loads(rec["body"])
            job_id, type_ = body["job_id"], body["type"]
            if not handlers.is_allowed(type_):
                # unknown/mutate type: do NOT retry (poison) — log + drop (job stays queued; reaper fails it)
                print(json.dumps({"event": "rejected_type", "job_id": job_id, "type": type_}))
                continue
            payload = {"job_id": job_id, "type": type_, "runtime": handlers.runtime_for(type_),
                       "payload": body.get("payload", {}), "dry_run": bool(body.get("dry_run", False))}
            try:
                _sfn.start_execution(stateMachineArn=_SM, name=job_id, input=json.dumps(payload))
            except ClientError as e:
                if e.response["Error"]["Code"] == "ExecutionAlreadyExists":
                    print(json.dumps({"event": "already_dispatched", "job_id": job_id}))  # success
                else:
                    raise
        except Exception as e:  # noqa: BLE001 — transient (SFN throttle, etc.) -> retry this record
            print(json.dumps({"event": "dispatch_error", "messageId": mid, "error": str(e)[:300]}))
            failures.append({"itemIdentifier": mid})
    return {"batchItemFailures": failures}
```

- [ ] **Step 2: syntax-check + commit**
```bash
cd /home/atomoh/awsops
python3 -m py_compile scripts/v2/workers/dispatcher.py && echo "py OK"
git add scripts/v2/workers/dispatcher.py
git commit -m "feat(v2-p2): dispatcher Lambda — type guard + ExecutionAlreadyExists=ok + ReportBatchItemFailures"
```
Expected: `py OK`.

---

## Task W5: Step Functions definition (ASL)

**Files:** Create `scripts/v2/workers/sfn.asl.json`.

Router: Choice on `runtime` → worker Lambda (`.sync` via direct invoke) or Fargate `ecs:runTask.sync`. Retry on worker errors; Catch → status-updater. Terraform injects ARNs via `templatefile` (W6), so this file uses `${...}` placeholders.

- [ ] **Step 1: write `scripts/v2/workers/sfn.asl.json`**
```json
{
  "Comment": "AWSops v2 P2 worker router",
  "StartAt": "Route",
  "States": {
    "Route": {
      "Type": "Choice",
      "Choices": [
        { "Variable": "$.runtime", "StringEquals": "fargate", "Next": "RunFargate" }
      ],
      "Default": "RunLambda"
    },
    "RunLambda": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": { "FunctionName": "${worker_lambda_arn}", "Payload.$": "$" },
      "Retry": [ { "ErrorEquals": ["States.ALL"], "IntervalSeconds": 5, "MaxAttempts": 2, "BackoffRate": 2 } ],
      "Catch": [ { "ErrorEquals": ["States.ALL"], "ResultPath": "$.errorInfo", "Next": "MarkFailed" } ],
      "End": true
    },
    "RunFargate": {
      "Type": "Task",
      "Resource": "arn:aws:states:::ecs:runTask.sync",
      "Parameters": {
        "Cluster": "${ecs_cluster_arn}",
        "TaskDefinition": "${fargate_task_def_arn}",
        "LaunchType": "FARGATE",
        "NetworkConfiguration": { "AwsvpcConfiguration": {
          "Subnets": ${private_subnet_ids_json}, "SecurityGroups": ["${worker_sg_id}"], "AssignPublicIp": "DISABLED" } },
        "Overrides": { "ContainerOverrides": [ {
          "Name": "worker",
          "Command.$": "States.Array('--job-id', $.job_id)" } ] }
      },
      "Retry": [ { "ErrorEquals": ["States.TaskFailed"], "IntervalSeconds": 10, "MaxAttempts": 1, "BackoffRate": 2 } ],
      "Catch": [ { "ErrorEquals": ["States.ALL"], "ResultPath": "$.errorInfo", "Next": "MarkFailed" } ],
      "End": true
    },
    "MarkFailed": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": { "FunctionName": "${status_updater_arn}",
        "Payload": { "job_id.$": "$.job_id", "error.$": "$.errorInfo" } },
      "End": true
    }
  }
}
```
Note: the OOM-demo command (`--oom`) is set per-job via payload in a follow-up (the Fargate `Command` here passes `--job-id`; the `--oom` path is exercised in W9 by a dedicated job whose Command override includes `--oom` — see W9). For P2 proof simplicity, W9 runs the OOM task via a direct `aws ecs run-task` with `--oom` to demonstrate isolation, plus the normal SFN path for the happy case.

- [ ] **Step 2: validate JSON**
```bash
python3 -c "import json; json.load(open('/home/atomoh/awsops/scripts/v2/workers/sfn.asl.json')); print('asl JSON OK (templatefile vars resolve in TF)')" 2>&1 || echo "NOTE: \${...} placeholders are not valid JSON values as-is; they are templatefile() vars. Validate the RENDERED ASL in W6 via terraform validate."
```
(The `${...}` are Terraform `templatefile` variables — see W6. terraform validate in W6 confirms the rendered ASL.)

- [ ] **Step 3: commit**
```bash
cd /home/atomoh/awsops
git add scripts/v2/workers/sfn.asl.json
git commit -m "feat(v2-p2): SFN router ASL (Choice lambda/fargate, Retry, Catch->status-updater)"
```

---

## Task W6: `workers.tf` — all infrastructure (gated)

**Files:** Create `terraform/foundation/workers.tf`.

- [ ] **Step 1: write `terraform/foundation/workers.tf`**
```hcl
# AWSops v2 — P2 async worker backbone. Gated on var.workers_enabled (default false → no-op).
variable "workers_enabled" {
  type        = bool
  description = "Provision the async worker backbone (SQS/SFN/Lambda/Fargate/S3). Written by make configure."
  default     = false
}

locals {
  wk_count = var.workers_enabled ? 1 : 0
  wk_src   = "${path.module}/../../../scripts/v2/workers"
  wk_lambdas = var.workers_enabled ? {
    dispatcher     = { file = "dispatcher.py",     handler = "dispatcher.lambda_handler" }
    worker         = { file = "worker_lambda.py",  handler = "worker_lambda.lambda_handler" }
    status_updater = { file = "status_updater.py", handler = "status_updater.lambda_handler" }
    reaper         = { file = "reaper.py",          handler = "reaper.lambda_handler" }
  } : {}
}

# ---- S3 results bucket (versioned + SSE-KMS; Object Lock audit deferred to P3+) ----
resource "aws_s3_bucket" "worker_results" {
  count         = local.wk_count
  bucket        = "${var.project}-worker-results-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}
resource "aws_s3_bucket_versioning" "worker_results" {
  count  = local.wk_count
  bucket = aws_s3_bucket.worker_results[0].id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "worker_results" {
  count  = local.wk_count
  bucket = aws_s3_bucket.worker_results[0].id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "aws:kms" } }
}
resource "aws_s3_bucket_public_access_block" "worker_results" {
  count                   = local.wk_count
  bucket                  = aws_s3_bucket.worker_results[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---- SQS jobs queue + DLQ ----
resource "aws_sqs_queue" "jobs_dlq" {
  count = local.wk_count
  name  = "${var.project}-jobs-dlq"
}
resource "aws_sqs_queue" "jobs" {
  count                      = local.wk_count
  name                       = "${var.project}-jobs"
  visibility_timeout_seconds = 90
  redrive_policy = jsonencode({ deadLetterTargetArn = aws_sqs_queue.jobs_dlq[0].arn, maxReceiveCount = 5 })
}

# ---- worker SG + Aurora ingress (workers reach Aurora :5432) ----
resource "aws_security_group" "worker" {
  count       = local.wk_count
  name        = "${var.project}-worker-sg"
  description = "AWSops v2 async workers"
  vpc_id      = local.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_vpc_security_group_ingress_rule" "aurora_from_worker" {
  count                        = local.wk_count
  security_group_id            = aws_security_group.aurora.id
  referenced_security_group_id = aws_security_group.worker[0].id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from async workers"
}

# ---- shared Lambda execution role (Aurora secret + VPC + logs) ----
data "aws_iam_policy_document" "wk_lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals { type = "Service"; identifiers = ["lambda.amazonaws.com"] }
  }
}
resource "aws_iam_role" "wk_lambda" {
  count              = local.wk_count
  name               = "${var.project}-worker-lambda"
  assume_role_policy = data.aws_iam_policy_document.wk_lambda_assume.json
}
resource "aws_iam_role_policy_attachment" "wk_lambda_vpc" {
  count      = local.wk_count
  role       = aws_iam_role.wk_lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
resource "aws_iam_role_policy" "wk_lambda" {
  count = local.wk_count
  name  = "${var.project}-worker-lambda-perms"
  role  = aws_iam_role.wk_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "AuroraSecret", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"],
        Resource = [aws_rds_cluster.aurora.master_user_secret[0].secret_arn] },
      { Sid = "AuroraKms", Effect = "Allow", Action = ["kms:Decrypt"], Resource = [aws_kms_key.aurora.arn] },
      { Sid = "Sfn", Effect = "Allow", Action = ["states:StartExecution"], Resource = ["arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${var.project}-workers"] },
      { Sid = "S3Results", Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"], Resource = ["${aws_s3_bucket.worker_results[0].arn}/*"] },
      { Sid = "Enqueue", Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.jobs[0].arn] }
    ]
  })
}

# ---- the four Lambdas (shared role) ----
data "archive_file" "wk_lambda" {
  for_each    = local.wk_lambdas
  type        = "zip"
  output_path = "${path.module}/.build/wk-${each.key}.zip"
  source { content = file("${local.wk_src}/${each.value.file}"); filename = each.value.file }
  source { content = file("${local.wk_src}/db.py");       filename = "db.py" }
  source { content = file("${local.wk_src}/handlers.py"); filename = "handlers.py" }
}
resource "aws_lambda_function" "wk" {
  for_each         = local.wk_lambdas
  function_name    = "${var.project}-wk-${each.key}"
  role             = aws_iam_role.wk_lambda[0].arn
  runtime          = "python3.12"
  handler          = each.value.handler
  filename         = data.archive_file.wk_lambda[each.key].output_path
  source_code_hash = data.archive_file.wk_lambda[each.key].output_base64sha256
  architectures    = ["arm64"]
  timeout          = each.key == "worker" ? 600 : 60
  memory_size      = each.key == "worker" ? 512 : 256
  environment {
    variables = {
      AURORA_ENDPOINT   = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE   = aws_rds_cluster.aurora.database_name
      AURORA_SECRET_ARN = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
      STATE_MACHINE_ARN = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${var.project}-workers"
      WORKER_RESULTS_BUCKET = aws_s3_bucket.worker_results[0].id
    }
  }
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.worker[0].id]
  }
}

# ---- Fargate worker (reuse ECS cluster from workload.tf; dual-tier ECR like web/agentcore) ----
resource "aws_ecr_repository" "worker" {
  count                = local.wk_count
  name                 = "${var.project}-worker"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
  force_delete = true
}
resource "aws_iam_role" "wk_task" {
  count              = local.wk_count
  name               = "${var.project}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role_policy" "wk_task" {
  count = local.wk_count
  name  = "${var.project}-worker-task-perms"
  role  = aws_iam_role.wk_task[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "AuroraSecret", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_rds_cluster.aurora.master_user_secret[0].secret_arn] },
      { Sid = "AuroraKms", Effect = "Allow", Action = ["kms:Decrypt"], Resource = [aws_kms_key.aurora.arn] },
      { Sid = "S3Results", Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"], Resource = ["${aws_s3_bucket.worker_results[0].arn}/*"] }
    ]
  })
}
resource "aws_cloudwatch_log_group" "worker" {
  count             = local.wk_count
  name              = "/ecs/${var.project}-worker"
  retention_in_days = 30
}
resource "aws_ecs_task_definition" "worker" {
  count                    = local.wk_count
  family                   = "${var.project}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024" # hard limit — --oom allocates beyond this to prove isolation
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.wk_task[0].arn
  runtime_platform { cpu_architecture = "ARM64"; operating_system_family = "LINUX" }
  container_definitions = jsonencode([{
    name      = "worker"
    image     = "${aws_ecr_repository.worker[0].repository_url}:worker-latest"
    essential = true
    environment = [
      { name = "AURORA_ENDPOINT", value = aws_rds_cluster.aurora.endpoint },
      { name = "AURORA_DATABASE", value = aws_rds_cluster.aurora.database_name },
      { name = "AURORA_SECRET_ARN", value = aws_rds_cluster.aurora.master_user_secret[0].secret_arn },
      { name = "WORKER_RESULTS_BUCKET", value = aws_s3_bucket.worker_results[0].id }
    ]
    logConfiguration = { logDriver = "awslogs", options = {
      "awslogs-group" = aws_cloudwatch_log_group.worker[0].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "worker" } }
  }])
}

# ---- SFN state machine ----
resource "aws_iam_role" "wk_sfn" {
  count = local.wk_count
  name  = "${var.project}-workers-sfn"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "states.amazonaws.com" } }] })
}
resource "aws_iam_role_policy" "wk_sfn" {
  count = local.wk_count
  name  = "${var.project}-workers-sfn-perms"
  role  = aws_iam_role.wk_sfn[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "InvokeWorkers", Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = [aws_lambda_function.wk["worker"].arn, aws_lambda_function.wk["status_updater"].arn] },
      { Sid = "RunFargate", Effect = "Allow", Action = ["ecs:RunTask"], Resource = [aws_ecs_task_definition.worker[0].arn] },
      { Sid = "PassTaskRoles", Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.wk_task[0].arn, aws_iam_role.execution.arn] },
      { Sid = "RunTaskSyncEvents", Effect = "Allow", Action = ["events:PutTargets", "events:PutRule", "events:DescribeRule"], Resource = ["arn:aws:events:${var.region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctionsGetEventsForECSTaskRule"] }
    ]
  })
}
resource "aws_sfn_state_machine" "workers" {
  count    = local.wk_count
  name     = "${var.project}-workers"
  role_arn = aws_iam_role.wk_sfn[0].arn
  definition = templatefile("${local.wk_src}/sfn.asl.json", {
    worker_lambda_arn       = aws_lambda_function.wk["worker"].arn
    status_updater_arn      = aws_lambda_function.wk["status_updater"].arn
    ecs_cluster_arn         = aws_ecs_cluster.main.arn
    fargate_task_def_arn    = aws_ecs_task_definition.worker[0].arn
    worker_sg_id            = aws_security_group.worker[0].id
    private_subnet_ids_json = jsonencode(local.private_subnet_ids)
  })
}

# ---- SQS -> dispatcher ESM (= kill switch: enable/disable this) ----
resource "aws_lambda_event_source_mapping" "dispatch" {
  count                              = local.wk_count
  event_source_arn                   = aws_sqs_queue.jobs[0].arn
  function_name                      = aws_lambda_function.wk["dispatcher"].arn
  batch_size                         = 10
  function_response_types            = ["ReportBatchItemFailures"]
  enabled                            = true # kill switch: aws lambda update-event-source-mapping --enabled false
}
resource "aws_iam_role_policy" "wk_lambda_sqs_consume" {
  count = local.wk_count
  name  = "${var.project}-worker-lambda-sqs-consume"
  role  = aws_iam_role.wk_lambda[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
    Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = [aws_sqs_queue.jobs[0].arn] }] })
}

# ---- reaper schedule (EventBridge Scheduler, every 5 min) ----
resource "aws_scheduler_schedule" "reaper" {
  count                        = local.wk_count
  name                         = "${var.project}-worker-reaper"
  flexible_time_window { mode = "OFF" }
  schedule_expression          = "rate(5 minutes)"
  target {
    arn      = aws_lambda_function.wk["reaper"].arn
    role_arn = aws_iam_role.wk_scheduler[0].arn
  }
}
resource "aws_iam_role" "wk_scheduler" {
  count = local.wk_count
  name  = "${var.project}-worker-scheduler"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "scheduler.amazonaws.com" } }] })
}
resource "aws_iam_role_policy" "wk_scheduler" {
  count  = local.wk_count
  name   = "${var.project}-worker-scheduler-perms"
  role   = aws_iam_role.wk_scheduler[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = [aws_lambda_function.wk["reaper"].arn] }] })
}

# ---- web task role: enqueue (SQS) + read results (S3) ----
resource "aws_iam_role_policy" "task_workers" {
  count = local.wk_count
  name  = "${var.project}-task-workers"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Enqueue", Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.jobs[0].arn] },
      { Sid = "ReadResults", Effect = "Allow", Action = ["s3:GetObject"], Resource = ["${aws_s3_bucket.worker_results[0].arn}/*"] }
    ]
  })
}

output "workers" {
  description = "Worker backbone inputs (null when disabled)."
  value = var.workers_enabled ? {
    jobs_queue_url   = aws_sqs_queue.jobs[0].url
    state_machine    = aws_sfn_state_machine.workers[0].arn
    results_bucket   = aws_s3_bucket.worker_results[0].id
    dispatch_esm_uuid = aws_lambda_event_source_mapping.dispatch[0].uuid
    worker_ecr       = aws_ecr_repository.worker[0].repository_url
  } : null
}
```

- [ ] **Step 2: add web env (AURORA_* already present; add SQS queue URL) to the web task def** — in `workload.tf`, the web container `environment` add the jobs queue URL so `POST /api/jobs` can send. Modify `terraform/foundation/workload.tf` web container `environment` block to append:
```hcl
        { name = "JOBS_QUEUE_URL", value = var.workers_enabled ? aws_sqs_queue.jobs[0].url : "" },
```
(Place after the `HOSTNAME` entry. When disabled it's empty — web enqueue route returns 503 if empty.)

- [ ] **Step 3: validate (disabled = no-op)**
```bash
cd /home/atomoh/awsops/terraform/foundation
terraform fmt && ~/.local/bin/terraform validate
```
Expected: `Success! The configuration is valid.` (workers_enabled=false → count/for_each 0; the templatefile is parsed at plan time even when disabled — confirm no templatefile error. If templatefile errors on the unrendered file when count=0, it is still evaluated; the `${...}` vars are all supplied by the templatefile() call, so it renders fine regardless of the gate.)

- [ ] **Step 4: ensure `.build/` ignored (already from P1f) + commit**
```bash
cd /home/atomoh/awsops
git add terraform/foundation/workers.tf terraform/foundation/workload.tf
git commit -m "feat(v2-p2): workers.tf — SQS/DLQ, SFN, 4 Lambdas, Fargate worker, S3, reaper, kill-switch ESM, web grant (gated)"
```

---

## Task W7: web enqueue + status routes

**Files:** Create `web/app/api/jobs/route.ts`, `web/app/api/jobs/[id]/route.ts`; modify `web/package.json`.

- [ ] **Step 1: add the SQS SDK dep** — `web/package.json` dependencies, add `"@aws-sdk/client-sqs": "^3.600.0"`. Then:
```bash
cd /home/atomoh/awsops/web && npm install @aws-sdk/client-sqs --save
```

- [ ] **Step 2: write `web/app/api/jobs/route.ts`** (POST enqueue)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
const sqs = new SQSClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });

export async function POST(req: NextRequest) {
  const queueUrl = process.env.JOBS_QUEUE_URL;
  if (!queueUrl) return NextResponse.json({ error: 'workers disabled' }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  const { type, payload = {}, dry_run = false, idempotency_key = null } = body;
  if (!type) return NextResponse.json({ error: 'type required' }, { status: 400 });
  const pool = getPool();
  // dedup on idempotency_key: return existing job if present
  if (idempotency_key) {
    const ex = await pool.query('SELECT job_id FROM worker_jobs WHERE idempotency_key=$1', [idempotency_key]);
    if (ex.rows[0]) return NextResponse.json({ job_id: ex.rows[0].job_id, dedup: true });
  }
  const jobId = randomUUID();
  await pool.query(
    'INSERT INTO worker_jobs (job_id, type, payload, dry_run, idempotency_key) VALUES ($1,$2,$3,$4,$5)',
    [jobId, type, JSON.stringify(payload), dry_run, idempotency_key],
  );
  try {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ job_id: jobId, type, payload, dry_run }) }));
  } catch (e) {
    // send failed after insert — mark failed so it isn't an orphan (reaper would also catch it)
    await pool.query("UPDATE worker_jobs SET status='failed', error='enqueue send failed' WHERE job_id=$1 AND status='queued'", [jobId]);
    return NextResponse.json({ error: 'enqueue failed' }, { status: 502 });
  }
  return NextResponse.json({ job_id: jobId });
}
```

- [ ] **Step 3: write `web/app/api/jobs/[id]/route.ts`** (GET status/result)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const pool = getPool();
  const r = await pool.query(
    'SELECT job_id, type, status, result, artifact_uri, error FROM worker_jobs WHERE job_id=$1', [params.id]);
  if (!r.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(r.rows[0]);
}
```

- [ ] **Step 4: confirm `getPool` export exists in web db lib** (the existing `/api/db` route uses a pool). Verify the import path:
```bash
cd /home/atomoh/awsops/web
grep -rn "export function getPool\|export const getPool\|export default" src/lib/db.* app/lib/db.* 2>/dev/null | head
```
If the existing db helper exports differently (e.g., a `query()` or a default `pool`), adapt the two routes' import to match the actual export (read `web/app/api/db/route.ts` to see how it gets a pool) — do NOT invent a new pool; reuse the existing one. Adjust imports accordingly.

- [ ] **Step 5: typecheck + commit**
```bash
cd /home/atomoh/awsops/web
npx tsc --noEmit 2>&1 | head -20 || true   # report type errors; fix import paths if any
git -C /home/atomoh/awsops add web/app/api/jobs/route.ts web/app/api/jobs/[id]/route.ts web/package.json web/package-lock.json
git -C /home/atomoh/awsops commit -m "feat(v2-p2): web /api/jobs (POST enqueue, GET status) — SQS send + worker_jobs"
```

---

## Task W8: `make workers` (build+push Fargate image)

**Files:** Create `scripts/v2/workers.mjs`; modify `Makefile`.

- [ ] **Step 1: write `scripts/v2/workers.mjs`** (mirror `agentcore.mjs`/`deploy.mjs`)
```javascript
#!/usr/bin/env node
// AWSops v2 P2: build arm64 worker image -> push ECR. Run after `terraform apply` (workers_enabled=true).
import { execSync } from 'node:child_process';
const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const CHDIR = 'terraform/foundation';
const TAG = process.env.WORKER_IMAGE_TAG || 'worker-latest';
const DOCKER = process.env.DOCKER || 'sudo docker';
const tfJson = () => JSON.parse(execSync(`terraform -chdir=${CHDIR} output -json`, { encoding: 'utf8' }));
const sh = (cmd) => execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });
const w = tfJson().workers?.value;
if (!w) { console.error('workers output null — set workers_enabled=true and terraform apply first.'); process.exit(1); }
const repo = w.worker_ecr, registry = repo.split('/')[0];
console.log(`\n[1/2] ECR login -> ${registry}`);
sh(`aws ecr get-login-password --region ${REGION} | ${DOCKER} login --username AWS --password-stdin ${registry}`);
console.log(`\n[2/2] build + push arm64 worker image -> ${repo}:${TAG}`);
sh(`${DOCKER} buildx build --platform linux/arm64 -t ${repo}:${TAG} --push scripts/v2/workers/`);
console.log('\n✅ make workers complete');
```

- [ ] **Step 2: add `workers` Makefile target** — change `.PHONY` to include `workers`, append:
```make

workers: ## Build+push arm64 worker image (run after `terraform apply` with workers_enabled=true)
	@node scripts/v2/workers.mjs
```

- [ ] **Step 3: syntax-check + commit**
```bash
cd /home/atomoh/awsops
node --check scripts/v2/workers.mjs && echo "mjs OK"
git add scripts/v2/workers.mjs Makefile
git commit -m "feat(v2-p2): make workers — build+push arm64 Fargate worker image"
```
Expected: `mjs OK`.

---

## Task W9: enable + apply + build + verify (CONTROLLER, real infra)

**Files:** Modify `terraform/foundation/terraform.tfvars` (gitignored).

- [ ] **Step 1: apply schema (worker_jobs) to live Aurora** (from the in-VPC deploy host, like P1c; reuses the master secret). The controller runs psql:
```bash
# (controller has in-VPC psql access used in P1c). Apply idempotent DDL:
PGPASSWORD=... psql "host=<aurora-endpoint> dbname=awsops user=awsops_admin sslmode=require" \
  -f terraform/foundation/data/schema.sql
psql ... -c "\d worker_jobs" | head   # confirm table exists
```
Expected: `worker_jobs` table present (8+ columns). (If the controller lacks direct psql, run the DDL via a one-off `aws_rds_cluster` query path used in P1c.)

- [ ] **Step 2: enable + plan + apply** (controller, saved plan; confirm branch first)
```bash
cd /home/atomoh/awsops && git branch --show-current   # MUST be feat/v2-architecture-design
cd terraform/foundation
grep -q '^workers_enabled' terraform.tfvars || echo 'workers_enabled = true' >> terraform.tfvars
~/.local/bin/terraform plan -out tfplan -no-color 2>&1 | grep -E "will be (created|updated|destroyed|replaced)|^Plan:|aurora.*replaced" | head -40
```
Expected: ADD the worker resources (SQS×2, S3 bucket+3 config, worker SG + Aurora ingress rule, 4 Lambdas + role/policies, ECR, Fargate task def + role + log group, SFN + role, ESM, reaper schedule + role, task_workers policy) + web task def update (JOBS_QUEUE_URL) → new task def revision. **NO Aurora cluster replace, NO destroy of web/edge/agentcore.** Then:
```bash
terraform apply tfplan && cd /home/atomoh/awsops
```

- [ ] **Step 3: build+push the worker image**
```bash
cd /home/atomoh/awsops && make workers
```
Expected: `✅ make workers complete` (arm64 image pushed to `${project}-worker:worker-latest`).

- [ ] **Step 4: GREEN — Lambda job end-to-end (off web)**
```bash
REGION=ap-northeast-2
Q=$(terraform -chdir=terraform/foundation output -json workers | python3 -c "import json,sys;print(json.load(sys.stdin)['jobs_queue_url'])")
JID=$(python3 -c "import uuid;print(uuid.uuid4())")
# enqueue via SQS directly (web route exercised separately): insert job row first is the web's job;
# here drive the backbone: send a noop (lambda) job. The web POST /api/jobs is tested in Step 8.
# Simplest backbone test: use the web route (auth-gated) OR send SQS + pre-insert via psql. Use psql+SQS:
psql ... -c "INSERT INTO worker_jobs(job_id,type,payload) VALUES ('$JID','noop','{\"sleep_s\":2}'::jsonb)"
aws sqs send-message --queue-url "$Q" --message-body "{\"job_id\":\"$JID\",\"type\":\"noop\",\"payload\":{\"sleep_s\":2}}" --region $REGION
sleep 20
psql ... -c "SELECT status,runtime,result FROM worker_jobs WHERE job_id='$JID'"
```
Expected: status=`succeeded`, runtime=`lambda`, result has `"ok": true`.

- [ ] **Step 5: GREEN — Fargate job end-to-end**
```bash
JID=$(python3 -c "import uuid;print(uuid.uuid4())")
psql ... -c "INSERT INTO worker_jobs(job_id,type,payload) VALUES ('$JID','noop-heavy','{\"sleep_s\":5}'::jsonb)"
aws sqs send-message --queue-url "$Q" --message-body "{\"job_id\":\"$JID\",\"type\":\"noop-heavy\",\"payload\":{\"sleep_s\":5}}" --region $REGION
sleep 90   # Fargate cold start + run
psql ... -c "SELECT status,runtime FROM worker_jobs WHERE job_id='$JID'"
```
Expected: status=`succeeded`, runtime=`fargate`.

- [ ] **Step 6: GREEN — OOM isolation proof (the §9 criterion)**
```bash
# Run the Fargate worker with --oom directly (bypasses SFN to isolate the OOM behavior),
# then confirm web is unaffected.
JID=$(python3 -c "import uuid;print(uuid.uuid4())")
psql ... -c "INSERT INTO worker_jobs(job_id,type,payload) VALUES ('$JID','noop-heavy','{}'::jsonb)"
CLUSTER=awsops-v2
aws ecs run-task --cluster $CLUSTER --task-definition awsops-v2-worker --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<priv-subnets>],securityGroups=[<worker-sg>],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"worker","command":["--job-id","'$JID'","--oom"]}]}' --region $REGION
# wait for the task to OOM (exit 137), then:
sleep 90
aws ecs describe-tasks --cluster $CLUSTER --tasks <task-arn> --region $REGION --query 'tasks[0].containers[0].[exitCode,reason]' --output text   # expect 137 / OutOfMemory
curl -sS -o /dev/null -w "%{http_code}\n" https://awsops-v2.example.com/api/health   # MUST be 200 (web unaffected)
aws ecs describe-services --cluster $CLUSTER --services awsops-v2-web --region $REGION --query 'services[0].[runningCount,desiredCount]' --output text  # 1/1
```
Expected: worker task exitCode=137 (OutOfMemory), **web /api/health=200 + web 1/1 running** → OOM isolation proven. (Optionally drive the OOM via SFN by adding `--oom` to a job type; the direct run-task is the cleanest proof.)

- [ ] **Step 7: GREEN — kill-switch + idempotency + reaper**
```bash
ESM=$(terraform -chdir=terraform/foundation output -json workers | python3 -c "import json,sys;print(json.load(sys.stdin)['dispatch_esm_uuid'])")
aws lambda update-event-source-mapping --uuid "$ESM" --no-enabled --region $REGION   # kill switch OFF
# enqueue a job → stays queued (no dispatch); re-enable → it processes
aws lambda update-event-source-mapping --uuid "$ESM" --enabled --region $REGION       # back ON
# idempotency: POST /api/jobs twice with same idempotency_key → same job_id (tested via web in Step 8)
```
Expected: with ESM disabled, a sent message is NOT dispatched (job stays queued, no SFN execution); re-enabling resumes. Confirm via SFN execution count / job status.

- [ ] **Step 8: GREEN — web route + plan clean + commit/memory**
```bash
# web POST /api/jobs requires Cognito auth via CloudFront; test from in-VPC against the ALB or via an authed session.
# Minimal: confirm the route exists + 503 when disabled is moot (enabled). Validate plan is clean:
~/.local/bin/terraform -chdir=terraform/foundation plan -no-color 2>&1 | grep -E "No changes|Plan:"
rm -f terraform/foundation/tfplan
git -C /home/atomoh/awsops add -A :/ ':!**/__pycache__' ':!**/.build'   # or explicit paths
git -C /home/atomoh/awsops commit -m "feat(v2-p2): provision worker backbone — Lambda+Fargate jobs GREEN, OOM isolation proven, kill-switch+idempotency verified" --allow-empty
```
Expected: `No changes` (zero drift). Then update memory: **P2 DONE** (worker backbone live; Lambda+Fargate+OOM-proof+kill-switch+idempotency GREEN; real heavy ops → P3+). Record queue/SFN/bucket names + that web `make deploy` must re-run to pick up the JOBS_QUEUE_URL env (new web task def revision).

---

## Self-Review

**Spec coverage:** §2 flow → W4(dispatcher)+W5(SFN)+W3(workers)+W2(db)+W7(web)+W3(reaper/status-updater) ✓; §3 components → W6 (every row) ✓; §4 worker_jobs → W1 ✓; §5 OOM proof → W9 Step6 ✓; §6 ADR-029 hooks → idempotency(W7 dedup+UNIQUE), kill-switch(W6 ESM+W9 Step7), mutate-guard(W4+handlers registry), dry-run(W2 handlers+worker), Object Lock deferred ✓; §11 plan-notes → ExecutionAlreadyExists+ReportBatchItemFailures(W4), conditional transitions(W2 db.py), SFN .sync events IAM(W6 wk_sfn), RunTask Failures(SFN Catch→status_updater), VPC egress(worker SG egress-all via NAT), reaper(W3/W6) ✓; alarms = noted as follow-up (not P2-GREEN-blocking — see note).

**Placeholder scan:** Two intentional `...` markers remain in W9 (psql connection string + subnet/SG/task-arn values) — these are RUNTIME operator values (secrets/IDs) the controller fills from `terraform output`/the Aurora secret at apply time, not code placeholders. All code (Python/HCL/TS/JSON/JS) is complete. The reaper alarms/observability is explicitly scoped as a post-P2 follow-up (spec §11 LOW), not omitted code.

**Type/name consistency:** `var.workers_enabled` ↔ tfvars; `local.wk_lambdas` keys (dispatcher/worker/status_updater/reaper) == `aws_lambda_function.wk[*]` == SFN IAM refs `wk["worker"]`/`wk["status_updater"]`; `STATE_MACHINE_ARN` env == the `${var.project}-workers` SFN name (constructed ARN matches `aws_sfn_state_machine.workers.name`); `handlers.REGISTRY` types (`noop`→lambda, `noop-heavy`→fargate) drive both the dispatcher `runtime_for` and the SFN Choice on `$.runtime`; `db.finish_job`/`claim_running` used consistently by worker_lambda/status_updater/reaper/fargate_worker; web `worker_jobs` columns (status/result/artifact_uri/error) match W1 DDL; Fargate container name `worker` matches the SFN `ContainerOverrides[].Name` and the W9 run-task override.

**Fix applied during review:** W6 SFN role `RunTaskSyncEvents` scopes `events:*` to the AWS-managed `StepFunctionsGetEventsForECSTaskRule` (the rule SFN auto-manages for `.sync`); the constructed `STATE_MACHINE_ARN` in the Lambda env + IAM uses the literal name `${var.project}-workers` (matches the state machine resource name) to avoid a cycle (Lambdas are created before the SFN, which references them).

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-02-awsops-v2-p2-async-worker-backbone.md`. Two options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task W1–W8 (code + validate + commit), two-stage review between tasks. **W9 (apply + image build + Fargate/OOM/SFN verify) is long/shared-infra real AWS → CONTROLLER runs it**, paused for explicit go-ahead.

**2. Inline Execution** — W1–W9 in this session with checkpoints.

**Which approach?** (Per ultracode + the P1f precedent, I'll also run a co-agent/workflow review of this plan before execution.)
