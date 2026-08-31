-- ADR-011 (amended 2026-06-26): ExternalId optional for 1st-party accounts whose target
-- trust policy pins the exact AWSops task-role ARN; required for 3rd-party (app-layer + trust
-- condition). Drop the blanket NOT-NULL guard; external_id is already a nullable column.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS external_id_required_for_target;
