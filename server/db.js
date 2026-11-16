'use strict';

const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.isTest ? 5 : 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (err) {
    if (!config.isTest) {
      console.error('Database query error:', {
        message: err.message,
        code: err.code,
        query: text,
      });
    }
    throw err;
  }
}

async function getClient() {
  return await pool.connect();
}

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  getClient,
  close,
};
