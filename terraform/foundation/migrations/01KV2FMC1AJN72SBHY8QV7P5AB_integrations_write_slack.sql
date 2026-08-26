-- Integrations READ_WRITE — Slack governed-write action (ADR-040/041). Flag-OFF: enabled=false.
-- The model PROPOSES; a human plans -> approves (4-eyes) -> executes via /api/actions; the
-- external_slack executor posts only after DLP-redaction + channel-allowlist. The 'external:' prefix on
-- target_resource_type marks this a DATA-write (NOT an AWS-resource mutation) -> the action gate routes
-- it to INTEGRATIONS_WRITE_ENABLED + a SEPARATE kill-switch + a split (no-AWS-mutation) executor IAM,
-- keeping the 2026-06-11 reversal intact for AWS-resource mutation. Channel allowlist = the Slack
-- integration row's source_allowlist (reused for egress-write destination control; admin sets it at
-- registration). enabled=false = do-not-enable until the owner explicitly turns it on.
INSERT INTO action_catalog
  (name, description, executor_type, target_resource_type, iam_actions, assume_role_ref,
   required_inputs, dry_run_contract, rollback_ref, approval_mode, conditions, enabled)
VALUES
  ('slack.post_message',
   'Post a message to an allowlisted Slack channel (external knowledge/comms write; ADR-040/041; DLP-redacted, human 4-eyes). NOT an AWS-resource mutation.',
   'lambda', 'external:slack',
   '[]'::jsonb,
   'integrations-slack-write',                 -- per-action role logical name (TF; no-AWS-mutation IAM)
   '["channel","text"]'::jsonb,
   '{"mode":"preview"}'::jsonb,                 -- dry-run renders the redacted message, no send
   NULL,                                        -- a posted message is not cleanly reversible; dry-run preview + 4-eyes are the safety
   'four_eyes',
   '{"accounts":["self"]}'::jsonb,
   false)                                       -- HARD OFF (do-not-enable until owner)
ON CONFLICT (name) DO NOTHING;
