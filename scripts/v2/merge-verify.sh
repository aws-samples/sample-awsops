#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

python_failures=()
web_failed=0

if [[ -n "${MERGE_VERIFY_PY_ROOT:-}" ]]; then
  py_roots=("$MERGE_VERIFY_PY_ROOT")
else
  py_roots=("scripts/v2" "agent")
fi

echo "== Stage 1: isolated pytest files =="
test_files=()
for root in "${py_roots[@]}"; do
  if [[ -d "$root" ]]; then
    while IFS= read -r -d '' file; do
      test_files+=("$file")
    done < <(find "$root" -type f -name 'test_*.py' -print0 | sort -z)
  else
    echo "SKIP missing Python test root: $root"
  fi
done

if [[ ${#test_files[@]} -eq 0 ]]; then
  echo "No Python test files found."
else
  for file in "${test_files[@]}"; do
    test_dir="$(dirname "$file")"
    test_arg="$(basename "$file")"
    test_pythonpath=""
    if [[ "$(basename "$test_dir")" == "tests" ]]; then
      test_pythonpath="$(cd "$test_dir/.." && pwd)"
    fi
    echo "RUN (cd $test_dir && python3 -m pytest $test_arg -q)"
    if [[ -n "$test_pythonpath" ]]; then
      if ! (cd "$test_dir" && PYTHONPATH="$test_pythonpath${PYTHONPATH:+:$PYTHONPATH}" python3 -m pytest "$test_arg" -q); then
        python_failures+=("$file")
      fi
    elif ! (cd "$test_dir" && python3 -m pytest "$test_arg" -q); then
      python_failures+=("$file")
    fi
  done
fi

echo "== Stage 2: web vitest =="
if [[ "${MERGE_VERIFY_SKIP_WEB:-0}" == "1" ]]; then
  echo "SKIP MERGE_VERIFY_SKIP_WEB=1"
else
  if ! (cd web && npx vitest run); then
    web_failed=1
  fi
fi

echo "== Stage 3: terraform checks =="
terraform_status="SKIP terraform binary not found"
if command -v terraform >/dev/null 2>&1; then
  terraform_fmt_status="PASS fmt -check"
  if ! terraform -chdir=terraform/foundation fmt -check; then
    terraform_fmt_status="WARN fmt -check failed (non-blocking)"
  fi

  terraform_validate_status="SKIP validate (.terraform missing)"
  if [[ -d terraform/foundation/.terraform ]]; then
    terraform_validate_status="PASS validate"
    if ! terraform -chdir=terraform/foundation validate; then
      terraform_validate_status="WARN validate failed (non-blocking)"
    fi
  fi

  terraform_status="$terraform_fmt_status; $terraform_validate_status"
fi

echo "== Merge verification summary =="
if [[ ${#python_failures[@]} -eq 0 ]]; then
  echo "Python isolated pytest: PASS"
else
  echo "Python isolated pytest: FAIL"
  for file in "${python_failures[@]}"; do
    echo "  - $file"
  done
fi

if [[ "${MERGE_VERIFY_SKIP_WEB:-0}" == "1" ]]; then
  echo "Web vitest: SKIP"
elif [[ "$web_failed" -eq 0 ]]; then
  echo "Web vitest: PASS"
else
  echo "Web vitest: FAIL"
fi

echo "Terraform: $terraform_status"

if [[ ${#python_failures[@]} -gt 0 || "$web_failed" -ne 0 ]]; then
  exit 1
fi
exit 0
