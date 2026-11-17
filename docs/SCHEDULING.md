# Scheduling, Overlap Exclusion & Attendance Architecture

**System**: CSE Fest — Judge Invitation & Assignment Management System  
**Phase**: Phase 3 (Scheduling, Attendance & Replacement)  
**Document**: `docs/SCHEDULING.md`  
**Status**: Implemented & Verified (110/110 Automated Tests Passing)

---

## 1. PostgreSQL Exclusion Constraint (`no_double_booking`)

### 1.1 The Double-Booking Vulnerability in Application Code
A common defect in naive scheduling architectures is implementing double-booking checks in application logic (e.g. `SELECT count(*) ... WHERE overlaps` followed by `INSERT`). Under concurrent request traffic (e.g., two administrators simultaneously scheduling judges or a coordinator batch-assigning judges), application-level checks invariably suffer from race conditions (Time-of-Check to Time-of-Use / TOCTOU).

### 1.2 Mathematical Database Invariant
PostgreSQL provides Generalized Search Tree (`GiST`) index-backed exclusion constraints via the `btree_gist` extension. In this system, double-booking is provably eliminated at the database storage engine layer:

```sql
CONSTRAINT no_double_booking EXCLUDE USING gist (
  judge_id WITH =,
  assignment_window WITH &&
) WHERE (status <> 'cancelled'::assignment_status_enum)
```

- **Index Type**: GiST (`btree_gist` extension enabled).
- **Attributes**:
  - `judge_id WITH =`: An exact equality operator on the judge identifier.
  - `assignment_window WITH &&`: The range overlap operator on temporal timestamp with time zone ranges (`TSTZRANGE`).
- **Predicate Whitelist**: `WHERE (status <> 'cancelled'::assignment_status_enum)`.
  - Cancelled assignments (`status = 'cancelled'`) do not occupy temporal space and release the judge's schedule immediately.
  - Active, held, replaced, and confirmed assignments strictly hold their temporal windows.
- **Application Behavior**: Application code performs **zero manual pre-checks** for overlap. It performs an atomic `INSERT` and catches PostgreSQL error code `23P01` (`exclusion_violation`), translating it deterministically into HTTP `409 Conflict` with `{ error: 'overlap', conflicting_assignment_id: <id> }`.

---

## 2. Temporal Window & Buffer Derivation

### 2.1 Trigger Synchronization (`trg_set_assignment_window`)
To prevent window drift between `sessions` and `judge_assignments`, the database trigger `trg_set_assignment_window` executes `BEFORE INSERT OR UPDATE OF session_id` on `judge_assignments`:

```sql
NEW.assignment_window := tstzrange(
  v_start, 
  v_end + (v_buffer || ' minutes')::interval, 
  '[)'
);
```

- **Start Bound**: Inclusive (`[`). Exactly equals `session.start_time`.
- **End Bound**: Exclusive (`)`). Computed as `session.end_time + session.buffer_minutes * INTERVAL '1 minute'`.
- **Buffer Semantics**: Post-session buffer (e.g., 15 minutes for scoring deliberations, tally sheets, and feedback). If Session A ends at 11:00 with a 15-minute buffer, its window is `[09:00, 11:15)`. Any subsequent session assigned to the same judge starting before 11:15 triggers `23P01` (`exclusion_violation`). Back-to-back sessions without buffers (e.g., Session 1 ending at 11:00, Session 2 starting at 11:00) produce non-overlapping half-open intervals `[09:00, 11:00)` and `[11:00, 13:00)` and succeed without conflict.

---

## 3. Peak Concurrency Sweep Algorithm

### 3.1 Purpose & Problem Statement
When planning a multi-track hackathon or fest, coordinators must verify whether the total pool of active evaluators can satisfy peak concurrent judging demand across simultaneous session schedules.

### 3.2 Algorithm Description
Given $M$ scheduled sessions for event $E$, each session $i$ has start boundary $t_{i,\text{start}} - \text{buffer}$, end boundary $t_{i,\text{end}} + \text{buffer}$, and judge demand $d_i$ (derived from competition `min_judges`):

