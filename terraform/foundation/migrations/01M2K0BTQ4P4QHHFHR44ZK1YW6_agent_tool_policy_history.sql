-- since: 0.9.0
-- Latch custom-agent restriction history across skill edits, disabling and detachment.
-- Apply through the standalone reviewed migration path before the new Web reader.
-- No reset is exposed by the catalog API; existing instruction-only agents remain legacy.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tool_policy_configured BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION remember_attached_tool_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE restricted BOOLEAN;
BEGIN
  -- Serialize attaching a skill with edits to its scope. FOR SHARE also waits for
  -- non-key updates; a concurrent edit cannot fall between our read and the binding.
  SELECT CASE WHEN jsonb_typeof(tool_allowlist) = 'array'
              THEN jsonb_array_length(tool_allowlist) > 0 ELSE true END
    INTO restricted FROM skills WHERE id = NEW.skill_id FOR SHARE;
  IF restricted THEN
    UPDATE agents SET tool_policy_configured = true
     WHERE id = NEW.agent_id AND NOT tool_policy_configured;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER agent_skills_remember_tool_policy
BEFORE INSERT OR UPDATE OF agent_id, skill_id ON agent_skills
FOR EACH ROW EXECUTE FUNCTION remember_attached_tool_policy();

CREATE OR REPLACE FUNCTION remember_edited_tool_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (CASE WHEN jsonb_typeof(OLD.tool_allowlist) = 'array'
           THEN jsonb_array_length(OLD.tool_allowlist) > 0 ELSE true END)
     OR (CASE WHEN jsonb_typeof(NEW.tool_allowlist) = 'array'
              THEN jsonb_array_length(NEW.tool_allowlist) > 0 ELSE true END) THEN
    UPDATE agents a SET tool_policy_configured = true
      FROM agent_skills b
     WHERE b.skill_id = NEW.id AND b.agent_id = a.id AND NOT a.tool_policy_configured;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER skills_remember_tool_policy
AFTER UPDATE OF tool_allowlist ON skills
FOR EACH ROW EXECUTE FUNCTION remember_edited_tool_policy();

-- Trigger creation holds the catalog write locks through this transaction's backfill.
-- Disabled bindings count, and malformed legacy scope cannot become unrestricted.
UPDATE agents a SET tool_policy_configured = true
 WHERE NOT a.tool_policy_configured AND EXISTS (
   SELECT 1 FROM agent_skills b JOIN skills s ON s.id = b.skill_id
    WHERE b.agent_id = a.id
      AND CASE WHEN jsonb_typeof(s.tool_allowlist) = 'array'
               THEN jsonb_array_length(s.tool_allowlist) > 0 ELSE true END
 );
