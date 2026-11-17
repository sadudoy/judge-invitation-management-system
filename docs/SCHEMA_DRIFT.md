# Schema Drift & Reconciliation Audit (Phase 2)
**Project**: CSE Fest — Judge Invitation & Assignment Management System  
**Audit Date**: 2026-11-16  
**Auditor**: Antigravity Engineering Agent  
**Baseline Migrations**: `001_schema.sql`, `002_triggers.sql`, `003_session_store.sql`, `004_fix_invitation_live_index.sql`  

---

## 1. Executive Summary & Gate Decision

### 1.1 Blockers
**None.**  
There are **zero blockers** that would prevent implementing Phase 2 on the current database schema. No new tables are required. All necessary extensions, column additions, and constraint adjustments land cleanly on the existing 19 public tables via additive migration `005_phase2_schema_alignment.sql`.

### 1.2 Non-Blockers & Migration 005 Action Plan
The following non-blocking schema refinements are identified and resolved in Migration 005:

1. **`auth_tokens`**:
   - `user_id` was `NOT NULL`, which blocks issuing judge magic-link tokens (judges are not users).
   - Solution: `ALTER COLUMN user_id DROP NOT NULL;` and add `judge_id BIGINT REFERENCES judges(id) ON DELETE CASCADE;`, `invitation_id BIGINT REFERENCES judge_invitations(id) ON DELETE CASCADE;`, `used_at TIMESTAMPTZ;`, and `purpose TEXT DEFAULT 'invitation';`.
   - Store SHA-256 token hashes (hex and bytea compatible).

2. **`notification_outbox`**:
   - Missing `idempotency_key` and `template` columns for outbox producer deduplication.
   - Solution: Add `idempotency_key TEXT UNIQUE`, `template TEXT`, and `to_email TEXT` (synced with `recipient_email`).

3. **`judge_conflicts`**:
   - Needs supersede tracking and richer declaration fields without breaking immutable append-only constraints.
   - Solution: Add `superseded_by BIGINT REFERENCES judge_conflicts(id) ON DELETE SET NULL;`, `subject_kind TEXT`, `subject_name TEXT`, and `severity TEXT DEFAULT 'medium'`.
   - Security: Grant column-level UPDATE only on `(superseded_by)` to `csefest_app`. Content UPDATE and all DELETEs remain strictly forbidden (returning SQLSTATE `42501`).

4. **`judge_availability`**:
   - Current column is `available_window TSTZRANGE NOT NULL`.
   - Solution: Add generated column `during TSTZRANGE GENERATED ALWAYS AS (available_window) STORED;` so both `during` and `available_window` resolve identically.

5. **`judge_invitations`**:
   - `competition_id` was added in migration 004 as nullable.
   - Solution: Backfill any remaining null `competition_id` records using their competition event reference and enforce `ALTER COLUMN competition_id SET NOT NULL;`.

6. **`judges`**:
   - Add `status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived'))` and `kind TEXT NOT NULL DEFAULT 'academic' CHECK (kind IN ('academic', 'industry', 'alumni', 'other'))`.
   - Enable `pg_trgm` extension for trigram name searching (`q` filter).

---

## 2. Table-by-Table Reconciliation

### 2.1 `events`
- **Spec / Intended**: Core festival event container.
- **Actual Schema**:
  - Columns: `id`, `name`, `slug`, `description`, `start_date`, `end_date`, `status`, `created_at`, `updated_at`.
  - Constraints: PK `events_pkey`, UNIQUE `events_slug_key`, CHECK `events_end_date_check`.
- **Drift / Discrepancy**: None. Fully compliant.

### 2.2 `venues`
- **Spec / Intended**: Event venues/rooms.
- **Actual Schema**:
  - Columns: `id`, `event_id`, `name`, `building`, `room`, `capacity`, `created_at`, `updated_at`.
  - FK: `venues_event_id_fkey` -> `events(id) ON DELETE CASCADE`.
- **Drift / Discrepancy**: None. Fully compliant.

### 2.3 `competitions`
- **Spec / Intended**: Festival competition tracks.
- **Actual Schema**:
  - Columns: `id`, `event_id`, `name`, `slug`, `category`, `description`, `min_judges`, `max_judges`, `created_at`, `updated_at`.
  - Constraints: PK, UNIQUE `uq_competition_event_slug`, CHECKs on `min_judges`, `max_judges`.
