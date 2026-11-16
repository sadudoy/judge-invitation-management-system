-- Migration 001: Base Schema
-- CSE Fest - Judge Invitation & Assignment Management System

-- Ensure btree_gist extension is available for exclusion constraints
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Custom Enum Types
DO $$ BEGIN
  CREATE TYPE event_status_enum AS ENUM ('draft', 'published', 'in_progress', 'completed', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE session_status_enum AS ENUM ('scheduled', 'in_progress', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_role_enum AS ENUM ('superadmin', 'admin', 'coordinator');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE token_type_enum AS ENUM ('session', 'password_reset', 'api_key');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE invitation_status_enum AS ENUM ('draft', 'invited', 'accepted', 'declined', 'cancelled', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE invitation_response_enum AS ENUM ('accepted', 'declined');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE availability_status_enum AS ENUM ('available', 'unavailable', 'tentative');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE conflict_type_enum AS ENUM ('student_supervision', 'co_author', 'institutional', 'personal', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE assignment_role_enum AS ENUM ('head_judge', 'judge', 'evaluator');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE assignment_status_enum AS ENUM ('assigned', 'confirmed', 'declined', 'reassigned', 'cancelled', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE assignment_response_enum AS ENUM ('confirmed', 'declined');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE attendance_status_enum AS ENUM ('present', 'absent', 'late', 'excused');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_channel_enum AS ENUM ('email', 'sms');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_status_enum AS ENUM ('pending', 'processing', 'sent', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_delivery_status_enum AS ENUM ('success', 'failure', 'bounced');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE audit_action_enum AS ENUM ('INSERT', 'UPDATE', 'DELETE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1. Events Table
CREATE TABLE IF NOT EXISTS events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL CHECK (end_date >= start_date),
  status event_status_enum NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Venues Table
CREATE TABLE IF NOT EXISTS venues (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  building TEXT,
  room TEXT,
  capacity INTEGER CHECK (capacity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_venues_event_id ON venues(event_id);

-- 3. Competitions Table
CREATE TABLE IF NOT EXISTS competitions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  category TEXT,
  description TEXT,
  min_judges INTEGER NOT NULL DEFAULT 1 CHECK (min_judges >= 1),
  max_judges INTEGER CHECK (max_judges >= min_judges),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_competition_event_slug UNIQUE (event_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_competitions_event_id ON competitions(event_id);

-- 4. Sessions Table
CREATE TABLE IF NOT EXISTS sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  competition_id BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  venue_id BIGINT REFERENCES venues(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL CHECK (end_time > start_time),
  buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
  status session_status_enum NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_competition_id ON sessions(competition_id);
CREATE INDEX IF NOT EXISTS idx_sessions_venue_id ON sessions(venue_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time);

-- 5. Judges Table
CREATE TABLE IF NOT EXISTS judges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  organization TEXT,
  designation TEXT,
  expertise TEXT[] DEFAULT '{}',
  bio TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_judges_email ON judges(LOWER(email));

-- 6. Users Table (Admins / Coordinators)
CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role user_role_enum NOT NULL DEFAULT 'admin',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email));

-- 7. Auth Tokens Table
CREATE TABLE IF NOT EXISTS auth_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  type token_type_enum NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_id ON auth_tokens(user_id);

-- 8. Judge Invitations Table
CREATE TABLE IF NOT EXISTS judge_invitations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  judge_id BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  invitation_token TEXT NOT NULL UNIQUE,
  status invitation_status_enum NOT NULL DEFAULT 'invited',
  sent_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_judge_invitations_event_id ON judge_invitations(event_id);
CREATE INDEX IF NOT EXISTS idx_judge_invitations_judge_id ON judge_invitations(judge_id);

-- Partial Unique Index: Only one live invitation per event per judge
-- Live invitations are draft, invited, or accepted. Cancelled, declined, or expired invitations allow re-invitation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitation_live
  ON judge_invitations (event_id, judge_id)
  WHERE status NOT IN ('cancelled', 'declined', 'expired');

-- 9. Invitation Responses Table
CREATE TABLE IF NOT EXISTS invitation_responses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invitation_id BIGINT NOT NULL REFERENCES judge_invitations(id) ON DELETE CASCADE,
  response invitation_response_enum NOT NULL,
  response_notes TEXT,
  ip_address INET,
  user_agent TEXT,
  responded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invitation_responses_invitation_id ON invitation_responses(invitation_id);

-- 10. Judge Availability Table
CREATE TABLE IF NOT EXISTS judge_availability (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  judge_id BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  available_window TSTZRANGE NOT NULL,
  status availability_status_enum NOT NULL DEFAULT 'available',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_judge_availability_judge_id ON judge_availability(judge_id);
CREATE INDEX IF NOT EXISTS idx_judge_availability_event_id ON judge_availability(event_id);
CREATE INDEX IF NOT EXISTS idx_judge_availability_window ON judge_availability USING gist(available_window);

-- 11. Judge Conflicts Table (Immutable Audit-safe Conflict Declarations)
CREATE TABLE IF NOT EXISTS judge_conflicts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  judge_id BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  competition_id BIGINT REFERENCES competitions(id) ON DELETE CASCADE,
  student_name TEXT,
  institution TEXT,
  conflict_type conflict_type_enum NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_judge_conflicts_judge_id ON judge_conflicts(judge_id);
CREATE INDEX IF NOT EXISTS idx_judge_conflicts_competition_id ON judge_conflicts(competition_id);

-- Enforce immutability on judge_conflicts: REVOKE UPDATE and DELETE
REVOKE UPDATE, DELETE ON judge_conflicts FROM csefest_app;
REVOKE UPDATE, DELETE ON judge_conflicts FROM PUBLIC;

-- 12. Judge Assignments Table
CREATE TABLE IF NOT EXISTS judge_assignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  judge_id BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  role assignment_role_enum NOT NULL DEFAULT 'judge',
  status assignment_status_enum NOT NULL DEFAULT 'assigned',
  assignment_window TSTZRANGE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_assignment_per_session UNIQUE (session_id, judge_id),
  CONSTRAINT no_double_booking EXCLUDE USING gist (
    judge_id WITH =,
    assignment_window WITH &&
  ) WHERE (status != 'cancelled')
);
CREATE INDEX IF NOT EXISTS idx_judge_assignments_session_id ON judge_assignments(session_id);
CREATE INDEX IF NOT EXISTS idx_judge_assignments_judge_id ON judge_assignments(judge_id);

-- 13. Assignment Responses Table
CREATE TABLE IF NOT EXISTS assignment_responses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id BIGINT NOT NULL REFERENCES judge_assignments(id) ON DELETE CASCADE,
  response assignment_response_enum NOT NULL,
  reason TEXT,
  responded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assignment_responses_assignment_id ON assignment_responses(assignment_id);

-- 14. Assignment Attendance Table
CREATE TABLE IF NOT EXISTS assignment_attendance (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id BIGINT NOT NULL UNIQUE REFERENCES judge_assignments(id) ON DELETE CASCADE,
  status attendance_status_enum NOT NULL DEFAULT 'present',
  check_in_time TIMESTAMPTZ,
  notes TEXT,
  marked_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assignment_attendance_assignment_id ON assignment_attendance(assignment_id);
CREATE INDEX IF NOT EXISTS idx_assignment_attendance_marked_by ON assignment_attendance(marked_by);

-- 15. Notification Outbox Table
CREATE TABLE IF NOT EXISTS notification_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  channel notification_channel_enum NOT NULL DEFAULT 'email',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  payload JSONB,
  status notification_status_enum NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
  ON notification_outbox(scheduled_at)
  WHERE status = 'pending';

-- 16. Notification Deliveries Table
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id BIGINT NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
  status notification_delivery_status_enum NOT NULL,
  provider_response JSONB,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification_id ON notification_deliveries(notification_id);

-- 17. Audit Log Table
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id BIGINT,
  action audit_action_enum NOT NULL,
  old_values JSONB,
  new_values JSONB,
  actor_id BIGINT,
  client_ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_table_record ON audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
