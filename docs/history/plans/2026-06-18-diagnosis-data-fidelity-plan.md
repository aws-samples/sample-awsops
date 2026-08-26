# Plan — AI Diagnosis data fidelity (TDD)

> Spec: `docs/superpowers/specs/2026-06-18-diagnosis-data-fidelity-design.md`.
> Branch `fix/v2-diagnosis-data` (worktree, base = origin/feat/v2-architecture-design).
> Read-only worker change; deploy via `make workers` after merge (no terraform/IAM change).
> Collectors keep their **never-raise / degrade-only** contract. Tests use a fake `conn`
> (the worker uses pg8000 `conn.run(sql)` → list of row tuples) — no live AWS/DB.

## Allowed file scope
- `scripts/v2/workers/diagnosis/sources.py`
- `scripts/v2/workers/diagnosis/test_sources.py`
- `scripts/v2/workers/diagnosis/report.py`
- `scripts/v2/workers/diagnosis/test_report.py`
- `scripts/v2/workers/diagnosis/test_intended_vs_actual.py`

## Out of scope
New collectors / AWS APIs / IAM; LLM prompt rewrites; section/tier changes; web; terraform.

## [P2 gate] mandatory conventions (agy+kiro)
- **pg8000 uses NAMED placeholders** `:name` with kwargs (`conn.run(sql, name=val)`), NOT positional
  `$1` (would raise a parse error) — see `db.py:32`, `sources.py:260`. Parameterize the resource_type
  (`:rtype`); never string-interpolate it (SQL-injection-safe).
- **`_redact` is INSUFFICIENT for raw resource `data`** — Lambda `environment`, `user_data`, IAM
  `policy`/inline policies, and `*password*`/`*secret*`/`*token*` fields can carry plaintext secrets.
  The collector MUST field-filter BEFORE the data leaves it (denylist + long-value truncation), not
  rely on post-hoc `_redact`. (pg8000 returns JSONB as dict; the dict/str handling is harmless defense.)

---

### Task 1: fix `collect_cw_metrics` instance lookup (resource_type + account scope)
- Modify: `scripts/v2/workers/diagnosis/sources.py`
- Create: `scripts/v2/workers/diagnosis/test_sources.py`
- [ ] Failing test: a fake conn whose `inventory_resources` has `resource_type='ec2'` rows returns
      those instance ids (the current `('ec2_instance','aws_ec2_instance','instance')` query finds 0).
      Assert the SQL filters `resource_type` to `'ec2'` and `account_id = 'self'`; with ids present and
      `_cw_client` stubbed, `get_metric_data` is called for them; with no ec2 rows, returns the graceful
      empty `{"by_instance":{}, "avg_cpu":None}` (degrade-only preserved).
- [ ] Implement: change the instance-id query to `WHERE resource_type = 'ec2' AND account_id = 'self'`.
      Leave the CloudWatch call + degrade path unchanged.
- [ ] Run `python3 -m pytest scripts/v2/workers/diagnosis/test_sources.py -q`.
- [ ] Commit: `fix(diagnosis): collect_cw_metrics queries resource_type 'ec2' (was never-matching 'ec2_instance')`.

### Task 2: `collect_inventory` returns bounded resource DETAIL, not just counts (keystone)
- Modify: `scripts/v2/workers/diagnosis/sources.py`
- Test: `scripts/v2/workers/diagnosis/test_sources.py`
- [ ] Failing tests: with a fake conn returning typed rows (incl. a `data` JSONB per resource — accept
      dict and JSON-string forms): (a) result has `resources[<type>]` with `{resource_id, region, data}`
      entries, not only `by_type`; (b) the SQL scopes `account_id = 'self'` and parameterizes the type
      via a NAMED placeholder (`:rtype`), no `$1`, no interpolation; (c) per-type cap `DIAG_INV_PER_TYPE`
      honored; (d) global byte cap `DIAG_INV_MAX_BYTES` truncates + sets `truncated: true`;
      (e) **[P2-MAJOR] sensitive fields are stripped** — a Lambda `data` carrying `environment`
      (+ `user_data`, `policy`, `*password*`/`*secret*`/`*token*`) has those keys removed before it
      enters `resources`, and a string value >500 chars is truncated; (f) on query error it degrades
      (never raises) keeping `by_type`/`resources` keys.
- [ ] Implement: keep the `by_type` count query (add `WHERE account_id='self'`). Add a detail pass —
      for each type in `by_type`: `conn.run("SELECT resource_id, region, data FROM inventory_resources
      WHERE account_id='self' AND resource_type = :rtype LIMIT <DIAG_INV_PER_TYPE>", rtype=t)` (default
      15); parse `data` via `json.loads` if str; run each `data` through a `_safe_data()` helper that
      **drops denylisted keys** (`environment`, `env`, `variables`, `user_data`, `policy`,
      `policy_document`, `inline_policies`, and any key matching `password|secret|token|credential`,
      case-insensitive) and **truncates string values >500 chars** (append `…(truncated)`); accumulate
      into `resources[type]` until serialized size would exceed `DIAG_INV_MAX_BYTES` (default 24000),
      then stop + set `truncated`. Return `{by_type, resources, truncated}`. (`_redact` in report.py
      remains the second layer, unchanged.)
- [ ] Run `python3 -m pytest scripts/v2/workers/diagnosis/test_sources.py -q`.
- [ ] Commit: `feat(diagnosis): collect_inventory feeds real resource detail (region+data, bounded) not just counts`.

### Task 3: render a data-coverage note so thin reports are self-explaining
- Modify: `scripts/v2/workers/diagnosis/report.py`
- Test: `scripts/v2/workers/diagnosis/test_report.py`
- [ ] Failing test: `build_markdown` (or a small `_coverage_note(collected)` helper) given a
      `collected` map where one collector is degraded and another empty renders a "데이터 커버리지"
      section listing each collector as `ok | degraded(<note>) | empty`. A fully-ok set still renders
      the note (all ok). The note appears in the final markdown.
- [ ] Implement: add `_coverage_note(collected)` returning a compact markdown block; `generate`
      passes `collected` through and `build_markdown` appends the note at the end (after sections).
      Reuse the existing `degraded`/notes data already computed in `generate`.
- [ ] Run `python3 -m pytest scripts/v2/workers/diagnosis/test_report.py -q`.
- [ ] Commit: `feat(diagnosis): append a data-coverage note (which collectors had data) to the report`.

### Task 4: fix the stale `_bedrock_render` region test + full sweep
- Modify: `scripts/v2/workers/diagnosis/test_intended_vs_actual.py`
- [ ] Pre-existing failure (NOT caused by this change — confirmed by stashing our diff): the test
      asserts `_bedrock_render` region == `us-east-1`, but the code migrated `us.*` → `global.*`
      inference profiles invoked from `ap-northeast-2` (report.py:20/107, matches `agent/agent.py`).
      Update the assertion + comment to `ap-northeast-2` (global.* profile, regional invoke).
- [ ] Run `python3 -m pytest scripts/v2/workers/diagnosis/ -q` — all green (existing + new).
- [ ] Commit: `test(diagnosis): _bedrock_render region assertion ap-northeast-2 (global.* migration; was stale us-east-1)`.
