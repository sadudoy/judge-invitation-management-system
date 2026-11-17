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

before(async () => {
  await setupTestDb();
  app = createApp();

  adminAgent = request.agent(app);
  await adminAgent
    .post('/api/auth/login')
    .send({ email: 'admin@csefest.edu', password: 'ChangeMe123!' })
    .expect(200);

  // Force refresh materialized views to have populated state
  await pool.query('SELECT refresh_mv_dashboard_force();');
});

after(async () => {
  await db.close();
  await teardownTestDb();
});

test('Dashboard: Unauthenticated requests return 401', async () => {
  const unauth = request(app);
  await unauth.get('/api/dashboard/summary').expect(401);
  await unauth.get('/api/dashboard/coverage').expect(401);
  await unauth.get('/api/dashboard/workload').expect(401);
  await unauth.get('/api/dashboard/feasibility').expect(401);
});

test('Dashboard: GET /api/dashboard/summary returns all 13 KPI metrics', async () => {
  const res = await adminAgent.get('/api/dashboard/summary').expect(200);
  const data = res.body;

  const expectedKeys = [
    'total_judges',
    'invitations_sent',
    'invitations_accepted',
    'invitations_declined',
    'invitations_pending',
    'assignments_confirmed',
    'assignments_held',
    'unassigned_sessions',
    'scheduling_conflicts',
    'expected_arrivals_today',
    'checked_in',
    'missing',
    'replacements_open',
  ];

  for (const key of expectedKeys) {
    assert.ok(key in data, `Expected key "${key}" in dashboard summary payload`);
    assert.equal(typeof data[key], 'number', `Expected "${key}" to be a number`);
  }
});

test('Dashboard: GET /api/dashboard/coverage reads mv_session_coverage with filtering', async () => {
  const resAll = await adminAgent.get('/api/dashboard/coverage').expect(200);
  assert.ok(Array.isArray(resAll.body));
  assert.ok(resAll.body.length > 0);

  const firstSession = resAll.body[0];
  assert.ok('session_id' in firstSession);
  assert.ok('session_name' in firstSession);
  assert.ok('competition_name' in firstSession);
  assert.ok('required_judges' in firstSession);
  assert.ok('confirmed_count' in firstSession);
  assert.ok('missing' in firstSession);
  assert.ok('has_head' in firstSession);
  assert.ok('status' in firstSession);

  // Test filter by status
  const resUnderstaffed = await adminAgent
    .get('/api/dashboard/coverage?status=understaffed')
    .expect(200);
  assert.ok(Array.isArray(resUnderstaffed.body));
  for (const s of resUnderstaffed.body) {
    assert.equal(s.status, 'understaffed');
  }
});

test('Dashboard: GET /api/dashboard/workload reads mv_judge_workload with sorting and filtering', async () => {
  const res = await adminAgent.get('/api/dashboard/workload?order=desc&limit=10').expect(200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length <= 10);

  if (res.body.length > 0) {
    const firstJudge = res.body[0];
    assert.ok('judge_id' in firstJudge);
    assert.ok('full_name' in firstJudge);
    assert.ok('email' in firstJudge);
    assert.ok('confirmed_count' in firstJudge);
    assert.ok('held_count' in firstJudge);
    assert.ok('no_show_rate' in firstJudge);
  }

  // Filter by kind
  const resAcademic = await adminAgent
    .get('/api/dashboard/workload?kind=academic')
    .expect(200);
  assert.ok(Array.isArray(resAcademic.body));
  for (const j of resAcademic.body) {
    assert.equal(j.kind, 'academic');
  }
});

test('Dashboard: GET /api/dashboard/feasibility returns interval-sweep metrics', async () => {
  const res = await adminAgent.get('/api/dashboard/feasibility').expect(200);
  const data = res.body;

  assert.ok('event_id' in data);
  assert.ok('event_name' in data);
  assert.ok('session_count' in data);
  assert.ok('peak' in data);
  assert.ok('available' in data);
  assert.ok('feasible' in data);
  assert.ok('deficit' in data);
  assert.equal(typeof data.feasible, 'boolean');
});

test('Dashboard: Materialized view force refresh updates coverage and workload MVs', async () => {
  // Call force refresh function
  await pool.query('SELECT refresh_mv_dashboard_force();');

  const checkCoverage = await pool.query('SELECT COUNT(*)::int AS count FROM mv_session_coverage;');
  const checkWorkload = await pool.query('SELECT COUNT(*)::int AS count FROM mv_judge_workload;');

  assert.ok(checkCoverage.rows[0].count > 0, 'mv_session_coverage should contain rows');
  assert.ok(checkWorkload.rows[0].count > 0, 'mv_judge_workload should contain rows');
});
