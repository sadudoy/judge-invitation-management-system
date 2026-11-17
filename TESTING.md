# CSE Fest — Comprehensive Testing Guide
## Test Architecture, Verification & Quality Assurance

This document details the test strategy, execution instructions, suite breakdown, and verification discipline for the **CSE Fest Judge Invitation & Assignment Management System**.

---

## 1. Test Architecture & Environment

The test suite is built on zero-external-runner primitives for maximum execution velocity and deterministic reproducibility:
- **Test Runner**: Node.js 20+ native test runner (`node:test`, `node:assert/strict`)
- **HTTP Integration**: `supertest` for REST API verification against Express
- **Browser Automation**: `Playwright` with Chromium/Edge for full end-to-end browser workflows
- **Database Isolation**: Dedicated PostgreSQL test database (`csefest_test`) managed via `DATABASE_URL_TEST`
- **Concurrency**: Executed with `--test-concurrency=1` to guarantee isolated database state between suites

---

## 2. Running Automated Tests

### 2.1 Complete Test Suite Execution
To run all test suites against the test database:
```bash
npm test
```

### 2.2 Running Specific Test Suites
```bash
# Run dashboard and materialized view tests
node --test tests/dashboard.test.js

# Run outbox delivery worker tests
node --test tests/outbox-worker.test.js

# Run scheduled reminders tests
node --test tests/reminders.test.js

# Run RFC 5545 iCalendar generation tests
node --test tests/ics.test.js

# Run security hardening & audit tests
node --test tests/security-hardening.test.js
```

### 2.3 Running Full Browser End-to-End Regression
```bash
node scripts/system-regression.js
```

---

## 3. Test Suites Directory & Coverage Matrix

| Test Suite File | Domain / Subsystem | Key Scenarios Covered |
| :--- | :--- | :--- |
| `tests/auth.test.js` | Authentication & Sessions | Login validation, bcrypt verification, session fixation prevention, logout |
| `tests/rbac.test.js` | Role-Based Access Control | Endpoint privilege enforcement (Admin, Coordinator, Viewer) |
| `tests/constraints.test.js` | Database Invariants | GiST exclusion `no_double_booking`, buffer overlap, draft invitation coexistence |
| `tests/judges.test.js` | Evaluator Roster | CRUD operations, case-insensitive email uniqueness, future assignment deactivation guards |
| `tests/invitations.test.js` | Invitation Lifecycle | Single/bulk invite, duplicate live invitation 409 rejection, token generation |
| `tests/outbox-producer.test.js` | Outbox Producer | Transactional insertion into `notification_outbox`, idempotency deduplication |
| `tests/magic-link.test.js` | Judge Response Portal | Single-use token resolution, temporal expiration (410), rate limiting (429) |
| `tests/coi.test.js` | Blinded Conflicts | Conflict declarations, blinding guarantees, SQL table immutability (42501) |
| `tests/availability.test.js` | Availability Windows | Time-slot submissions, chronological validation, 24h replacement policy |
| `tests/assignments.test.js` | Session Assignments | Admin assignments, role updates, double-booking rejection, soft deletion |
| `tests/attendance.test.js` | Festival Attendance | On-time check-in, late arrival penalty, early checkout flag, absent sweep |
| `tests/replacement.test.js` | Replacement Chaining | Candidate suggestions, replacement chaining, 10-minute undo cancellation window |
| `tests/coverage.test.js` | Staffing & Feasibility | Required vs confirmed rollup, missing head judge detection, peak interval sweep |
| `tests/dashboard.test.js` | Materialized Views & KPIs | `mv_session_coverage`, `mv_judge_workload`, force refresh trigger, 13 KPI metrics |
| `tests/ics.test.js` | RFC 5545 iCalendar | Calendar generation, UTC formatting, CRLF injection sanitization, line folding |
| `tests/outbox-worker.test.js` | SMTP Worker | `SKIP LOCKED` concurrency, template rendering, exponential backoff, delivery logging |
| `tests/reminders.test.js` | Scheduled Sweeps | Pending invitation sweep, 24-hour assignment reminder, coordinator late alerts |
| `tests/security-hardening.test.js` | Hardening & Audit | Password rotation, universal session invalidation, `X-Request-Id`, audit viewer RBAC |

---

## 4. Current Test Results

As of Phase 4 completion, **136 of 136 tests pass cleanly with 0 skips and 0 failures**:

```text
✔ 136 tests passing
✔ 0 tests failing
✔ 0 tests skipped
✔ Duration: ~65s (serial execution across 18 test suites)
```
