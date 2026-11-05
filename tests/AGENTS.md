<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 59d627042b2d · generated-at: 2026-11-05 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Tests Module — Reviewer Context

Bash-based structure test suite, separate from the app's own tests (`web/`'s vitest,
`agent/`'s pytest/unittest). Validates repo-wide tooling/structure contracts: doc/path
consistency, PR review workflow / Steampipe-ExternalId terraform wiring (`tests/structure/test-*.sh`).
`tests/fixtures/` secret samples are retained for future secret-detection tests; no suite loads them yet.

Full image checks also require Docker and `AWSOPS_REVIEW_CODEC_STATE`; see `docs/runbooks/review-codec-sandbox.md#verification`.

## Build · Test
The image fixtures require Python 3.12 and the pinned binary Pillow codec in a virtualenv. The agent suite's
runtime-dependency contracts import the installed SDKs from `agent/requirements.txt` (never combined with the hash-locked file).

```bash
python -m pip install --require-hashes --only-binary=:all: -r scripts/pr-review/image-requirements.txt
python -m pip install -r agent/requirements.txt   # separate install: runtime SDKs for agent/tests/test_runtime_dependencies.py
bash tests/run-all.sh    # everything: structure + agent unittest, TAP v13 output
```

## Rules
- Output is TAP v13 (`ok N - desc` / `not ok N - desc`).
- Integration tests must use fixtures/mocks — never touch real Steampipe/AgentCore.
- Never bypass a failing CI hook (`--no-verify` is forbidden); fix the root cause.

## Review checklist
1. No test reaches out to live AWS/Steampipe/AgentCore.
