"""The actual workflow binding preserves the existing dev ExternalId without AWS calls."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

import pytest
import yaml

from ci_failure_diagnostics import child_environment
from test_ci_deployment_workflows import ROOT, expression, workflow_step


@pytest.mark.parametrize("target,secret,override,expected", [
    ("dev", "existing-shared-reader-id", None, "existing-shared-reader-id"),
    ("dev", "", None, ""),
    ("main", "existing-shared-reader-id", None, ""),
    ("atomoh", "existing-shared-reader-id", None, ""),
    ("dev", "existing-shared-reader-id", "stack-specific-reader-id", "stack-specific-reader-id"),
    ("dev", "existing-shared-reader-id", "", ""),
])
def test_external_id_uses_dev_secret_and_preserves_explicit_tfvars_precedence(target, secret, override, expected):
    step = workflow_step("terraform.yml", "plan", "terraform plan")
    value = expression(step.get("env", {}).get("TF_VAR_agent_external_id", ""),
                       {"env": {"TARGET": target}, "secrets": {"AGENT_EXTERNAL_ID_DEV": secret}})
    source = (ROOT / "terraform/foundation/variables.tf").read_text()
    start = source.index('variable "agent_external_id"')
    end = re.search(r'\nvariable "', source[start + 1:])
    declaration = source[start:start + 1 + end.start()] if end else source[start:]
    with tempfile.TemporaryDirectory() as directory:
        Path(directory, "main.tf").write_text(declaration + "\n")
        if override is not None:
            Path(directory, "terraform.tfvars").write_text("agent_external_id = " + json.dumps(override) + "\n")
        env = {key: val for key, val in os.environ.items() if not key.startswith("TF_")}
        env.update(TF_VAR_agent_external_id=value, CHECKPOINT_DISABLE="1", TF_IN_AUTOMATION="1")
        result = subprocess.run(["terraform", "console", "-no-color"],
                                input="nonsensitive(var.agent_external_id)\n",
                                cwd=directory, env=child_environment(env),
                                text=True, capture_output=True, timeout=20, check=True)
        assert json.loads(result.stdout) == expected


def test_external_id_secret_is_only_available_to_the_plan_step():
    workflow = yaml.safe_load((ROOT / ".github/workflows/terraform.yml").read_text())
    assert "AGENT_EXTERNAL_ID_DEV" not in json.dumps(workflow.get("env", {}))
    bindings = []
    for job_name, job in workflow["jobs"].items():
        assert "AGENT_EXTERNAL_ID_DEV" not in json.dumps(job.get("env", {}))
        for step in job["steps"]:
            if "AGENT_EXTERNAL_ID_DEV" in json.dumps(step):
                bindings.append((job_name, step["name"]))
    assert bindings == [("plan", "terraform plan")]
