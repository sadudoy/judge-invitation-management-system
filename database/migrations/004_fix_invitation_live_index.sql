-- Migration 004: Fix invitation live index semantics, add competition scoping, and enhance triggers
-- CSE Fest - Judge Invitation & Assignment Management System

-- 1. Extend enums with required values
ALTER TYPE invitation_status_enum ADD VALUE IF NOT EXISTS 'sent';
ALTER TYPE invitation_status_enum ADD VALUE IF NOT EXISTS 'viewed';
ALTER TYPE invitation_status_enum ADD VALUE IF NOT EXISTS 'tentative';
ALTER TYPE user_role_enum ADD VALUE IF NOT EXISTS 'viewer';

-- 2. Add competition_id column to judge_invitations and adjust constraints
ALTER TABLE judge_invitations
  ADD COLUMN IF NOT EXISTS competition_id BIGINT REFERENCES competitions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_judge_invitations_competition_id ON judge_invitations(competition_id);

-- Make event_id nullable so invitations can be competition-scoped directly
ALTER TABLE judge_invitations ALTER COLUMN event_id DROP NOT NULL;

-- Trigger to auto-fill event_id from competition if not explicitly supplied
CREATE OR REPLACE FUNCTION set_invitation_event_from_competition()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.event_id IS NULL AND NEW.competition_id IS NOT NULL THEN
    SELECT event_id INTO NEW.event_id FROM competitions WHERE id = NEW.competition_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_invitation_event ON judge_invitations;
CREATE TRIGGER trg_set_invitation_event
BEFORE INSERT OR UPDATE OF competition_id ON judge_invitations
FOR EACH ROW
EXECUTE FUNCTION set_invitation_event_from_competition();

-- 3. Replace uq_invitation_live with live-state whitelist index
DROP INDEX IF EXISTS uq_invitation_live;

CREATE UNIQUE INDEX uq_invitation_live
  ON judge_invitations (judge_id, competition_id)
  WHERE status IN ('sent','viewed','accepted','tentative');

-- Preserve event-level uniqueness when competition_id is omitted (maintaining backward compatibility)
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitation_live_event
  ON judge_invitations (event_id, judge_id)
  WHERE competition_id IS NULL AND status IN ('sent','viewed','accepted','tentative','invited');

-- 4. Attach audit_row trigger to judge_conflicts
DROP TRIGGER IF EXISTS trg_audit_judge_conflicts ON judge_conflicts;
CREATE TRIGGER trg_audit_judge_conflicts
AFTER INSERT OR UPDATE OR DELETE ON judge_conflicts
FOR EACH ROW EXECUTE FUNCTION audit_row();

-- 5. Add row_id generated column to audit_log to support row_id queries
DO $$ BEGIN
  ALTER TABLE audit_log ADD COLUMN row_id BIGINT GENERATED ALWAYS AS (record_id) STORED;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
