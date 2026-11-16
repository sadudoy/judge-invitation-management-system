# CSE Fest — Judge Invitation & Assignment Management System
## Database Schema Documentation (Phase 1)

### 1. Database Specifications
- **Database Engine**: PostgreSQL 15+ (tested on PostgreSQL 18.4)
- **Timezone**: `Asia/Dhaka` default. All temporal columns use `TIMESTAMPTZ`.
- **Primary Keys**: `BIGINT GENERATED ALWAYS AS IDENTITY` for all entity tables.
- **Extensions**: `btree_gist` enabled to allow scalar types (like `BIGINT`) inside GiST exclusion constraints.

---

### 2. Custom Enumerations
| Type Name | Allowed Values | Description |
|---|---|---|
| `event_status_enum` | `draft`, `published`, `in_progress`, `completed`, `archived` | Lifecycle stage of the festival. |
| `session_status_enum` | `scheduled`, `in_progress`, `completed`, `cancelled` | Status of individual judging sessions. |
| `user_role_enum` | `superadmin`, `admin`, `coordinator` | Administrative access tier. |
| `token_type_enum` | `session`, `password_reset`, `api_key` | Purpose of authentication token. |
| `invitation_status_enum` | `draft`, `invited`, `accepted`, `declined`, `cancelled`, `expired` | Stage of judge invitation. |
| `invitation_response_enum`| `accepted`, `declined` | Judge response payload. |
| `availability_status_enum`| `available`, `unavailable`, `tentative` | Judge availability declaration. |
| `conflict_type_enum` | `student_supervision`, `co_author`, `institutional`, `personal`, `other` | Categorization of conflict of interest. |
| `assignment_role_enum` | `head_judge`, `judge`, `evaluator` | Judge capacity in a given session. |
| `assignment_status_enum` | `assigned`, `confirmed`, `declined`, `reassigned`, `cancelled`, `completed` | Status of judge-to-session assignment. |
| `assignment_response_enum`| `confirmed`, `declined` | Judge assignment confirmation. |
| `attendance_status_enum` | `present`, `absent`, `late`, `excused` | Day-of physical or virtual check-in. |
| `notification_channel_enum`| `email`, `sms` | Dispatch method. |
| `notification_status_enum` | `pending`, `processing`, `sent`, `failed` | Outbox lifecycle status. |
| `notification_delivery_status_enum` | `success`, `failure`, `bounced` | Gateway dispatch report. |
| `audit_action_enum` | `INSERT`, `UPDATE`, `DELETE` | Recorded DML action. |

---

### 3. Entity Tables & Schema Definitions

#### 3.1 `events`
Root event container representing an instance of the university festival.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `name`: `TEXT NOT NULL`
- `slug`: `TEXT NOT NULL UNIQUE`
- `description`: `TEXT`
- `start_date`: `DATE NOT NULL`
- `end_date`: `DATE NOT NULL CHECK (end_date >= start_date)`
- `status`: `event_status_enum NOT NULL DEFAULT 'draft'`
- `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- `updated_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`

#### 3.2 `venues`
Rooms, auditoriums, and labs hosting judging sessions.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `event_id`: `BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE`
- `name`: `TEXT NOT NULL`
- `building`: `TEXT`
- `room`: `TEXT`
- `capacity`: `INTEGER CHECK (capacity > 0)`
- `created_at`, `updated_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Index**: `idx_venues_event_id ON venues(event_id)`

#### 3.3 `competitions`
Individual competitions (e.g. Hackathon, Programming Contest, Robotics).
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `event_id`: `BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE`
- `name`: `TEXT NOT NULL`
- `slug`: `TEXT NOT NULL`
- `category`: `TEXT`
- `description`: `TEXT`
- `min_judges`: `INTEGER NOT NULL DEFAULT 1 CHECK (min_judges >= 1)`
- `max_judges`: `INTEGER CHECK (max_judges >= min_judges)`
- `created_at`, `updated_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Constraint**: `CONSTRAINT uq_competition_event_slug UNIQUE (event_id, slug)`
- **Index**: `idx_competitions_event_id ON competitions(event_id)`

#### 3.4 `sessions`
Specific time-bounded judging periods for a competition at a venue.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `competition_id`: `BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE`
- `venue_id`: `BIGINT REFERENCES venues(id) ON DELETE SET NULL`
- `name`: `TEXT NOT NULL`
- `start_time`: `TIMESTAMPTZ NOT NULL`
- `end_time`: `TIMESTAMPTZ NOT NULL CHECK (end_time > start_time)`
- `buffer_minutes`: `INTEGER NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0)`
- `status`: `session_status_enum NOT NULL DEFAULT 'scheduled'`
- `created_at`, `updated_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Indexes**: `idx_sessions_competition_id`, `idx_sessions_venue_id`, `idx_sessions_start_time`

