# CSE Fest — Judge Invitation & Assignment Management System
## Phase 2 API Reference

This document provides exhaustive documentation for all Phase 2 REST API endpoints, schemas, authentication tiers, validation constraints, and error codes.

---

## 1. Authentication & Authorization Tiers

The system supports four distinct access tiers:

| Tier | Header / Credential | Scope |
|------|---------------------|-------|
| **Public Magic Link** | URL parameter `:token` (32-byte base64url) | Unauthenticated external judge portal access (`/j/:token`, `/api/j/:token/*`). Rate-limited to 60 req/min. |
| **Admin** | `connect.sid` session cookie | Full system access: judges CRUD, invitations dispatch, lifecycle controls, audit logs. |
| **Coordinator** | `connect.sid` session cookie | Operational access: judges CRUD, bulk invitations dispatch, resend/cancel invitations. |
| **Viewer** | `connect.sid` session cookie | Read-only administrative dashboard and metrics; cannot mutate judges or dispatch invitations (receives `403 Forbidden`). |

---

## 2. Judges Management API

Base route: `/api/judges`  
**Authorization**: `admin`, `coordinator`

### 2.1 List & Filter Judges
`GET /api/judges`

#### Query Parameters
- `q` (string, optional): Search query matched against judge full name (`first_name || ' ' || last_name`), email, and organization via trigram/ILIKE.
- `kind` (string, optional): One of `'academic'`, `'industry'`, `'alumni'`, `'other'`.
- `status` (string, optional): One of `'active'`, `'inactive'`, `'archived'`.
- `organization` (string, optional): ILIKE substring search on organization name.
- `expertise` (string | string[], optional): Array overlap check (`expertise && $1`).
- `limit` (integer, default: 20, max: 100): Page size.
- `offset` (integer, default: 0): Record offset.
- `sort_by` (string, default: `'created_at'`): Whitelisted to `'name'`, `'created_at'`, `'status'`, `'organization'`.
- `order` (string, default: `'desc'`): `'asc'` or `'desc'`.

#### Response (200 OK)
```json
{
  "judges": [
    {
      "id": 1,
      "first_name": "Alan",
      "last_name": "Turing",
      "email": "alan.turing@cambridge.ac.uk",
      "phone": "+44 1223 123456",
      "organization": "University of Cambridge",
      "designation": "Fellow",
      "expertise": ["Cryptography", "Algorithms", "Logic"],
      "bio": "Mathematician and computer scientist.",
      "kind": "academic",
      "status": "active",
      "is_active": true,
      "created_at": "2026-11-16T12:00:00.000Z",
      "updated_at": "2026-11-16T12:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

---

### 2.2 Create Judge
`POST /api/judges`

#### Request Body
```json
{
  "first_name": "Ada",
  "last_name": "Lovelace",
  "email": "ada.lovelace@engine.org",
  "phone": "+44 20 7946 0991",
  "organization": "Analytical Engine Project",
  "designation": "Lead Theorist",
  "kind": "academic",
  "expertise": ["Mathematical Foundations", "Algorithms"],
  "bio": "Pioneer of scientific computation.",
  "status": "active"
}
```

#### Validation Rules
- `first_name`: Required non-empty string.
- `last_name`: Required non-empty string.
- `email`: Required valid email address format. Normalized to lowercase; duplicate check is case-insensitive.
- `kind`: Optional, one of `['academic', 'industry', 'alumni', 'other']` (default: `'academic'`).
- `expertise`: Optional array of strings (max 20 items, each 1–40 chars).
- `status`: Optional, one of `['active', 'inactive', 'archived']` (default: `'active'`).

#### Response (201 Created)
Returns `{ "judge": { ... } }`.

#### Errors
- `400 Bad Request`: Validation failure (missing required fields, malformed email).
- `409 Conflict`: Case-insensitive email collision.

---

### 2.3 Get Judge Details
`GET /api/judges/:id`

#### Response (200 OK)
Returns `{ "judge": { ... } }`.

#### Errors
- `400 Bad Request`: Non-integer ID.
- `404 Not Found`: Judge record does not exist.

---

### 2.4 Update Judge
`PATCH /api/judges/:id`

#### Request Body
Partial updates accepted. At least one updatable field must be provided.
```json
{
  "designation": "Director of Computing",
  "phone": "+44 20 7946 0999"
}
```

#### Errors
- `400 Bad Request`: Empty update payload or invalid field values.
- `404 Not Found`: Judge does not exist.
- `409 Conflict`: Updated email collides with an existing judge account.

---

### 2.5 Guarded Judge Deactivation
`POST /api/judges/:id/deactivate`

#### Guard Logic
Before setting `status = 'inactive'`, checks for confirmed future assignments:
```sql
SELECT ja.id, s.start_time, s.end_time, c.name AS competition_name
FROM judge_assignments ja
JOIN sessions s ON s.id = ja.session_id
JOIN competitions c ON c.id = s.competition_id
WHERE ja.judge_id = $1
  AND ja.status IN ('confirmed', 'assigned')
  AND s.end_time > NOW()