1. **Edge Interval Decomposition**:
   - For each session $i$, emit two edge points:
     - `(time: start_time, delta: +d_i)`
     - `(time: end_time, delta: -d_i)`
2. **Chronological Sorting**:
   - Sort all points by timestamp ascending.
   - If two events share identical timestamps, process departure (`delta < 0`) before arrival (`delta > 0`) to handle boundary handoffs correctly.
3. **Cumulative Sum Sweep**:
   - Traverse sorted edge points, maintaining `current_demand += delta`.
   - Track `peak_demand = max(peak_demand, current_demand)`.
4. **Feasibility Verdict**:
   - Compare `peak_demand` against active available judges count:
     $$\text{Feasible} \iff \text{Active Judges} \ge \text{Peak Demand}$$
     $$\text{Deficit} = \max(0, \text{Peak Demand} - \text{Active Judges})$$

### 3.3 Computational Complexity
- Generating points: $\mathcal{O}(M)$
- Sorting points: $\mathcal{O}(M \log M)$
- Sweep traversal: $\mathcal{O}(M)$
- Total time complexity: $\mathcal{O}(M \log M)$ (optimal for interval sweep problems).
- Space complexity: $\mathcal{O}(M)$.

---

## 4. Replacement Workflow & Chaining Semantics

### 4.1 Immutable Chaining Model
When an assigned evaluator drops out or experiences an unexpected conflict on fest day, coordinators invoke `POST /api/assignments/:id/replace`:

1. **With Replacement Judge**:
   - A new assignment row is inserted with `status = 'held'` and pointer `replaces_assignment_id = :id`.
   - The prior assignment is updated to `status = 'replaced'` and pointer `superseded_by = new_id`.
   - A high-priority outbox notification (`replacement_notification`) is dispatched with an assignment magic link.
   - The action is logged to `audit_log`.
2. **Without Replacement Judge (Vacancy)**:
   - The assignment status is transitioned to `'replaced'` with `superseded_by = NULL`.
   - The vacancy is immediately reflected in `GET /api/sessions/:id/coverage` as a missing judge gap.

### 4.2 The 10-Minute Undo Window
To protect against administrative misclicks while preventing unbounded history alteration:
- If `POST /api/assignments/:id/cancel-replacement` is called within $\le 10$ minutes of the replacement's creation (`NOW() - created_at <= INTERVAL '10 minutes'`), the new replacement row is hard-deleted, and the original assignment is restored to `'confirmed'` with `superseded_by = NULL`.
- If called after 10 minutes, the server rejects the cancellation with HTTP `409 Conflict` (`10-minute undo window has elapsed`).

---

## 5. Attendance & Real-Time Roster Verification

### 5.1 Reporting Time & Grace Threshold
Each session defines `reporting_at` (defaulting to `start_time - 15 minutes`) and `grace_minutes` (default 15 minutes).
$$\text{Grace Deadline} = \text{reporting\_at} + \text{grace\_minutes} \times 60\,\text{seconds}$$

When a judge invokes `POST /api/j/:token/checkin`:
- If $\text{Arrival Time} \le \text{Grace Deadline} \implies \text{status} = \text{'checked\_in'}, \text{minutes\_late} = 0$.
- If $\text{Arrival Time} > \text{Grace Deadline} \implies \text{status} = \text{'late'}, \text{minutes\_late} = \lceil (\text{Arrival} - \text{Grace Deadline}) / 60 \rceil > 0$.

### 5.2 Checkout & Early Departure
When a judge invokes `POST /api/j/:token/checkout`:
- If $\text{Departure Time} < \text{session.end\_time} \implies \text{status} = \text{'early\_departure'}$.
- If $\text{Departure Time} \ge \text{session.end\_time} \implies$ attendance status remains intact.

### 5.3 Automated Absent Sweep (`flag-absent`)
Admins and coordinators can trigger `POST /api/sessions/:id/flag-absent`:
- Identifies all assigned judges for the session who have not arrived (`not_arrived` or no attendance record).
- Transitions attendance status to `'absent'`.
- Produces coordinator alert rows in `notification_outbox` (`judge_absent_alert`) to prompt immediate emergency replacement.