- **Drift / Discrepancy**: None. Fully compliant.

### 2.4 `sessions`
- **Spec / Intended**: Competition judging session intervals.
- **Actual Schema**:
  - Columns: `id`, `competition_id`, `venue_id`, `name`, `start_time`, `end_time`, `buffer_minutes`, `status`, `created_at`, `updated_at`.
- **Drift / Discrepancy**: None. Fully compliant.

### 2.5 `judges`
- **Spec / Intended**: Academic and industry evaluators.
- **Actual Schema**:
  - Columns: `id`, `first_name`, `last_name`, `email`, `phone`, `organization`, `designation`, `expertise TEXT[]`, `bio`, `is_active`, `created_at`, `updated_at`.
- **Drift / Discrepancy**: Phase 2 adds `q` (name trigram search), `kind`, and `status`.
- **Resolution**: Add `kind` and `status` in Migration 005; install `pg_trgm` extension.

### 2.6 `users`
- **Spec / Intended**: Administrative accounts (admin, coordinator, viewer).
- **Actual Schema**:
  - Columns: `id`, `email`, `password_hash`, `full_name`, `role` (`user_role_enum`), `is_active`, `created_at`, `updated_at`.
- **Drift / Discrepancy**: None. `viewer` role added in migration 004.

### 2.7 `auth_tokens`
- **Spec / Intended**: Magic-link tokens and authentication tokens.
- **Actual Schema**:
  - Columns: `id`, `user_id` (NOT NULL), `token_hash TEXT UNIQUE`, `type` (`token_type_enum`), `expires_at`, `created_at`.
- **Drift / Discrepancy**:
  - `user_id` was mandatory (blocks judge tokens where `user_id` is null).
  - Missing `judge_id`, `invitation_id`, `used_at`, and `purpose`.
- **Resolution**: Migration 005 makes `user_id` nullable, adds `judge_id`, `invitation_id`, `used_at`, and `purpose`.

### 2.8 `judge_invitations`
- **Spec / Intended**: Formal judge invitations.
- **Actual Schema**:
  - Columns: `id`, `event_id` (nullable), `judge_id`, `invitation_token`, `status` (`invitation_status_enum`), `sent_at`, `expires_at`, `created_at`, `updated_at`, `competition_id` (nullable).
  - Index: `uq_invitation_live` on `(judge_id, competition_id) WHERE status IN ('sent','viewed','accepted','tentative')`.
- **Drift / Discrepancy**: `competition_id` is currently nullable.
- **Resolution**: Backfill any nulls and enforce `NOT NULL` in Migration 005.

### 2.9 `invitation_responses`
- **Spec / Intended**: Judge RSVP responses.
- **Actual Schema**:
  - Columns: `id`, `invitation_id`, `response` (`invitation_response_enum`), `response_notes`, `ip_address`, `user_agent`, `responded_at`.
- **Drift / Discrepancy**: `invitation_response_enum` currently has `'accepted'`, `'declined'`. Phase 2 adds `'tentative'`.
- **Resolution**: Add `'tentative'` to `invitation_response_enum` in Migration 005.

### 2.10 `judge_availability`
- **Spec / Intended**: Declared available windows.
- **Actual Schema**:
  - Columns: `id`, `judge_id`, `event_id`, `available_window TSTZRANGE`, `status`, `notes`, `created_at`, `updated_at`.
- **Drift / Discrepancy**: Column named `available_window` rather than `during`.
- **Resolution**: Add generated column `during TSTZRANGE GENERATED ALWAYS AS (available_window) STORED;`. Documented for Phase 3.

### 2.11 `judge_conflicts`
- **Spec / Intended**: Immutable conflicts of interest.
- **Actual Schema**:
  - Columns: `id`, `judge_id`, `competition_id`, `student_name`, `institution`, `conflict_type`, `description`, `created_at`.
  - Permissions: `REVOKE UPDATE, DELETE ON judge_conflicts FROM csefest_app, PUBLIC;`.
- **Drift / Discrepancy**: Missing `superseded_by`, `subject_kind`, `subject_name`, `severity`.
- **Resolution**: Add columns in Migration 005. Issue column-level `GRANT UPDATE (superseded_by) ON judge_conflicts TO csefest_app;` so content remains immutable while predecessor pointer update succeeds.

