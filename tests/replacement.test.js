'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { setupTestDb, teardownTestDb, pool } = require('./helpers/db');
const { createApp } = require('../server/app');
const db = require('../server/db');

let app;
let adminAgent;

let testCompetitionId;
let testSessionId;
let testJudgeOriginalId;
let testJudgeReplacer1Id;
let testJudgeReplacer2Id;
let testAssignmentOriginalId;

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
  const jOrig = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active, status)
    VALUES ('Orig', 'Judge', 'orig.judge.rep@csefest.edu', true, 'active')
    RETURNING id;
  `);
  testJudgeOriginalId = jOrig.rows[0].id;

  const jRep1 = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active, status)
    VALUES ('RepOne', 'Judge', 'rep1.judge.rep@csefest.edu', true, 'active')
    RETURNING id;
  `);
  testJudgeReplacer1Id = jRep1.rows[0].id;

  const jRep2 = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active, status)
    VALUES ('RepTwo', 'Judge', 'rep2.judge.rep@csefest.edu', true, 'active')
    RETURNING id;
  `);
  testJudgeReplacer2Id = jRep2.rows[0].id;

  // Create session
  const sRes = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, status)
    VALUES ($1, 'Replacement Session', '2026-11-23 14:00:00+06', '2026-11-23 16:00:00+06', 0, 'scheduled')
    RETURNING id;
  `, [testCompetitionId]);
  testSessionId = sRes.rows[0].id;

  // Initial assignment: confirmed
  const aRes = await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'judge', 'confirmed')
    RETURNING id;
  `, [testSessionId, testJudgeOriginalId]);
  testAssignmentOriginalId = aRes.rows[0].id;
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Replacement: Replacement candidates endpoint returns eligible candidate judges', async () => {
  const res = await adminAgent
    .get(`/api/assignments/${testAssignmentOriginalId}/replacement-candidates`)
    .expect(200);

  assert.equal(Number(res.body.assignment_id), Number(testAssignmentOriginalId));
  assert.ok(Array.isArray(res.body.candidates));
  assert.ok(res.body.candidates.length > 0);
});

test('Replacement: Replace with new judge sets old status=replaced and new status=held with pointer', async () => {
  const res = await adminAgent
    .post(`/api/assignments/${testAssignmentOriginalId}/replace`)
    .send({
      replacement_judge_id: testJudgeReplacer1Id,
      reason: 'Original judge unavailable due to emergency',
    })
    .expect(201);

  assert.equal(res.body.old_assignment.status, 'replaced');
  assert.equal(res.body.replacement_assignment.status, 'held');
  assert.equal(Number(res.body.replacement_assignment.replaces_assignment_id), Number(testAssignmentOriginalId));
  assert.equal(Number(res.body.old_assignment.superseded_by), Number(res.body.replacement_assignment.id));

  // DB verification
  const checkOld = await pool.query('SELECT status, superseded_by FROM judge_assignments WHERE id = $1', [testAssignmentOriginalId]);
  assert.equal(checkOld.rows[0].status, 'replaced');
  assert.equal(Number(checkOld.rows[0].superseded_by), Number(res.body.replacement_assignment.id));

  const checkNew = await pool.query('SELECT status, replaces_assignment_id FROM judge_assignments WHERE id = $1', [res.body.replacement_assignment.id]);
  assert.equal(checkNew.rows[0].status, 'held');
  assert.equal(Number(checkNew.rows[0].replaces_assignment_id), Number(testAssignmentOriginalId));
});

test('Replacement: Notification outbox row is produced for replacement judge', async () => {
  const outbox = await pool.query(`
    SELECT * FROM notification_outbox
    WHERE template = 'replacement_notification'
    ORDER BY id DESC
    LIMIT 1;
  `);

  assert.ok(outbox.rows.length > 0);
  assert.match(outbox.rows[0].recipient_email, /rep1\.judge\.rep@csefest\.edu/);
  assert.match(outbox.rows[0].subject, /Urgent Judging Assignment/);
});

test('Replacement: Cancel replacement within 10-minute window deletes replacement and reverts old to confirmed', async () => {
  // Cancel using the original assignment id or replacement assignment id
  const res = await adminAgent
    .post(`/api/assignments/${testAssignmentOriginalId}/cancel-replacement`)
    .expect(200);

  assert.equal(res.body.assignment.status, 'confirmed');
  assert.equal(res.body.assignment.superseded_by, null);

  // DB verification
  const checkOld = await pool.query('SELECT status, superseded_by FROM judge_assignments WHERE id = $1', [testAssignmentOriginalId]);
  assert.equal(checkOld.rows[0].status, 'confirmed');
  assert.equal(checkOld.rows[0].superseded_by, null);
});

test('Replacement: Cancel replacement after 10-minute window returns 409', async () => {
  // Replace again
  const repRes = await adminAgent
    .post(`/api/assignments/${testAssignmentOriginalId}/replace`)
    .send({ replacement_judge_id: testJudgeReplacer1Id, reason: 'Re-test replacement' })
    .expect(201);

  const replacementId = repRes.body.replacement_assignment.id;

  // Fake timestamp of replacement to 15 minutes ago
  await pool.query(`
    UPDATE judge_assignments
    SET created_at = NOW() - INTERVAL '15 minutes'
    WHERE id = $1
  `, [replacementId]);

  const cancelRes = await adminAgent
    .post(`/api/assignments/${testAssignmentOriginalId}/cancel-replacement`)
    .expect(409);

  assert.match(cancelRes.body.error, /10-minute undo window has elapsed/i);
});

test('Replacement: Replacement chaining — replacing a replacement retains chain pointers', async () => {
  // Retrieve current active replacement assignment (testJudgeReplacer1Id)
  const currRes = await pool.query('SELECT id FROM judge_assignments WHERE judge_id = $1 AND session_id = $2', [
    testJudgeReplacer1Id,
    testSessionId,
  ]);
  const firstReplacementId = currRes.rows[0].id;

  // Replace first replacement with Replacer 2
  const chainRes = await adminAgent
    .post(`/api/assignments/${firstReplacementId}/replace`)
    .send({ replacement_judge_id: testJudgeReplacer2Id, reason: 'Chained secondary replacement' })
    .expect(201);

  const secondReplacement = chainRes.body.replacement_assignment;
  assert.equal(Number(secondReplacement.replaces_assignment_id), Number(firstReplacementId));

  // Verify first replacement superseded_by points to second replacement
  const checkFirst = await pool.query('SELECT status, superseded_by, replaces_assignment_id FROM judge_assignments WHERE id = $1', [firstReplacementId]);
  assert.equal(checkFirst.rows[0].status, 'replaced');
  assert.equal(Number(checkFirst.rows[0].superseded_by), Number(secondReplacement.id));
  assert.equal(Number(checkFirst.rows[0].replaces_assignment_id), Number(testAssignmentOriginalId));
});

test('Replacement: Replace without replacement judge marks old status=replaced (vacancy)', async () => {
  // Create another isolated assignment
  const isolated = await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, (SELECT id FROM judges WHERE id NOT IN ($2, $3, $4) LIMIT 1), 'judge', 'confirmed')
    RETURNING id;
  `, [testSessionId, testJudgeOriginalId, testJudgeReplacer1Id, testJudgeReplacer2Id]);

  const isoId = isolated.rows[0].id;

  const res = await adminAgent
    .post(`/api/assignments/${isoId}/replace`)
    .send({ reason: 'Judge withdrew, opening vacancy' })
    .expect(200);

  assert.equal(res.body.assignment.status, 'replaced');
});
