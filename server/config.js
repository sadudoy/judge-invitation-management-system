'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const nodeEnv = process.env.NODE_ENV || 'development';
const port = parseInt(process.env.PORT, 10) || 3000;
const sessionSecret = process.env.SESSION_SECRET;
const isTest = nodeEnv === 'test';
const databaseUrl = isTest
  ? (process.env.DATABASE_URL_TEST || process.env.DATABASE_URL)
  : process.env.DATABASE_URL;
const bcryptCost = parseInt(process.env.BCRYPT_COST, 10) || 12;

if (!databaseUrl) {
  throw new Error(`DATABASE_URL is required but not set in environment (NODE_ENV=${nodeEnv}).`);
}

if (!sessionSecret && !isTest) {
  throw new Error('SESSION_SECRET is required but not set in environment.');
}

const config = {
  nodeEnv,
  port,
  sessionSecret: sessionSecret || 'test-session-secret-at-least-64-characters-long-for-testing-purposes-123456',
  databaseUrl,
  bcryptCost,
  isProduction: nodeEnv === 'production',
  isTest,
};

module.exports = config;
