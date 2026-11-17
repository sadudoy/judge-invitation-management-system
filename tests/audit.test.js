'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, teardownTestDb, runInRollback } = require('./helpers/db');

before(async () => {
  await setupTestDb();
});

after(async () => {
  await teardownTestDb();
});

test('Audit: audit_row trigger records INSERT on judge_assignments', async () => {
  await runInRollback(async (client) => {
    // 1. Create a session for testing
    const sessRes = await client.query(`
      INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes)
      VALUES (1, 'Audit-Test-Session', '2026-11-28 09:00:00+06', '2026-11-28 10:00:00+06', 0)
      RETURNING id;
    `);
    const sessionId = sessRes.rows[0].id;

    // 2. Insert into judge_assignments
    const assignRes = await client.query(`
      INSERT INTO judge_assignments (session_id, judge_id, role)
      VALUES ($1, 1, 'judge')
      RETURNING id;
    `, [sessionId]);
    const assignId = assignRes.rows[0].id;

    // 3. Query audit_log for judge_assignments matching row_id / record_id
    const auditRes = await client.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'judge_assignments' AND (row_id = $1 OR record_id = $1);
    `, [assignId]);

    assert.equal(auditRes.rows.length, 1, 'Expected exactly one audit row for judge_assignments INSERT');
    assert.equal(auditRes.rows[0].action, 'INSERT');
    assert.equal(auditRes.rows[0].table_name, 'judge_assignments');
    assert.equal(String(auditRes.rows[0].record_id), String(assignId));
    assert.ok(auditRes.rows[0].new_values);
  });
});

test('Audit: audit_row trigger records INSERT on judge_conflicts', async () => {
  await runInRollback(async (client) => {
    // Insert into judge_conflicts
    const conflictRes = await client.query(`
      INSERT INTO judge_conflicts (judge_id, competition_id, student_name, conflict_type, description)
      VALUES (1, 1, 'Audit Student Test', 'student_supervision', 'Trigger audit test verification')
      RETURNING id;
    `);
    const conflictId = conflictRes.rows[0].id;

    // Query audit_log for judge_conflicts matching row_id / record_id
    const auditRes = await client.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'judge_conflicts' AND (row_id = $1 OR record_id = $1);
    `, [conflictId]);

    assert.equal(auditRes.rows.length, 1, 'Expected exactly one audit row for judge_conflicts INSERT');
    assert.equal(auditRes.rows[0].action, 'INSERT');
    assert.equal(auditRes.rows[0].table_name, 'judge_conflicts');
    assert.equal(String(auditRes.rows[0].record_id), String(conflictId));
    assert.ok(auditRes.rows[0].new_values);
  });
});
