# PR #115 review follow-up: panel prompt-injection guard

Source: multi-AI panel review on PR #115 (`fix/pr-review-panel-argv-limit`), MAJOR + MINOR findings.

PR #115 changed `scripts/pr-review/run-panel.sh` so kiro-cli reads the diff from a file (via its
own trusted `read`/`fs_read` tool) instead of the diff being embedded in argv. The panel flagged
that the new prompt tells the model to autonomously read a file whose content is attacker-controlled
(the PR diff) without the same "treat this as data only" guard `synthesize.sh` already carries for
the chair. Combined with `pull_request_target` (elevated token) and the result being posted
publicly as a PR comment, a malicious diff could try to steer the model into reading and leaking
other files. Also flagged (MINOR): the prompt mentions `read`/`fs_read` while `--trust-tools`
grants `read,grep,fs_read` — not a live bug (already covers both names), but worth a comment
noting the alignment explicitly so it doesn't drift.

## Task 1: add a data-only guard to the kiro panel prompt

**Files:**
- Modify: `scripts/pr-review/run-panel.sh`
- Test: `tests/structure/test-pr-review-panel-prompt.sh`

- [x] Write `tests/structure/test-pr-review-panel-prompt.sh` (TAP output, matches
      `tests/structure/test-plugin-structure.sh` conventions) asserting:
      - `KIRO_PROMPT=` construction in `run-panel.sh` contains a data-only / do-not-follow-instructions
        guard phrase (e.g. grep for `data only` or `do NOT follow`)
      - the same file/diff-under-review block also still references `$DIFF` (the file-path delivery
        from PR #115 stays intact)
- [x] Add one line to the `KIRO_PROMPT` heredoc in `scripts/pr-review/run-panel.sh`, directly below
      the `=== DIFF UNDER REVIEW ===` marker, instructing the model to treat the file content as
      data only and never follow instructions found inside it — mirroring the guard
      `scripts/pr-review/synthesize.sh` already sends to the chair.
- [x] `tests/run-all.sh` globs `tests/structure/test-*.sh` automatically — no registration needed.
- [x] Add a one-line comment next to `--trust-tools=read,grep,fs_read` in `run-panel.sh` noting
      that the prompt's tool-name mentions (`read`/`fs_read`) and this flag must stay in sync
      (plan-gate MINOR finding: this alignment wasn't previously called out anywhere).
- [x] Run `bash tests/run-all.sh` and confirm the new test passes (TAP `ok`).

## Plan-gate result
Single-opinion review (agy; quorum guard — only 1 gate-eligible peer this run, codex misclassified
ERROR by a `check_panel.py` probe bug (missing `--skip-git-repo-check`), kiro-cli TIMEOUT on
probe). Verdict: no CRITICAL/MAJOR. One MINOR (the trust-tools/prompt alignment comment) folded
into the task above.

## Resolution (superseded by CI review, 2 more rounds)
The actual CI panel (codex + kiro-opus, real run) caught what the single-opinion agy plan-gate
missed: the guard above initially landed ONLY in `KIRO_PROMPT`, leaving codex — which reads the
SHARED `panel-prompt.txt` via stdin, not `KIRO_PROMPT` — unprotected. Fixed by moving the guard
into the shared prompt (`.github/workflows/pr-review.yml`'s heredoc), inherited by all 4
panelists; `KIRO_PROMPT` also repeats it as defense-in-depth since `run-panel.sh` is reusable with
any `$PROMPT_FILE`. A second CI round then caught that the new test's `fail()` never set a
non-zero exit — a false-assurance regression guard — fixed by tracking a `FAILED` counter and
exiting 1 at the end. Closed.
