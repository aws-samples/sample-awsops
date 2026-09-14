# Legacy web image recovery

## Symptoms and scope

An older production image may predate build receipts or outlive their 90-day retention. Actions correctly refuses reuse without that evidence. This is an explicitly approved operator recovery, not a receipt bypass in Actions. Never manufacture a receipt or treat a mutable SHA tag or image label as source provenance.

## Required evidence and approval

Record privately: target account/project/region and operator role, the older source SHA, exact image digest, trusted successful build/deployment records tying that digest to the source, reviewed controller checkout SHA, current schema compatibility approval, and change owner/window. Original authenticated Actions run metadata plus its successful build's digest log can establish the legacy binding. If the binding is unavailable, stop; a separately reviewed rebuild is a new candidate, not proof of the old image.

Coordinate with the parent/operator before AWS writes. Freeze competing releases and migrations for the window. Use current reviewed helpers from a clean checkout; never execute the old application's migration runner. No migration runs here.

## Verify and recover

On the approved private operator host, select an existing AWS profile and set **metadata only**:

```bash
export AWS_PROFILE='<approved-operator-profile>'
export AWS_REGION=ap-northeast-2
export AWS_MAX_ATTEMPTS=1
export RECOVERY_ACCOUNT='<12-digit-account>'
export RECOVERY_PROJECT='<project>'
export RECOVERY_ROLE_NAME='<approved-assumed-role-name>'
export RECOVERY_DIGEST='sha256:<approved-64-hex-digest>'
export RECOVERY_CONTROLLER_SHA='<reviewed-controller-commit>'
export RECOVERY_SCHEMA_APPROVED=true
set -euo pipefail
test "$(git rev-parse HEAD)" = "$RECOVERY_CONTROLLER_SHA"
git diff --quiet
git diff --cached --quiet
test -z "$(git status --porcelain --untracked-files=all)"
```

The helpers support `ap-northeast-2` and the owned `web-latest` task configuration. Account/project must come from independently checked production metadata. Obtain explicit approval for the following one tag promotion and one service update; the boolean is not a substitute for that approval:

```bash
python3 - <<'PY'
import os, re, sys
sys.path.insert(0, "scripts/v2")
from ci_web_deploy import aws_request, runtime_digest, snapshot, start, verify
from ci_web_image import require, pin_image
c = {"account": os.environ["RECOVERY_ACCOUNT"], "project": os.environ["RECOVERY_PROJECT"]}
role = os.environ["RECOVERY_ROLE_NAME"]
require(re.fullmatch(r"[0-9]{12}", c["account"]) and
        re.fullmatch(r"[a-z][a-z0-9-]{1,39}", c["project"]) and
        re.fullmatch(r"[A-Za-z0-9_+=,.@-]+", role), "Invalid approved target")
require(os.environ.get("RECOVERY_SCHEMA_APPROVED") == "true", "Schema approval required")
require(not any(k.startswith("AWS_ENDPOINT_URL") and v for k, v in os.environ.items()),
        "Endpoint overrides forbidden")
identity = aws_request("sts", "get-caller-identity", [])
require(identity.get("Account") == c["account"] and
        identity.get("Arn", "").startswith(f'arn:aws:sts::{c["account"]}:assumed-role/{role}/'),
        "Operator identity mismatch")
digest = os.environ["RECOVERY_DIGEST"]
child = runtime_digest(c, digest)
before = snapshot(c, aws_request)
pin_image(c["project"] + "-web", digest, account=c["account"])
proof = start(c, digest, child, aws_request, before=before)
verify(c, proof)
print("Approved legacy image and exact healthy deployment verified")
PY
```

Reads verify content, ARM64 selection, owned configuration, positive desired count and effective access before mutation. Empty/unhealthy services can recover; paused services cannot be reactivated. Replaced deployments, wrong digests and unhealthy candidates fail; there is no automatic second mutation or rollback.

Before closing recovery, use the existing authenticated login/DB smoke with a private credential file for this target: set `PUBLIC_URL`, `CLOUDFRONT_DOMAIN` and `SMOKE_CREDENTIAL_FILE` through the approved private process, then run `node scripts/v2/authenticated-smoke.mjs`. Never substitute dev demo credentials on production, reset credentials to pass or publish response bodies. Retain source/digest and actual verification results in the private change record.

## Stop conditions and related files

Stop on missing provenance/schema approval, target mismatch, denied reads or failed verification. A post-pin failure may leave state changed: inspect it before another explicitly approved recovery. Do not use `make deploy` for rollback because it also runs migrations.

See [web release](web-release.md), [deployment setup](dev-repo-setup.md), `scripts/v2/ci_web_image.py`, `scripts/v2/ci_web_deploy.py`, and `scripts/v2/authenticated-smoke.mjs`. ADR-001 preserves immutable migration history; ADR-005 separates operator deployments from frozen product autonomy.
