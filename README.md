# CSE Fest — Judge Invitation & Assignment Management System

A high-integrity PostgreSQL-backed web platform for university festival administrators to manage judge invitations, prevent scheduling double-booking through mathematical database exclusion constraints, track blinded academic conflicts of interest, and orchestrate festival operations in real-time.

---

## Capabilities & Architecture (Phases 1–4 Complete)

- **Phase 1: Database Schema & Authentication**
  - Migration-managed PostgreSQL 15+ database architecture (19 public tables invariant).
  - Secure administrative authentication via `bcrypt` (12 rounds) and PostgreSQL-backed sessions (`connect-pg-simple`).
  - Role-Based Access Control (`admin`, `coordinator`, `viewer`).
- **Phase 2: Evaluator Roster, Magic Links & Blinded Conflicts**
  - Evaluators directory with soft deactivation guards and case-insensitive email uniqueness.
  - Bulk invitation workflow with automatic deduplication.
  - Zero-credential public judge portal governed by single-use, 256-bit entropy SHA-256 hashed magic links.
  - Append-only, blinded conflict-of-interest declarations with revoked `UPDATE`/`DELETE` permissions (`SQLSTATE 42501`).
- **Phase 3: Session Scheduling, Attendance & Replacement**
  - Provable temporal double-booking prevention via PostgreSQL GiST exclusion constraint `no_double_booking` on `(judge_id WITH =, assignment_window WITH &&)`.
  - Automatic session window derivation with post-session scoring buffers (`trg_set_assignment_window`).
  - Real-time festival attendance tracking with grace periods, late-arrival minutes calculation, and early departure flags.
  - Candidate recommendation engine & replacement chaining with 10-minute administrative undo cancellation windows.
  - Peak concurrency sweep algorithm calculating festival staffing feasibility.
- **Phase 4: Operations Dashboard, SMTP Outbox Worker, Reminders & Hardening**
  - Real-time operations dashboard powered by pre-aggregated PostgreSQL Materialized Views (`mv_session_coverage`, `mv_judge_workload`).
  - Trigger-based automated 30s debounced view refresh function (`refresh_mv_dashboard()`) and on-demand force refresh.
  - Concurrency-safe transactional outbox worker (`SELECT ... FOR UPDATE SKIP LOCKED`) with Nodemailer SMTP delivery and exponential backoff ($2^{\text{attempts}} \times 30\text{s}$).
  - RFC 5545 iCalendar (`.ics`) generation with CRLF injection sanitization and UTC standardization.
  - Automated reminder sweeps for upcoming judging sessions, pending RSVPs, and coordinator emergency late alerts.
  - Security hardening: Administrative password rotation with universal session revocation, `X-Request-Id` correlation tracing, production error sanitization, and Admin Audit Log Viewer (`GET /api/audit`).

---

## Quickstart

### Prerequisites
- Node.js 20+ LTS
- PostgreSQL 15+ running on `localhost:5432` with `btree_gist` extension enabled

### Setup Steps
1. **Clone repository and configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your PostgreSQL credentials
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run database migrations:**
   ```bash
   npm run migrate
   npm run migrate:status
   ```

4. **Seed reference data & admin accounts (Development only):**
   ```bash
   npm run seed
   ```

5. **Run automated test suite (136 tests):**
   ```bash
   npm test
   ```

6. **Run system-wide end-to-end regression (Playwright):**
   ```bash
   node scripts/system-regression.js
   ```

7. **Start server:**
   ```bash
   npm start
   ```
   Open `http://localhost:3000` (or `http://localhost:3000/dashboard.html` after sign-in).

---

## Seed Accounts
- **Administrator**: `admin@csefest.edu` / `ChangeMe123!`
- **Coordinator**: `coordinator@csefest.edu` / `ChangeMe123!`

---

## Documentation Directory
- [Production Deployment Guide](DEPLOYMENT.md)
- [Comprehensive Testing Guide](TESTING.md)
- [Project Changelog](CHANGELOG.md)
- [Project Status & Quality Gates](PROJECT_STATUS.md)
- [REST API Reference (All Endpoints)](docs/API.md)
- [Scheduling, Overlap & Materialized Views Architecture](docs/SCHEDULING.md)
- [Security Architecture & Threat Model](docs/SECURITY.md)
- [Database Schema & Invariants](docs/DATABASE.md)
- [Schema Drift Reconciliation Audit](docs/SCHEMA_DRIFT.md)
- [Operations & Runbook](docs/RUNBOOK.md)
