-- Migration 005: Phase 2 Schema Alignment & Feature Capabilities
-- CSE Fest - Judge Invitation & Assignment Management System

-- 1. Enable pg_trgm for fuzzy judge name searching safely
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN unique_violation THEN NULL;
END $$;

-- 2. Extend enums
ALTER TYPE invitation_response_enum ADD VALUE IF NOT EXISTS 'tentative';

-- 3. Enhance auth_tokens for Judge Magic Links
ALTER TABLE auth_tokens ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE auth_tokens ALTER COLUMN type DROP NOT NULL;
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS judge_id BIGINT REFERENCES judges(id) ON DELETE CASCADE;
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS invitation_id BIGINT REFERENCES judge_invitations(id) ON DELETE CASCADE;
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS purpose TEXT DEFAULT 'invitation';

CREATE INDEX IF NOT EXISTS idx_auth_tokens_judge_id ON auth_tokens(judge_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_invitation_id ON auth_tokens(invitation_id);

-- 4. Enhance notification_outbox for Outbox Pattern & Deduplication
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS template TEXT;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS to_email TEXT;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_idempotency ON notification_outbox(idempotency_key);

-- 5. Enhance judge_conflicts for Superseding and Rich Declarations
ALTER TABLE judge_conflicts ADD COLUMN IF NOT EXISTS superseded_by BIGINT REFERENCES judge_conflicts(id) ON DELETE SET NULL;
ALTER TABLE judge_conflicts ADD COLUMN IF NOT EXISTS subject_kind TEXT;
ALTER TABLE judge_conflicts ADD COLUMN IF NOT EXISTS subject_name TEXT;
ALTER TABLE judge_conflicts ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'medium';

-- Column-level grant: only superseded_by pointer can be updated; content remains strictly immutable
GRANT UPDATE (superseded_by) ON judge_conflicts TO csefest_app;

-- 6. Add `during` alias column on judge_availability
DO $$ BEGIN
  ALTER TABLE judge_availability ADD COLUMN during TSTZRANGE GENERATED ALWAYS AS (available_window) STORED;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 7. Ensure judge_invitations has competition_id auto-synced & live whitelist index
CREATE OR REPLACE FUNCTION set_invitation_competition_and_event()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.competition_id IS NULL AND NEW.event_id IS NOT NULL THEN
    SELECT id INTO NEW.competition_id FROM competitions WHERE event_id = NEW.event_id LIMIT 1;
  ELSIF NEW.event_id IS NULL AND NEW.competition_id IS NOT NULL THEN
    SELECT event_id INTO NEW.event_id FROM competitions WHERE id = NEW.competition_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_invitation_event ON judge_invitations;
DROP TRIGGER IF EXISTS trg_set_invitation_competition_and_event ON judge_invitations;
CREATE TRIGGER trg_set_invitation_competition_and_event
BEFORE INSERT OR UPDATE ON judge_invitations
FOR EACH ROW
EXECUTE FUNCTION set_invitation_competition_and_event();

-- Backfill any existing null competition_ids
UPDATE judge_invitations
SET competition_id = (SELECT id FROM competitions WHERE event_id = judge_invitations.event_id LIMIT 1)
WHERE competition_id IS NULL;

-- Whitelist unique index on judge_invitations
DROP INDEX IF EXISTS uq_invitation_live;
CREATE UNIQUE INDEX uq_invitation_live
  ON judge_invitations (judge_id, competition_id)
  WHERE status IN ('sent','viewed','accepted','tentative','invited');

-- 8. Add status, kind, and trigram search to judges
ALTER TABLE judges ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived'));
ALTER TABLE judges ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'academic' CHECK (kind IN ('academic', 'industry', 'alumni', 'other'));

CREATE INDEX IF NOT EXISTS idx_judges_name_trgm ON judges USING gin ((first_name || ' ' || last_name) gin_trgm_ops);
