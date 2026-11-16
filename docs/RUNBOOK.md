# CSE Fest — Judge Invitation & Assignment Management System
## Runbook & Operations Guide (Phase 1)

### 1. Prerequisites
- **Node.js**: `v20.0.0` or higher (verified with `v25.9.0`)
- **PostgreSQL**: `15+` (verified with PostgreSQL `18.4`)
- **Git**
- **Shell**: PowerShell (Windows) or bash/zsh (Linux/macOS)

---

### 2. Environment Configuration & Database Bootstrap

#### Step 2.1: Bootstrap Dedicated PostgreSQL Role and Databases
Do not run the application under the Postgres superuser. Connect locally using your Postgres superuser (e.g. `psql -U postgres`) and run:

```sql
CREATE ROLE csefest_app LOGIN PASSWORD 'change-me-in-env';
CREATE DATABASE csefest_dev OWNER csefest_app;
CREATE DATABASE csefest_test OWNER csefest_app;
GRANT ALL PRIVILEGES ON DATABASE csefest_dev TO csefest_app;
GRANT ALL PRIVILEGES ON DATABASE csefest_test TO csefest_app;
```

#### Step 2.2: Configure `.env`
In `.env` (or copy from `.env.example`):
```ini
NODE_ENV=development
PORT=3000
SESSION_SECRET=<generate-64-hex-chars-via-node-crypto>
DATABASE_URL=postgresql://csefest_app:change-me-in-env@localhost:5432/csefest_dev
DATABASE_URL_TEST=postgresql://csefest_app:change-me-in-env@localhost:5432/csefest_test
BCRYPT_COST=12
```

> **Security Note**: If your database password contains special characters such as `@`, `#`, or `/`, percent-encode them inside the connection URI (e.g. `@` becomes `%40`).

---

### 3. Installation & Database Setup

Navigate to the project root directory:
```powershell
npm install
```

#### Step 3.1: Execute Database Migrations
Run the transactional migration runner:
```powershell
npm run migrate
```
*Expected Output:*
```
Applying migration: 001_schema.sql...
  ✓ 001_schema.sql applied successfully.
Applying migration: 002_triggers.sql...
  ✓ 002_triggers.sql applied successfully.
Applying migration: 003_session_store.sql...
  ✓ 003_session_store.sql applied successfully.
Successfully applied 3 migration(s).
```

#### Step 3.2: Inspect Migration Status
```powershell
npm run migrate:status
```
*Expected Output:*
```
Migration Status:
┌─────────┬─────────────────────────┬───────────┬────────────────────────────┐
│ (index) │ Migration               │ Status    │ Applied At                 │
├─────────┼─────────────────────────┼───────────┼────────────────────────────┤
│ 0       │ '001_schema.sql'        │ 'Applied' │ '...'                      │
│ 1       │ '002_triggers.sql'      │ 'Applied' │ '...'                      │
│ 2       │ '003_session_store.sql' │ 'Applied' │ '...'                      │
└─────────┴─────────────────────────┴───────────┴────────────────────────────┘
```

#### Step 3.3: Seed Demo Data & Administrative Accounts
```powershell
npm run seed
```
*Expected Output:*
```
Seeding database structure and reference data...
  ✓ Base seed SQL executed.
  ✓ Inserted 2 users with bcrypt cost 12 (email: admin@csefest.edu, coordinator@csefest.edu).
Database seeding completed successfully.
```

---

### 4. Running the Application

#### Start in Production / Standard Mode:
```powershell
npm start
```

#### Start in Watch / Development Mode:
```powershell
npm run dev
```

The application will bind to `http://localhost:3000`.

#### Test `/health` Endpoint:
```powershell
curl -i http://localhost:3000/health
```
*Expected Response (`200 OK`):*
```json
{
  "status": "ok",
  "db": "ok",
  "timestamp": "2026-11-16T15:50:04.443Z",
  "uptime": 22.75
}
```

---

### 5. Running Automated Tests

Run the full test suite (backed by `node:test` and `supertest` against `DATABASE_URL_TEST`):
```powershell
npm test
```

The test runner will execute:
- `tests/health.test.js`: Verifies `/health` endpoint and database connectivity.
- `tests/auth.test.js`: Verifies login success, bad credentials, session retrieval (`/me`), logout, and post-logout 401.
- `tests/constraints.test.js`: Provably tests `23P01` double-booking exclusion, `23505` duplicate live invitations, `42501` conflict table immutability, adjacent session acceptance, buffer collisions, and session move triggers inside rolled-back transactions.

---

### 6. Operational Troubleshooting

| Symptom | Cause | Resolution |
|---|---|---|
| `EADDRINUSE: 3000` | Port 3000 is occupied by an existing process. | Identify the process using `Get-Process` or `netstat -ano \| findstr :3000` and terminate it, or change `PORT=3001` in `.env`. |
| `ECONNREFUSED 127.0.0.1:5432` | Local PostgreSQL service is stopped. | Start the service via `Start-Service postgresql*` or Windows Services console. |
| `password authentication failed` | Credentials in `DATABASE_URL` do not match PostgreSQL role. | Verify the username and password in `DATABASE_URL`. Ensure special characters (e.g. `@`) are percent-encoded (`%40`). |
| `ERROR: permission denied for table judge_conflicts` | Attempted `UPDATE` or `DELETE` on `judge_conflicts`. | Expected behavior! `judge_conflicts` is immutable. If a conflict was logged in error, document an offsetting administrative note or consult the database superuser. |
| `ERROR: conflicting key value violates exclusion constraint "no_double_booking"` | An assignment overlaps with another session assigned to the same judge. | Assign a different judge or adjust session start/end/buffer times. |