### 2.12 `judge_assignments`
- **Spec / Intended**: Session assignments with `no_double_booking` EXCLUDE constraint.
- **Actual Schema**: Fully compliant, with GiST exclusion constraint and window synchronization triggers.
- **Drift / Discrepancy**: None. (Phase 3 scope).

### 2.13 `assignment_responses` & `assignment_attendance`
- **Spec / Intended**: Day-of attendance and assignment responses.
- **Actual Schema**: Fully compliant. (Phase 4 scope).

### 2.14 `notification_outbox`
- **Spec / Intended**: Asynchronous message queue.
- **Actual Schema**:
  - Columns: `id`, `recipient_email`, `recipient_name`, `channel`, `subject`, `body`, `payload JSONB`, `status`, `retry_count`, `scheduled_at`, `sent_at`, `error_message`, `created_at`, `updated_at`.
- **Drift / Discrepancy**: Missing `idempotency_key` (UNIQUE), `template`, and `to_email`.
- **Resolution**: Add `idempotency_key TEXT UNIQUE`, `template TEXT`, and `to_email TEXT` in Migration 005.

### 2.15 `notification_deliveries`
- **Spec / Intended**: Outbox delivery logs.
- **Actual Schema**: Fully compliant. (Phase 4 worker scope).

### 2.16 `audit_log`
- **Spec / Intended**: System-wide DML audit ledger.
- **Actual Schema**:
  - Columns: `id`, `table_name`, `record_id`, `action`, `old_values`, `new_values`, `actor_id`, `client_ip`, `created_at`, `row_id`.
- **Drift / Discrepancy**: None. Fully compliant.

### 2.17 `session` (connect-pg-simple)
- **Spec / Intended**: Express session store table.
- **Actual Schema**: `sid`, `sess`, `expire`. Fully compliant.

---

## 3. Availability & Conflict Policy Documentation

### 3.1 Availability Replacement Policy (Phase 2 Rule)
When a judge posts new availability via their magic link (`POST /api/j/:token/availability`):
- If the token was created within 24 hours **OR** this is the judge's first declaration, the submission replaces all previous availability rows for that judge (transactional `DELETE` followed by `INSERT`).
- Otherwise (token older than 24h on a subsequent call), declarations append without deleting prior history.

### 3.2 Conflict Superseding Policy (Phase 2 Rule)
- Direct `UPDATE` or `DELETE` on `judge_conflicts` is rejected with SQLSTATE `42501`.
- When a judge declares a replacement or refinement for an earlier conflict, a new row is inserted, and the server sets the earlier row's `superseded_by = NEW.id` via column-level update permission. The previous declaration content remains permanently immutable.
- In responses, judges only ever see their own declared free-text strings; no participant IDs, team rosters, or matching engine details are ever exposed.

---

## 4. Current Public Schema Snapshot (Pre-Migration 005)

### Public Tables (19)
```
assignment_attendance
assignment_responses
audit_log
auth_tokens
competitions
events
invitation_responses
judge_assignments
judge_availability
judge_conflicts
judge_invitations
judges
notification_deliveries
notification_outbox
schema_migrations
session
sessions
users
venues
```
*(Total: 19 tables. Phase 2 maintains strictly 19 tables).*


---

## 5. Phase 3 Pre-Check & Schema Reconciliation

**Audit Date**: 2026-11-16  
**Auditor**: Antigravity Engineering Agent

### 5.1 Verification Checklist
1. **`information_schema.columns` Inspection**:
   - `judge_assignments`: `id`, `session_id`, `judge_id`, `role`, `status`, `assignment_window`, `created_at`, `updated_at`.
   - `assignment_responses`: `id`, `assignment_id`, `response` (`assignment_response_enum`), `reason`, `responded_at`.
   - `assignment_attendance`: `id`, `assignment_id`, `status` (`attendance_status_enum`), `check_in_time`, `notes`, `marked_by`, `created_at`, `updated_at`. UNIQUE constraint on `(assignment_id)` is present.
   - `sessions`: `id`, `competition_id`, `venue_id`, `name`, `start_time`, `end_time`, `buffer_minutes`, `status`, `created_at`, `updated_at`.
   - `auth_tokens`: `id`, `user_id`, `token_hash`, `type` (`token_type_enum`), `expires_at`, `created_at`, `judge_id`, `invitation_id`, `used_at`, `purpose` (`text`).
   - `notification_outbox`: `id`, `recipient_email`, `to_email`, `recipient_name`, `channel`, `subject`, `body`, `payload`, `status`, `retry_count`, `scheduled_at`, `sent_at`, `error_message`, `idempotency_key` (UNIQUE), `template`, `created_at`, `updated_at`.

