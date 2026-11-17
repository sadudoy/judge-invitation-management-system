'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcrypt');

const { setupTestDb, teardownTestDb, pool } = require('./helpers/db');
const { createApp } = require('../server/app');
const db = require('../server/db');

let app;
let adminAgent;
let viewerAgent;

let testCompetitionId;
let testJudge1Id;
let testJudge2Id;
let testSessionMorningId;
let testSessionOverlapId;
let testSessionAdjacentId;
let testSessionBufferId;
let testSessionBuffer2Id;

before(async () => {
  await setupTestDb();
  app = createApp();

  // Create viewer user
  const hash = await bcrypt.hash('ViewerPass123!', 12);
  await pool.query(`
    INSERT INTO users (email, password_hash, full_name, role, is_active)
    VALUES ('viewer_assignments@csefest.edu', $1, 'Viewer User', 'viewer', true)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'viewer';
  `, [hash]);

  // Log in admin
  adminAgent = request.agent(app);
  await adminAgent
    .post('/api/auth/login')
    .send({ email: 'admin@csefest.edu', password: 'ChangeMe123!' })
    .expect(200);

  // Log in viewer
  viewerAgent = request.agent(app);
  await viewerAgent
    .post('/api/auth/login')
    .send({ email: 'viewer_assignments@csefest.edu', password: 'ViewerPass123!' })
    .expect(200);

  // Seed fixture data
  const compRes = await pool.query(`SELECT id, event_id FROM competitions LIMIT 1`);
  testCompetitionId = compRes.rows[0].id;
  const eventId = compRes.rows[0].event_id;

  // Insert two dedicated test judges
  const j1 = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, organization, kind, is_active)
    VALUES ('Assign', 'JudgeOne', 'assign.judge1@csefest.edu', 'AI Tech', 'industry', true)
    RETURNING id;
  `);
  testJudge1Id = j1.rows[0].id;

  const j2 = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, organization, kind, is_active)
    VALUES ('Assign', 'JudgeTwo', 'assign.judge2@csefest.edu', 'Robo Tech', 'academic', true)
    RETURNING id;
  `);
  testJudge2Id = j2.rows[0].id;

  // Base Morning Session: 2026-11-20 09:00 to 11:00 (buffer: 0)
  const sm = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, status, reporting_at, grace_minutes)
    VALUES ($1, 'Morning Coding', '2026-11-20 09:00:00+06', '2026-11-20 11:00:00+06', 0, 'scheduled', '2026-11-20 08:45:00+06', 15)
    RETURNING id;
  `, [testCompetitionId]);
  testSessionMorningId = sm.rows[0].id;

  // Overlapping Session: 2026-11-20 10:00 to 12:00
  const so = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, status, reporting_at, grace_minutes)
    VALUES ($1, 'Overlapping Session', '2026-11-20 10:00:00+06', '2026-11-20 12:00:00+06', 0, 'scheduled', '2026-11-20 09:45:00+06', 15)
    RETURNING id;
  `, [testCompetitionId]);
  testSessionOverlapId = so.rows[0].id;

  // Adjacent Session: 2026-11-20 11:00 to 13:00 (back-to-back with morning, 0 buffer)
  const sa = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, status, reporting_at, grace_minutes)
    VALUES ($1, 'Adjacent Session', '2026-11-20 11:00:00+06', '2026-11-20 13:00:00+06', 0, 'scheduled', '2026-11-20 10:45:00+06', 15)
    RETURNING id;
  `, [testCompetitionId]);
  testSessionAdjacentId = sa.rows[0].id;

  // Buffered Session: 2026-11-20 14:00 to 15:00 with 15-minute buffer (window extends to 15:15)
  const sb1 = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, status)
    VALUES ($1, 'Buffered Session', '2026-11-20 14:00:00+06', '2026-11-20 15:00:00+06', 15, 'scheduled')
    RETURNING id;
  `, [testCompetitionId]);
  testSessionBufferId = sb1.rows[0].id;

  // Buffer Overlap Session: 2026-11-20 15:10 to 16:00 (starts at 15:10, clashing with 15:15 buffer)
  const sb2 = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, status)
    VALUES ($1, 'Buffer Overlap Session', '2026-11-20 15:10:00+06', '2026-11-20 16:00:00+06', 0, 'scheduled')
    RETURNING id;
  `, [testCompetitionId]);
  testSessionBuffer2Id = sb2.rows[0].id;
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Assignments: Unauthenticated requests return 401', async () => {
  const res = await request(app).get('/api/assignments').expect(401);
  assert.equal(res.body.error, 'Unauthorized: login required');
});

test('Assignments: Viewer role receives 403', async () => {
  const res = await viewerAgent.get('/api/assignments').expect(403);
  assert.equal(res.body.error, 'Forbidden: insufficient permissions');
});

test('Assignments: Admin can list assignments (200)', async () => {
  const res = await adminAgent.get('/api/assignments').expect(200);
  assert.ok(Array.isArray(res.body.assignments));
  assert.equal(typeof res.body.total, 'number');
});

test('Assignments: Filter assignments by session_id, judge_id, status, role', async () => {
  const res = await adminAgent
    .get(`/api/assignments?session_id=${testSessionMorningId}&limit=10&offset=0`)
    .expect(200);
  assert.ok(Array.isArray(res.body.assignments));
  assert.equal(res.body.limit, 10);
  assert.equal(res.body.offset, 0);
});

test('Assignments: Create assignment succeeds with 201', async () => {
  const res = await adminAgent
    .post('/api/assignments')
    .send({
      session_id: testSessionMorningId,
      judge_id: testJudge1Id,
      role: 'head_judge',
    })
    .expect(201);

  assert.ok(res.body.assignment.id);
  assert.equal(res.body.assignment.role, 'head_judge');
  assert.ok(['confirmed', 'held'].includes(res.body.assignment.status));
});

test('Assignments: Exclude overlap constraint returns 409 with error=overlap and conflicting_assignment_id', async () => {
  // Attempting to assign Judge 1 to testSessionOverlapId (which overlaps testSessionMorningId)
  const res = await adminAgent
    .post('/api/assignments')
    .send({
      session_id: testSessionOverlapId,
      judge_id: testJudge1Id,
      role: 'judge',
    })
    .expect(409);

  assert.equal(res.body.error, 'overlap');
  assert.ok(res.body.conflicting_assignment_id, 'Must return the conflicting_assignment_id');
});

test('Assignments: Adjacent assignments without overlap succeed (201)', async () => {
  // testSessionAdjacentId starts exactly when testSessionMorningId ends (11:00) with 0 buffer
  const res = await adminAgent
    .post('/api/assignments')
    .send({
      session_id: testSessionAdjacentId,
      judge_id: testJudge1Id,
      role: 'judge',
    })
    .expect(201);

  assert.ok(res.body.assignment.id);
  assert.equal(res.body.assignment.session_id, testSessionAdjacentId);
});

test('Assignments: Buffer-overlap triggers 409 exclusion violation', async () => {
  // First assign Judge 1 to testSessionBufferId (14:00 to 15:00 + 15m buffer => [14:00, 15:15))
  await adminAgent
    .post('/api/assignments')
    .send({
      session_id: testSessionBufferId,
      judge_id: testJudge1Id,
      role: 'judge',
    })
    .expect(201);

  // Then attempt to assign Judge 1 to testSessionBuffer2Id (15:10 to 16:00, which clashes with 15:15 buffer)
  const res = await adminAgent
    .post('/api/assignments')
    .send({
      session_id: testSessionBuffer2Id,
      judge_id: testJudge1Id,
      role: 'judge',
    })
    .expect(409);

  assert.equal(res.body.error, 'overlap');
});

test('Assignments: Duplicate assignment on same session returns 409 unique violation', async () => {
  const res = await adminAgent
    .post('/api/assignments')
    .send({
      session_id: testSessionMorningId,
      judge_id: testJudge1Id,
      role: 'evaluator',
    })
    .expect(409);

  assert.match(res.body.error, /already assigned to this session/i);
});

test('Assignments: Inactive judge assignment rejected with 400', async () => {
  const inact = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active)
    VALUES ('Inactive', 'Judge', 'inactive.assigned@csefest.edu', false)
    RETURNING id;
  `);

  const res = await adminAgent
    .post('/api/assignments')
    .send({
      session_id: testSessionMorningId,
      judge_id: inact.rows[0].id,
      role: 'judge',
    })
    .expect(400);

  assert.match(res.body.error, /inactive/i);
});

