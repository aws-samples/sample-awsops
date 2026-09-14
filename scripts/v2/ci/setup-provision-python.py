#!/usr/bin/env python3
"""Prepare isolated, hash-pinned host SDK packages before AgentCore deployment."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

REQUIREMENTS = Path(__file__).resolve().parents[1] / "agentcore/requirements-provision.txt"
PREFIX = "awsops-provision-python-"
PREFLIGHT = """
import json, platform, boto3, botocore, botocore.session
session = botocore.session.get_session()
control = session.get_service_model('bedrock-agentcore-control')
required = {'CreateAgentRuntime', 'GetAgentRuntime', 'CreateGateway',
            'CreateGatewayTarget', 'CreateMemory', 'CreateCodeInterpreter'}
assert required <= set(control.operation_names)
assert 'InvokeAgentRuntime' in session.get_service_model('bedrock-agentcore').operation_names
print(json.dumps({'python': platform.python_version(),
                  'boto3': boto3.__version__, 'botocore': botocore.__version__}))
"""


def child_environment(env):
    result = {key: env[key] for key in ("PATH", "LD_LIBRARY_PATH", "LANG", "LC_ALL", "SYSTEMROOT")
              if env.get(key)}
    result.update(AWS_EC2_METADATA_DISABLED="true", AWS_CONFIG_FILE="/dev/null",
                  AWS_SHARED_CREDENTIALS_FILE="/dev/null")
    return result


def cleanup(root, directory):
    if not directory:
        return
    path = Path(directory)
    if (not path.is_absolute() or path.parent != Path(root).resolve()
            or not re.fullmatch(PREFIX + r"[a-zA-Z0-9_]+", path.name) or path.is_symlink()):
        raise ValueError("invalid_provision_sdk_directory")
    if path.exists():
        shutil.rmtree(path)


def prepare(env, run=subprocess.run):
    root = Path(env["RUNNER_TEMP"]).resolve()
    if not root.is_dir() or any(c in str(root) for c in "\r\n"):
        raise ValueError("invalid_provision_sdk_root")
    directory = tempfile.mkdtemp(prefix=PREFIX, dir=root)
    phase = "provision_python_create_failed"
    try:
        child = child_environment(env)
        run([sys.executable, "-m", "venv", directory],
            env=child, check=True, capture_output=True, text=True, timeout=90)
        python = str(Path(directory) / "bin/python3")
        phase = "provision_sdk_install_failed"
        run([python, "-m", "pip", "--isolated", "install", "--no-cache-dir",
             "--index-url", "https://pypi.org/simple", "--require-hashes", "--only-binary=:all:",
             "-r", str(REQUIREMENTS)],
            env=child, check=True, capture_output=True, text=True, timeout=300)
        phase = "provision_sdk_preflight_failed"
        result = run([python, "-c", PREFLIGHT], env=child, check=True,
                     capture_output=True, text=True, timeout=30)
        versions = json.loads(result.stdout)
        if (set(versions) != {"python", "boto3", "botocore"}
                or any(not re.fullmatch(r"\d+\.\d+\.\d+", value) for value in versions.values())
                or not versions["python"].startswith("3.12.")):
            raise ValueError()
        run([python, str(REQUIREMENTS.parent / "provision.py"), "--help"],
            env=child, check=True, capture_output=True, text=True, timeout=30)
        # Publish only after package installation and local service-model checks succeed.
        with open(env["GITHUB_PATH"], "a") as stream:
            stream.write(f"{directory}/bin\n")
        with open(env["GITHUB_OUTPUT"], "a") as stream:
            stream.write(f"directory={directory}\n")
        print(json.dumps({"provision_sdk": "ready", **versions}))
        return directory
    except BaseException:
        cleanup(root, directory)
        raise RuntimeError(phase) from None


def main():
    try:
        if len(sys.argv) != 2:
            raise ValueError("invalid_provision_sdk_command")
        if sys.argv[1] == "prepare":
            if sys.version_info[:2] != (3, 12):
                raise ValueError("provision_sdk_requires_python_312")
            prepare(os.environ)
        elif sys.argv[1] == "cleanup":
            cleanup(os.environ["RUNNER_TEMP"], os.environ.get("PROVISION_SDK_DIRECTORY", ""))
        else:
            raise ValueError("invalid_provision_sdk_command")
    except (ValueError, RuntimeError, KeyError) as error:
        code = str(error) if re.fullmatch(r"[a-z0-9_]+", str(error)) else "provision_sdk_setup_failed"
        print(f"::error::{code}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
