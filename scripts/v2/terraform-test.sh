#!/usr/bin/env bash
# Mock providers only, in a disposable copy of tracked working-tree files.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Never inherit deployment credentials, CLI arguments, variables or backend data.
# TF_CLI_CONFIG_FILE / TF_PLUGIN_CACHE_DIR may point to a prepopulated provider mirror/cache.
for name in $(compgen -e); do
  case "$name" in
    AWS_*|GH_TOKEN|GITHUB_TOKEN|TF_VAR_*|TF_CLI_ARGS*|TF_DATA_DIR|TF_WORKSPACE|TF_LOG*|TF_REATTACH_PROVIDERS)
      unset "$name";;
  esac
done
export CHECKPOINT_DISABLE=1 AWS_EC2_METADATA_DISABLED=true
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
terraform version -json | python3 -c \
  'import json,sys; v=json.load(sys.stdin)["terraform_version"]; sys.exit(0 if v == "1.17.1" else "Terraform 1.17.1 is required")'

scratch="$(mktemp -d "${TMPDIR:-/tmp}/awsops-terraform-test.XXXXXXXX")"
trap 'rm -rf "$scratch"' EXIT
# Preserve relative archive source paths; exclude untracked backend/config/state
# and .terraform data. Current tracked files may have been deleted or renamed.
git ls-files -z | python3 -c \
  'import os,sys
paths=[p for p in sys.stdin.buffer.read().split(b"\0") if p]
for p in paths:
    if not os.path.lexists(p): sys.stderr.write("terraform-test: skipping tracked path missing from the working tree: %s\n" % p.decode(errors="replace"))
sys.stdout.buffer.write(b"".join(p+b"\0" for p in paths if os.path.lexists(p)))' \
  | tar --null --verbatim-files-from -T - -cf - | tar -C "$scratch" -xf -
cd "$scratch/terraform/foundation"
export TF_DATA_DIR="$scratch/.terraform"
terraform init -backend=false -input=false -lockfile=readonly -no-color
terraform validate -no-color
terraform test -filter=tests/dns_deferred.tftest.hcl -filter=tests/runtime_iam.tftest.hcl -filter=tests/controller_readiness.tftest.hcl -no-color
