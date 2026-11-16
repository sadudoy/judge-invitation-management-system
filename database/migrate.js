'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function getConnectionString() {
  const isTest = process.argv.includes('--test') || process.env.NODE_ENV === 'test';
  const url = isTest ? (process.env.DATABASE_URL_TEST || process.env.DATABASE_URL) : process.env.DATABASE_URL;
  if (!url) {
    throw new Error(`Missing database URL (${isTest ? 'DATABASE_URL_TEST' : 'DATABASE_URL'}). Check your .env file.`);
  }
  return url;
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // Lexicographical sort (001_, 002_, 003_...)
}

async function getStatus(targetUrl) {
  const url = targetUrl || getConnectionString();
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    await ensureMigrationTable(client);
    const { rows } = await client.query('SELECT name, applied_at FROM schema_migrations ORDER BY name ASC;');
    const appliedMap = new Map(rows.map((r) => [r.name, r.applied_at]));

    const files = getMigrationFiles();
    const statusList = files.map((file) => {
      const appliedAt = appliedMap.get(file);
      return {
        Migration: file,
        Status: appliedAt ? 'Applied' : 'Pending',
        'Applied At': appliedAt ? new Date(appliedAt).toISOString() : '---',
      };
    });

    return statusList;
  } finally {
    await client.end();
  }
}

async function runMigrations(targetUrl, options = { silent: false }) {
  const url = targetUrl || getConnectionString();
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    await ensureMigrationTable(client);

    const { rows } = await client.query('SELECT name FROM schema_migrations;');
    const appliedSet = new Set(rows.map((r) => r.name));

    const files = getMigrationFiles();
    let appliedCount = 0;

    for (const file of files) {
      if (!appliedSet.has(file)) {
        if (!options.silent) {
          console.log(`Applying migration: ${file}...`);
        }
        const filePath = path.join(MIGRATIONS_DIR, file);
        const sql = fs.readFileSync(filePath, 'utf8');

        // Execute in transaction
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1);', [file]);
          await client.query('COMMIT');
          appliedCount++;
          if (!options.silent) {
            console.log(`  ✓ ${file} applied successfully.`);
          }
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`  ✗ Error in ${file}: ${err.message}`);
          throw err;
        }
      }
    }

    if (!options.silent) {
      if (appliedCount === 0) {
        console.log('Database is up to date. No pending migrations.');
      } else {
        console.log(`Successfully applied ${appliedCount} migration(s).`);
      }
    }

    return appliedCount;
  } finally {
    await client.end();
  }
}

// CLI execution
if (require.main === module) {
  const isStatus = process.argv.includes('--status');

  if (isStatus) {
    getStatus()
      .then((status) => {
        console.log('\nMigration Status:');
        console.table(status);
        process.exit(0);
      })
      .catch((err) => {
        console.error('Migration status check failed:', err.message);
        process.exit(1);
      });
  } else {
    runMigrations()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('Migration failed:', err.message);
        process.exit(1);
      });
  }
}

module.exports = {
  runMigrations,
  getStatus,
  getConnectionString,
};
