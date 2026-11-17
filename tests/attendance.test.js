'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcrypt');

const { setupTestDb, teardownTestDb, pool } = require('./helpers/db');
const { createApp } = require('../server/app');
const db = require('../server/db');
const { generateToken, hashToken } = require('../server/lib/tokens');

let app;
let adminAgent;

let testJudgeId;
let testJudgeLateId;
let testJudgeAbsentId;
let testCompetitionId;
let testSessionId;
let testAssignmentOnTimeId;
let testAssignmentLateId;
let testAssignmentAbsentId;
let onTimeToken;
let lateToken;

before(async () => {
  await setupTestDb();
  app = createApp();

  // Log in admin
  adminAgent = request.agent(app);
  await adminAgent
    .post('/api/auth/login')
    .send({ email: 'admin@csefest.edu', password: 'ChangeMe123!' })
    .expect(200);

  // Retrieve competition
  const compRes = await pool.query(`SELECT id FROM competitions LIMIT 1`);
  testCompetitionId = compRes.rows[0].id;

  // Insert judges
  const j1 = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active, status)
    VALUES ('OnTime', 'Judge', 'ontime.judge@csefest.edu', true, 'active')
    RETURNING id;
  `);
  testJudgeId = j1.rows[0].id;

  const j2 = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active, status)
    VALUES ('Late', 'Judge', 'late.judge@csefest.edu', true, 'active')
    RETURNING id;
  `);
  testJudgeLateId = j2.rows[0].id;

  const j3 = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active, status)
    VALUES ('Absent', 'Judge', 'absent.judge@csefest.edu', true, 'active')
    RETURNING id;
  `);
  testJudgeAbsentId = j3.rows[0].id;

  // Session: starts in future, reporting time is 2 hours from now
  const sRes = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, reporting_at, grace_minutes, status)
    VALUES ($1, 'Attendance Session', NOW() + INTERVAL '2 hours', NOW() + INTERVAL '4 hours', 0, NOW() + INTERVAL '1 hour 45 minutes', 15, 'scheduled')
    RETURNING id;
  `, [testCompetitionId]);
  testSessionId = sRes.rows[0].id;

  // Create assignments
  const a1 = await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'judge', 'confirmed')
    RETURNING id;
  `, [testSessionId, testJudgeId]);
  testAssignmentOnTimeId = a1.rows[0].id;

  const a2 = await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'judge', 'confirmed')
    RETURNING id;
  `, [testSessionId, testJudgeLateId]);
  testAssignmentLateId = a2.rows[0].id;

  const a3 = await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'judge', 'confirmed')
    RETURNING id;
  `, [testSessionId, testJudgeAbsentId]);
  testAssignmentAbsentId = a3.rows[0].id;

  // Tokens
  onTimeToken = generateToken();
  await pool.query(`
    INSERT INTO auth_tokens (judge_id, assignment_id, token_hash, purpose, expires_at)
    VALUES ($1, $2, $3, 'checkin', NOW() + INTERVAL '24 hours');
  `, [testJudgeId, testAssignmentOnTimeId, hashToken(onTimeToken)]);

  lateToken = generateToken();
  await pool.query(`
    INSERT INTO auth_tokens (judge_id, assignment_id, token_hash, purpose, expires_at)
    VALUES ($1, $2, $3, 'checkin', NOW() + INTERVAL '24 hours');
  `, [testJudgeLateId, testAssignmentLateId, hashToken(lateToken)]);
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Attendance: Check-in before reporting time -> checked_in, minutes_late = 0', async () => {
  // Session reporting time is in future -> check-in now is before deadline
  const res = await request(app)
    .post(`/api/j/${onTimeToken}/checkin`)
    .send({ assignment_id: testAssignmentOnTimeId })
    .expect(200);

  assert.equal(res.body.status, 'checked_in');
  assert.equal(res.body.minutes_late, 0);

  // DB check
  const dbCheck = await pool.query('SELECT * FROM assignment_attendance WHERE assignment_id = $1', [testAssignmentOnTimeId]);
  assert.equal(dbCheck.rows.length, 1);
  assert.equal(dbCheck.rows[0].status, 'checked_in');
  assert.ok(dbCheck.rows[0].check_in_time !== null);
});

test('Attendance: Check-in after reporting + grace -> late with minutes_late > 0', async () => {
  // Update session reporting_at to 40 minutes in past, grace = 15m (deadline passed 25m ago)
  await pool.query(`
    UPDATE sessions
    SET reporting_at = NOW() - INTERVAL '40 minutes', grace_minutes = 15
    WHERE id = $1
  `, [testSessionId]);

  const res = await request(app)
    .post(`/api/j/${lateToken}/checkin`)
    .send({ assignment_id: testAssignmentLateId })
    .expect(200);

  assert.equal(res.body.status, 'late');
  assert.ok(res.body.minutes_late >= 20, `minutes_late should be >= 20, got ${res.body.minutes_late}`);

  // DB check
  const dbCheck = await pool.query('SELECT * FROM assignment_attendance WHERE assignment_id = $1', [testAssignmentLateId]);
  assert.equal(dbCheck.rows[0].status, 'late');
  assert.ok(dbCheck.rows[0].minutes_late > 0);
});

test('Attendance: Check-out before session end_time -> early_departure', async () => {
  // Session end_time is in future (NOW() + 4 hours)
  const res = await request(app)
    .post(`/api/j/${onTimeToken}/checkout`)
    .send({ assignment_id: testAssignmentOnTimeId })
    .expect(200);

  assert.equal(res.body.status, 'early_departure');
  assert.equal(res.body.early_departure, true);

  // DB check
  const dbCheck = await pool.query('SELECT * FROM assignment_attendance WHERE assignment_id = $1', [testAssignmentOnTimeId]);
  assert.equal(dbCheck.rows[0].status, 'early_departure');
  assert.ok(dbCheck.rows[0].checked_out_at !== null);
});

test('Attendance: Check-out after session end_time preserves normal completion status', async () => {
  // Move session start_time and end_time into past (preserving start_time < end_time)
  await pool.query(`
    UPDATE sessions
    SET start_time = NOW() - INTERVAL '2 hours', end_time = NOW() - INTERVAL '5 minutes'
    WHERE id = $1
  `, [testSessionId]);

  const res = await request(app)
    .post(`/api/j/${lateToken}/checkout`)
    .send({ assignment_id: testAssignmentLateId })
    .expect(200);

  assert.equal(res.body.early_departure, false);
});

test('Attendance: Admin PATCH attendance updates status and creates audit log row', async () => {
  const res = await adminAgent
    .patch(`/api/assignments/${testAssignmentOnTimeId}/attendance`)
    .send({ status: 'excused', notes: 'Medical emergency excused by coordinator' })
    .expect(200);

  assert.equal(res.body.attendance.status, 'excused');

  // Verify audit log
  const auditRes = await pool.query(`
    SELECT * FROM audit_log
    WHERE table_name = 'assignment_attendance' AND (record_id = $1 OR row_id = $1)
    ORDER BY id DESC
    LIMIT 1;
  `, [res.body.attendance.id]);

  assert.ok(auditRes.rows.length > 0);
  assert.equal(auditRes.rows[0].action, 'UPDATE');
  assert.match(JSON.stringify(auditRes.rows[0].new_values), /Medical emergency/);
});

test('Attendance: Admin PATCH invalid status returns 400', async () => {
  await adminAgent
    .patch(`/api/assignments/${testAssignmentOnTimeId}/attendance`)
    .send({ status: 'invalid_status_enum' })
    .expect(400);
});

test('Attendance: Session attendance roster GET /api/sessions/:id/attendance', async () => {
  const res = await adminAgent
    .get(`/api/sessions/${testSessionId}/attendance`)
    .expect(200);

  assert.equal(Number(res.body.session_id), Number(testSessionId));
  assert.ok(Array.isArray(res.body.attendance));
  assert.ok(res.body.attendance.length >= 3);
});

test('Attendance: Flag-absent marks not_arrived judges as absent and produces outbox notification', async () => {
  // testAssignmentAbsentId has no attendance row yet (or not_arrived)
  const res = await adminAgent
    .post(`/api/sessions/${testSessionId}/flag-absent`)
    .expect(200);

  assert.ok(res.body.flagged_count >= 1);
  assert.ok(res.body.absent_judges.some((j) => Number(j.assignment_id) === Number(testAssignmentAbsentId)));

  // Verify DB status
  const attCheck = await pool.query('SELECT status FROM assignment_attendance WHERE assignment_id = $1', [testAssignmentAbsentId]);
  assert.equal(attCheck.rows[0].status, 'absent');

  // Verify notification outbox alert
  const outbox = await pool.query(`
    SELECT * FROM notification_outbox
    WHERE template = 'judge_absent_alert'
    ORDER BY id DESC
    LIMIT 1;
  `);
  assert.ok(outbox.rows.length > 0);
  assert.match(outbox.rows[0].subject, /Alert: Judge Absent/);
});