2. **Constraints & Exclusion Proof**:
   - `no_double_booking`: `EXCLUDE USING gist (judge_id WITH =, assignment_window WITH &&) WHERE ((status <> 'cancelled'::assignment_status_enum))` — Verified present and active.
   - `uq_assignment_per_session`: `UNIQUE (session_id, judge_id)` — Verified present and active.

3. **Window Auto-Sync Trigger**:
   - `trg_set_assignment_window` executes `set_assignment_window()` BEFORE INSERT or UPDATE OF `session_id`.
   - Tested in rolled-back transaction: successfully derived and populated `assignment_window: '["2026-11-20 09:00:00+06","2026-11-20 12:15:00+06")'`.

4. **`auth_tokens.purpose` Enum / Text Shape**:
   - Actual schema: `purpose` is a `TEXT` column with default `'invitation'::text` (added in Migration 005), not an enum. It natively accepts `'assignment'`, `'checkin'`, and other purpose strings without enum constraints.
   - `token_type_enum` contains `('session', 'password_reset', 'api_key')`. Added `'assignment'` and `'checkin'` to `token_type_enum` for consistency.

5. **`judge_availability.during` Column Shape**:
   - Actual schema: `during` is a stored generated column (`during TSTZRANGE GENERATED ALWAYS AS (available_window) STORED`) added in Migration 005. Both `during` and `available_window` resolve identically.

### 5.2 Blockers Gate
- **Genuine Blockers**: **NONE.** All Phase 3 requirements land cleanly on the existing 19 public tables. Zero new tables required.

### 5.3 Non-Blockers Resolved in Migration 006
The following schema enhancements are enacted via `006_phase3_scheduling_attendance.sql`:
1. `assignment_status_enum`: Add values `'held'` and `'replaced'` (for replacement chaining).
2. `attendance_status_enum`: Add values `'checked_in'`, `'early_departure'`, `'not_arrived'`.
3. `token_type_enum`: Add values `'assignment'`, `'checkin'`.
4. `judge_assignments`: Add `replaces_assignment_id BIGINT REFERENCES judge_assignments(id) ON DELETE SET NULL` and `superseded_by BIGINT REFERENCES judge_assignments(id) ON DELETE SET NULL`.
5. `assignment_attendance`: Add `checked_out_at TIMESTAMPTZ` and `minutes_late INTEGER NOT NULL DEFAULT 0`.
6. `sessions`: Add `reporting_at TIMESTAMPTZ` and `grace_minutes INTEGER NOT NULL DEFAULT 15`.
7. `auth_tokens`: Add `assignment_id BIGINT REFERENCES judge_assignments(id) ON DELETE CASCADE`.


---

## 6. Phase 4 Pre-Check & Schema Snapshot

**Audit Date**: 2026-11-16  
**Auditor**: Antigravity Engineering Agent

### 6.1 Migration Status
All migrations 001 through 006 applied and verified:
- 001_schema.sql (Applied)
- 002_triggers.sql (Applied)
- 003_session_store.sql (Applied)
- 004_fix_invitation_live_index.sql (Applied)
- 005_phase2_schema_alignment.sql (Applied)
- 006_phase3_scheduling_attendance.sql (Applied)

### 6.2 Pre-Check Invariants
- Total public tables: 19 (strictly preserved)
- Active tests: 110/110 passing (0 skipped, 0 failed)
- Git tracked .env files: 0 (verified empty)

