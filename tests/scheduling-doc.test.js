'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, teardownTestDb, pool } = require('./helpers/db');
const db = require('../server/db');

before(async () => {
  await setupTestDb();
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Schema: Public schema strictly maintains exactly 19 tables (No New Tables in Phase 3)', async () => {
  const res = await pool.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename ASC;
  `);

  const tables = res.rows.map((r) => r.tablename);
  assert.equal(tables.length, 19, `Expected exactly 19 tables, found ${tables.length}: ${tables.join(', ')}`);
});

test('Schema: no_double_booking exclusion constraint definition matches invariant', async () => {
  const res = await pool.query(`
    SELECT conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE cl.relname = 'judge_assignments' AND c.conname = 'no_double_booking';
  `);

  assert.equal(res.rows.length, 1, 'no_double_booking constraint must exist');
  const def = res.rows[0].def;

  // Must enforce GIST with judge_id =, assignment_window &&, and status != cancelled
  assert.match(def, /EXCLUDE/i);
  assert.match(def, /gist/i);
  assert.match(def, /judge_id WITH =/i);
  assert.match(def, /assignment_window WITH &&/i);
  assert.match(def, /status.*cancelled/i);
});

test('Schema: uq_assignment_per_session unique constraint exists', async () => {
  const res = await pool.query(`
    SELECT conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE cl.relname = 'judge_assignments' AND c.conname = 'uq_assignment_per_session';
  `);

  assert.equal(res.rows.length, 1);
  assert.match(res.rows[0].def, /UNIQUE \(session_id, judge_id\)/i);
});

test('Schema: Phase 3 columns present on existing tables without drift', async () => {
  // judge_assignments
  const jaCols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'judge_assignments' AND column_name IN ('replaces_assignment_id', 'superseded_by');
  `);
  assert.equal(jaCols.rows.length, 2);

  // assignment_attendance
  const aaCols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'assignment_attendance' AND column_name IN ('checked_out_at', 'minutes_late');
  `);
  assert.equal(aaCols.rows.length, 2);

  // sessions
  const sCols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name IN ('reporting_at', 'grace_minutes');
  `);
  assert.equal(sCols.rows.length, 2);

  // auth_tokens
  const atCols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'auth_tokens' AND column_name = 'assignment_id';
  `);
  assert.equal(atCols.rows.length, 1);
});
