# CSE Fest — Judge Invitation & Assignment Management System
## Architecture Documentation (Phase 1)

### 1. System Overview
The **CSE Fest Judge Invitation & Assignment Management System** is a university-grade event coordination platform designed to eliminate scheduling conflicts, prevent judge double-booking, manage formal invitations, and record conflicts of interest during academic and competitive collegiate festivals (e.g., Hackathons, ICPC contests, Project Expositions, Robotics Tournaments).

Phase 1 establishes the rock-solid PostgreSQL schema, mathematical temporal constraints, automated window-synchronization triggers, migration infrastructure, seed engine, security layer, and an Express authentication backend with an accessible vanilla administrator console.

---

### 2. Architectural Boundaries & Phase Scope
The system follows a strict staged delivery lifecycle:

- **Phase 1 (Current): Core Infrastructure & Admin Auth**
  - Schema definition for 17 relational tables with `TIMESTAMPTZ` timezone-aware temporal integrity.
  - PostgreSQL exclusion constraints (`EXCLUDE USING gist`) and partial unique indexes.
  - Triggers for automatic assignment window computation, session resync, and row-level auditing.
  - Pure SQL migration runner with transactional execution and `--status` inspection.
  - Dynamic bcrypt seeding for administrative roles.
  - Express server with Helmet security headers, session-based authentication backed by PostgreSQL (`connect-pg-simple`), and health monitoring.
  - Accessible, responsive vanilla HTML/CSS/JS administrator sign-in and console.
- **Phase 2 (Deferred): Judge Roster & Invitation Engine**
  - Judge profile self-management, tokenized email invitations, magic links, RSVP endpoints, and outbox delivery dispatchers.
- **Phase 3 (Deferred): Automated Scheduling & Assignment Engine**
  - Conflict-free automated judge-to-session scheduling, availability matching, and workload balancing.
- **Phase 4 (Deferred): Live Operations & Scoring**
  - Session check-in, real-time rubric scoring, audit exports, and certificate generation.

---

### 3. Repository Directory Structure
```
.                               # Project Root
├── client/                     # Static vanilla frontend assets
│   ├── app.js                  # Client logic, session checking, auth fetch
│   ├── index.html              # Accessible admin login & dashboard UI
│   └── style.css               # Fest-themed responsive styling & contrast tokens
├── database/                   # Database migrations, runner, and seeds
│   ├── migrations/
│   │   ├── 001_schema.sql      # Core tables, enums, indexes, constraints
│   │   ├── 002_triggers.sql    # Trigger functions: set_window, resync, audit
│   │   └── 003_session_store.sql# connect-pg-simple session table
│   ├── migrate.js              # Transactional migration runner with --status
│   ├── seed.js                 # Dynamic bcrypt seeder script
│   └── seed.sql                # Reference festival dataset (demo only)
├── docs/                       # Project documentation
│   ├── ARCHITECTURE.md         # System structure and architectural design
│   ├── RUNBOOK.md              # Setup, operations, and troubleshooting guide
│   ├── SCHEMA.md               # Detailed schema, constraints, and trigger guide
│   └── SECURITY.md             # Security architecture and threat mitigations
├── server/                     # Node.js / Express backend
│   ├── middleware/
│   │   └── auth.js             # requireAuth and requireRole middleware
│   ├── routes/
│   │   └── auth.js             # Login, logout, and /api/auth/me endpoints
│   ├── app.js                  # Express app factory with Helmet & sessions
│   ├── config.js               # Environment config validation & parsing
│   ├── db.js                   # node-postgres Pool wrapper with query logging
│   └── index.js                # Server entrypoint and graceful shutdown
├── tests/                      # Automated test suite (node:test + supertest)
│   ├── helpers/
│   │   └── db.js               # Fresh test DB runner and rollback harness
│   ├── auth.test.js            # Auth lifecycle and session tests
│   ├── constraints.test.js     # Exclusion, unique, and privilege tests
│   └── health.test.js          # /health verification test
├── .env.example                # Environment variable template
├── .gitignore                  # Git ignore rules (protects credentials)
├── package.json                # Dependencies, engines, and scripts
├── PROJECT_STATUS.md           # Implementation status and roadmap tracking
└── README.md                   # Quickstart guide
```

---

### 4. Component Architecture & Data Flow

```
+-------------------------------------------------------------------------+
|                              Web Browser                                |
|  [Admin Login Form]  <--->  [Vanilla JS client/app.js]  <---> [Dashboard]|
+-------------------------------------------------------------------------+
                                    |
                    HTTP / HTTPS + SameSite Cookies
                                    v
+-------------------------------------------------------------------------+
|                          Express Application                            |
|                                                                         |
|  [Helmet Security Headers]                                              |
|  [express-session + connect-pg-simple Session Store]                     |
|  [Auth Middleware (requireAuth, requireRole)]                           |
|                                                                         |
|  Routes:                                                                |
|    - GET  /health           (Database connectivity & uptime)             |
|    - POST /api/auth/login   (Bcrypt verification & session regeneration)|
|    - POST /api/auth/logout  (Session destruction & cookie clear)        |
|    - GET  /api/auth/me      (Session user inspection)                   |
|    - GET  /*                (Static assets: index.html, css, js)        |
+-------------------------------------------------------------------------+
                                    |
                       Parameterized SQL Queries
                                    v
+-------------------------------------------------------------------------+
|                         PostgreSQL 18 Database                          |
|                                                                         |
|  Operational Tables:                                                    |
|    events, venues, competitions, sessions, judges, users, auth_tokens,   |
|    judge_invitations, invitation_responses, judge_availability,         |
|    judge_conflicts, judge_assignments, assignment_responses,            |
|    assignment_attendance, notification_outbox, notification_deliveries, |
|    audit_log, session                                                   |
|                                                                         |
|  Integrity Engines:                                                     |
|    - btree_gist extension                                               |
|    - no_double_booking EXCLUDE constraint                               |
|    - uq_invitation_live partial unique index                            |
|    - Immutable conflicts via SQL privilege revocation                   |
|    - set_assignment_window & resync_assignments triggers                |
+-------------------------------------------------------------------------+
```

---

### 5. Architectural Invariants
1. **Database as Single Source of Truth for Invariants**: Application logic can fail or experience race conditions under high concurrent load; therefore, scheduling exclusivity and duplicate prevention are guaranteed at the database engine level via GiST exclusion constraints and partial unique indexes.
2. **Deterministic Time Handling**: All temporal coordinates are stored in `TIMESTAMPTZ` (UTC internally), with calculations handling local event timezones (default: `Asia/Dhaka`).
3. **Defense-in-Depth Authentication**: Passwords hashed with high-cost bcrypt (cost 12), sessions stored in PostgreSQL with `httpOnly`, `sameSite: 'lax'`, and session regeneration on privilege elevation to prevent fixation attacks.
