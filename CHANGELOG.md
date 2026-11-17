# Changelog
All notable changes to the **CSE Fest — Judge Invitation & Assignment Management System** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-11-17 - Phase 4: Operations Dashboard, SMTP Outbox Worker, Reminders & Security Hardening

### Added
- **Materialized Views for Dashboard Performance** (`database/migrations/007_phase4_dashboard_materialized_views.sql`):
  - `mv_session_coverage`: Aggregates required judges, confirmed counts, missing judges, head judge presence, and coverage status (`covered`, `understaffed`, `overstaffed`).
  - `mv_judge_workload`: Aggregates confirmed slots, held slots, total assignments, reliability / no-show rates, and last assigned session.
  - Unique indexes on `session_id` and `judge_id` enabling `REFRESH MATERIALIZED VIEW CONCURRENTLY`.
  - Trigger-based automated debounced refresh function (`refresh_mv_dashboard()`) executed on assignment/attendance changes, debounced to at most once per 30 seconds via `_control.mv_refresh_log`.
  - Force refresh utility function `refresh_mv_dashboard_force()` for on-demand synchronization.
- **Dashboard API** (`server/routes/dashboard.js`):
  - `GET /api/dashboard/summary`: Returns 13 aggregated KPI metrics across judges, invitations, assignments, coverage, and live attendance.
  - `GET /api/dashboard/coverage`: Filterable session staffing data directly queried from `mv_session_coverage`.
  - `GET /api/dashboard/workload`: Evaluator leaderboard queried from `mv_judge_workload`.
  - `GET /api/dashboard/feasibility`: Interval-sweep peak concurrency feasibility calculator.
- **Client Operations Dashboard** (`client/dashboard.html`, `client/js/dashboard.js`):
  - KPI metric cards with live counts.
  - Visual festival concurrency meter with surplus/deficit status.
  - Session coverage table with color-coded status badges (`understaffed`, `covered`, `overstaffed`, `missing-head`).
  - Judge workload leaderboard with reliability and no-show statistics.
  - Automatic 60-second polling for real-time monitoring without full page reloads.
  - Top navigation links unified across all admin portals (`index.html`, `judges.html`, `invite.html`, `assignments.html`).
- **SMTP Outbox Delivery Worker** (`server/worker/outbox.js`):
  - Concurrency-safe poll query using `SELECT ... FOR UPDATE SKIP LOCKED` to prevent duplicate deliveries across multi-worker deployments.
  - Nodemailer transport supporting MailHog/Mailpit on `localhost:1025` in development and authenticated SMTP relays in production.
  - Exponential backoff schedule ($2^{\text{attempts}} \times 30\text{s}$) with automatic failure after 5 attempts.
  - Detailed delivery audit trail logged into `notification_deliveries`.
  - Multi-template rendering (`invitation`, `assignment_notification`, `assignment_declined`, `response_received`, `replacement_notification`, `reminder_invitation`, `reminder_assignment`).
- **RFC 5545 iCalendar Generation** (`server/lib/ics.js`):
  - Standardized `.ics` calendar generator for judging sessions.
  - Standard RFC 5545 UTC timestamp formatting (`YYYYMMDDTHHMMSSZ`), line folding (> 75 chars), and `Asia/Dhaka` `VTIMEZONE`.
  - Strict CRLF sanitization to defend against calendar injection attacks.
- **Automated Reminders Scheduler** (`server/worker/reminders.js`):
  - Daily sweep for pending invitations expiring within 3–4 days.
  - Daily sweep for confirmed assignments starting in 23–25 hours with `.ics` calendar attachment.
  - Real-time late alert to coordinators when judges fail to arrive past reporting time + grace + 5 minutes.
  - Deterministic idempotency keys (`reminder:{kind}:{id}:{YYYY-MM-DD}`) preventing duplicate emails.
- **Security Hardening & Account Controls**:
  - `POST /api/auth/password`: Authenticated password rotation with mandatory current password check, $\ge 8$ character policy, bcrypt (12 rounds), and atomic revocation of all active sessions from the PostgreSQL session store.
  - `GET /api/audit`: Paginated immutable audit trail viewer restricted strictly to the `admin` role.
  - Correlation ID middleware attaching `X-Request-Id` UUID to every HTTP transaction.
  - Production error handler masking internal stack traces on 500 responses while preserving correlation tracing.
  - Helmet HSTS restricted strictly to `NODE_ENV=production`.
- **System-Wide End-to-End Regression Suite** (`scripts/system-regression.js`):
  - Automated Playwright browser workflow verifying admin login, judge creation, bulk invite, token landing, COI declaration, availability declaration, assignment, 409 duplicate rejection, 409 overlap rejection, check-in, checkout, coverage updates, and live dashboard metrics.

### Changed
- `package.json`: Added `nodemailer` dependency.
- Test suite expanded from 110 to 136 passing tests (0 skips, 0 failures).
- Public schema table count strictly maintained at 19 tables.

---

## [0.3.0] - 2026-11-16 - Phase 3: Scheduling, Attendance & Replacement Chaining
- Implemented PostgreSQL GiST exclusion constraint `no_double_booking` on `(judge_id WITH =, assignment_window WITH &&)`.
- Added assignment endpoints, attendance check-in/check-out with automatic minutes_late calculation.
- Added candidate recommendation engine and replacement chaining workflow with 10-minute cancellation window.
- Added event feasibility sweep algorithm calculating peak concurrent judging demand.

---

## [0.2.0] - 2026-11-16 - Phase 2: Judges Roster, Invitations & Magic Link Portal
- Implemented judges directory CRUD with soft-deactivation guards.
- Implemented bulk invitation workflow with automated deduplication.
- Implemented single-use SHA-256 hashed magic link response portal (`/j/:token`).
- Implemented blinded, immutable conflict-of-interest declarations (`judge_conflicts`).
- Implemented transactional outbox producer logging notifications for background dispatch.

---

## [0.1.0] - 2026-11-16 - Phase 1: Core Schema & Authentication Foundation
- Initial migration-managed PostgreSQL database schema (19 tables).
- Express application foundation with PostgreSQL session persistence (`connect-pg-simple`).
- Admin authentication with bcrypt hashing and RBAC middleware.
