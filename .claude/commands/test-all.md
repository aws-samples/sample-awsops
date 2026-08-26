# Run Full Test Suite

Execute the complete AWSops v2 validation pipeline.

## Steps

1. **App gate**: Run `bash scripts/v2/merge-verify.sh` (Python pytest for `scripts/v2`+`agent`, `web/` vitest, `terraform/foundation` validate)
2. **Repo tooling tests**: Run `bash tests/run-all.sh` (hooks, structure contracts, agent Python unittests)
3. **ADR count**: Verify `docs/decisions/` has at least one ADR

Report a summary table:

| Check | Status | Details |
|-------|--------|---------|
| App gate | PASS/FAIL | ... |
| Repo tooling | PASS/FAIL | ... |
| Docs | PASS/FAIL | ... |
