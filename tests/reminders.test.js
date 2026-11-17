'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, teardownTestDb, pool } = require('./helpers/db');
const db = require('../server/db');
const { runReminderSweep, getDateString } = require('../server/worker/reminders');

let compId;
let eventId;
let judgeId;
let sessionId;
let assignmentId;

before(async () => {
  await setupTestDb();

  const c = await pool.query('SELECT id, event_id FROM competitions LIMIT 1;');
  compId = c.rows[0].id;
  eventId = c.rows[0].event_id;

  const j = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, kind, status)
    VALUES ('Reminder', 'TestJudge', 'reminder.judge@example.com', 'academic', 'active')
    RETURNING id;
  `);
  judgeId = j.rows[0].id;

  // Insert session starting in 24 hours
  const s = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, status, reporting_at, grace_minutes)
    VALUES (
      $1, 'Reminder Session',
      NOW() + INTERVAL '24 hours',
      NOW() + INTERVAL '26 hours',
      15, 'scheduled',
      NOW() + INTERVAL '23 hours 45 minutes',
      15
    ) RETURNING id;
  `, [compId]);
  sessionId = s.rows[0].id;

  // Confirmed assignment for upcoming session
  const ja = await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'judge', 'confirmed')
    RETURNING id;
  `, [sessionId, judgeId]);
  assignmentId = ja.rows[0].id;

  // Pending invitation expiring in 3.5 days
  await pool.query(`
    INSERT INTO judge_invitations (event_id, competition_id, judge_id, invitation_token, status, expires_at)
    VALUES ($1, $2, $3, 'token_reminder_test', 'invited', NOW() + INTERVAL '3 days 12 hours');
  `, [eventId, compId, judgeId]);
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Reminders: getDateString helper formats ISO date YYYY-MM-DD', () => {
  const d = new Date('2026-11-20T14:30:00.000Z');
  assert.equal(getDateString(d), '2026-11-20');
});

test('Reminders: runReminderSweep enqueues pending invitation and assignment reminders', async () => {
  const initialCount = await pool.query('SELECT COUNT(*)::int AS count FROM notification_outbox;');

  const stats = await runReminderSweep();
  assert.ok(stats.invitationsEnqueued >= 1, 'Should have enqueued at least 1 pending invitation reminder');
  assert.ok(stats.assignmentsEnqueued >= 1, 'Should have enqueued at least 1 upcoming assignment reminder');

  const afterCount = await pool.query('SELECT COUNT(*)::int AS count FROM notification_outbox;');
  assert.equal(afterCount.rows[0].count, initialCount.rows[0].count + stats.invitationsEnqueued + stats.assignmentsEnqueued);

  // Check the enqueued reminder rows
  const invRow = await pool.query(
    "SELECT * FROM notification_outbox WHERE template = 'reminder_invitation' AND recipient_email = 'reminder.judge@example.com'"
  );
  assert.equal(invRow.rows.length, 1);
  assert.ok(invRow.rows[0].idempotency_key.startsWith('reminder:invitation:'));

  const asgRow = await pool.query(
    "SELECT * FROM notification_outbox WHERE template = 'reminder_assignment' AND recipient_email = 'reminder.judge@example.com'"
  );
  assert.equal(asgRow.rows.length, 1);
  assert.ok(asgRow.rows[0].idempotency_key.startsWith('reminder:assignment:'));
});

test('Reminders: Idempotency deduplication prevents double-enqueuing on repeat runs', async () => {
  const countBefore = await pool.query('SELECT COUNT(*)::int AS count FROM notification_outbox;');

  // Run a second time within same calendar day
  const stats2 = await runReminderSweep();
  assert.equal(stats2.invitationsEnqueued, 0, 'Repeat sweep should not duplicate invitation reminders');
  assert.equal(stats2.assignmentsEnqueued, 0, 'Repeat sweep should not duplicate assignment reminders');

  const countAfter = await pool.query('SELECT COUNT(*)::int AS count FROM notification_outbox;');
  assert.equal(countAfter.rows[0].count, countBefore.rows[0].count);
});

test('Reminders: Coordinator alert enqueued for judges past reporting time + grace + 5m', async () => {
  // Create an active in-flight session where reporting_at + grace + 5m is in the past
  const pastSession = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, status, reporting_at, grace_minutes)
    VALUES (
      $1, 'Late Alert Session',
      NOW() - INTERVAL '10 minutes',
      NOW() + INTERVAL '1 hour',
      0, 'in_progress',
      NOW() - INTERVAL '30 minutes',
      15
    ) RETURNING id;
  `, [compId]);
  const pastSessionId = pastSession.rows[0].id;

  // Create another judge and assignment
  const lateJudge = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, kind, status)
    VALUES ('Late', 'Judge', 'late.judge@example.com', 'industry', 'active')
    RETURNING id;
  `);
  const lateJudgeId = lateJudge.rows[0].id;

  const lateAsg = await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'judge', 'confirmed')
    RETURNING id;
  `, [pastSessionId, lateJudgeId]);

  const stats = await runReminderSweep();
  assert.ok(stats.lateAlertsEnqueued >= 1, 'Should have enqueued coordinator late alert');

  const alertRow = await pool.query(
    "SELECT * FROM notification_outbox WHERE idempotency_key LIKE $1",
    [`reminder:late:${lateAsg.rows[0].id}:%`]
  );
  assert.equal(alertRow.rows.length, 1);
  assert.ok(alertRow.rows[0].subject.includes('Late Judge'));
});
