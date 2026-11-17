# CSE Fest — Judge Invitation & Assignment Management System
## Security Architecture & Threat Mitigations (Phase 1)

### 1. Mandatory Bootstrap & Credential Disclosures

#### 1.1 Local Bootstrap Superuser Password
- The local PostgreSQL superuser account (`postgres`) password was used **exclusively** during initial environment provisioning to create the dedicated unprivileged application role (`csefest_app`) and the respective development and test databases (`csefest_dev` and `csefest_test`).
- The superuser password is **NOT** present in any codebase file, migration, seed, script, or configuration tracked in this repository.
- Verification command: grep for the superuser password pattern returns no occurrences.

#### 1.2 Database URL Password Encoding Caveat
- In connection URIs (such as `DATABASE_URL` and `DATABASE_URL_TEST`), any password containing special characters **must be percent-encoded**.
- In particular, the literal `@` symbol must be written as `%40` (e.g., `p@ssword` -> `p%40ssword`). Unencoded `@` characters corrupt the URI parsing logic, causing PostgreSQL clients to mistake the password for the hostname.

---

### 2. Implemented Security Controls (Phase 1)

#### 2.1 Password Hashing
- Administrative passwords are never stored in plaintext.
- User passwords are processed using `bcrypt` with a minimum cost factor of 12 (`BCRYPT_COST=12`).
- Dynamic runtime salting prevents rainbow table attacks.

#### 2.2 Session Security
- Sessions are managed by `express-session` with a PostgreSQL backing store (`connect-pg-simple`).
- Cookie settings enforce:
  - `httpOnly: true`: Prevents client-side JavaScript access via DOM (mitigating session theft via XSS).
  - `sameSite: 'lax'`: Provides CSRF mitigation for standard top-level cross-site navigations.
  - `secure: true` in production: Enforces transmission only over TLS (HTTPS).
  - Session secrets must be at least 64 hex characters generated via cryptographically secure pseudo-random number generators (`crypto.randomBytes(32).toString('hex')`).
  - Session Fixation Mitigation: Upon successful login, the existing session ID is regenerated via `req.session.regenerate()`.

#### 2.3 SQL Injection Defense
- Strict parameterization (`$1`, `$2`, ...) is enforced across all queries in application code.
- Dynamic string concatenation for SQL queries is prohibited.

#### 2.4 HTTP Hardening via Helmet
- `helmet()` middleware sets standard security headers:
  - `Content-Security-Policy`: Restricts script and resource origins.
  - `X-Frame-Options: SAMEORIGIN`: Defends against clickjacking.
  - `X-Content-Type-Options: nosniff`: Prevents MIME-type sniffing.
  - `Strict-Transport-Security` (HSTS): Enforces HTTPS connections.

#### 2.5 Audit Trails & Database Privilege Revocation
- **Immutable Conflict Declarations**: To prevent post-facto tampering with declared academic conflicts of interest, `UPDATE` and `DELETE` privileges on `judge_conflicts` have been explicitly revoked from the application role (`REVOKE UPDATE, DELETE ON judge_conflicts FROM csefest_app, PUBLIC;`). Any tampering attempt fails immediately with SQLSTATE `42501` (`insufficient_privilege`).
- **Audit Logging**: DML operations on operational tables (`events`, `sessions`, `judges`, `users`, `judge_invitations`, `judge_assignments`) trigger the `audit_row` procedure, writing snapshots of pre- and post-modification data into the `audit_log` table.

---

### 3. Deferred Security Items (Phases 2–4)

The following security enhancements are intentionally scoped for subsequent project phases:
1. **Row-Level Security (RLS)**: PostgreSQL RLS policies isolating multi-tenant departments or restricting future judge self-service rows to authenticated judge tokens.
2. **Double-Submit CSRF Tokens**: Implementation of explicit CSRF verification tokens (e.g. `csurf` or double-submit cookies) for state-changing endpoints in client forms.
3. **Rate Limiting**: Rate-limiting middleware (`express-rate-limit`) on `/api/auth/login` to thwart brute-force password guessing and credential stuffing.
4. **Self-Service Password Reset Flows**: Tokenized, expiring email-based password reset workflows with rate limits and cryptographic outbox delivery.

*Note: RBAC negative-path tests were added in Phase 1 repair pass.*


---

### 4. Phase 2 Security Controls & Threat Mitigations

#### 4.1 Magic Link Token Cryptography & Threat Model
Judges are external academic/industry evaluators and do not hold persistent user accounts or passwords. Access to evaluation response portals is governed exclusively via cryptographically secure magic links:

1. **High-Entropy Generation**:
   - Generated using `crypto.randomBytes(32).toString('base64url')`, providing 256 bits of cryptographic entropy.
   - Brute-force guessing attacks are computationally infeasible ($2^{256}$ search space).

