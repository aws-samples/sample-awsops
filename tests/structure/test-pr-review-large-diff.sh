#!/bin/bash
# Privileged CI may read immutable PR Git objects. Only reviewed CI code may execute.
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 - <<'PY'
from pathlib import Path
import yaml

jobs = yaml.safe_load(Path(".github/workflows/pr-review.yml").read_text())["jobs"]
prepare, model, gate = (jobs[key] for key in ("prepare", "claude", "gate"))
for job in (prepare, model):
    assert "ci-review-recovery" in job["environment"] and "ci-review-auto" in job["environment"]
    for step in job["steps"]:
        if step.get("uses", "").startswith("actions/checkout@"):
            assert step["with"]["persist-credentials"] is False
            ref = step["with"]["ref"]
            assert ref in {
                "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
                "${{ github.event.pull_request.base.sha }}",
            }
        assert "${{" not in step.get("run", ""), "pass event fields as quoted environment data"
assert "id-token" not in prepare["permissions"]
assert model["needs"] == "prepare"
assert model["permissions"] == {"contents": "read", "pull-requests": "read", "id-token": "write"}
credentials = next(s for s in model["steps"] if s.get("uses", "").startswith("aws-actions/configure-aws-credentials@"))
assert credentials["with"]["role-to-assume"] == "${{ secrets.AWS_CI_REVIEW_ROLE_ARN }}"
assert credentials["with"]["role-duration-seconds"] == 3600
assert credentials["with"]["unset-current-credentials"] is True
assert credentials["with"]["use-existing-credentials"] is False
assert not any("${{" in step.get("run", "") for step in gate["steps"])
scope = Path("scripts/pr-review/claude_scope.py").read_text()
assert '"--literal-pathspecs"' in scope
assert '"--no-renames", "--name-only", "-z"' in scope
assert 'os.fsdecode(raw_name)' in scope
print("ok - trusted CI checkout, immutable target base, literal Git paths and isolated Bedrock credentials")
PY
