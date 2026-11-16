-- Migration 002: Triggers and Business Integrity Functions
-- CSE Fest - Judge Invitation & Assignment Management System

-- 1. Function and Trigger: set_assignment_window
-- Automatically derives the judge_assignments.assignment_window range from the session's start_time,
-- end_time, and post-session buffer_minutes. Guarantees consistency between session times and exclusion bounds.
CREATE OR REPLACE FUNCTION set_assignment_window()
RETURNS TRIGGER AS $$
DECLARE
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_buffer INTEGER;
BEGIN
  SELECT start_time, end_time, buffer_minutes
  INTO v_start, v_end, v_buffer
  FROM sessions
  WHERE id = NEW.session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session with id % does not exist', NEW.session_id;
  END IF;

  -- Compute the effective window: [start_time, end_time + buffer_minutes)
  NEW.assignment_window := tstzrange(v_start, v_end + (v_buffer || ' minutes')::interval, '[)');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_assignment_window ON judge_assignments;
CREATE TRIGGER trg_set_assignment_window
BEFORE INSERT OR UPDATE OF session_id ON judge_assignments
FOR EACH ROW
EXECUTE FUNCTION set_assignment_window();

-- 2. Function and Trigger: resync_assignments_on_session_change
-- When a session's time or buffer changes, automatically resync the assignment_window
-- of all existing assignments for that session. This triggers the no_double_booking constraint
-- to ensure the moved session does not cause any assigned judge to be double-booked.
CREATE OR REPLACE FUNCTION resync_assignments_on_session_change()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.start_time IS DISTINCT FROM NEW.start_time OR
      OLD.end_time IS DISTINCT FROM NEW.end_time OR
      OLD.buffer_minutes IS DISTINCT FROM NEW.buffer_minutes) THEN

    UPDATE judge_assignments
    SET assignment_window = tstzrange(NEW.start_time, NEW.end_time + (NEW.buffer_minutes || ' minutes')::interval, '[)'),
        updated_at = now()
    WHERE session_id = NEW.id;

  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_resync_assignments_on_session_change ON sessions;
CREATE TRIGGER trg_resync_assignments_on_session_change
AFTER UPDATE OF start_time, end_time, buffer_minutes ON sessions
FOR EACH ROW
EXECUTE FUNCTION resync_assignments_on_session_change();

-- 3. Function and Trigger: audit_row
-- Generic audit trigger function that captures INSERT, UPDATE, DELETE into audit_log
CREATE OR REPLACE FUNCTION audit_row()
RETURNS TRIGGER AS $$
DECLARE
  v_record_id BIGINT;
  v_old_data JSONB := NULL;
  v_new_data JSONB := NULL;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    v_record_id := OLD.id;
    v_old_data := to_jsonb(OLD);
    INSERT INTO audit_log (table_name, record_id, action, old_values, new_values)
    VALUES (TG_TABLE_NAME, v_record_id, TG_OP::audit_action_enum, v_old_data, NULL);
    RETURN OLD;
  ELSIF (TG_OP = 'UPDATE') THEN
    v_record_id := NEW.id;
    v_old_data := to_jsonb(OLD);
    v_new_data := to_jsonb(NEW);
    INSERT INTO audit_log (table_name, record_id, action, old_values, new_values)
    VALUES (TG_TABLE_NAME, v_record_id, TG_OP::audit_action_enum, v_old_data, v_new_data);
    RETURN NEW;
  ELSIF (TG_OP = 'INSERT') THEN
    v_record_id := NEW.id;
    v_new_data := to_jsonb(NEW);
    INSERT INTO audit_log (table_name, record_id, action, old_values, new_values)
    VALUES (TG_TABLE_NAME, v_record_id, TG_OP::audit_action_enum, NULL, v_new_data);
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Attach audit triggers to core operational tables
DROP TRIGGER IF EXISTS trg_audit_events ON events;
CREATE TRIGGER trg_audit_events
AFTER INSERT OR UPDATE OR DELETE ON events
FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER IF EXISTS trg_audit_sessions ON sessions;
CREATE TRIGGER trg_audit_sessions
AFTER INSERT OR UPDATE OR DELETE ON sessions
FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER IF EXISTS trg_audit_judges ON judges;
CREATE TRIGGER trg_audit_judges
AFTER INSERT OR UPDATE OR DELETE ON judges
FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER IF EXISTS trg_audit_users ON users;
CREATE TRIGGER trg_audit_users
AFTER INSERT OR UPDATE OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER IF EXISTS trg_audit_judge_invitations ON judge_invitations;
CREATE TRIGGER trg_audit_judge_invitations
AFTER INSERT OR UPDATE OR DELETE ON judge_invitations
FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER IF EXISTS trg_audit_judge_assignments ON judge_assignments;
CREATE TRIGGER trg_audit_judge_assignments
AFTER INSERT OR UPDATE OR DELETE ON judge_assignments
FOR EACH ROW EXECUTE FUNCTION audit_row();