#### 3.5 `judges`
Academic and industry evaluators invited to judge competitions.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `first_name`: `TEXT NOT NULL`
- `last_name`: `TEXT NOT NULL`
- `email`: `TEXT NOT NULL UNIQUE`
- `phone`: `TEXT`
- `organization`: `TEXT`
- `designation`: `TEXT`
- `expertise`: `TEXT[] DEFAULT '{}'`
- `bio`: `TEXT`
- `is_active`: `BOOLEAN NOT NULL DEFAULT true`
- `created_at`, `updated_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Index**: `idx_judges_email ON judges(LOWER(email))`

#### 3.6 `users`
System administrators and event coordinators.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `email`: `TEXT NOT NULL UNIQUE`
- `password_hash`: `TEXT NOT NULL`
- `full_name`: `TEXT NOT NULL`
- `role`: `user_role_enum NOT NULL DEFAULT 'admin'`
- `is_active`: `BOOLEAN NOT NULL DEFAULT true`
- `created_at`, `updated_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Index**: `idx_users_email ON users(LOWER(email))`

#### 3.7 `auth_tokens`
Tokens for sessions, password resets, and API clients.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `user_id`: `BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `token_hash`: `TEXT NOT NULL UNIQUE`
- `type`: `token_type_enum NOT NULL`
- `expires_at`: `TIMESTAMPTZ NOT NULL`
- `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Index**: `idx_auth_tokens_user_id ON auth_tokens(user_id)`

#### 3.8 `judge_invitations`
Formal event-level invitations sent to judges.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `event_id`: `BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE`
- `judge_id`: `BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE`
- `invitation_token`: `TEXT NOT NULL UNIQUE`
- `status`: `invitation_status_enum NOT NULL DEFAULT 'invited'`
- `sent_at`: `TIMESTAMPTZ`
- `expires_at`: `TIMESTAMPTZ`
- `created_at`, `updated_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Partial Unique Index**:
  ```sql
  CREATE UNIQUE INDEX uq_invitation_live
  ON judge_invitations (event_id, judge_id)
  WHERE status NOT IN ('cancelled', 'declined', 'expired');
  ```
  *Behavior*: At most one active/live invitation per judge per event. If an invitation is cancelled or declined, a replacement invitation can be issued.
- **Indexes**: `idx_judge_invitations_event_id`, `idx_judge_invitations_judge_id`

#### 3.9 `invitation_responses`
Logged RSVP actions from invited judges.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `invitation_id`: `BIGINT NOT NULL REFERENCES judge_invitations(id) ON DELETE CASCADE`
- `response`: `invitation_response_enum NOT NULL`
- `response_notes`: `TEXT`
- `ip_address`: `INET`
- `user_agent`: `TEXT`
- `responded_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Index**: `idx_invitation_responses_invitation_id ON invitation_responses(invitation_id)`

#### 3.10 `judge_availability`
Time windows when a judge has stated they are physically or virtually available.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `judge_id`: `BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE`
- `event_id`: `BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE`
- `available_window`: `TSTZRANGE NOT NULL`
- `status`: `availability_status_enum NOT NULL DEFAULT 'available'`
- `notes`: `TEXT`
- `created_at`, `updated_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Indexes**: `idx_judge_availability_judge_id`, `idx_judge_availability_event_id`, GiST index on `available_window`

#### 3.11 `judge_conflicts`
Immutable declarations of conflicts of interest (e.g. advising a participating student, institutional bias).
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `judge_id`: `BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE`
- `competition_id`: `BIGINT REFERENCES competitions(id) ON DELETE CASCADE`
- `student_name`: `TEXT`
- `institution`: `TEXT`
- `conflict_type`: `conflict_type_enum NOT NULL`
- `description`: `TEXT`
- `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Security & Immutability**:
  ```sql
  REVOKE UPDATE, DELETE ON judge_conflicts FROM csefest_app;
  REVOKE UPDATE, DELETE ON judge_conflicts FROM PUBLIC;
  ```
  *Behavior*: Once a conflict is entered, any attempt to `UPDATE` or `DELETE` it fails with SQLSTATE `42501` (`insufficient_privilege`), preserving an immutable audit record for contest integrity.
- **Indexes**: `idx_judge_conflicts_judge_id`, `idx_judge_conflicts_competition_id`

