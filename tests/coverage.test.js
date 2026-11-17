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

let testEventId;
let testCompetitionId;
let testSession1Id;
let testSession2Id;
let testJudgeAvailId;
let testJudgeOverlapId;
let testJudgeCoiId;

before(async () => {
  await setupTestDb();
  app = createApp();

  // Log in admin
  adminAgent = request.agent(app);
  await adminAgent
    .post('/api/auth/login')
    .send({ email: 'admin@csefest.edu', password: 'ChangeMe123!' })
    .expect(200);

  // Retrieve event & competition
  const compRes = await pool.query(`SELECT id, event_id FROM competitions LIMIT 1`);
  testCompetitionId = compRes.rows[0].id;
  testEventId = compRes.rows[0].event_id;

  // Ensure competition has min_judges = 2
  await pool.query('UPDATE competitions SET min_judges = 2 WHERE id = $1', [testCompetitionId]);

  // Insert Session 1: 2026-11-21 10:00 to 12:00
  const s1 = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, status)
    VALUES ($1, 'Coverage Session 1', '2026-11-21 10:00:00+06', '2026-11-21 12:00:00+06', 0, 'scheduled')
    RETURNING id;
  `, [testCompetitionId]);
  testSession1Id = s1.rows[0].id;

  // Insert Session 2 (overlapping Session 1): 2026-11-21 11:00 to 13:00
  const s2 = await pool.query(`
    INSERT INTO sessions (competition_id, name, start_time, end_time, buffer_minutes, status)
    VALUES ($1, 'Coverage Session 2', '2026-11-21 11:00:00+06', '2026-11-21 13:00:00+06', 0, 'scheduled')
    RETURNING id;
  `, [testCompetitionId]);
  testSession2Id = s2.rows[0].id;

  // Insert Available Judge
  const jAvail = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active, status)
    VALUES ('Avail', 'Candidate', 'avail.cand@csefest.edu', true, 'active')
    RETURNING id;
  `);
  testJudgeAvailId = jAvail.rows[0].id;

  // Insert Judge who will have an overlapping assignment
  const jOverlap = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active, status)
    VALUES ('Overlap', 'Candidate', 'overlap.cand@csefest.edu', true, 'active')
    RETURNING id;
  `);
  testJudgeOverlapId = jOverlap.rows[0].id;

  // Assign jOverlap to Session 2
  await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'judge', 'confirmed')
  `, [testSession2Id, testJudgeOverlapId]);

  // Insert Judge who has a Conflict of Interest on this competition
  const jCoi = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active, status)
    VALUES ('COI', 'Candidate', 'coi.cand@csefest.edu', true, 'active')
    RETURNING id;
  `);
  testJudgeCoiId = jCoi.rows[0].id;

  await pool.query(`
    INSERT INTO judge_conflicts (judge_id, competition_id, conflict_type, description, severity)
    VALUES ($1, $2, 'student_supervision', 'Supervising student team', 'high')
  `, [testJudgeCoiId, testCompetitionId]);
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Coverage: Missing judges count accurately calculates required vs confirmed', async () => {
  // Session 1 currently has 0 assignments; min_judges = 2
  const res = await adminAgent.get(`/api/sessions/${testSession1Id}/coverage`).expect(200);

  assert.equal(res.body.required_judges, 2);
  assert.equal(res.body.confirmed_judges, 0);
  assert.equal(res.body.missing_judges, 2);
  assert.equal(res.body.is_covered, false);
});

test('Coverage: Missing head judge flag raised when no head judge is assigned', async () => {
  const res = await adminAgent.get(`/api/sessions/${testSession1Id}/coverage`).expect(200);

  assert.equal(res.body.missing_head, true);
  assert.ok(res.body.gaps.some((g) => g.toLowerCase().includes('head judge')));
});

test('Coverage: Coverage status turns ready when requirements and head judge are satisfied', async () => {
  // Assign head judge
  await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'head_judge', 'confirmed')
  `, [testSession1Id, testJudgeAvailId]);

  // Assign second judge
  const jExtra = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active, status)
    VALUES ('Extra', 'Judge', 'extra.judge.cov@csefest.edu', true, 'active')
    RETURNING id;
  `);
  await pool.query(`
    INSERT INTO judge_assignments (session_id, judge_id, role, status)
    VALUES ($1, $2, 'judge', 'confirmed')
  `, [testSession1Id, jExtra.rows[0].id]);

  const res = await adminAgent.get(`/api/sessions/${testSession1Id}/coverage`).expect(200);
  assert.equal(res.body.confirmed_judges, 2);
  assert.equal(res.body.missing_head, false);
  assert.equal(res.body.is_covered, true);
  assert.equal(res.body.gaps.length, 0);
});

test('Coverage: Competition coverage rollup aggregates across all competition sessions', async () => {
  const res = await adminAgent.get(`/api/competitions/${testCompetitionId}/coverage`).expect(200);

  assert.equal(typeof res.body.total_sessions, 'number');
  assert.ok(res.body.total_sessions >= 2);
  assert.equal(typeof res.body.coverage_percentage, 'number');
  assert.ok(Array.isArray(res.body.sessions));
});

test('Coverage: Event feasibility reports peak concurrency demand vs available active judges', async () => {
  const res = await adminAgent.get(`/api/events/${testEventId}/feasibility`).expect(200);

  assert.equal(Number(res.body.event_id), Number(testEventId));
  assert.equal(typeof res.body.peak, 'number');
  assert.equal(typeof res.body.available, 'number');
  assert.equal(typeof res.body.feasible, 'boolean');
  assert.equal(typeof res.body.deficit, 'number');
});

test('Coverage: Candidates endpoint excludes judges with overlapping assignment', async () => {
  // testJudgeOverlapId is assigned to Session 2 (11:00-13:00) which overlaps Session 1 (10:00-12:00)
  const res = await adminAgent.get(`/api/sessions/${testSession1Id}/candidates`).expect(200);

  const candidateIds = res.body.candidates.map((c) => Number(c.id));
  assert.ok(!candidateIds.includes(Number(testJudgeOverlapId)), 'Overlapping judge must NOT be listed as candidate');
});

test('Coverage: Candidates endpoint excludes judges with hard COI', async () => {
  // testJudgeCoiId has declared student_supervision COI on this competition
  const res = await adminAgent.get(`/api/sessions/${testSession1Id}/candidates`).expect(200);

  const candidateIds = res.body.candidates.map((c) => Number(c.id));
  assert.ok(!candidateIds.includes(Number(testJudgeCoiId)), 'Judge with competition COI must NOT be listed as candidate');
});

test('Coverage: Candidates endpoint excludes judges marked unavailable', async () => {
  const jUnavail = await pool.query(`
    INSERT INTO judges (first_name, last_name, email, is_active, status)
    VALUES ('Unavail', 'Judge', 'unavail.cand@csefest.edu', true, 'active')
    RETURNING id;
  `);
  // Declare unavailable window overlapping Session 1
  await pool.query(`
    INSERT INTO judge_availability (judge_id, event_id, available_window, status)
    VALUES ($1, $2, tstzrange('2026-11-21 09:00:00+06', '2026-11-21 13:00:00+06', '[]'), 'unavailable')
  `, [jUnavail.rows[0].id, testEventId]);

  const res = await adminAgent.get(`/api/sessions/${testSession1Id}/candidates`).expect(200);
  const candidateIds = res.body.candidates.map((c) => Number(c.id));
  assert.ok(!candidateIds.includes(Number(jUnavail.rows[0].id)), 'Unavailable judge must NOT be listed as candidate');
});

test('Coverage: Sessions coverage returns 404 for invalid/non-existent session ID', async () => {
  await adminAgent.get('/api/sessions/9999999/coverage').expect(404);
  await adminAgent.get('/api/sessions/notanid/coverage').expect(400);
});
