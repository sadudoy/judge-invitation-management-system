-- Migration 006: Phase 3 Scheduling, Assignments, Replacement & Attendance
-- CSE Fest - Judge Invitation & Assignment Management System

-- 1. Extend enums (pre-transaction execution)
ALTER TYPE assignment_status_enum ADD VALUE IF NOT EXISTS 'held';
ALTER TYPE assignment_status_enum ADD VALUE IF NOT EXISTS 'replaced';
ALTER TYPE attendance_status_enum ADD VALUE IF NOT EXISTS 'checked_in';
ALTER TYPE attendance_status_enum ADD VALUE IF NOT EXISTS 'early_departure';
ALTER TYPE attendance_status_enum ADD VALUE IF NOT EXISTS 'not_arrived';
ALTER TYPE token_type_enum ADD VALUE IF NOT EXISTS 'assignment';
ALTER TYPE token_type_enum ADD VALUE IF NOT EXISTS 'checkin';

-- 2. Enhance judge_assignments for Replacement Tracking & Chaining
ALTER TABLE judge_assignments ADD COLUMN IF NOT EXISTS replaces_assignment_id BIGINT REFERENCES judge_assignments(id) ON DELETE SET NULL;
ALTER TABLE judge_assignments ADD COLUMN IF NOT EXISTS superseded_by BIGINT REFERENCES judge_assignments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_judge_assignments_replaces ON judge_assignments(replaces_assignment_id);
CREATE INDEX IF NOT EXISTS idx_judge_assignments_superseded_by ON judge_assignments(superseded_by);

-- 3. Enhance assignment_attendance for Check-in / Checkout / Late Tracking
ALTER TABLE assignment_attendance ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMPTZ;
ALTER TABLE assignment_attendance ADD COLUMN IF NOT EXISTS minutes_late INTEGER NOT NULL DEFAULT 0;

-- 4. Enhance sessions for Reporting Time & Grace Period
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reporting_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS grace_minutes INTEGER NOT NULL DEFAULT 15;

-- Default reporting_at for existing rows to start_time - 15 minutes
UPDATE sessions
SET reporting_at = start_time - INTERVAL '15 minutes'
WHERE reporting_at IS NULL;

-- 5. Link auth_tokens to specific assignment
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS assignment_id BIGINT REFERENCES judge_assignments(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_auth_tokens_assignment_id ON auth_tokens(assignment_id);
