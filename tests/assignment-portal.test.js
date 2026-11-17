'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { setupTestDb, teardownTestDb, pool } = require('./helpers/db');
const { createApp } = require('../server/app');
const db = require('../server/db');
const { generateToken, hashToken } = require('../server/lib/tokens');

let app;
let testJudge1Id;
let testJudge2Id;
let testSessionId;
let testAssignment1Id;
let testAssignment2Id;
let rawToken1;
let rawToken2;
let rawExpiredToken;

before(async () => {
  await setupTestDb();
  app = createApp();

  // Create two judges
  const j1 = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active, status)
    VALUES ('Portal', 'JudgeOne', 'portal.judge1@csefest.edu', true, 'active')
    RETURNING id;
  `);
  testJudge1Id = j1.rows[0].id;

  const j2 = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active, status)
    VALUES ('Portal', 'JudgeTwo', 'portal.judge2@csefest.edu', true, 'active')
    RETURNING id;
  `);
  testJudge2Id = j2.rows[0].id;

  // Retrieve competition
  const compRes = await pool.query(`SELECT id FROM competitions LIMIT 1`);
  const competitionId = compRes.rows[0].id;

  // Create session
  const sRes = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, status)
    VALUES ($1, 'Portal Session', '2026-11-22 10:00:00+06', '2026-11-22 12:00:00+06', 0, 'scheduled')
    RETURNING id;
  `, [competitionId]);
  testSessionId = sRes.rows[0].id;

  // Create assignments
  const a1 = await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'judge', 'held')
    RETURNING id;
  `, [testSessionId, testJudge1Id]);
  testAssignment1Id = a1.rows[0].id;

  const a2 = await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'head_judge', 'held')
    RETURNING id;
  `, [testSessionId, testJudge2Id]);
  testAssignment2Id = a2.rows[0].id;

  // Generate tokens
  rawToken1 = generateToken();
  const hash1 = hashToken(rawToken1);
  await pool.query(`
    INSERT INTO auth_tokens (judge_id, assignment_id, token_hash, purpose, expires_at)
    VALUES ($1, $2, $3, 'assignment', NOW() + INTERVAL '24 hours');
  `, [testJudge1Id, testAssignment1Id, hash1]);

  rawToken2 = generateToken();
  const hash2 = hashToken(rawToken2);
  await pool.query(`
    INSERT INTO auth_tokens (judge_id, assignment_id, token_hash, purpose, expires_at)
    VALUES ($1, $2, $3, 'assignment', NOW() + INTERVAL '24 hours');
  `, [testJudge2Id, testAssignment2Id, hash2]);

  rawExpiredToken = generateToken();
  const hashExpired = hashToken(rawExpiredToken);
  await pool.query(`
    INSERT INTO auth_tokens (judge_id, assignment_id, token_hash, purpose, expires_at)
    VALUES ($1, $2, $3, 'assignment', NOW() - INTERVAL '1 hour');
  `, [testJudge1Id, testAssignment1Id, hashExpired]);
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Assignment Portal: Accept -> confirmed + assignment_responses row + used_at set', async () => {
  const res = await request(app)
    .post(`/api/j/${rawToken1}/assignment/${testAssignment1Id}/respond`)
    .send({ response: 'accepted', reason: 'Happy to participate!' })
    .expect(200);

  assert.equal(res.body.status, 'confirmed');

  // Verify assignment status in DB
  const assignCheck = await pool.query('SELECT status FROM judge_assignments WHERE id = $1', [testAssignment1Id]);
  assert.equal(assignCheck.rows[0].status, 'confirmed');

  // Verify assignment_responses row
  const respCheck = await pool.query('SELECT * FROM assignment_responses WHERE assignment_id = $1', [testAssignment1Id]);
  assert.equal(respCheck.rows.length, 1);
  assert.equal(respCheck.rows[0].response, 'confirmed');
  assert.equal(respCheck.rows[0].reason, 'Happy to participate!');

  // Verify auth_tokens used_at is set
  const tokenCheck = await pool.query('SELECT used_at FROM auth_tokens WHERE token_hash = $1', [hashToken(rawToken1)]);
  assert.ok(tokenCheck.rows[0].used_at !== null, 'used_at must be populated');
});

test('Assignment Portal: Replay prevention — subsequent response fails with 409', async () => {
  const res = await request(app)
    .post(`/api/j/${rawToken1}/assignment/${testAssignment1Id}/respond`)
    .send({ response: 'declined', reason: 'Changed my mind' })
    .expect(409);

  assert.match(res.body.error, /already been used/i);
});

test('Assignment Portal: Decline -> declined + coordinator outbox alert', async () => {
  const res = await request(app)
    .post(`/api/j/${rawToken2}/assignment/${testAssignment2Id}/respond`)
    .send({ response: 'declined', reason: 'Unavoidable scheduling clash' })
    .expect(200);

  assert.equal(res.body.status, 'declined');

  // Verify assignment status is declined
  const assignCheck = await pool.query('SELECT status FROM judge_assignments WHERE id = $1', [testAssignment2Id]);
  assert.equal(assignCheck.rows[0].status, 'declined');

  // Verify coordinator outbox alert produced
  const outboxCheck = await pool.query(`
    SELECT * FROM notification_outbox
    WHERE template = 'judge_declined_assignment_alert'
    ORDER BY id DESC
    LIMIT 1;
  `);
  assert.ok(outboxCheck.rows.length > 0, 'Outbox alert must be queued for coordinator');
  assert.match(outboxCheck.rows[0].body, /has declined assignment/);
});

test('Assignment Portal: Wrong-judge token fails with 403', async () => {
  // Generate a fresh token belonging to Judge 1
  const freshToken = generateToken();
  const freshHash = hashToken(freshToken);

  await pool.query(`
    INSERT INTO auth_tokens (judge_id, token_hash, purpose, expires_at)
    VALUES ($1, $2, 'assignment', NOW() + INTERVAL '24 hours');
  `, [testJudge1Id, freshHash]);

  // Attempt to use Judge 1's token on Judge 2's assignment
  const res = await request(app)
    .post(`/api/j/${freshToken}/assignment/${testAssignment2Id}/respond`)
    .send({ response: 'accepted' })
    .expect(403);

  assert.match(res.body.error, /Forbidden/i);
});

test('Assignment Portal: Expired token returns 410', async () => {
  const res = await request(app)
    .post(`/api/j/${rawExpiredToken}/assignment/${testAssignment1Id}/respond`)
    .send({ response: 'accepted' })
    .expect(410);

  assert.match(res.body.error, /expired/i);
});

test('Assignment Portal: Invalid token returns 404', async () => {
  const fakeToken = '0123456789abcdef0123456789abcdef';
  await request(app)
    .post(`/api/j/${fakeToken}/assignment/${testAssignment1Id}/respond`)
    .send({ response: 'accepted' })
    .expect(404);
});

test('Assignment Portal: GET /api/j/:token includes upcoming assignments array', async () => {
  // Create valid fresh token
  const readToken = generateToken();
  await pool.query(`
    INSERT INTO auth_tokens (judge_id, token_hash, purpose, expires_at)
    VALUES ($1, $2, 'assignment', NOW() + INTERVAL '24 hours');
  `, [testJudge1Id, hashToken(readToken)]);

  const res = await request(app).get(`/api/j/${readToken}`).expect(200);

  assert.ok(Array.isArray(res.body.assignments), 'Response must contain assignments array');
  assert.ok(res.body.assignments.length > 0);
  assert.equal(res.body.judge.email, 'portal.judge1@csefest.edu');
});
