'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const config = require('./config');
const db = require('./db');
const authRouter = require('./routes/auth');
const judgesRouter = require('./routes/judges');
const invitationsRouter = require('./routes/invitations');
const competitionsRouter = require('./routes/competitions');
const judgePortalRouter = require('./routes/judge-portal');
const assignmentsRouter = require('./routes/assignments');
const coverageRouter = require('./routes/coverage');
const dashboardRouter = require('./routes/dashboard');
const auditRouter = require('./routes/audit');
const { requireAuth, requireRole } = require('./middleware/auth');

function createApp(options = {}) {
  const app = express();

  // Request Correlation ID Middleware (X-Request-Id)
  app.use((req, res, next) => {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  });

  // Security Headers via Helmet (HSTS strictly restricted to production)
  app.use(
    helmet({
      hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"], // Allow simple inline style or CSS custom properties
          imgSrc: ["'self'", 'data:'],
        },
      },
    })
  );

  // Body Parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Session Middleware with PostgreSQL persistence
  const sessionStore = options.sessionStore || new PgSession({
    pool: db.pool,
    tableName: 'session',
    createTableIfMissing: false,
  });

  app.use(
    session({
      store: sessionStore,
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      name: 'connect.sid',
      cookie: {
        httpOnly: true,
        secure: config.isProduction, // HTTPS in production
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      },
    })
  );

  // Health Endpoint: returns 200 with db:"ok"
  app.get('/health', async (req, res, next) => {
    try {
      const dbCheck = await db.query('SELECT 1 AS ok;');
      const isDbOk = dbCheck && dbCheck.rows && dbCheck.rows[0].ok === 1;

      return res.status(200).json({
        status: 'ok',
        db: isDbOk ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    } catch (err) {
      return res.status(503).json({
        status: 'error',
        db: 'unreachable',
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Auth API routes
  app.use('/api/auth', authRouter);

  // Phase 2 API routes
  app.use('/api/judges', judgesRouter);
  app.use('/api/invitations', invitationsRouter);
  app.use('/api/competitions', competitionsRouter);
  app.use('/', judgePortalRouter);

  // Phase 3 API routes
  app.use('/api/assignments', assignmentsRouter);
  app.use('/api', coverageRouter);

  // Phase 4 API routes
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/audit', auditRouter);

  // RBAC proof route (Admin-only stub for Phase 1 verification)
  app.get('/api/admin/only', requireAuth, requireRole('admin'), (req, res) => {
    res.status(200).json({ ok: true });
  });

  // Static Assets (Client UI)
  const clientDir = path.join(__dirname, '..', 'client');
  app.use(express.static(clientDir));

  // Central 404 Handler for API
  app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // Central Error Handler with Correlation ID and Production Stack Masking
  app.use((err, req, res, next) => {
    const requestId = req.id || (res.getHeader && res.getHeader('X-Request-Id')) || null;
    if (!config.isTest) {
      console.error(`[${requestId || 'REQ'}] Unhandled Server Error:`, err);
    }

    const statusCode = err.status || err.statusCode || 500;
    const isProdInternal = config.isProduction && statusCode === 500;
    const message = isProdInternal
      ? 'Internal Server Error'
      : err.message || 'Internal Server Error';

    const errorPayload = { error: message };
    if (requestId) {
      errorPayload.requestId = requestId;
    }
    if (!config.isProduction && err.stack && statusCode === 500) {
      errorPayload.stack = err.stack;
    }

    res.status(statusCode).json(errorPayload);
  });

  return app;
}

module.exports = { createApp };
