# CSE Fest — Judge Invitation & Assignment Management System

A PostgreSQL-backed web platform for university festival administrators to manage judge invitations, prevent scheduling double-booking through mathematical database constraints, and record conflicts of interest.

---

## Quickstart

### Prerequisites
- Node.js 20+
- PostgreSQL 15+ running on `localhost:5432`

### Setup Steps
1. **Clone repository and configure environment:**
   ```powershell
   cp .env.example .env
   # Edit .env with your PostgreSQL credentials
   ```

2. **Install dependencies:**
   ```powershell
   npm install
   ```

3. **Run database migrations:**
   ```powershell
   npm run migrate
   npm run migrate:status
   ```

4. **Seed reference data & admin accounts:**
   ```powershell
   npm run seed
   ```

5. **Run automated test suite:**
   ```powershell
   npm test
   ```

6. **Start development server:**
   ```powershell
   npm start
   ```
   Open `http://localhost:3000` in your browser.

---

## Seed Accounts
- **Administrator**: `admin@csefest.edu` / `ChangeMe123!`
- **Coordinator**: `coordinator@csefest.edu` / `ChangeMe123!`

---

## Documentation
- [Architecture & Design](docs/ARCHITECTURE.md)
- [Database Schema & Constraints](docs/SCHEMA.md)
- [Operations & Runbook](docs/RUNBOOK.md)
- [Security Architecture](docs/SECURITY.md)
- [Project Status](PROJECT_STATUS.md)
