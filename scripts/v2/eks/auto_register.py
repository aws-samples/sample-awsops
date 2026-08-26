"""EKS auto-register — EventBridge(CloudTrail) → eks_registrations.

The v1 "Register kubeconfig" flow, fully automated for v2: when an operator runs the
onboarding CLI (create-access-entry + associate-access-policy) for the web task role,
CloudTrail emits the management event, EventBridge matches it, and this Lambda records
the cluster in Aurora `eks_registrations` — the BFF allow-list (env ∪ DB) picks it up on
the next read. DeleteAccessEntry symmetrically unregisters. READ-ONLY toward AWS: we
never create/modify AWS resources here — we only observe operator actions (ADR-029-safe).

OPERATIONAL NOTE (PR #36 r5): registration reflects the policy posture AT GRANT TIME.
A later AssociateAccessPolicy adding a broader policy is skipped by the read-only gate
(the row stays — correctly, since the view policy is still attached), and removing the
entry unregisters. The BFF's kind allow-list independently caps what can transit anyway.

Env: AURORA_ENDPOINT, AURORA_DATABASE, AURORA_SECRET_ARN, TASK_ROLE_NAME, AWS_REGION.
"""
import json
import os
import re
import ssl
import time
import urllib.parse

# Secret cache with TTL — a warm Lambda container must not hold a rotated-out password
# forever (PR #36 r3: RDS-managed rotation would start failing auth after the cycle).
_SECRET_TTL_S = 300
_secret_cache: dict = {}


# Only read-only VIEW policy associations may auto-register (PR #36 r4): an operator
# fat-fingering e.g. AmazonEKSEditPolicy onto the task role must NOT silently onboard
# that cluster — ADR-029 reversal keeps this system strictly read-only.
# Keep in sync with terraform/foundation/eks.tf aws_eks_access_policy_association.web_view
# policy_arn (AdminViewPolicy) — both lists name AWS-managed, stable policy names (PR #36 r5).
_READONLY_POLICY_SUFFIXES = ("/AmazonEKSViewPolicy", "/AmazonEKSAdminViewPolicy")


def parse_event(event, task_role_name):
    """Pure: extract (action, cluster) from a CloudTrail-via-EventBridge EKS event.

    Returns ("register"|"unregister", cluster) or (None, reason). Only events whose
    principalArn targets OUR task role count — other principals' entries are not ours —
    and only read-only view-policy associations register.
    """
    # Defense-in-depth (PR #36 r5): the EventBridge rule already filters
    # source=aws.eks + eventSource=eks.amazonaws.com (eks.tf), but a misconfigured
    # rule edit or manual test invoke must not slip foreign events through.
    if event.get("source") not in (None, "aws.eks"):
        return None, f"unexpected event source: {event.get('source')}"
    detail = event.get("detail") or {}
    name = detail.get("eventName") or ""
    if detail.get("errorCode"):  # failed API calls must not register anything
        return None, f"errored call: {name or '(no eventName)'} -> {detail.get('errorCode')}"
    params = detail.get("requestParameters") or {}
    # EKS REST API: the cluster is the 'name' path param; principalArn may be URL-encoded.
    cluster = params.get("name") or params.get("clusterName") or ""
    principal = urllib.parse.unquote(params.get("principalArn") or "")
    if not cluster:
        return None, "no cluster in requestParameters"
    # Same charset gate as the BFF's CLUSTER_NAME_RE — eks_registrations is a TEXT PK,
    # so the Lambda must not be the path that lets a malformed name in (PR #36 r5).
    if not re.fullmatch(r"[0-9A-Za-z][A-Za-z0-9-_]{0,99}", cluster):
        return None, f"invalid cluster name: {cluster[:120]}"
    if not principal.endswith(f":role/{task_role_name}"):
        return None, f"principal is not {task_role_name}"
    if name == "AssociateAccessPolicy":
        policy = urllib.parse.unquote(params.get("policyArn") or "")
        if not policy.endswith(_READONLY_POLICY_SUFFIXES):
            return None, f"policy is not a read-only view policy: {policy or '(absent)'}"
        return "register", cluster
    if name == "DeleteAccessEntry":
        return "unregister", cluster  # entry deletion revokes ALL policies — always unregister
    return None, f"unhandled event {name}"


def _creds(force_refresh=False):
    import boto3
    arn = os.environ["AURORA_SECRET_ARN"]
    hit = _secret_cache.get(arn)
    if force_refresh or hit is None or time.monotonic() - hit["at"] > _SECRET_TTL_S:
        sm = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
        hit = {"value": json.loads(sm.get_secret_value(SecretId=arn)["SecretString"]), "at": time.monotonic()}
        _secret_cache[arn] = hit
    return hit["value"]


def _ssl_context():
    """Verified TLS to Aurora — PR #36 review MAJOR, implemented (not just TODO'd).

    This path is auto-triggered by EventBridge and WRITES the cluster allow-list, so a
    MITM on the Aurora hop could inject an arbitrary cluster into eks_registrations →
    the BFF would immediately proxy it. Unlike workers/db.py (job queue; different threat
    model), this connection REQUIRES cert verification: the GLOBAL RDS CA bundle
    (rds-ca-bundle.pem = truststore.pki.rds.amazonaws.com/global/global-bundle.pem —
    all regions, so multi-region deploys need no swap; PR #36 r3) ships in the Lambda
    zip and hostname checking stays on (pg8000 passes host as server_hostname).
    Bundle refresh (AWS rotates CAs rarely; bundle carries current+next gens):
      curl -sf https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
        -o scripts/v2/eks/rds-ca-bundle.pem   # then terraform apply re-zips it
    """
    bundle = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rds-ca-bundle.pem")
    ctx = ssl.create_default_context(cafile=bundle)
    # defaults with a cafile: verify_mode=CERT_REQUIRED, check_hostname=True — keep both.
    return ctx


def _connect():
    import pg8000.native
    c = _creds()
    return pg8000.native.Connection(
        user=c["username"], password=c["password"],
        host=os.environ["AURORA_ENDPOINT"], database=os.environ["AURORA_DATABASE"],
        port=5432, ssl_context=_ssl_context(),
    )


def handler(event, _ctx):
    action, cluster = parse_event(event, os.environ.get("TASK_ROLE_NAME", "awsops-v2-task"))
    if action is None:
        print(json.dumps({"evt": "eks_auto_register_skip", "reason": cluster}))
        return {"skipped": True, "reason": cluster}
    actor = ((event.get("detail") or {}).get("userIdentity") or {}).get("arn", "cloudtrail")
    try:
        conn = _connect()
    except Exception:
        # Likely a mid-TTL credential rotation — force-refresh the secret and retry once
        # (PR #36 r3). A second failure propagates to EventBridge's retry policy.
        _creds(force_refresh=True)
        conn = _connect()
    try:
        if action == "register":
            conn.run(
                "INSERT INTO eks_registrations (cluster_name, registered_by) VALUES (:c, :b) "
                "ON CONFLICT (cluster_name) DO NOTHING",
                c=cluster, b=f"eventbridge:{actor}",  # registered_by is TEXT — no truncation needed (PR #36 review)
            )
        else:
            conn.run("DELETE FROM eks_registrations WHERE cluster_name = :c", c=cluster)
    finally:
        conn.close()
    print(json.dumps({"evt": "eks_auto_register", "action": action, "cluster": cluster, "actor": actor}))
    return {"ok": True, "action": action, "cluster": cluster}