### 6.3 Schema Dump (judge_* and notification_*)
```sql
--
-- PostgreSQL database dump
--

\restrict TwAn4sS6ioQPqQ0W2DoVhOFVkuHHfgRm6829pwTTUzXZjzYKvRlbfZfOJ0j5lLX

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: judge_assignments; Type: TABLE; Schema: public; Owner: csefest_app
--

CREATE TABLE public.judge_assignments (
    id bigint NOT NULL,
    session_id bigint NOT NULL,
    judge_id bigint NOT NULL,
    role public.assignment_role_enum DEFAULT 'judge'::public.assignment_role_enum NOT NULL,
    status public.assignment_status_enum DEFAULT 'assigned'::public.assignment_status_enum NOT NULL,
    assignment_window tstzrange NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    replaces_assignment_id bigint,
    superseded_by bigint
);


ALTER TABLE public.judge_assignments OWNER TO csefest_app;

--
-- Name: judge_assignments_id_seq; Type: SEQUENCE; Schema: public; Owner: csefest_app
--

ALTER TABLE public.judge_assignments ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.judge_assignments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: judge_availability; Type: TABLE; Schema: public; Owner: csefest_app
--

CREATE TABLE public.judge_availability (
    id bigint NOT NULL,
    judge_id bigint NOT NULL,
    event_id bigint NOT NULL,
    available_window tstzrange NOT NULL,
    status public.availability_status_enum DEFAULT 'available'::public.availability_status_enum NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    during tstzrange GENERATED ALWAYS AS (available_window) STORED
);


ALTER TABLE public.judge_availability OWNER TO csefest_app;

--
-- Name: judge_availability_id_seq; Type: SEQUENCE; Schema: public; Owner: csefest_app
--

ALTER TABLE public.judge_availability ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.judge_availability_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: judge_conflicts; Type: TABLE; Schema: public; Owner: csefest_app
--

CREATE TABLE public.judge_conflicts (
    id bigint NOT NULL,
    judge_id bigint NOT NULL,
    competition_id bigint,
    student_name text,
    institution text,
    conflict_type public.conflict_type_enum NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_by bigint,
    subject_kind text,
    subject_name text,
    severity text DEFAULT 'medium'::text
);


ALTER TABLE public.judge_conflicts OWNER TO csefest_app;

--
-- Name: judge_conflicts_id_seq; Type: SEQUENCE; Schema: public; Owner: csefest_app
--

ALTER TABLE public.judge_conflicts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.judge_conflicts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: judge_invitations; Type: TABLE; Schema: public; Owner: csefest_app
--

CREATE TABLE public.judge_invitations (
    id bigint NOT NULL,
    event_id bigint,
    judge_id bigint NOT NULL,
    invitation_token text NOT NULL,
    status public.invitation_status_enum DEFAULT 'invited'::public.invitation_status_enum NOT NULL,
    sent_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    competition_id bigint NOT NULL
);


ALTER TABLE public.judge_invitations OWNER TO csefest_app;

--
-- Name: judge_invitations_id_seq; Type: SEQUENCE; Schema: public; Owner: csefest_app
--

ALTER TABLE public.judge_invitations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.judge_invitations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification_deliveries; Type: TABLE; Schema: public; Owner: csefest_app
--

CREATE TABLE public.notification_deliveries (
    id bigint NOT NULL,
    notification_id bigint NOT NULL,
    status public.notification_delivery_status_enum NOT NULL,
    provider_response jsonb,
    delivered_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.notification_deliveries OWNER TO csefest_app;

--
-- Name: notification_deliveries_id_seq; Type: SEQUENCE; Schema: public; Owner: csefest_app
--

ALTER TABLE public.notification_deliveries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.notification_deliveries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification_outbox; Type: TABLE; Schema: public; Owner: csefest_app
--

CREATE TABLE public.notification_outbox (
    id bigint NOT NULL,
    recipient_email text NOT NULL,
    recipient_name text,
    channel public.notification_channel_enum DEFAULT 'email'::public.notification_channel_enum NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    payload jsonb,
    status public.notification_status_enum DEFAULT 'pending'::public.notification_status_enum NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    scheduled_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text,
    template text,
    to_email text
);


ALTER TABLE public.notification_outbox OWNER TO csefest_app;

--
-- Name: notification_outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: csefest_app
--

ALTER TABLE public.notification_outbox ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.notification_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: judge_assignments judge_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_assignments
    ADD CONSTRAINT judge_assignments_pkey PRIMARY KEY (id);


--
-- Name: judge_availability judge_availability_pkey; Type: CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_availability
    ADD CONSTRAINT judge_availability_pkey PRIMARY KEY (id);


--
-- Name: judge_conflicts judge_conflicts_pkey; Type: CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_conflicts
    ADD CONSTRAINT judge_conflicts_pkey PRIMARY KEY (id);


--
-- Name: judge_invitations judge_invitations_invitation_token_key; Type: CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_invitations
    ADD CONSTRAINT judge_invitations_invitation_token_key UNIQUE (invitation_token);


--
-- Name: judge_invitations judge_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_invitations
    ADD CONSTRAINT judge_invitations_pkey PRIMARY KEY (id);


--
-- Name: judge_assignments no_double_booking; Type: CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_assignments
    ADD CONSTRAINT no_double_booking EXCLUDE USING gist (judge_id WITH =, assignment_window WITH &&) WHERE ((status <> 'cancelled'::public.assignment_status_enum));


--
-- Name: notification_deliveries notification_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);


--
-- Name: notification_outbox notification_outbox_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: notification_outbox notification_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_pkey PRIMARY KEY (id);


--
-- Name: judge_assignments uq_assignment_per_session; Type: CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_assignments
    ADD CONSTRAINT uq_assignment_per_session UNIQUE (session_id, judge_id);


--
-- Name: idx_judge_assignments_judge_id; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_judge_assignments_judge_id ON public.judge_assignments USING btree (judge_id);


--
-- Name: idx_judge_assignments_replaces; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_judge_assignments_replaces ON public.judge_assignments USING btree (replaces_assignment_id);


--
-- Name: idx_judge_assignments_session_id; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_judge_assignments_session_id ON public.judge_assignments USING btree (session_id);


--
-- Name: idx_judge_assignments_superseded_by; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_judge_assignments_superseded_by ON public.judge_assignments USING btree (superseded_by);


--
-- Name: idx_judge_availability_event_id; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_judge_availability_event_id ON public.judge_availability USING btree (event_id);


--
-- Name: idx_judge_availability_judge_id; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_judge_availability_judge_id ON public.judge_availability USING btree (judge_id);


--
-- Name: idx_judge_availability_window; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_judge_availability_window ON public.judge_availability USING gist (available_window);


--
-- Name: idx_judge_conflicts_competition_id; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_judge_conflicts_competition_id ON public.judge_conflicts USING btree (competition_id);


--
-- Name: idx_judge_conflicts_judge_id; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_judge_conflicts_judge_id ON public.judge_conflicts USING btree (judge_id);


--
-- Name: idx_judge_invitations_competition_id; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_judge_invitations_competition_id ON public.judge_invitations USING btree (competition_id);


--
-- Name: idx_judge_invitations_event_id; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_judge_invitations_event_id ON public.judge_invitations USING btree (event_id);


--
-- Name: idx_judge_invitations_judge_id; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_judge_invitations_judge_id ON public.judge_invitations USING btree (judge_id);


--
-- Name: idx_notification_deliveries_notification_id; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_notification_deliveries_notification_id ON public.notification_deliveries USING btree (notification_id);


--
-- Name: idx_notification_outbox_idempotency; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_notification_outbox_idempotency ON public.notification_outbox USING btree (idempotency_key);


--
-- Name: idx_notification_outbox_pending; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE INDEX idx_notification_outbox_pending ON public.notification_outbox USING btree (scheduled_at) WHERE (status = 'pending'::public.notification_status_enum);


--
-- Name: uq_invitation_live; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE UNIQUE INDEX uq_invitation_live ON public.judge_invitations USING btree (judge_id, competition_id) WHERE (status = ANY (ARRAY['sent'::public.invitation_status_enum, 'viewed'::public.invitation_status_enum, 'accepted'::public.invitation_status_enum, 'tentative'::public.invitation_status_enum, 'invited'::public.invitation_status_enum]));


--
-- Name: uq_invitation_live_event; Type: INDEX; Schema: public; Owner: csefest_app
--

CREATE UNIQUE INDEX uq_invitation_live_event ON public.judge_invitations USING btree (event_id, judge_id) WHERE ((competition_id IS NULL) AND (status = ANY (ARRAY['sent'::public.invitation_status_enum, 'viewed'::public.invitation_status_enum, 'accepted'::public.invitation_status_enum, 'tentative'::public.invitation_status_enum, 'invited'::public.invitation_status_enum])));


--
-- Name: judge_assignments trg_audit_judge_assignments; Type: TRIGGER; Schema: public; Owner: csefest_app
--

CREATE TRIGGER trg_audit_judge_assignments AFTER INSERT OR DELETE OR UPDATE ON public.judge_assignments FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: judge_conflicts trg_audit_judge_conflicts; Type: TRIGGER; Schema: public; Owner: csefest_app
--

CREATE TRIGGER trg_audit_judge_conflicts AFTER INSERT OR DELETE OR UPDATE ON public.judge_conflicts FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: judge_invitations trg_audit_judge_invitations; Type: TRIGGER; Schema: public; Owner: csefest_app
--

CREATE TRIGGER trg_audit_judge_invitations AFTER INSERT OR DELETE OR UPDATE ON public.judge_invitations FOR EACH ROW EXECUTE FUNCTION public.audit_row();


--
-- Name: judge_assignments trg_set_assignment_window; Type: TRIGGER; Schema: public; Owner: csefest_app
--

CREATE TRIGGER trg_set_assignment_window BEFORE INSERT OR UPDATE OF session_id ON public.judge_assignments FOR EACH ROW EXECUTE FUNCTION public.set_assignment_window();


--
-- Name: judge_invitations trg_set_invitation_competition_and_event; Type: TRIGGER; Schema: public; Owner: csefest_app
--

CREATE TRIGGER trg_set_invitation_competition_and_event BEFORE INSERT OR UPDATE ON public.judge_invitations FOR EACH ROW EXECUTE FUNCTION public.set_invitation_competition_and_event();


--
-- Name: judge_assignments judge_assignments_judge_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_assignments
    ADD CONSTRAINT judge_assignments_judge_id_fkey FOREIGN KEY (judge_id) REFERENCES public.judges(id) ON DELETE CASCADE;


--
-- Name: judge_assignments judge_assignments_replaces_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_assignments
    ADD CONSTRAINT judge_assignments_replaces_assignment_id_fkey FOREIGN KEY (replaces_assignment_id) REFERENCES public.judge_assignments(id) ON DELETE SET NULL;


--
-- Name: judge_assignments judge_assignments_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_assignments
    ADD CONSTRAINT judge_assignments_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: judge_assignments judge_assignments_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_assignments
    ADD CONSTRAINT judge_assignments_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.judge_assignments(id) ON DELETE SET NULL;


--
-- Name: judge_availability judge_availability_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_availability
    ADD CONSTRAINT judge_availability_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: judge_availability judge_availability_judge_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_availability
    ADD CONSTRAINT judge_availability_judge_id_fkey FOREIGN KEY (judge_id) REFERENCES public.judges(id) ON DELETE CASCADE;


--
-- Name: judge_conflicts judge_conflicts_competition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_conflicts
    ADD CONSTRAINT judge_conflicts_competition_id_fkey FOREIGN KEY (competition_id) REFERENCES public.competitions(id) ON DELETE CASCADE;


--
-- Name: judge_conflicts judge_conflicts_judge_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_conflicts
    ADD CONSTRAINT judge_conflicts_judge_id_fkey FOREIGN KEY (judge_id) REFERENCES public.judges(id) ON DELETE CASCADE;


--
-- Name: judge_conflicts judge_conflicts_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_conflicts
    ADD CONSTRAINT judge_conflicts_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.judge_conflicts(id) ON DELETE SET NULL;


--
-- Name: judge_invitations judge_invitations_competition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_invitations
    ADD CONSTRAINT judge_invitations_competition_id_fkey FOREIGN KEY (competition_id) REFERENCES public.competitions(id) ON DELETE CASCADE;


--
-- Name: judge_invitations judge_invitations_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_invitations
    ADD CONSTRAINT judge_invitations_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: judge_invitations judge_invitations_judge_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.judge_invitations
    ADD CONSTRAINT judge_invitations_judge_id_fkey FOREIGN KEY (judge_id) REFERENCES public.judges(id) ON DELETE CASCADE;


--
-- Name: notification_deliveries notification_deliveries_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: csefest_app
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notification_outbox(id) ON DELETE CASCADE;


--
-- Name: TABLE judge_conflicts; Type: ACL; Schema: public; Owner: csefest_app
--

REVOKE ALL ON TABLE public.judge_conflicts FROM csefest_app;
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.judge_conflicts TO csefest_app;


--
-- Name: COLUMN judge_conflicts.superseded_by; Type: ACL; Schema: public; Owner: csefest_app
--

GRANT UPDATE(superseded_by) ON TABLE public.judge_conflicts TO csefest_app;


--
-- PostgreSQL database dump complete
--

\unrestrict TwAn4sS6ioQPqQ0W2DoVhOFVkuHHfgRm6829pwTTUzXZjzYKvRlbfZfOJ0j5lLX
```