---

## 6. Materialized Views & Debounced Dashboard Refresh (Phase 4)

### 6.1 Materialized Views Design
To serve high-concurrency festival operations dashboard traffic without executing complex multi-table analytical joins on every page load, Migration 007 provisions two pre-aggregated PostgreSQL Materialized Views:

1. `mv_session_coverage`:
   - Pre-computes per-session staffing metrics: `session_id`, `session_name`, `competition_id`, `competition_name`, `start_time`, `end_time`, `required_judges`, `confirmed_count`, `has_head`, `missing`, and `status` (`covered`, `understaffed`, `overstaffed`).
   - Covered by unique index `idx_mv_session_coverage_session_id`.
2. `mv_judge_workload`:
   - Pre-computes evaluator workloads: `judge_id`, `full_name`, `email`, `organization`, `kind`, `confirmed_count`, `held_count`, `assigned_count`, `total_assignments`, `no_show_rate`, and `last_assignment_at`.
   - Covered by unique index `idx_mv_judge_workload_judge_id`.

### 6.2 Debounce Strategy Choice: `_control.mv_refresh_log` vs `pg_cron`
The project evaluated two architectural choices for automating materialized view synchronization:

| Criterion | Option A: `pg_cron` | Option B: Statement Trigger + Control Row (Chosen) |
| :--- | :--- | :--- |
| **Dependency Requirement** | Requires `shared_preload_libraries = 'pg_cron'` and superuser install | Zero external dependencies; standard PostgreSQL 15+ PL/pgSQL |
| **Public Table Invariant** | Creates internal cron tables | Zero new public tables (stores control row in `_control.mv_refresh_log`) |
| **Event Latency** | Polling latency (fires only at fixed 1-minute cron intervals) | Sub-second reaction to mutations, capped by 30-second debounce |
| **Portability** | Incompatible with environments disallowing custom GUCs | Works identically on local development, Docker, and any cloud host |

**Architectural Decision**: Option B was selected.
- Control row is placed in schema `_control` (`_control.mv_refresh_log`), strictly preserving the invariant of **exactly 19 public tables** in `public.pg_tables`.
- When administrative actions modify `judge_assignments` (INSERT/UPDATE) or `assignment_attendance` (UPDATE), statement-level triggers invoke `refresh_mv_dashboard()`.
- The function inspects `_control.mv_refresh_log` under a row lock (`FOR UPDATE`). If $\text{NOW}() - \text{last\_refreshed\_at} \ge 30\,\text{seconds}$, it executes `REFRESH MATERIALIZED VIEW CONCURRENTLY` for both views and updates the control timestamp.
- On-demand / test synchronization can be triggered instantly via `SELECT refresh_mv_dashboard_force();`.

### 6.3 Automated Reminders Scheduler (`server/worker/reminders.js`)
When `OUTBOX_WORKER=on`, a periodic scheduler executes deterministic notification sweeps:

1. **Pending Invitations**:
   - Query: `expires_at BETWEEN NOW() + INTERVAL '3 days' AND NOW() + INTERVAL '4 days'`.
   - Action: Dispatches `reminder_invitation` template with response magic link.
   - Idempotency Key: `reminder:invitation:${invitation.id}:${YYYY-MM-DD}`.
2. **Upcoming Assigned Sessions**:
   - Query: Confirmed assignments where `start_time BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours'`.
   - Action: Dispatches `reminder_assignment` template with RFC 5545 `.ics` calendar file attachment.
   - Idempotency Key: `reminder:assignment:${assignment.id}:${YYYY-MM-DD}`.
3. **Emergency Coordinator Late Alerts**:
   - Query: Active sessions where $\text{NOW}() \ge \text{reporting\_at} + \text{grace\_minutes} + 5\,\text{minutes}$ and assigned judges remain `not_arrived`.
   - Action: Alerts event coordinators to prompt urgent replacement.
   - Idempotency Key: `reminder:late:${assignment.id}:${YYYY-MM-DD}`.