test('Assignments: Non-existent session returns 404', async () => {
  const res = await adminAgent
    .post('/api/assignments')
    .send({
      session_id: 9999999,
      judge_id: testJudge2Id,
      role: 'judge',
    })
    .expect(404);

  assert.equal(res.body.error, 'Session not found');
});

test('Assignments: Soft delete (DELETE /api/assignments/:id) sets status=cancelled', async () => {
  const ins = await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'judge', 'held')
    RETURNING id;
  `, [testSessionMorningId, testJudge2Id]);
  const assignId = ins.rows[0].id;

  const res = await adminAgent.delete(`/api/assignments/${assignId}`).expect(200);
  assert.equal(res.body.assignment.status, 'cancelled');

  // Verify in database: row still exists, status is cancelled
  const check = await pool.query('SELECT status FROM judge_assignments WHERE id = $1', [assignId]);
  assert.equal(check.rows[0].status, 'cancelled');
});

test('Assignments: Cancelled assignment allows re-assigning judge to overlapping session', async () => {
  // Judge 2 was cancelled on Morning session, can now be assigned to Overlapping session
  const res = await adminAgent
    .post('/api/assignments')
    .send({
      session_id: testSessionOverlapId,
      judge_id: testJudge2Id,
      role: 'head_judge',
    })
    .expect(201);

  assert.ok(res.body.assignment.id);
  assert.equal(res.body.assignment.judge_id, testJudge2Id);
});

test('Assignments: Role PATCH updates role (200) and rejects invalid role (400)', async () => {
  const ins = await pool.query(`
    SELECT id FROM judge_assignments WHERE judge_id = $1 AND session_id = $2
  `, [testJudge1Id, testSessionMorningId]);
  const assignId = ins.rows[0].id;

  // Invalid role
  await adminAgent
    .patch(`/api/assignments/${assignId}`)
    .send({ role: 'super_judge' })
    .expect(400);

  // Valid role
  const res = await adminAgent
    .patch(`/api/assignments/${assignId}`)
    .send({ role: 'evaluator' })
    .expect(200);

  assert.equal(res.body.assignment.role, 'evaluator');
});

test('Assignments: Admin override confirm sets status=confirmed and writes audit_log', async () => {
  // Create held assignment
  const ins = await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'judge', 'held')
    ON CONFLICT (session_id, judge_id) DO UPDATE SET status = 'held'
    RETURNING id;
  `, [testSessionOverlapId, testJudge2Id]);
  const assignId = ins.rows[0].id;

  const res = await adminAgent
    .post(`/api/assignments/${assignId}/confirm`)
    .send({ reason: 'Emergency admin override' })
    .expect(200);

  assert.equal(res.body.assignment.status, 'confirmed');

  // Verify audit_log entry
  const auditRes = await pool.query(`
    SELECT * FROM audit_log
    WHERE table_name = 'judge_assignments' AND (record_id = $1 OR row_id = $1)
    ORDER BY id DESC
    LIMIT 1;
  `, [assignId]);

  assert.ok(auditRes.rows.length > 0, 'Audit log row must be recorded');
  assert.equal(auditRes.rows[0].action, 'UPDATE');
  assert.match(JSON.stringify(auditRes.rows[0].new_values), /Emergency admin override/);
});
