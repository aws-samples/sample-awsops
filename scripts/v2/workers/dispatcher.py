"""SQS-triggered dispatcher: validate the job type, start ONE Step Functions execution per message.
Idempotent on execution name (== job_id) -> ExecutionAlreadyExists is success (SQS at-least-once
redelivery). Returns batchItemFailures (ReportBatchItemFailures) so ONLY genuinely-failed messages
are retried/DLQ'd. No Aurora access here: the web route already inserted the 'queued' row; the
worker/status_updater own all status writes. The SQS ESM is the kill-switch (disable = pause dispatch)."""
import json
import os
import boto3
import handlers

_sfn = boto3.client("stepfunctions", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
_SM_ARN = os.environ["STATE_MACHINE_ARN"]
# ADR-029+036: remediation jobs route to a SEPARATE state machine. Empty when remediation is off
# (the gated infra in remediation.tf is the only thing that sets this) -> action jobs are DROPPED.
_REM_SM_ARN = os.environ.get("REMEDIATION_STATE_MACHINE_ARN", "")
# ADR-032: incident_stage jobs route to the SIBLING incident state machine. Empty when the
# autonomous incident lifecycle is off (only the gated infra in incidents.tf sets this) ->
# incident_stage jobs are DROPPED (never retried into a loop). The lifecycle ships flag-OFF.
_INC_SM_ARN = os.environ.get("INCIDENT_STATE_MACHINE_ARN", "")


def lambda_handler(event, _ctx):
    failures = []
    for rec in event.get("Records", []):
        msg_id = rec["messageId"]
        job_id = None
        try:
            body = json.loads(rec["body"])
            job_id, type_ = body["job_id"], body["type"]
            if type_ == "action":
                # ADR-029+036 remediation job. The web `execute` route already injected the catalog
                # `action` name + `executor_type` (the dispatcher has NO Aurora access, so it does NOT
                # resolve the catalog here — the catalog gate runs in-VPC in record_ssm_start /
                # remediation_executor). The dispatcher only picks the remediation SM.
                if not _REM_SM_ARN:
                    # Remediation substrate is OFF (flag/infra) -> drop (never retry into a loop).
                    print(f"DROP action job (remediation disabled) job_id={job_id}")
                    continue
                _sfn.start_execution(
                    stateMachineArn=_REM_SM_ARN,
                    name=job_id,  # idempotent: execution name == job_id
                    input=json.dumps({
                        "job_id": job_id,
                        "plan_id": body.get("plan_id"),
                        "action": body["action"],
                        "payload": body.get("payload", {}),
                        "dry_run": bool(body.get("dry_run", False)),
                        "runtime": body.get("executor_type", "lambda"),  # SM Choice routes on this
                    }),
                )
                continue
            if type_ == "incident_stage":
                # ADR-032 autonomous incident lifecycle. The web Triage route already inserted the
                # 'queued' worker_jobs row + the incidents/stage rows; the dispatcher only picks the
                # sibling incident SM (it has NO Aurora access). Empty SM ARN => lifecycle is OFF
                # (flag/infra) -> drop (never retry into a loop). The SM itself invokes the stage
                # Lambdas; the Lead delegates only (no mutation here or downstream).
                if not _INC_SM_ARN:
                    print(f"DROP incident job (lifecycle disabled) job_id={job_id}")
                    continue
                _sfn.start_execution(
                    stateMachineArn=_INC_SM_ARN,
                    name=job_id,  # idempotent: execution name == job_id
                    input=json.dumps({
                        "job_id": job_id,
                        "incident_id": body.get("incident_id"),
                        "payload": body.get("payload", {}),
                    }),
                )
                continue
            if not handlers.is_allowed(type_):
                # Disallowed/unknown type is a client error: it will NEVER succeed, so drop (do not
                # retry into an infinite loop / DLQ). Logged for triage. The web route validates too.
                print(f"DROP unknown type={type_} job_id={job_id}")
                continue
            _sfn.start_execution(
                stateMachineArn=_SM_ARN,
                name=job_id,  # idempotent: execution name == job_id
                input=json.dumps({
                    "job_id": job_id,
                    "type": type_,
                    "payload": body.get("payload", {}),
                    "dry_run": bool(body.get("dry_run", False)),
                    "runtime": handlers.runtime_for(type_),  # SFN Choice routes on this
                }),
            )
        except _sfn.exceptions.ExecutionAlreadyExists:
            # Already started for this job_id (redelivery): success, no retry.
            print(f"DUP execution exists job_id={job_id}")
        except Exception as e:  # noqa: BLE001 - any other error -> retry this one message, then DLQ
            print(f"FAIL msg={msg_id} job_id={job_id}: {e}")
            failures.append({"itemIdentifier": msg_id})
    return {"batchItemFailures": failures}
