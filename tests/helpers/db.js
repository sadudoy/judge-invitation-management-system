'use strict';

process.env.NODE_ENV = 'test';

const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { runMigrations } = require('../../database/migrate');
const { seedDatabase } = require('../../database/seed');

const testDbUrl = process.env.DATABASE_URL_TEST;

if (!testDbUrl) {
  throw new Error('DATABASE_URL_TEST is not set in environment.');
}

const pool = new Pool({
  connectionString: testDbUrl,
  max: 10,
  idleTimeoutMillis: 10000,
});

async function setupTestDb() {
  // Run migrations against test database
  await runMigrations(testDbUrl, { silent: true });
  // Seed test database
  await seedDatabase(testDbUrl, { silent: true });
}

async function runInRollback(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback error if transaction was already aborted
    }
    throw err;
  } finally {
    client.release();
  }
}

async function teardownTestDb() {
  await pool.end();
}

module.exports = {
  pool,
  testDbUrl,
  setupTestDb,
  runInRollback,
  teardownTestDb,
};
