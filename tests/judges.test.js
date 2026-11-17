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

before(async () => {
  await setupTestDb();
  app = createApp();

  // Create viewer user
  const hash = await bcrypt.hash('ViewerPass123!', 12);
  await pool.query(`
    INSERT INTO users (email, password_hash, full_name, role, is_active)
    VALUES ('viewer_judges@csefest.edu', $1, 'Viewer User', 'viewer', true)
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
    .send({ email: 'viewer_judges@csefest.edu', password: 'ViewerPass123!' })
    .expect(200);
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Judges: Unauthenticated request to /api/judges returns 401', async () => {
  const res = await request(app).get('/api/judges').expect(401);
  assert.equal(res.body.error, 'Unauthorized: login required');
});

test('Judges: Viewer role receives 403 on /api/judges', async () => {
  const res = await viewerAgent.get('/api/judges').expect(403);
  assert.equal(res.body.error, 'Forbidden: insufficient permissions');
});

test('Judges: Admin can create a new judge (201)', async () => {
  const res = await adminAgent
    .post('/api/judges')
    .send({
      first_name: 'Alan',
      last_name: 'Turing',
      email: 'alan.turing@cambridge.ac.uk',
      organization: 'University of Cambridge',
      designation: 'Fellow',
      kind: 'academic',
      expertise: ['Cryptography', 'Algorithms', 'Logic'],
    })
    .expect(201);

  assert.equal(res.body.judge.first_name, 'Alan');
  assert.equal(res.body.judge.last_name, 'Turing');
  assert.equal(res.body.judge.email, 'alan.turing@cambridge.ac.uk');
  assert.equal(res.body.judge.status, 'active');
});

test('Judges: Creating judge with invalid email returns 400', async () => {
  const res = await adminAgent
    .post('/api/judges')
    .send({
      first_name: 'Bad',
      last_name: 'Email',
      email: 'not-an-email',
    })
    .expect(400);

  assert.equal(res.body.error, 'Validation failed');
  assert.ok(res.body.details.some(d => d.includes('valid email')));
});

test('Judges: Creating judge with duplicate email (case-insensitive) returns 409', async () => {
  const res = await adminAgent
    .post('/api/judges')
    .send({
      first_name: 'Alan',
      last_name: 'Duplicate',
      email: 'ALAN.TURING@cambridge.ac.uk', // uppercase duplicate
    })
    .expect(409);

  assert.ok(res.body.error.includes('already exists'));
});

test('Judges: GET /api/judges supports search and filter by kind', async () => {
  const res = await adminAgent
    .get('/api/judges?q=Turing&kind=academic')
    .expect(200);

  assert.ok(res.body.judges.length >= 1);
  assert.equal(res.body.judges[0].first_name, 'Alan');
});

test('Judges: PATCH /api/judges/:id updates judge and blocks duplicate email (409)', async () => {
  // Create another judge first
  const j2 = await adminAgent
    .post('/api/judges')
    .send({
      first_name: 'Grace',
      last_name: 'Hopper',
      email: 'grace.hopper@navy.mil',
      kind: 'industry',
    })
    .expect(201);

  const graceId = j2.body.judge.id;

  // Try updating grace's email to alan's email -> 409
  await adminAgent
    .patch(`/api/judges/${graceId}`)
    .send({ email: 'alan.turing@cambridge.ac.uk' })
    .expect(409);

  // Successfully update designation
  const updated = await adminAgent
    .patch(`/api/judges/${graceId}`)
    .send({ designation: 'Rear Admiral' })
    .expect(200);

  assert.equal(updated.body.judge.designation, 'Rear Admiral');
});

test('Judges: POST /api/judges/:id/deactivate blocks deactivation if active future assignment exists (409)', async () => {
  // Create judge
  const jRes = await adminAgent
    .post('/api/judges')
    .send({
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada.lovelace@engine.org',
      kind: 'academic',
    })
    .expect(201);
  const judgeId = jRes.body.judge.id;

  // Create event, venue, competition, session, and future assignment
  const evRes = await pool.query(`
    INSERT INTO events (name, slug, start_date, end_date)
    VALUES ('Future Fest', 'future-fest', NOW() + INTERVAL '10 days', NOW() + INTERVAL '12 days')
    RETURNING id;
  `);
  const eventId = evRes.rows[0].id;

  const venRes = await pool.query(`
    INSERT INTO venues (event_id, name) VALUES ($1, 'Auditorium') RETURNING id;
  `, [eventId]);
  const venueId = venRes.rows[0].id;

  const compRes = await pool.query(`
    INSERT INTO competitions (event_id, name, slug) VALUES ($1, 'Future Comp', 'future-comp') RETURNING id;
  `, [eventId]);
  const compId = compRes.rows[0].id;

  const sessRes = await pool.query(`
    INSERT INTO sessions (competition_id, venue_id, name, start_time, end_time)
    VALUES ($1, $2, 'Future Session 1', NOW() + INTERVAL '10 days 10 hours', NOW() + INTERVAL '10 days 12 hours')
    RETURNING id;
  `, [compId, venueId]);
  const sessionId = sessRes.rows[0].id;

  // Insert confirmed future assignment
  await pool.query(`
    INSERT INTO judge_assignments (judge_id, session_id, status)
    VALUES ($1, $2, 'confirmed');
  `, [judgeId, sessionId]);

  // Attempt deactivation -> expect 409 Conflict
  const deactRes = await adminAgent
    .post(`/api/judges/${judgeId}/deactivate`)
    .expect(409);

  assert.ok(deactRes.body.error.includes('future assignments'));
  assert.equal(deactRes.body.conflict.competition, 'Future Comp');
});

test('Judges: POST /api/judges/:id/deactivate succeeds when no future assignment exists', async () => {
  const jRes = await adminAgent
    .post('/api/judges')
    .send({
      first_name: 'Claude',
      last_name: 'Shannon',
      email: 'claude.shannon@bell.com',
      kind: 'industry',
    })
    .expect(201);
  const judgeId = jRes.body.judge.id;

  const deactRes = await adminAgent
    .post(`/api/judges/${judgeId}/deactivate`)
    .expect(200);

  assert.equal(deactRes.body.judge.status, 'inactive');
  assert.equal(deactRes.body.judge.is_active, false);
});

test('Judges: GET /api/judges/:id/history returns past invitations and records', async () => {
  const jRes = await adminAgent.get('/api/judges?q=Turing').expect(200);
  const judgeId = jRes.body.judges[0].id;

  const histRes = await adminAgent.get(`/api/judges/${judgeId}/history`).expect(200);
  assert.ok(histRes.body.judge);
  assert.ok(Array.isArray(histRes.body.invitations));
  assert.ok(Array.isArray(histRes.body.assignments));
  assert.ok(Array.isArray(histRes.body.availability));
  assert.ok(Array.isArray(histRes.body.conflicts));
});