LIMIT 1;
```

#### Response (200 OK)
If no active future assignments exist:
```json
{
  "message": "Judge successfully deactivated",
  "judge": {
    "id": 1,
    "status": "inactive",
    "is_active": false
  }
}
```

#### Guard Rejection (409 Conflict)
If an active or confirmed future session assignment is attached:
```json
{
  "error": "Cannot deactivate judge with active or confirmed future assignments",
  "conflict": {
    "assignment_id": 42,
    "competition": "Autonomous Robotics Hackathon",
    "start_time": "2026-11-20T10:00:00.000Z",
    "end_time": "2026-11-20T13:00:00.000Z"
  }
}
```

---

### 2.6 Judge Comprehensive History
`GET /api/judges/:id/history`

Returns full historical ledger for a judge across festival cycles:
- All past and current invitations (`judge_invitations`)
- All scheduled session assignments (`judge_assignments`)
- All submitted availability windows (`judge_availability`)
- All declared conflicts of interest (`judge_conflicts`)

#### Response (200 OK)
```json
{
  "judge": { ... },
  "invitations": [ ... ],
  "assignments": [ ... ],
  "availability": [ ... ],
  "conflicts": [ ... ]
}
```

---

## 3. Invitations Lifecycle API

Base route: `/api/invitations`  
**Authorization**: `admin`, `coordinator`

### 3.1 List Invitations
`GET /api/invitations`

#### Query Parameters
- `competition_id` (integer, optional): Filter by target competition.
- `judge_id` (integer, optional): Filter by judge.
- `status` (string, optional): Filter by status (`sent`, `viewed`, `accepted`, `declined`, `tentative`, `cancelled`).
- `limit`, `offset`: Pagination controls.

#### Response (200 OK)
```json
{
  "invitations": [
    {
      "id": 10,
      "competition_id": 2,
      "competition_name": "Algorithm Sprint",
      "judge_id": 4,
      "first_name": "Claude",
      "last_name": "Shannon",
      "email": "claude.shannon@bell.com",
      "status": "sent",
      "sent_at": "2026-11-16T12:00:00.000Z",
      "expires_at": "2026-11-19T12:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

---

### 3.2 Single Invitation Dispatch
`POST /api/invitations`

#### Request Body
```json
{
  "judge_id": 4,
  "competition_id": 2,
  "expires_at": "2026-11-20T18:00:00Z"
}
```

#### Processing Pipeline
1. Validates input schema.
2. Verifies judge is active (`status = 'active'`).
3. Verifies no existing live invitation exists for `(judge_id, competition_id)` (`status IN ('sent','viewed','accepted','tentative','invited')`).
4. Generates 32-byte secure random raw token; hashes raw token with SHA-256.
5. Inserts `judge_invitations` (`status = 'sent'`).
6. Inserts `auth_tokens` (`purpose = 'invitation'`, `token_hash`, `expires_at`).
7. Produces `notification_outbox` row with unique `idempotency_key` (`invite_<invitation_id>_<hash_prefix>`).
8. Response:
   - In Development / Test (`NODE_ENV !== 'production'`): Includes `magicLinkUrl` and `rawToken` for local testing.
   - In Production (`NODE_ENV === 'production'`): `magicLinkUrl` and `rawToken` are **strictly omitted** to prevent credential disclosure in API logs.

#### Errors
- `400 Bad Request`: Inactive judge or validation failure.
- `404 Not Found`: Judge or competition not found.
- `409 Conflict`: Judge already has an active live invitation for this competition.

---

### 3.3 Bulk Invitations Dispatch
`POST /api/invitations/bulk`

#### Request Body
```json
{
  "competition_id": 2,
  "judge_ids": [4, 5, 6, 7],
  "deadline_hours": 72
}
```

#### Deduping & Skip Semantics
- Evaluates existing live invitations across requested `judge_ids`.
- Judges who already possess an active invitation for `competition_id` are **automatically skipped** without failing the overall transaction.
- Inactive judges are safely skipped with explanation.
- Valid candidate judges receive invitations, auth tokens, and outbox rows.

#### Response (201 Created)
```json
{
  "message": "Processed 4 invitations",
  "created_count": 3,
  "skipped_count": 1,
  "created": [
    { "invitation_id": 11, "judge_id": 4, "judge_name": "Claude Shannon", "email": "claude@bell.com" },
    { "invitation_id": 12, "judge_id": 5, "judge_name": "Grace Hopper", "email": "grace@navy.mil" },
    { "invitation_id": 13, "judge_id": 6, "judge_name": "Kurt Godel", "email": "kurt@ias.edu" }
  ],
  "skipped": [
    { "judge_id": 7, "reason": "Judge already has an active invitation" }
  ]
}
```

---

### 3.4 Resend Invitation
`POST /api/invitations/:id/resend`

- Resends an existing live invitation (`sent` or `viewed`).
- Generates a fresh 32-byte magic token and extends `expires_at` by 72 hours.
- Invalidates prior active tokens (`expires_at = NOW()`).
- Inserts `notification_outbox` row with template `'judge_invitation_reminder'`.
- Rejection (409 Conflict): Cannot resend invitations with terminal statuses (`accepted`, `declined`, `cancelled`).

---

### 3.5 Cancel Invitation
`POST /api/invitations/:id/cancel`

- Sets `status = 'cancelled'`.
- Invalidates active `auth_tokens` immediately (`expires_at = NOW()`).
- Rejection (409 Conflict): Cannot cancel invitations that have already been `accepted` or `declined`.

---

## 4. Public Judge Portal API

Base routes: `/j/:token` (HTML) and `/api/j/:token/*` (JSON)  
**Authorization**: Public Magic Link Token (`:token`)  
**Rate Limit**: 60 requests / minute per IP

### 4.1 Resolve Magic Link Portal (HTML)
`GET /j/:token`

- Checks SHA-256 hash of token against `auth_tokens`.
- Validates expiration (`expires_at > NOW()`).
- Status Codes:
  - `200 OK`: Serves `client/j.html`.
  - `410 Gone`: Serves styled HTML notice stating the invitation link has expired.
  - `404 Not Found`: Serves styled HTML notice stating the link is invalid.

---

### 4.2 Fetch Invitation Context (JSON)
`GET /api/j/:token`

#### Response (200 OK)
```json
{
  "judge": {
    "first_name": "Leslie",
    "last_name": "Lamport",
    "email": "leslie.lamport@microsoft.com",
    "organization": "Microsoft Research",
    "kind": "industry"
  },
  "competition": {
    "id": 1,
    "name": "Software Design Challenge",
    "description": "Enterprise-grade microservices evaluation."
  },
  "event": {
    "id": 1,
    "name": "National Hackathon 2026",
    "start_date": "2026-11-20T09:00:00.000Z",
    "end_date": "2026-11-22T18:00:00.000Z"
  },
  "invitation": {
    "id": 14,
    "status": "viewed",
    "expires_at": "2026-11-19T18:00:00.000Z",
    "is_used": false
  },
  "availability": [],
  "conflicts": []
}
```

#### Strict Blinding Guarantee
- The response returns **only** the judge's own declared free-text strings.
- Never returns participant names, contestant lists, student IDs, or team evaluation records.

---

### 4.3 Mark Viewed
`POST /api/j/:token/view`

- Idempotent action: If invitation is currently `'sent'`, updates status to `'viewed'`.
- Leaves `auth_tokens.used_at` strictly `NULL` (viewing does not consume the single-use token).

---

### 4.4 Submit RSVP Response
`POST /api/j/:token/respond`

#### Request Body
```json
{
  "response": "accepted",
  "note": "Looking forward to evaluating microservice submissions."
}
```

#### Semantics & Single-Use Consumption
- `response`: Required, one of `'accepted'`, `'declined'`, `'tentative'`.
- Atomic transaction:
  1. Updates `judge_invitations.status = $1`.
  2. Appends row to `invitation_responses` (`response`, `response_notes`, `ip_address`, `user_agent`).
  3. Updates `auth_tokens.used_at = NOW()`.
  4. Inserts notification row in `notification_outbox` notifying coordinators.
- Replay Protection: Re-submitting on a token where `used_at IS NOT NULL` returns `409 Conflict`.

---

### 4.5 Declare Availability
`POST /api/j/:token/availability`

#### Request Body
```json
{
  "slots": [
    {
      "start_time": "2026-11-20T09:00:00Z",
      "end_time": "2026-11-20T13:00:00Z",
      "is_available": true
    },
    {
      "start_time": "2026-11-20T14:00:00Z",
      "end_time": "2026-11-20T18:00:00Z",
      "is_available": true
    }
  ]
}
```

#### Constraints & Replacement Policy
- `start_time` must be strictly before `end_time` (minimum duration: 15 minutes, maximum duration: 7 days).
- Maximum 10 slots per submission.
- Overlapping conflicting availability returns `400 Bad Request`.
- **24-Hour Policy**:
  - If token created within 24 hours: Transactional replacement (`DELETE` prior records for this judge/event, followed by `INSERT`).
  - If token created > 24 hours ago: Appends new windows without deleting previous submissions.

---

### 4.6 Declare Conflicts of Interest (COI)
`POST /api/j/:token/conflicts`

#### Request Body
```json
{
  "conflicts": [
    {
      "subject_name": "Team Paxos",
      "subject_kind": "Former Advisee",
      "severity": "high",
      "description": "Team lead is a recent graduate from my research group.",
      "supersedes_id": 12
    }
  ]
}
```

#### Database Immutability & Superseding
- Append-only table: Every declaration creates a new row in `judge_conflicts`.
- When `supersedes_id` is supplied, the server updates the predecessor row's `superseded_by` pointer via PostgreSQL column-level permission `GRANT UPDATE (superseded_by)`.
- Content columns (`description`, `severity`, `subject_name`) remain permanently immutable (direct UPDATE or DELETE returns SQLSTATE `42501`).

---

## 5. Summary of Error Codes

| Code | Meaning | Context |
|------|---------|---------|
| `400` | Bad Request | Schema validation error, malformed UUID/ID, overlapping conflicting time ranges. |
| `401` | Unauthorized | Unauthenticated request to administrative routes. |
| `403` | Forbidden | Insufficient permissions (viewer attempting mutation). |
| `404` | Not Found | Judge, competition, or magic link token not found. |
| `409` | Conflict | Email collision, active invitation duplicate, deactivation blocked by active assignment, single-use token replay. |
| `410` | Gone | Magic link invitation has expired (`expires_at < NOW()`). |
| `429` | Too Many Requests | Rate limit exceeded on judge portal (60 req/min). |
| `500` | Internal Server Error | Unhandled database or server exception. |

---

## 6. Phase 3 API Reference: Scheduling, Coverage, Attendance & Replacement

### 6.1 Admin Assignments API
Base route: `/api/assignments`  
**Authorization**: `admin`, `coordinator`

#### 6.1.1 List & Filter Assignments
`GET /api/assignments`

##### Query Parameters
- `session_id` (integer, optional): Filter by session ID.
- `judge_id` (integer, optional): Filter by judge ID.
- `competition_id` (integer, optional): Filter by competition ID.
- `status` (string, optional): One of `'assigned'`, `'confirmed'`, `'declined'`, `'held'`, `'replaced'`, `'cancelled'`, `'completed'`.
- `role` (string, optional): One of `'head_judge'`, `'judge'`, `'evaluator'`.
- `limit` (integer, default: 50, max: 100): Page limit.
- `offset` (integer, default: 0): Record offset.

##### Response (200 OK)
```json
{
  "assignments": [
    {
      "id": 12,
      "session_id": 4,
      "judge_id": 8,
      "role": "head_judge",
      "status": "confirmed",
      "assignment_window": "[\"2026-11-20 09:00:00+06\",\"2026-11-20 11:15:00+06\")",
      "replaces_assignment_id": null,
      "superseded_by": null,
      "first_name": "Alan",
      "last_name": "Turing",
      "session_name": "Morning Coding",
      "competition_name": "Hackathon",
      "attendance_status": "checked_in",
      "minutes_late": 0
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

#### 6.1.2 Create Assignment
`POST /api/assignments`

##### Request Body
```json
{
  "session_id": 4,
  "judge_id": 8,
  "role": "head_judge"
}
```

##### Responses
- **201 Created**:
  ```json
  {
    "assignment": {
      "id": 12,
      "session_id": 4,
      "judge_id": 8,
      "role": "head_judge",
      "status": "confirmed",
      "assignment_window": "[\"2026-11-20 09:00:00+06\",\"2026-11-20 11:15:00+06\")"
    }
  }
  ```
- **409 Conflict (Overlap - Exclusion Constraint Violation 23P01)**:
  ```json
  {
    "error": "overlap",
    "message": "Judge is already assigned to an overlapping session",
    "conflicting_assignment_id": 5
  }
  ```
- **409 Conflict (Duplicate Assignment 23505)**:
  ```json
  {
    "error": "Judge is already assigned to this session"
  }
  ```
- **400 Bad Request**: Inactive judge or validation failure.
- **404 Not Found**: Session or judge does not exist.

#### 6.1.3 Update Assignment Role
`PATCH /api/assignments/:id`

##### Request Body
```json
{
  "role": "evaluator"
}
```
*Note: Judge or session change requires delete and recreate to preserve EXCLUDE semantics.*

#### 6.1.4 Soft Delete Assignment
`DELETE /api/assignments/:id`
Sets `status = 'cancelled'`. Soft-delete releases the exclusion constraint immediately without data loss.

#### 6.1.5 Admin Override Confirmation
`POST /api/assignments/:id/confirm`

##### Request Body
```json
{
  "reason": "Administrative override confirmation"
}
```
Sets `status = 'confirmed'` and writes an audit row to `audit_log`.

#### 6.1.6 Replace Judge Workflow
`POST /api/assignments/:id/replace`

##### Request Body
```json
{
  "replacement_judge_id": 15,
  "reason": "Original judge reported flight cancellation"
}
```
- Sets original assignment `status = 'replaced'` and `superseded_by = <new_id>`.
- Creates new assignment with `status = 'held'`, `role = <old_role>`, and `replaces_assignment_id = :id`.
- Produces `replacement_notification` outbox row.
- If `replacement_judge_id` is omitted, marks original assignment as vacancy (`status = 'replaced'`, `superseded_by = NULL`).

#### 6.1.7 Undo Replacement (10-Minute Window)
`POST /api/assignments/:id/cancel-replacement`
- If called within $\le 10$ minutes of replacement creation: deletes replacement assignment and reverts original assignment to `'confirmed'`.
- If called after 10 minutes: returns `409 Conflict` (`10-minute undo window has elapsed`).

#### 6.1.8 Manual Attendance Correction
`PATCH /api/assignments/:id/attendance`

##### Request Body
```json
{
  "status": "excused",
  "notes": "Medical emergency excused by coordinator"
}
```
Updates `assignment_attendance` and writes an audit row to `audit_log`.

#### 6.1.9 Get Replacement Candidates
`GET /api/assignments/:id/replacement-candidates`
Returns candidate judges for the session linked to assignment `:id`.

---

### 6.2 Admin Coverage & Feasibility API
Base route: `/api`  
**Authorization**: `admin`, `coordinator`

#### 6.2.1 Session Coverage
`GET /api/sessions/:id/coverage`
Returns required vs confirmed judges, missing head judge flag, and staffing gap messages.

#### 6.2.2 Competition Coverage Rollup
`GET /api/competitions/:id/coverage`
Aggregates coverage metrics, fully covered sessions count, and overall coverage percentage across all sessions in the competition.

#### 6.2.3 Event Peak Concurrency Feasibility Sweep
`GET /api/events/:id/feasibility`
Executes interval sweep algorithm over all event sessions, reporting peak concurrent judges demand, active available pool, feasible verdict, and deficit.

#### 6.2.4 Session Candidate Judges
`GET /api/sessions/:id/candidates`
Returns active judges filtered automatically: excludes overlapping assignments, excludes hard competition COI declarations, and excludes unavailable windows.

#### 6.2.5 Real-Time Session Attendance Roster
`GET /api/sessions/:id/attendance`
Returns real-time check-in, late arrival, minutes late, and checkout status for all judges in the session.

#### 6.2.6 Flag Absent Unchecked Judges
`POST /api/sessions/:id/flag-absent`
Marks all unchecked judges as `'absent'` and produces `judge_absent_alert` outbox rows for coordinator action.

---

### 6.3 Judge Portal Assignment & Attendance API (Token Authenticated)
Base route: `/api/j/:token`  
**Rate Limited**: 60 req/min

#### 6.3.1 Respond to Assignment (Accept / Decline)
`POST /api/j/:token/assignment/:assignment_id/respond`

##### Request Body
```json
{
  "response": "accepted",
  "reason": "Excited to judge this session"
}
```
- `accepted`: Sets `judge_assignments.status = 'confirmed'`, appends `assignment_responses` row, and marks `auth_tokens.used_at = NOW()`.
- `declined`: Sets `judge_assignments.status = 'declined'`, appends `assignment_responses` row, marks `auth_tokens.used_at = NOW()`, and produces coordinator outbox alert (`judge_declined_assignment_alert`).
- Replay: Returns `409 Conflict`.
- Wrong judge token: Returns `403 Forbidden`.
- Expired token: Returns `410 Gone`.

#### 6.3.2 Judge Self Check-In
`POST /api/j/:token/checkin`

##### Request Body
```json
{
  "assignment_id": 12
}
```
- Checks arrival time against session `reporting_at + grace_minutes`:
  - On or before grace deadline: `status = 'checked_in'`, `minutes_late = 0`.
  - Past grace deadline: `status = 'late'`, `minutes_late > 0`.

#### 6.3.3 Judge Self Check-Out
`POST /api/j/:token/checkout`

##### Request Body
```json
{
  "assignment_id": 12
}
```
- Checks departure time against session `end_time`:
  - Before session end time: `status = 'early_departure'`, `early_departure = true`.
  - At or after session end time: `early_departure = false`.

---

## 7. Phase 4 Dashboard & Security Hardening APIs

### 7.1 Operations Dashboard API
Base route: `/api/dashboard`  
**Authorization**: `admin`, `coordinator`, `viewer`

#### 7.1.1 Aggregated Festival KPI Summary
`GET /api/dashboard/summary`

##### Response (200 OK)
```json
{
  "total_judges": 42,
  "invitations_sent": 38,
  "invitations_accepted": 30,
  "invitations_declined": 3,
  "invitations_pending": 5,
  "assignments_confirmed": 28,
  "assignments_held": 4,
  "unassigned_sessions": 2,
  "scheduling_conflicts": 1,
  "expected_arrivals_today": 12,
  "checked_in": 10,
  "missing": 3,
  "replacements_open": 1
}
```

#### 7.1.2 Materialized Session Coverage
`GET /api/dashboard/coverage`  
Reads directly from `mv_session_coverage` with sub-millisecond latency.

##### Query Parameters
- `status` (string, optional): Filter by `'understaffed'`, `'covered'`, or `'overstaffed'`.
- `competition_id` (integer, optional): Filter by target competition ID.

##### Response (200 OK)
```json
[
  {
    "session_id": 1,
    "session_name": "Hackathon Round 1 Evaluation",
    "competition_id": 1,
    "competition_name": "Inter-University Hackathon",
    "start_time": "2026-11-20T03:00:00.000Z",
    "end_time": "2026-11-20T06:00:00.000Z",
    "session_status": "scheduled",
    "required_judges": 2,
    "confirmed_count": 2,
    "total_assigned": 2,
    "has_head": true,
    "missing": 0,
    "status": "covered"
  }
]
```

#### 7.1.3 Evaluator Workload Leaderboard
`GET /api/dashboard/workload`  
Reads directly from `mv_judge_workload`.

##### Query Parameters
- `order` (string, default: `'desc'`): Sort direction by confirmed count (`'asc'` or `'desc'`).
- `limit` (integer, default: 20, max: 100): Page size.
- `kind` (string, optional): Filter by affiliation (`'academic'`, `'industry'`, `'alumni'`).

##### Response (200 OK)
```json
[
  {
    "judge_id": 1,
    "full_name": "Aminul Islam",
    "email": "aminislam@university.edu",
    "organization": "University of Engineering & Tech",
    "kind": "academic",
    "confirmed_count": 3,
    "held_count": 0,
    "assigned_count": 0,
    "total_assignments": 3,
    "no_show_rate": 0.0,
    "last_assignment_at": "2026-11-20T14:00:00.000Z"
  }
]
```

#### 7.1.4 Feasibility Assessment
`GET /api/dashboard/feasibility`  
Evaluates overall festival feasibility across scheduled session intervals.

##### Query Parameters
- `event_id` (integer, optional): Target event ID (defaults to active event).

##### Response (200 OK)
```json
{
  "event_id": 1,
  "event_name": "CSE Fest 2026",
  "session_count": 5,
  "peak": 4,
  "available": 8,
  "feasible": true,
  "deficit": 0
}
```

---

### 7.2 Security Hardening & Audit APIs

#### 7.2.1 Administrator Password Rotation
`POST /api/auth/password`  
**Authorization**: `admin`, `coordinator`, `viewer`

##### Request Body
```json
{
  "current_password": "OldPassword123!",
  "new_password": "NewStrongPassword456!"
}
```

##### Response (200 OK)
```json
{
  "message": "Password updated successfully. Please log in again."
}
```
- Validates current password using `bcrypt.compare`.
- Enforces minimum 8-character length for new password.
- Atomically deletes all active user sessions: `DELETE FROM session WHERE sess->'user'->>'id' = $1::text;`.
- Appends `users` record update to `audit_log`.

#### 7.2.2 System Audit Trail Viewer
`GET /api/audit`  
**Authorization**: Strictly restricted to `admin` role.

##### Query Parameters
- `table` (string, optional): Filter by target table name (`'judges'`, `'judge_assignments'`, `'users'`).
- `actor` (integer, optional): Filter by user ID who initiated the change.
- `since` (ISO 8601 string, optional): Filter entries created on or after timestamp.
- `limit` (integer, default: 50, max: 100): Pagination page size.
- `offset` (integer, default: 0): Record offset.

##### Response (200 OK)
```json
{
  "entries": [
    {
      "id": 45,
      "table_name": "judge_assignments",
      "record_id": 12,
      "action": "UPDATE",
      "actor_id": 1,
      "old_values": { "status": "assigned" },
      "new_values": { "status": "confirmed", "reason": "Administrative telephone confirmation" },
      "created_at": "2026-11-17T00:00:00.000Z",
      "actor_email": "admin@csefest.edu",
      "actor_name": "CSE Fest Admin"
    }
  ],
  "total": 45,
  "limit": 50,
  "offset": 0
}
```