2. **Storage Hashed at Rest**:
   - The raw token is **never stored** in the database.
   - Only its cryptographic SHA-256 hash (`crypto.createHash('sha256').update(rawToken).digest('hex')`) is persisted in `auth_tokens.token_hash`.
   - A database compromise or read-only SQL injection cannot leak usable magic links.

3. **Constant-Time Verification**:
   - Token lookup resolves the SHA-256 hash, and sensitive comparison functions utilize `crypto.timingSafeEqual` to prevent side-channel timing attacks.

4. **Temporal Expiration**:
   - Every token carries a hard expiration timestamp (`expires_at`, default: 72 hours).
   - Once expired, `/j/:token` and `/api/j/:token/*` return `410 Gone` and reject state mutations.

5. **Single-Use Consumption & Replay Prevention**:
   - When an evaluator submits an RSVP response (`POST /api/j/:token/respond`), the token's `used_at` timestamp is atomically marked (`used_at = NOW()`).
   - Subsequent calls or replay attempts are rejected with `409 Conflict`.
   - Read-only actions (such as `GET /j/:token` or `POST /api/j/:token/view`) leave `used_at` null so judges can review event context.

6. **Token Disclosure Boundary (Production Hardening)**:
   - In development/test mode (`NODE_ENV !== 'production'`), the raw token and magic link URL are included in the invitation creation response to facilitate local verification.
   - In production (`NODE_ENV === 'production'`), `magicLinkUrl` and `rawToken` are **strictly omitted** from API JSON payloads and exist solely inside the encrypted outbox notification message dispatched to the judge's email address.

7. **Rate Limiting**:
   - Public magic link resolution and response endpoints are guarded by sliding-window rate limiters (60 requests per minute per IP), setting `X-RateLimit-*` headers and returning `429 Too Many Requests` on abuse.

#### 4.2 Blinded Conflict Declarations & Anti-Tampering
- **Strict Blinding Guarantee**: Evaluators are asked to declare potential conflicts of interest via free-text inputs (`subject_name`, `subject_kind`, `description`, `severity`). The API never queries, leaks, or exposes student contestant names, team IDs, or participant rosters.
- **Append-Only Immutability with Predecessor Pointers**:
  - `UPDATE` and `DELETE` on content columns of `judge_conflicts` remain strictly revoked from `csefest_app` and `PUBLIC` (SQLSTATE `42501`).
  - To allow evaluators to revise earlier declarations, PostgreSQL column-level permission `GRANT UPDATE (superseded_by) ON judge_conflicts TO csefest_app` was applied in Migration 005. New declarations insert new rows and point the predecessor's `superseded_by` column to the new row ID.

---

### 5. Phase 3 Security Controls & Scheduling Integrity

#### 5.1 DB-Level Exclusion Constraint vs. TOCTOU Race Conditions
- Application-level overlap checks (`SELECT count(*) ...` followed by `INSERT`) are vulnerable to concurrency race conditions (Time-of-Check to Time-of-Use).
- Phase 3 enforces temporal non-overlap strictly via the PostgreSQL GiST exclusion constraint `no_double_booking` on `(judge_id WITH =, assignment_window WITH &&) WHERE (status <> 'cancelled'::assignment_status_enum)`.
- Race condition exploits between concurrent admin scheduling requests are physically impossible at the database engine level; concurrent clashing transactions receive SQLSTATE `23P01` (`exclusion_violation`).

#### 5.2 Token-to-Judge Identity Binding (403 Forbidden Defense)
- In the judge portal, endpoints such as `POST /api/j/:token/assignment/:assignment_id/respond`, `POST /api/j/:token/checkin`, and `POST /api/j/:token/checkout` perform strict identity verification:
  - The token's resolved `judge_id` must match `judge_assignments.judge_id`.
  - If a token issued to Judge A is replayed against an assignment belonging to Judge B, the server immediately rejects the request with HTTP `403 Forbidden` (`Forbidden: token does not match the judge assigned to this session`).
  - If the token was created specifically for a given `assignment_id` (`auth_tokens.assignment_id IS NOT NULL`), any attempt to use it on a different assignment is rejected with `403 Forbidden`.

#### 5.3 Single-Use Replay Prevention on Assignment Tokens
- Assignment magic link tokens enforce single-use consumption (`used_at = NOW()`).
- Attempting to replay an accept or decline submission returns HTTP `409 Conflict`.
- Expired tokens (`expires_at < NOW()`) reject state mutations with HTTP `410 Gone`.

#### 5.4 Tamper-Evident Audit Logging for Overrides and Attendance Corrections
- Administrative overrides (`POST /api/assignments/:id/confirm`) and manual attendance adjustments (`PATCH /api/assignments/:id/attendance`) cannot occur silently.
- Both operations execute inside PostgreSQL transactions that write an immutable row to `audit_log`, capturing the operator's `actor_id`, `action` (`UPDATE`), timestamp, previous values, and the mandatory administrative justification string (`reason` or `notes`).