#### 3.12 `judge_assignments`
Assignment of an accepted judge to a specific competition judging session.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `session_id`: `BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`
- `judge_id`: `BIGINT NOT NULL REFERENCES judges(id) ON DELETE CASCADE`
- `role`: `assignment_role_enum NOT NULL DEFAULT 'judge'`
- `status`: `assignment_status_enum NOT NULL DEFAULT 'assigned'`
- `assignment_window`: `TSTZRANGE NOT NULL` (automatically managed by triggers)
- `created_at`, `updated_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Constraints**:
  - `CONSTRAINT uq_assignment_per_session UNIQUE (session_id, judge_id)`
  - `CONSTRAINT no_double_booking EXCLUDE USING gist (judge_id WITH =, assignment_window WITH &&) WHERE (status != 'cancelled')`
  *Behavior*: Guarantees that a judge cannot have overlapping assignment windows across any concurrent sessions. Overlaps (including buffer collisions) are rejected with SQLSTATE `23P01` (`exclusion_violation`). Adjacent sessions `[A, B)` and `[B, C)` succeed.
- **Indexes**: `idx_judge_assignments_session_id`, `idx_judge_assignments_judge_id`

#### 3.13 `assignment_responses`
Judge confirmations or declinations of session assignments.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `assignment_id`: `BIGINT NOT NULL REFERENCES judge_assignments(id) ON DELETE CASCADE`
- `response`: `assignment_response_enum NOT NULL`
- `reason`: `TEXT`
- `responded_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Index**: `idx_assignment_responses_assignment_id ON assignment_responses(assignment_id)`

#### 3.14 `assignment_attendance`
Check-in and presence tracking for judges on competition day.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `assignment_id`: `BIGINT NOT NULL UNIQUE REFERENCES judge_assignments(id) ON DELETE CASCADE`
- `status`: `attendance_status_enum NOT NULL DEFAULT 'present'`
- `check_in_time`: `TIMESTAMPTZ`
- `notes`: `TEXT`
- `marked_by`: `BIGINT REFERENCES users(id) ON DELETE SET NULL`
- `created_at`, `updated_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`

#### 3.15 `notification_outbox`
Asynchronous message dispatch queue for emails and SMS notifications.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `recipient_email`: `TEXT NOT NULL`
- `recipient_name`: `TEXT`
- `channel`: `notification_channel_enum NOT NULL DEFAULT 'email'`
- `subject`: `TEXT NOT NULL`
- `body`: `TEXT NOT NULL`
- `payload`: `JSONB`
- `status`: `notification_status_enum NOT NULL DEFAULT 'pending'`
- `retry_count`: `INTEGER NOT NULL DEFAULT 0`
- `scheduled_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- `sent_at`: `TIMESTAMPTZ`
- `error_message`: `TEXT`
- `created_at`, `updated_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Partial Index**: `idx_notification_outbox_pending ON notification_outbox(scheduled_at) WHERE status = 'pending'`

#### 3.16 `notification_deliveries`
Delivery receipts and provider webhooks from mail/SMS gateways.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `notification_id`: `BIGINT NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE`
- `status`: `notification_delivery_status_enum NOT NULL`
- `provider_response`: `JSONB`
- `delivered_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Index**: `idx_notification_deliveries_notification_id ON notification_deliveries(notification_id)`

#### 3.17 `audit_log`
Append-only log of modifications across critical operational tables.
- `id`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `table_name`: `TEXT NOT NULL`
- `record_id`: `BIGINT`
- `action`: `audit_action_enum NOT NULL`
- `old_values`: `JSONB`
- `new_values`: `JSONB`
- `actor_id`: `BIGINT`
- `client_ip`: `INET`
- `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Indexes**: `idx_audit_log_table_record ON audit_log(table_name, record_id)`, `idx_audit_log_created_at ON audit_log(created_at)`

#### 3.18 `session` (connect-pg-simple)
Storage for authenticated Express user sessions.
- `sid`: `VARCHAR NOT NULL PRIMARY KEY`
- `sess`: `JSON NOT NULL`
- `expire`: `TIMESTAMP(6) NOT NULL`
- **Index**: `IDX_session_expire ON "session" ("expire")`

---

### 4. Database Triggers & Invariant Enforcement

#### 4.1 Trigger `set_assignment_window`
- **Target**: `BEFORE INSERT OR UPDATE OF session_id ON judge_assignments`
- **Logic**: Looks up the target session's `start_time`, `end_time`, and `buffer_minutes`. Sets:
  ```sql
  NEW.assignment_window := tstzrange(v_start, v_end + (v_buffer || ' minutes')::interval, '[)');
  ```
  Guarantees that `assignment_window` is strictly derived from the session times, preventing clients from inserting forged windows.

#### 4.2 Trigger `resync_assignments_on_session_change`
- **Target**: `AFTER UPDATE OF start_time, end_time, buffer_minutes ON sessions`
- **Logic**: Automatically recalculates and updates `assignment_window` for all child assignments of the modified session:
  ```sql
  UPDATE judge_assignments
  SET assignment_window = tstzrange(NEW.start_time, NEW.end_time + (NEW.buffer_minutes || ' minutes')::interval, '[)'),
      updated_at = now()
  WHERE session_id = NEW.id;
  ```
  If moving the session creates an overlap for any assigned judge, the `no_double_booking` exclusion constraint immediately fires, rolling back the session move with `23P01`.

#### 4.3 Trigger `audit_row`
- **Target**: `AFTER INSERT OR UPDATE OR DELETE ON events, sessions, judges, users, judge_invitations, judge_assignments`
- **Logic**: Records old and new states as JSONB into `audit_log`.
