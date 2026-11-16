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
