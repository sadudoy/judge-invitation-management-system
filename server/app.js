'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const config = require('./config');
const db = require('./db');
const authRouter = require('./routes/auth');

function createApp(options = {}) {
  const app = express();

  // Security Headers via Helmet
  app.use(
    helmet({
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

  // Static Assets (Client UI)
  const clientDir = path.join(__dirname, '..', 'client');
  app.use(express.static(clientDir));

  // Central 404 Handler for API
  app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // Central Error Handler
  app.use((err, req, res, next) => {
    if (!config.isTest) {
      console.error('Unhandled Server Error:', err);
    }

    const statusCode = err.status || err.statusCode || 500;
    const message = config.isProduction && statusCode === 500
      ? 'Internal Server Error'
      : err.message || 'Internal Server Error';

    res.status(statusCode).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