#### 5.5 10-Minute Replacement Cancellation Window Security Boundary
- The replacement undo action (`POST /api/assignments/:id/cancel-replacement`) enforces a strict 10-minute temporal boundary:
  $$\text{Age} = \text{NOW}() - \text{created\_at} \le 10\,\text{minutes}$$
- Once the window has elapsed, the cancellation is rejected with `409 Conflict`. This prevents historical tampering or retroactively invalidating published schedules after notifications have been sent to substitute judges.


---

### 6. Phase 4 Security Hardening & Background Worker Isolation

#### 6.1 In-Memory Rate Limiter Rationale & Memory Characteristics
- **Architecture**: The sliding-window rate limiter implemented in `server/middleware/rate-limiter.js` tracks request counters in process memory per IP address (`Map<string, { count, resetTime }>`).
- **Rationale**: For an academic festival administration platform operating on single-instance nodes or container pods, an in-memory token bucket/sliding window delivers sub-millisecond execution without the operational overhead or network latency of an external Redis cache.
- **Memory Footprint & Cleanup**:
  - The map key is an IPv4/IPv6 string (approx. 16–45 bytes), and the record holds two numbers (`count` and `resetTime`, 16 bytes).
  - Even under an active scanning event with 50,000 distinct IPs, the total memory consumed is less than 5 MB.
  - An automatic periodic pruning routine sweeps the cache every window interval ($T = 60\text{s}$) to purge expired IP buckets, guaranteeing $O(1)$ amortized memory usage and preventing unbounded memory growth.

#### 6.2 CSRF Protection Rationale: SameSite=Lax & Origin Validation
- **Defense-in-Depth Architecture**:
  - Modern browsers respect `SameSite=Lax` on session cookies (`connect.sid`). Cross-site requests initiated by third-party origins (such as `POST`, `PUT`, `DELETE` via `fetch` or form submission) do not attach the session cookie.
  - The administration portal API accepts JSON payloads exclusively (`Content-Type: application/json`), which triggers browser CORS preflight checks (`OPTIONS`) on any cross-origin attempt. Cross-origin sites cannot forge state-changing JSON API calls without triggering CORS blocks.
  - The judge portal interacts exclusively via single-use cryptographically random magic link tokens; tokens are bound to specific actions and cannot be forged by third parties.
- **Explicit CSRF Token Tokenization**: Classical CSRF token forms (such as `csurf`) were intentionally omitted to maintain stateless JSON APIs and avoid synchronizer token storage overhead, given that the combination of `SameSite=Lax`, strict `Content-Type: application/json` enforcement, and CORS isolation provides airtight CSRF protection.

#### 6.3 Password Rotation & Universal Session Revocation
- **Endpoint**: `POST /api/auth/password` allows authenticated administrators to update their password.
- **Policy**:
  - Requires `current_password` verification using `bcrypt.compare`.
  - Enforces minimum 8-character length for `new_password`.
  - Re-hashes using `bcrypt` with cost factor 12.
- **Universal Session Revocation**:
  - When an account password is changed, the server issues an atomic SQL deletion on the session store:
    `DELETE FROM session WHERE sess->'user'->>'id' = $1::text;`
  - This immediately terminates all active sessions across all devices, browsers, and mobile devices associated with the compromised or rotated account, defending against stolen persistent session cookies.

#### 6.4 Production Error Sanitization & Correlation Tracing
- **X-Request-Id Tracing**: Every inbound HTTP request is assigned a UUID correlation ID (`req.headers['x-request-id'] || crypto.randomUUID()`), echoed in the response header `X-Request-Id`.
- **Zero Information Leakage**:
  - In `production` mode, unhandled 500 exceptions return `{ "error": "Internal Server Error", "requestId": "..." }`.
  - Database schema details, SQL syntax errors, file paths, and internal stack traces are completely masked from clients and logged exclusively to server logs tagged with the matching `requestId`.

#### 6.5 Helmet HSTS Production Restriction
- `helmet({ hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false })`
- Restricting HTTP Strict Transport Security (HSTS) strictly to production prevents developers or test environments running on `http://localhost` from having their browsers permanently force HTTPS redirects onto local testing ports.

#### 6.6 Concurrency Safety in Outbox Worker (`SKIP LOCKED`)
- The outbox worker selects pending notifications using:
  `SELECT ... FROM notification_outbox WHERE status = 'pending' AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT 10 FOR UPDATE SKIP LOCKED;`
- In multi-instance deployments, `SKIP LOCKED` guarantees that no two workers ever acquire or process the same notification row simultaneously, eliminating duplicate email deliveries.

#### 6.7 CRLF Sanitization in RFC 5545 iCalendar Generation
- The calendar generator (`server/lib/ics.js`) strips carriage return (`\r`) and newline (`\n`) characters from event titles, descriptions, venue locations, and organizer/attendee names prior to assembling the `.ics` payload.
- This neutralizes CRLF injection attacks that could otherwise inject rogue VEVENT fields or forged calendar invites.
