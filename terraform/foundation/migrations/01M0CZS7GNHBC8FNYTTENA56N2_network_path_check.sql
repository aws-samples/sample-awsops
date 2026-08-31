-- since: 2.2.0
-- Network Path Check (docs/superpowers/specs/2026-08-13-network-path-check-design.md, Approved
-- 2026-08-19; flag `network_path_check_enabled`, default false — BASELINE.md §2 register row, no
-- governing ADR (ADR-019 §Decision explicitly excludes this flag) — see
-- scripts/v2/workers/network_path.py's module docstring for the disambiguation).
--
-- Saved definitions are versioned by snapshotting the full request into every run
-- (`network_path_runs.definition_snapshot`); editing a definition never rewrites prior results.
-- Delete is soft (`network_path_checks.deleted_at`) so prior run evidence stays available for
-- audit/comparison after a definition is retired.
--
-- `network_path_run_candidates` is a separate table from `network_path_run_steps` (not a column on
-- the steps table) because `candidate_kind` (resolved|hypothesis) and the per-candidate reduced
-- `status`/`first_blocker` are computed once by `conclude` and must not be duplicated across every
-- step row for that candidate — see the design spec's Result semantics section.

CREATE TABLE network_path_checks (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  source_account_id  text NOT NULL,
  definition         jsonb NOT NULL,
  created_by_sub     text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE INDEX idx_network_path_checks_active
  ON network_path_checks (source_account_id) WHERE deleted_at IS NULL;

CREATE TABLE network_path_runs (
  id                   text PRIMARY KEY,
  check_id             text NOT NULL REFERENCES network_path_checks(id),
  requested_by_sub     text NOT NULL,
  definition_snapshot  jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  phase                text NOT NULL DEFAULT 'resolve'
                         CHECK (phase IN ('resolve','discover','verify','conclude')),
  overall_status       text
                         CHECK (overall_status IS NULL
                           OR overall_status IN ('allowed','blocked','conditional','failed')),
  validation_bundle    jsonb,
  worker_job_id        text UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz
);

CREATE INDEX idx_network_path_runs_check_id ON network_path_runs (check_id, created_at DESC);
-- Reaper: extends scripts/v2/workers/reaper.py the same way it already reaps worker_jobs/diagnosis_reports.
CREATE INDEX idx_network_path_runs_stale ON network_path_runs (status) WHERE status IN ('queued','running');

CREATE TABLE network_path_run_candidates (
  run_id          text NOT NULL REFERENCES network_path_runs(id) ON DELETE CASCADE,
  candidate_id    text NOT NULL,
  candidate_kind  text NOT NULL CHECK (candidate_kind IN ('resolved','hypothesis')),
  status          text CHECK (status IS NULL OR status IN ('allowed','blocked','conditional','failed')),
  first_blocker   text,
  PRIMARY KEY (run_id, candidate_id)
);

CREATE TABLE network_path_run_steps (
  run_id        text NOT NULL REFERENCES network_path_runs(id) ON DELETE CASCADE,
  candidate_id  text NOT NULL,
  account_id    text NOT NULL,
  region        text NOT NULL,
  ordinal       integer NOT NULL,
  layer         text NOT NULL,
  status        text NOT NULL CHECK (status IN ('allowed','blocked','unknown','conditional','not_run')),
  resource      text,
  summary       text NOT NULL,
  evidence      jsonb NOT NULL DEFAULT '[]',
  observed_at   timestamptz,
  PRIMARY KEY (run_id, candidate_id, ordinal),
  FOREIGN KEY (run_id, candidate_id) REFERENCES network_path_run_candidates(run_id, candidate_id) ON DELETE CASCADE
);
