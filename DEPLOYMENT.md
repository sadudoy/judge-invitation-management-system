# CSE Fest — Production Deployment Guide
## Judge Invitation & Assignment Management System

This guide outlines production provisioning, configuration, environment security, database migration, worker orchestration, and maintenance procedures for the **CSE Fest Judge Invitation & Assignment Management System**.

---

## 1. System Requirements

- **Operating System**: Linux (Ubuntu 22.04 LTS / Debian 12 / RHEL 9 recommended) or Windows Server 2022+
- **Runtime Environment**: Node.js `v20.x` LTS or `v22.x` LTS
- **Package Manager**: npm `v10.x` or higher
- **Database Engine**: PostgreSQL `v15+` (PostgreSQL 16 or 18 recommended) with `btree_gist` extension enabled
- **Mail Server**: SMTP relay (SendGrid, Mailgun, Amazon SES, Postmark, or university SMTP gateway)
- **Reverse Proxy**: Nginx or Caddy with automated Let's Encrypt TLS / SSL certificates

---

## 2. Production Environment Variables (`.env`)

In production, create a `.env` file with restrictive permissions (`chmod 600 .env`) owned by the application service user.

```ini
# Node Environment
NODE_ENV=production
PORT=3000
APP_BASE_URL=https://judges.csefest.edu

# Database Connection (percent-encode special characters in password)
DATABASE_URL=postgres://csefest_app:STRONG_ENCODED_PASSWORD@127.0.0.1:5432/csefest_prod?sslmode=prefer

# Session Security (Minimum 64 random hex characters)
# Generate via: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=c8e7b39f1a0e4b8d7c2a5e9f3b1d0c8a7e6f5d4c3b2a1e0f9d8c7b6a5e4f3d2c

# Password Hashing Cost Factor (Default: 12)
BCRYPT_COST=12

# Background Workers (Set to 'on' to activate outbox delivery & scheduled reminders)
OUTBOX_WORKER=on

# SMTP Outbox Delivery Configuration
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=postmaster@csefest.edu
SMTP_PASS=production-smtp-secret-key
EMAIL_FROM="CSE Fest Organizing Committee" <no-reply@csefest.edu>
```

> [!WARNING]
> Never commit `.env` or production credentials to source control. Ensure `.gitignore` ignores `.env`.

---

## 3. Database Provisioning & Migration

### 3.1 Initial Setup (PostgreSQL Superuser)
Execute once as the `postgres` superuser on your database host:

```sql
-- 1. Create dedicated application role
CREATE ROLE csefest_app WITH LOGIN PASSWORD 'YOUR_STRONG_PASSWORD';

-- 2. Create production database
CREATE DATABASE csefest_prod OWNER csefest_app;

-- 3. Connect to database and enable btree_gist
\c csefest_prod
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 4. Grant schema permissions
GRANT ALL ON SCHEMA public TO csefest_app;
```

### 3.2 Running Schema Migrations
Execute database migrations using the idempotent Node.js migration runner:

```bash
# Run all pending migrations (001 through 007)
npm run migrate

# Check migration status
npm run migrate:status
```

> [!CAUTION]
> **DO NOT RUN `npm run seed` in production.** The seed script truncates all tables and resets sequences. Production accounts must be initialized via secure administrator bootstrap scripts.

---

## 4. Background Workers Architecture

The platform architecture cleanly decouples HTTP endpoints from asynchronous workers:

1. **Transactional Outbox Producer**:
   API endpoints (e.g., `POST /api/invitations`, `POST /api/assignments/:id/replace`) insert rows into `notification_outbox` in the same database transaction as the business operation.
2. **Outbox Worker (`server/worker/outbox.js`)**:
   Polls pending notifications using concurrency-safe `SELECT ... FOR UPDATE SKIP LOCKED`, generates RFC 5545 `.ics` calendar files, renders HTML/text templates, dispatches emails over SMTP, and applies exponential backoff ($2^{\text{attempts}} \times 30\text{s}$) on failure.
3. **Automated Reminders Worker (`server/worker/reminders.js`)**:
   Sweeps pending invitations (3–4 days before deadline), upcoming confirmed sessions (24 hours prior), and coordinator late alerts, enqueuing deterministic messages with unique idempotency keys.
4. **Execution Control**:
   Workers start if and only if `OUTBOX_WORKER=on`. In clustered deployments, workers can run alongside the main web process or on a dedicated worker instance.

---

## 5. Reverse Proxy Configuration (Nginx)

Place Nginx in front of Node.js to handle TLS termination, request rate limiting, and static asset delivery:

```nginx
server {
    listen 80;
    server_name judges.csefest.edu;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name judges.csefest.edu;

    ssl_certificate /etc/letsencrypt/live/judges.csefest.edu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/judges.csefest.edu/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Security Headers
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    # Static Client Assets
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 6. Process Management (systemd)

Create a systemd unit file at `/etc/systemd/system/csefest-judges.service`:

```ini
[Unit]
Description=CSE Fest Judge Invitation & Assignment Management System
After=network.target postgresql.service

[Service]
Type=simple
User=csefest
WorkingDirectory=/opt/csefest-judges
EnvironmentFile=/opt/csefest-judges/.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=csefest-judges

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable csefest-judges
sudo systemctl start csefest-judges
sudo systemctl status csefest-judges
```

---

## 7. Backup & Maintenance

### 7.1 Automated Daily Database Backups
```bash
#!/bin/bash
BACKUP_DIR="/var/backups/csefest"
DATE=$(date +\%Y\%m\%d_\%H\%M\%S)
mkdir -p "$BACKUP_DIR"

PGPASSWORD="YOUR_PASSWORD" pg_dump -h 127.0.0.1 -U csefest_app -d csefest_prod -F c -b -v -f "$BACKUP_DIR/csefest_$DATE.dump"

# Retain backups for 30 days
find "$BACKUP_DIR" -type f -name "*.dump" -mtime +30 -delete
```

### 7.2 Materialized View Refresh
The platform automatically debounces view refreshes via database triggers. If manual maintenance is required:
```sql
SELECT refresh_mv_dashboard_force();
```
