<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: fa4f51b7859e · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

## tests/ — Test Suite

Bash structure/hook test suite (`tests/hooks/test-*.sh`, `tests/structure/test-*.sh`) — exercises `.claude/hooks/` scripts (behavior + secret-pattern detection), agent/plugin structure contracts, and PR-review-workflow/Steampipe/ExternalId terraform wiring. `tests/run-all.sh` also drives `agent/`'s Python unittests (dark-path loop, account logic).
- **`tests/fixtures/`** — secret samples and false-positive samples, loaded by the hook/secret tests.

## Conventions a reviewer must enforce
- **Output is TAP v13** — `ok N - desc` / `not ok N - desc`. New bash tests must conform.
- **New hook ⇒ new test** — adding a hook requires a matching `tests/hooks/test-<hook>.sh`.
- **Secret-detection cases** — positives go in `tests/fixtures/secret-samples.txt`, negatives in `false-positives.txt`. Use real-looking-but-fake samples only.

## Banned patterns / gotchas
- **No live external deps in integration tests** — never connect to real Steampipe or AgentCore; use fixtures/mocks.
- **Never bypass a failing CI hook** — `--no-verify` is banned; fix the root cause instead.

## Scope note
This directory is repo-wide tooling/structure coverage — distinct from v2's own colocated app tests (`web/`'s vitest `*.test.ts(x)` beside sources, `agent/`'s pytest/unittest). Don't conflate the two when reviewing.
