<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: c0bb1de0dd52 · generated-at: 2026-09-15 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Tests Module — Reviewer Context

Bash-based structure test suite, separate from the app's own tests (`web/`'s vitest,
`agent/`'s pytest/unittest). Validates repo-wide tooling/structure contracts: PR review
workflow / Steampipe-ExternalId terraform wiring (`tests/structure/test-*.sh`).

## Build · Test
The image fixtures require Python 3.12 and the pinned binary Pillow codec in a virtualenv.

```bash
python -m pip install --require-hashes --only-binary=:all: -r scripts/pr-review/image-requirements.txt
bash tests/run-all.sh    # everything: structure + agent unittest, TAP v13 output
```

## Rules
- Output is TAP v13 (`ok N - desc` / `not ok N - desc`).
- Integration tests must use fixtures/mocks — never touch real Steampipe/AgentCore.
- Never bypass a failing CI hook (`--no-verify` is forbidden); fix the root cause.

## Review checklist
1. No test reaches out to live AWS/Steampipe/AgentCore.
