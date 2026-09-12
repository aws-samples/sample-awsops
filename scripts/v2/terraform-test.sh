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
  'import json,sys; v=json.load(sys.stdin)["terraform_version"]; sys.exit(0 if v == "1.15.7" else "Terraform 1.15.7 is required")'

scratch="$(mktemp -d "${TMPDIR:-/tmp}/awsops-terraform-test.XXXXXXXX")"
trap 'rm -rf "$scratch"' EXIT
# Preserve relative archive source paths; exclude untracked backend/config/state
# and .terraform data. This copies current edits, not a stale HEAD archive.
git ls-files -z | tar --null --verbatim-files-from -T - -cf - | tar -C "$scratch" -xf -
cd "$scratch/terraform/foundation"
export TF_DATA_DIR="$scratch/.terraform"
terraform init -backend=false -input=false -lockfile=readonly -no-color
terraform validate -no-color
terraform test -filter=tests/dns_deferred.tftest.hcl -no-color
