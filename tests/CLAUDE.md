# Tests Module

## Role
Bash-based structure/hook test suite. Separate from the v2 app's own tests — `web/`'s vitest,
`agent/`'s pytest/unittest — this validates repo-wide tooling/structure contracts.

## Layout
| Path | Covers | Runner |
|------|--------|--------|
| `tests/structure/test-*.sh` | Agent contracts, PR review workflow, Steampipe/ExternalId terraform wiring | `bash tests/run-all.sh` |
| `tests/fixtures/` | Secret samples, false-positive samples | Loaded by hook/secret tests |

`tests/run-all.sh` also drives `agent/`'s Python unittest (dark-path loop, account logic, etc.)
alongside the hook/structure tests above.

## Running
The image fixtures require Python 3.12 and the pinned binary Pillow codec in a virtualenv.

```bash
python -m pip install --require-hashes --only-binary=:all: -r scripts/pr-review/image-requirements.txt
bash tests/run-all.sh    # everything (TAP format: hooks + structure + agent)
```

## Rules
- Output is TAP v13 — `ok N - desc` / `not ok N - desc`.
- Adding a new hook requires a matching test file under `tests/hooks/` (`test-<hook>.sh`).
- Secret-detection tests: add positive cases to `tests/fixtures/secret-samples.txt`, negative
  cases to `false-positives.txt`.
- Integration tests must never touch real Steampipe/AgentCore — use fixtures/mocks.
- Never bypass a failing CI hook (`--no-verify` is forbidden) — fix the root cause.
